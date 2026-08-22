import { db } from "../../db/index.js";
import { stationReceivers, telehealthPeers, telehealthRooms, telehealthSignals, appointments } from "../../db/schema.js";
import { and, eq, gt, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { ringPlan, ringTimeoutSec, stationFromRoomId, stationMapCached, type StationRow } from "../lib/stations.js";
import { pushToStation } from "../lib/push.js";

/**
 * Signaling WebRTC không dùng WebSocket (Netlify không giữ kết nối socket lâu dài).
 * Mỗi thành viên trong phòng khám gửi/nhận bản tin signaling qua HTTP:
 *   - POST /api/signal  { action: 'join' | 'signal' | 'leave' | 'vitals' | 'notes' | 'complete', ... }
 *   - POST /api/signal  { action: 'standby', roomId: '__lobby__', peerId, name, stationCode, userId }
 *   - POST /api/signal  { action: 'accept', roomId, peerId, userId, name }   (giành quyền tiếp nhận)
 *   - POST /api/signal  { action: 'decline', roomId, peerId }                (từ chối -> leo thang ngay)
 *   - GET  /api/signal?roomId=...&peerId=...&cursor=...   (long-poll ngắn, trả về bản tin mới)
 *   - GET  /api/signal?action=rooms                       (danh sách phòng đang chờ bác sĩ)
 *   - GET  /api/signal?action=rooms&wait=1&sig=...        (long-poll hàng đợi: trả ngay khi hàng đợi đổi)
 *   - GET  /api/signal?action=on-duty                     (số cán bộ đang trực, cho màn hình người dân)
 *
 * PHÒNG KHÁM BA BÊN
 * -----------------
 * Một phòng khám chứa đồng thời ba vai: người dân gọi tới, Bảng điều khiển của
 * điểm trạm và Bác sĩ tuyến trên. Máy chủ không ghép cặp hai người nữa mà trả về
 * DANH SÁCH thành viên đang có trong phòng; bên vừa vào tự mở một kết nối ngang
 * hàng riêng tới từng người đã ở trong phòng (mô hình lưới - mesh). Nhờ đó mọi
 * bản tin offer/answer/ICE đều phải ghi rõ `to` là peerId người nhận, không còn
 * phát tán cho cả phòng như khi chỉ có hai bên.
 *
 * ĐIỀU HƯỚNG THEO ĐIỂM TRẠM
 * -------------------------
 * Mỗi cuộc gọi mang theo mã điểm trạm người dân đã chọn. Máy chủ không chạy tiến
 * trình nền nào để leo thang: trạng thái đổ chuông được SUY RA từ mốc thời gian
 * `ringing_since` ở mỗi lượt quét hàng đợi (xem ringPlan trong netlify/lib/stations.ts).
 * Nhờ vậy cơ chế hoạt động đúng trên nền serverless, nơi không có tiến trình nào
 * sống sót giữa hai lần gọi hàm.
 *
 * Việc tiếp nhận đi qua MỘT câu lệnh UPDATE có điều kiện: chỉ cuộc gọi còn ở
 * trạng thái chờ mới bị đổi sang ACCEPTED, nên khi hai cán bộ bấm cùng lúc thì
 * đúng một người thắng và người kia nhận được thông báo "đã có người tiếp nhận".
 */

// Phòng ảo giữ danh sách cán bộ/bác sĩ đang trực (không phải phòng khám thật).
const LOBBY_ROOM = "__lobby__";
const PEER_TTL_MS = 45_000;
const SIGNAL_TTL_MS = 180_000;
// Giữ dưới ngưỡng timeout 10s của Netlify Functions.
const POLL_WINDOW_MS = 7_000;
/*
 * Nhịp quét bản tin trong một lượt long-poll, thay đổi theo thời điểm.
 *
 * Toàn bộ việc bắt tay WebRTC (offer -> answer -> ICE) diễn ra trong khoảng một
 * giây đầu của lượt chờ; càng về sau thì kênh chỉ còn nằm im đợi sự kiện. Nên
 * quét rất dày ở đầu lượt để hình lên nhanh, rồi giãn ra để không phải hỏi cơ sở
 * dữ liệu vô ích - tổng số truy vấn mỗi lượt vẫn xấp xỉ mức cũ (nhịp cố định
 * 250ms), nhưng độ trễ bắt tay giảm khoảng ba lần.
 */
const POLL_FAST_INTERVAL_MS = 80;
const POLL_FAST_PHASE_MS = 1_200;
const POLL_SLOW_INTERVAL_MS = 300;

function pollInterval(elapsedMs: number) {
  return elapsedMs < POLL_FAST_PHASE_MS ? POLL_FAST_INTERVAL_MS : POLL_SLOW_INTERVAL_MS;
}

const headers = {
  "Content-Type": "application/json",
  "Cache-Control": "no-store",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS"
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { headers, status });

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function pruneStale(now: number) {
  // Hai lệnh xoá không phụ thuộc nhau: chạy song song để lượt quét hàng đợi trả
  // về sớm hơn, cuộc gọi mới hiện lên máy cán bộ nhanh hơn tương ứng.
  await Promise.all([
    db.delete(telehealthPeers).where(lt(telehealthPeers.lastSeen, now - PEER_TTL_MS)),
    db.delete(telehealthSignals).where(lt(telehealthSignals.ts, now - SIGNAL_TTL_MS))
  ]);
}

async function currentSeq(): Promise<number> {
  const rows = await db
    .select({ seq: sql<number>`coalesce(max(${telehealthSignals.seq}), 0)` })
    .from(telehealthSignals);
  return Number(rows[0]?.seq ?? 0);
}

async function activePeers(roomId: string, now: number) {
  return db
    .select()
    .from(telehealthPeers)
    .where(and(eq(telehealthPeers.roomId, roomId), gt(telehealthPeers.lastSeen, now - PEER_TTL_MS)));
}

async function getRoom(roomId: string) {
  const rows = await db.select().from(telehealthRooms).where(eq(telehealthRooms.id, roomId));
  return rows[0] || null;
}

async function pushSignal(input: {
  roomId: string;
  fromPeer: string;
  toPeer?: string | null;
  type: string;
  payload?: unknown;
  now: number;
}) {
  await db.insert(telehealthSignals).values({
    roomId: input.roomId,
    fromPeer: input.fromPeer,
    toPeer: input.toPeer || null,
    type: input.type,
    payload: input.payload === undefined ? null : JSON.stringify(input.payload),
    ts: input.now
  });
}

async function touchRoom(roomId: string, patch: Record<string, unknown>, now: number) {
  const existing = await getRoom(roomId);
  if (existing) {
    await db
      .update(telehealthRooms)
      .set({ ...patch, updatedAt: now })
      .where(eq(telehealthRooms.id, roomId));
  } else {
    await db.insert(telehealthRooms).values({ id: roomId, updatedAt: now, ...patch } as never);
  }
}

/**
 * Số cán bộ/bác sĩ đang trực (đăng nhập CMS và mở kênh tiếp nhận cuộc gọi).
 *
 * Ngoài tổng số còn tách theo từng điểm trạm: màn hình người dân cần biết
 * "trạm này có người trực" chứ không phải "toàn hệ thống có người trực".
 */
async function countOnDuty(now: number) {
  const rows = await db
    .select()
    .from(telehealthPeers)
    .where(and(eq(telehealthPeers.roomId, LOBBY_ROOM), gt(telehealthPeers.lastSeen, now - PEER_TTL_MS)));

  const byStation: Record<string, number> = {};
  for (const row of rows) {
    const code = row.stationCode || "";
    if (!code) continue;
    byStation[code] = (byStation[code] || 0) + 1;
  }
  return { count: rows.length, names: rows.map((r) => r.name), byStation };
}

/** Trạng thái coi như "chưa ai nhận" - còn nằm trong tầm đổ chuông. */
const RINGING_STATES = ["WAITING", "RINGING", "ESCALATED"];

/** Danh sách phòng khám đang mở kèm thông tin để bác sĩ quyết định tiếp nhận. */
async function listRooms(now: number, stations: Map<string, StationRow>) {
  const peers = await db
    .select()
    .from(telehealthPeers)
    .where(gt(telehealthPeers.lastSeen, now - PEER_TTL_MS));

  const grouped = new Map<string, typeof peers>();
  for (const peer of peers) {
    if (peer.roomId === LOBBY_ROOM) continue;
    const entry = grouped.get(peer.roomId) || ([] as typeof peers);
    entry.push(peer);
    grouped.set(peer.roomId, entry);
  }

  const roomIds = Array.from(grouped.keys());
  if (!roomIds.length) return [];

  // Một truy vấn cho tất cả phòng thay vì mỗi phòng một lượt hỏi. Với hàng đợi
  // vài chục cuộc gọi, cách cũ (N+1) là phần chậm nhất của lượt quét hàng đợi.
  const roomRows = await db.select().from(telehealthRooms).where(inArray(telehealthRooms.id, roomIds));
  const roomById = new Map(roomRows.map((r) => [r.id, r]));

  const rooms = [];
  for (const [roomId, entry] of grouped.entries()) {
    const room = roomById.get(roomId) || null;
    const waiting = entry.filter((p) => p.role !== "doctor");
    const since = waiting.length ? Math.min(...waiting.map((p) => Number(p.lastSeen))) : now;

    /* Mã trạm lấy từ cột dữ liệu; cuộc gọi tạo trước khi có tính năng này thì
       đọc ngược từ quy ước đặt tên phòng cũ, nên hàng đợi không bị mất bản ghi. */
    const stationCode = room?.stationCode || stationFromRoomId(roomId, stations.keys());
    const station = stationCode ? stations.get(stationCode) || null : null;
    const routingState = String(room?.routingState || "WAITING").toUpperCase();

    // Chỉ cuộc gọi chưa ai nhận mới cần tính xem đang đổ chuông tới đâu.
    const plan = RINGING_STATES.includes(routingState)
      ? ringPlan(stationCode, Number(room?.ringingSince || since), stations, now)
      : null;

    rooms.push({
      roomId,
      patientName: room?.patientName || null,
      patientId: room?.patientId || null,
      symptoms: room?.symptoms || null,
      status: room?.status || "WAITING",
      vitals: room?.vitals ? JSON.parse(room.vitals) : null,
      // --- Điều hướng theo điểm trạm ---
      stationCode,
      stationName: station?.stationName || "",
      routingState,
      acceptedBy: room?.acceptedBy || "",
      acceptedName: room?.acceptedName || "",
      // Trạm đang đổ chuông ở thời điểm này (khác stationCode nghĩa là đã chuyển dự phòng).
      ringingStation: plan ? plan.stationCode : "",
      // Mức ưu tiên cao nhất đang được gọi: 1 = mới chỉ trực chính, 2 = đã lan sang trực phụ...
      ringMaxPriority: plan ? plan.maxPriority : 0,
      ringRemainingSec: plan ? plan.remainingSec : 0,
      ringingSince: Number(room?.ringingSince || since),
      escalated: plan ? plan.escalated : false,
      // Đã gọi hết vòng mà không ai nhận: hàng đợi tô đỏ và báo Quản trị.
      exhausted: plan ? plan.exhausted : false,
      hasDoctor: entry.some((p) => p.role === "doctor"),
      // Số bên đang có mặt trong phòng - màn hình tiếp nhận dùng để biết cuộc gọi
      // đã đủ ba bên (người dân + điểm trạm + tuyến trên) hay còn thiếu ai.
      participants: entry.length,
      since,
      waiting: waiting.map((p) => ({ name: p.name, role: p.role, since: Number(p.lastSeen) }))
    });
  }
  return rooms;
}

/**
 * Vân tay của hàng đợi: chỉ đổi khi có cuộc gọi vào/ra, đổi trạng thái, đổi số
 * bên tham gia hoặc đổi số cán bộ đang trực. Máy tiếp nhận gửi kèm vân tay của
 * lần quét trước; máy chủ giữ yêu cầu cho tới khi vân tay khác đi rồi mới trả
 * lời, nên cuộc gọi mới hiện ra gần như tức thì thay vì đợi hết một chu kỳ quét.
 */
function queueSignature(rooms: Array<Record<string, unknown>>, onDuty: { count: number; byStation: Record<string, number> }) {
  /* Có thêm trạng thái điều hướng, trạm đang đổ chuông và mức ưu tiên: một bước
     leo thang cũng làm vân tay đổi, nên máy đang chờ được đánh thức ngay khi
     cuộc gọi lan tới mình. Cố ý KHÔNG đưa ringRemainingSec vào - số giây đếm
     ngược đổi liên tục sẽ phá tác dụng của long-poll; giao diện tự đếm lùi. */
  const parts = rooms
    .map(
      (r) =>
        `${r.roomId}:${r.status}:${r.routingState}:${r.ringingStation || ""}:${r.ringMaxPriority || 0}:${
          r.hasDoctor ? 1 : 0
        }:${r.participants}`
    )
    .sort();
  const duty = Object.keys(onDuty.byStation)
    .sort()
    .map((code) => `${code}=${onDuty.byStation[code]}`)
    .join(";");
  return `${onDuty.count}|${duty}|${parts.join(",")}`;
}

async function fetchMessages(roomId: string, peerId: string, cursor: number) {
  const rows = await db
    .select()
    .from(telehealthSignals)
    .where(
      and(
        eq(telehealthSignals.roomId, roomId),
        gt(telehealthSignals.seq, cursor),
        or(eq(telehealthSignals.toPeer, peerId), isNull(telehealthSignals.toPeer))
      )
    )
    .orderBy(telehealthSignals.seq);

  return rows
    .filter((row) => row.fromPeer !== peerId)
    .map((row) => ({
      seq: Number(row.seq),
      from: row.fromPeer,
      type: row.type,
      payload: row.payload ? JSON.parse(row.payload) : null
    }));
}

/** Một ảnh chụp hàng đợi kèm vân tay để so sánh giữa hai lượt quét. */
async function queueSnapshot(now: number) {
  const stations = await stationMapCached(now);
  const [rooms, onDuty] = await Promise.all([listRooms(now, stations), countOnDuty(now)]);
  return { rooms, onDuty, sig: queueSignature(rooms, onDuty) };
}

/**
 * Thông tin phòng khám trả về cho mọi thành viên đang ở trong phòng.
 *
 * Liên kết Zoom CHỈ xuất hiện sau khi cuộc gọi đã được tiếp nhận. Trước thời
 * điểm đó, biết roomId cũng không đọc được phòng họp của điểm trạm - đây là
 * ranh giới ngăn liên kết phòng bị dò ra từ bên ngoài.
 */
function roomView(
  room: NonNullable<Awaited<ReturnType<typeof getRoom>>>,
  stations: Map<string, StationRow>,
  now: number
) {
  const routingState = String(room.routingState || "WAITING").toUpperCase();
  const accepted = routingState === "ACCEPTED";

  /* Bậc thang leo thang được suy ra tại chỗ từ mốc bắt đầu đổ chuông, giống hệt
     cách hàng đợi của cán bộ tính - nhờ vậy hai màn hình luôn nói cùng một câu
     mà không cần đồng bộ thêm trạng thái nào. */
  const plan = RINGING_STATES.includes(routingState)
    ? ringPlan(room.stationCode || "", Number(room.ringingSince || now), stations, now)
    : null;
  const ringingCode = plan ? plan.stationCode : room.ringingStation || room.stationCode || "";

  return {
    status: room.status,
    patientName: room.patientName,
    patientId: room.patientId || "",
    vitals: room.vitals ? JSON.parse(room.vitals) : null,
    notes: room.notes || "",
    stationCode: room.stationCode || "",
    stationName: stations.get(room.stationCode || "")?.stationName || "",
    routingState,
    ringingStation: ringingCode,
    ringingStationName: stations.get(ringingCode)?.stationName || "",
    ringRemainingSec: plan ? plan.remainingSec : null,
    escalated: plan ? plan.escalated : false,
    exhausted: plan ? plan.exhausted : false,
    acceptedName: room.acceptedName || "",
    acceptedAt: room.acceptedAt || null,
    ringingSince: room.ringingSince || null,
    zoom: accepted && room.zoomJoinUrl
      ? {
          joinUrl: room.zoomJoinUrl,
          meetingId: room.zoomMeetingId || "",
          passcode: room.zoomPasscode || ""
        }
      : null
  };
}

async function handleGet(url: URL) {
  const now = Date.now();

  if (url.searchParams.get("action") === "rooms") {
    await pruneStale(now);
    let snap = await queueSnapshot(Date.now());

    // Long-poll hàng đợi: máy tiếp nhận gửi vân tay của lần quét trước, máy chủ
    // chỉ trả lời khi hàng đợi thực sự đổi (hoặc hết cửa sổ chờ). Cuộc gọi mới
    // đổ chuông sau vài trăm mili-giây thay vì đợi hết chu kỳ quét của trình duyệt.
    const wantWait = url.searchParams.get("wait") === "1";
    const knownSig = url.searchParams.get("sig");
    if (wantWait && knownSig !== null) {
      const deadline = now + POLL_WINDOW_MS;
      while (snap.sig === knownSig && Date.now() < deadline) {
        await sleep(pollInterval(Date.now() - now));
        snap = await queueSnapshot(Date.now());
      }
    }

    return json({
      ok: true,
      rooms: snap.rooms,
      sig: snap.sig,
      doctorsOnline: snap.onDuty.count,
      doctorNames: snap.onDuty.names,
      dutyByStation: snap.onDuty.byStation
    });
  }

  if (url.searchParams.get("action") === "on-duty") {
    // Màn hình người dân hỏi tuyến này để tô đèn "Đang trực" cho từng điểm trạm.
    const onDuty = await countOnDuty(now);
    return json({
      ok: true,
      doctorsOnline: onDuty.count,
      doctorNames: onDuty.names,
      dutyByStation: onDuty.byStation
    });
  }

  const roomId = url.searchParams.get("roomId");
  const peerId = url.searchParams.get("peerId");
  if (!roomId || !peerId) {
    return json({ error: "Thiếu roomId hoặc peerId" }, 400);
  }
  const cursor = Number(url.searchParams.get("cursor") || 0);

  // Báo còn sống và lấy bản tin cùng lúc: hai việc không phụ thuộc nhau, và lượt
  // hỏi đầu tiên chính là lượt mang offer/answer nên phải trả về sớm nhất có thể.
  const [, firstBatch] = await Promise.all([
    db.update(telehealthPeers).set({ lastSeen: now }).where(eq(telehealthPeers.id, peerId)),
    fetchMessages(roomId, peerId, cursor)
  ]);

  // Long-poll ngắn: chờ tối đa POLL_WINDOW_MS để trả bản tin ngay khi có,
  // giúp bắt tay WebRTC nhanh gần bằng WebSocket mà vẫn chạy trên serverless.
  const deadline = now + POLL_WINDOW_MS;
  let messages = firstBatch;
  while (messages.length === 0 && Date.now() < deadline) {
    await sleep(pollInterval(Date.now() - now));
    messages = await fetchMessages(roomId, peerId, cursor);
  }

  const pollNow = Date.now();
  // Ba truy vấn khép lại một lượt long-poll, không cái nào cần kết quả của cái
  // kia: gộp lại còn một lượt chờ thay vì ba lượt nối tiếp.
  const [peers, room, onDuty, stations] = await Promise.all([
    activePeers(roomId, pollNow),
    getRoom(roomId),
    countOnDuty(pollNow),
    stationMapCached(pollNow)
  ]);
  const nextCursor = messages.length ? messages[messages.length - 1].seq : cursor;

  return json({
    ok: true,
    cursor: nextCursor,
    messages,
    doctorsOnline: onDuty.count,
    doctorNames: onDuty.names,
    room: room ? roomView(room, stations, pollNow) : null,
    // Toàn bộ thành viên đang có mặt (trừ chính mình): màn hình khám dùng danh
    // sách này để biết phải giữ bao nhiêu khung hình và ai vừa rời đi.
    peers: peers.filter((p) => p.id !== peerId).map((p) => ({ peerId: p.id, role: p.role, name: p.name }))
  });
}

/**
 * Một cán bộ giành quyền tiếp nhận cuộc gọi.
 *
 * Toàn bộ chống nhận trùng nằm ở MỘT câu lệnh UPDATE ... WHERE routing_state IN
 * (chưa ai nhận) ... RETURNING. Cơ sở dữ liệu tự tuần tự hoá hai lệnh đến cùng
 * lúc, nên đúng một lệnh nhận về bản ghi và trở thành người thắng; không cần khoá
 * ngoài, cũng không có khe hở giữa lúc đọc và lúc ghi như cách kiểm tra hai bước.
 */
async function handleAccept(body: Record<string, any>, roomId: string, peerId: string, now: number) {
  const userId = String(body.userId || "").trim();
  const name = String(body.name || "Cán bộ trực").trim();

  const room = await getRoom(roomId);
  if (!room) return json({ ok: false, code: "GONE", error: "Cuộc gọi không còn trong hàng đợi." }, 404);

  /* Phòng Zoom dùng cho phiên này được CHỐT ngay lúc tiếp nhận: ưu tiên phòng
     riêng của người nhận, không có thì dùng phòng của điểm trạm. Chốt lại thành
     dữ liệu của cuộc gọi để người dân và cán bộ chắc chắn vào cùng một phòng, kể
     cả khi Quản trị viên sửa cấu hình trạm ngay sau đó. */
  const stations = await stationMapCached(now);
  const station = room.stationCode ? stations.get(room.stationCode) || null : null;
  let joinUrl = station?.zoomJoinUrl || null;
  let meetingId = station?.zoomMeetingId || null;
  let passcode = station?.zoomPasscode || null;

  if (userId && room.stationCode) {
    const personal = await db
      .select()
      .from(stationReceivers)
      .where(and(eq(stationReceivers.stationCode, room.stationCode), eq(stationReceivers.userId, userId)));
    const link = personal[0];
    if (link?.personalZoomUrl) {
      joinUrl = link.personalZoomUrl;
      meetingId = link.personalMeetingId || "";
      // Phòng riêng thì mật khẩu nằm trong chính liên kết, không lấy của trạm.
      passcode = null;
    }
  }

  const claimed = await db
    .update(telehealthRooms)
    .set({
      routingState: "ACCEPTED",
      acceptedBy: userId || peerId,
      acceptedName: name,
      acceptedAt: now,
      status: "IN_CALL",
      zoomJoinUrl: joinUrl,
      zoomMeetingId: meetingId,
      zoomPasscode: passcode,
      updatedAt: now
    })
    .where(and(eq(telehealthRooms.id, roomId), inArray(telehealthRooms.routingState, RINGING_STATES)))
    .returning();

  if (!claimed.length) {
    // Thua cuộc: đọc lại để nói rõ ai đã nhận thay vì báo lỗi chung chung.
    const taken = await getRoom(roomId);
    const holder = taken?.acceptedName || "cán bộ khác";
    return json(
      {
        ok: false,
        code: "ALREADY_TAKEN",
        acceptedName: taken?.acceptedName || "",
        error: `Cuộc gọi đã được ${holder} tiếp nhận.`
      },
      409
    );
  }

  /* Báo cho mọi máy đang mở phòng: người dân đổi màn hình chờ sang "đã kết nối",
     các máy trực khác tắt chuông. Bản tin cố ý KHÔNG mang liên kết Zoom - ai
     đang trong phòng sẽ đọc nó qua tuyến long-poll đã kiểm tra trạng thái. */
  await pushSignal({
    roomId,
    fromPeer: peerId,
    type: "call-accepted",
    payload: { by: name, stationCode: room.stationCode || "", at: now },
    now
  });

  return json({
    ok: true,
    acceptedName: name,
    zoom: joinUrl ? { joinUrl, meetingId: meetingId || "", passcode: passcode || "" } : null
  });
}

/**
 * Cán bộ bấm "Từ chối": đẩy cuộc gọi sang vòng leo thang kế tiếp ngay lập tức.
 *
 * Thay vì thêm một cột trạng thái nữa, chỉ cần lùi mốc `ringingSince` lại đúng
 * một chu kỳ đổ chuông - lượt quét kế tiếp tự suy ra là đã hết một vòng và mở
 * rộng sang mức ưu tiên tiếp theo. Một phép trừ, không có tiến trình nền nào.
 */
async function handleDecline(body: Record<string, any>, roomId: string, peerId: string, now: number) {
  const room = await getRoom(roomId);
  if (!room) return json({ ok: true });
  if (String(room.routingState || "").toUpperCase() === "ACCEPTED") {
    return json({ ok: false, code: "ALREADY_TAKEN", error: "Cuộc gọi đã được tiếp nhận." }, 409);
  }

  const stations = await stationMapCached(now);
  const timeoutMs = ringTimeoutSec(room.stationCode ? stations.get(room.stationCode) : null) * 1000;
  await db
    .update(telehealthRooms)
    .set({
      routingState: "ESCALATED",
      ringingSince: Number(room.ringingSince || now) - timeoutMs,
      escalationRound: Number(room.escalationRound || 0) + 1,
      updatedAt: now
    })
    .where(and(eq(telehealthRooms.id, roomId), inArray(telehealthRooms.routingState, RINGING_STATES)));

  // Vòng mới nghĩa là có thêm người phải biết: gõ cửa đúng nhóm vừa được mở rộng.
  const nextPlan = ringPlan(room.stationCode || "", Number(room.ringingSince || now) - timeoutMs, stations, now);
  try {
    await pushToStation(nextPlan.stationCode, nextPlan.maxPriority, now);
  } catch (err) {
    console.error("push on escalate failed", err);
  }

  await pushSignal({
    roomId,
    fromPeer: peerId,
    type: "call-declined",
    payload: { by: String(body.name || "").trim(), at: now },
    now
  });
  return json({ ok: true });
}

async function handlePost(req: Request) {
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return json({ error: "Body không hợp lệ" }, 400);
  }

  const { action, roomId, peerId } = body as Record<string, string>;
  if (!action) return json({ error: "Thiếu action" }, 400);
  if (!roomId || !peerId) return json({ error: "Thiếu roomId hoặc peerId" }, 400);

  const now = Date.now();

  if (action === "join") {
    await pruneStale(now);
    /* Một phòng khám trực tiếp có tối đa ba vai: người dân đang gọi, bảng điều
       khiển của điểm trạm và bác sĩ tuyến trên. Vai chỉ dùng để hiển thị (đầu cầu
       nào lên khung hình lớn, ai đang trực); mọi phép đếm hàng đợi vẫn chỉ phân
       biệt "doctor" với phần còn lại nên thêm vai "patient" không đổi hành vi cũ. */
    const rawRole = String((body as any).role || "");
    const role = rawRole === "doctor" ? "doctor" : rawRole === "patient" ? "patient" : "station";
    const name = String((body as any).name || "Thành viên");
    const joinStation = String((body as any).stationCode || "").trim().toUpperCase();
    const joinUserId = String((body as any).userId || "").trim();

    const [existing, stations, roomBefore] = await Promise.all([
      activePeers(roomId, now),
      stationMapCached(now),
      getRoom(roomId)
    ]);
    const others = existing.filter((p) => p.id !== peerId);

    await db
      .insert(telehealthPeers)
      .values({
        id: peerId,
        roomId,
        role,
        name,
        lastSeen: now,
        stationCode: joinStation || null,
        userId: joinUserId || null
      })
      .onConflictDoUpdate({
        target: telehealthPeers.id,
        set: { roomId, role, name, lastSeen: now, stationCode: joinStation || null, userId: joinUserId || null }
      });

    const roomPatch: Record<string, unknown> = {
      status: role === "doctor" ? "IN_CALL" : others.length ? "IN_CALL" : "WAITING"
    };

    /* KHỞI ĐỘNG ĐỔ CHUÔNG
       Người dân là bên mở cuộc gọi, nên chỉ lần vào phòng đầu tiên của một bên
       KHÔNG phải cán bộ mới đặt mốc `ringingSince`. Cán bộ vào sau (kể cả khi
       tải lại trang) không được phép làm đồng hồ leo thang chạy lại từ đầu. */
    const resolvedStation = joinStation || roomBefore?.stationCode || stationFromRoomId(roomId, stations.keys());
    if (resolvedStation && !roomBefore?.stationCode) roomPatch.stationCode = resolvedStation;
    const startsRinging = role !== "doctor" && !roomBefore?.ringingSince;
    if (startsRinging) {
      roomPatch.routingState = "RINGING";
      roomPatch.ringingStation = resolvedStation || null;
      roomPatch.ringingSince = now;
      roomPatch.escalationRound = 0;
    }
    if ((body as any).patientName) roomPatch.patientName = String((body as any).patientName);
    if ((body as any).symptoms) roomPatch.symptoms = String((body as any).symptoms);
    // Số căn cước công dân do người dân tự nhập ở màn hình đăng ký: lưu theo
    // phòng khám để điểm trạm và bác sĩ tuyến trên đọc lại được kể cả khi vào
    // sau, không phụ thuộc vào việc bắt được đúng bản tin patient-info.
    if ((body as any).patientId) roomPatch.patientId = String((body as any).patientId).trim().slice(0, 32);
    await touchRoom(roomId, roomPatch, now);

    /* Gõ cửa trực chính của trạm ngay khi cuộc gọi bắt đầu đổ chuông. Chỉ chạy ở
       lần vào phòng đầu tiên nên không có chuyện gửi lại mỗi lượt tải lại trang.
       Lỗi ở đây không được phép làm hỏng cuộc gọi: popup và chuông trong trình
       duyệt vẫn là kênh chính, thông báo đẩy chỉ để với tới máy đang đóng. */
    if (startsRinging && resolvedStation) {
      try {
        await pushToStation(resolvedStation, 1, now);
      } catch (err) {
        console.error("push on ring failed", err);
      }
    }

    const cursor = await currentSeq();
    await pushSignal({ roomId, fromPeer: peerId, type: "peer-joined", payload: { role, name }, now });

    const room = await getRoom(roomId);
    return json({
      ok: true,
      cursor,
      // Người vào sau chịu trách nhiệm tạo offer -> luôn chỉ có duy nhất một bên gọi.
      shouldOffer: others.length > 0,
      // Trong phòng ba bên, "một bên gọi" nghĩa là: người vừa vào mở một kết nối
      // riêng tới TỪNG người đã có mặt. Danh sách này chính là các đích cần chào
      // mời, còn người đang ở trong phòng chỉ việc ngồi yên chờ offer tới.
      offerTo: others.map((p) => p.id),
      peers: others.map((p) => ({ peerId: p.id, role: p.role, name: p.name })),
      room: room
        ? {
            status: room.status,
            patientName: room.patientName,
            patientId: room.patientId || "",
            vitals: room.vitals ? JSON.parse(room.vitals) : null,
            notes: room.notes || ""
          }
        : null
    });
  }

  if (action === "standby") {
    // Cán bộ CMS mở kênh tiếp nhận: vừa báo đang trực, vừa lấy hàng đợi trong 1 lượt gọi.
    await pruneStale(now);
    const name = String((body as any).name || "Cán bộ trực");
    // Trạm và tài khoản của người trực: hai thông tin này quyết định cuộc gọi nào
    // được đổ chuông tới máy nào, và làm nên phép đếm "đang trực" của từng trạm.
    const dutyStation = String((body as any).stationCode || "").trim().toUpperCase();
    const dutyUserId = String((body as any).userId || "").trim();
    await db
      .insert(telehealthPeers)
      .values({
        id: peerId,
        roomId: LOBBY_ROOM,
        role: "doctor",
        name,
        lastSeen: now,
        stationCode: dutyStation || null,
        userId: dutyUserId || null
      })
      .onConflictDoUpdate({
        target: telehealthPeers.id,
        set: {
          roomId: LOBBY_ROOM,
          role: "doctor",
          name,
          lastSeen: now,
          stationCode: dutyStation || null,
          userId: dutyUserId || null
        }
      });

    let snap = await queueSnapshot(Date.now());
    // Giống long-poll hàng đợi ở nhánh GET: nếu máy tiếp nhận gửi kèm vân tay của
    // lần trước thì giữ yêu cầu lại cho tới khi có thay đổi thật.
    const knownSig = (body as any).sig;
    if (typeof knownSig === "string") {
      const deadline = now + POLL_WINDOW_MS;
      while (snap.sig === knownSig && Date.now() < deadline) {
        await sleep(pollInterval(Date.now() - now));
        snap = await queueSnapshot(Date.now());
      }
    }

    return json({
      ok: true,
      rooms: snap.rooms,
      sig: snap.sig,
      doctorsOnline: snap.onDuty.count,
      doctorNames: snap.onDuty.names,
      dutyByStation: snap.onDuty.byStation
    });
  }

  if (action === "accept") return await handleAccept(body as Record<string, any>, roomId, peerId, now);
  if (action === "decline") return await handleDecline(body as Record<string, any>, roomId, peerId, now);

  if (action === "signal") {
    const type = String((body as any).type || "");
    if (!type) return json({ error: "Thiếu type" }, 400);
    if (type === "patient-info") {
      // Bản tin định danh bệnh nhân vừa chuyển tiếp, vừa đọng lại trong phòng.
      const payload = ((body as any).payload || {}) as Record<string, unknown>;
      const patch: Record<string, unknown> = {};
      const patientId = String(payload.patientId || "").trim();
      const patientName = String(payload.patientName || "").trim();
      if (patientId) patch.patientId = patientId.slice(0, 32);
      if (patientName) patch.patientName = patientName;
      if (Object.keys(patch).length) await touchRoom(roomId, patch, now);
    }
    await pushSignal({
      roomId,
      fromPeer: peerId,
      toPeer: (body as any).to || null,
      type,
      payload: (body as any).payload ?? null,
      now
    });
    return json({ ok: true });
  }

  if (action === "vitals") {
    const vitals = (body as any).vitals || {};
    await touchRoom(roomId, { vitals: JSON.stringify(vitals) }, now);
    await pushSignal({ roomId, fromPeer: peerId, type: "vitals", payload: vitals, now });
    return json({ ok: true });
  }

  if (action === "notes") {
    const notes = String((body as any).notes || "");
    await touchRoom(roomId, { notes }, now);
    await pushSignal({ roomId, fromPeer: peerId, type: "notes", payload: { notes }, now });
    return json({ ok: true });
  }

  if (action === "complete") {
    await touchRoom(roomId, { status: "COMPLETED", routingState: "ENDED" }, now);
    await pushSignal({ roomId, fromPeer: peerId, type: "call-ended", payload: { reason: "completed" }, now });
    const apptId = (body as any).appointmentId;
    if (apptId) {
      await db.update(appointments).set({ status: "COMPLETED" }).where(eq(appointments.id, String(apptId)));
    }
    return json({ ok: true });
  }

  if (action === "leave") {
    await db.delete(telehealthPeers).where(eq(telehealthPeers.id, peerId));
    if (roomId === LOBBY_ROOM) {
      // Rời kênh trực: không phát bản tin vào phòng khám nào.
      return json({ ok: true });
    }
    await pushSignal({ roomId, fromPeer: peerId, type: "peer-left", payload: null, now });
    const remaining = await activePeers(roomId, now);
    if (remaining.length === 0) {
      const room = await getRoom(roomId);
      if (room && room.status !== "COMPLETED") {
        /* Phòng trống mà chưa ai kịp tiếp nhận nghĩa là người dân đã bỏ cuộc -
           ghi CANCELLED chứ không phải ENDED, để báo cáo tách được cuộc gọi lỡ
           với cuộc gọi đã khám xong. */
        const wasAccepted = String(room.routingState || "").toUpperCase() === "ACCEPTED";
        await touchRoom(roomId, { status: "ENDED", routingState: wasAccepted ? "ENDED" : "CANCELLED" }, now);
      }
    }
    return json({ ok: true });
  }

  return json({ error: "Action không hợp lệ" }, 400);
}

export default async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers, status: 204 });
  }

  try {
    if (req.method === "GET") return await handleGet(new URL(req.url));
    if (req.method === "POST") return await handlePost(req);
    return json({ error: "Method not allowed" }, 405);
  } catch (err: any) {
    console.error("signal error", err);
    return json({ error: err?.message || "Lỗi signaling" }, 500);
  }
};

export const config = {
  path: "/api/signal"
};
