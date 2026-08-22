/**
 * API Mô-đun "Bảng điều khiển điểm trạm" (lối vào ở Chân trang CMS).
 *
 * Đây là nơi Quản trị viên cấp và quản lý phòng Zoom + tài khoản nhận cuộc gọi
 * cho từng điểm trạm. Cũng chính API này phát danh mục điểm trạm ra màn hình
 * người dân, nhưng bản công khai đã lược bỏ mọi thông tin phòng họp.
 *
 *   GET  /api/station-rooms                    danh mục công khai cho ô chọn của người dân
 *   GET  /api/station-rooms?admin=1            hồ sơ đầy đủ (yêu cầu phạm vi "admin")
 *   GET  /api/station-rooms?audit=<mã trạm>    nhật ký thay đổi cấu hình
 *   POST /api/station-rooms  { action: ... }
 *        create            tạo điểm trạm mới
 *        update            sửa hồ sơ / phòng Zoom / định tuyến
 *        set_status        ACTIVE | PAUSED | DISABLED (có kiểm tra điều kiện đủ)
 *        delete            xoá điểm trạm chưa từng dùng
 *        check_zoom        phân tích liên kết Zoom, cảnh báo trùng phòng
 *        add_receiver      gán tài khoản nhận cuộc gọi vào trạm
 *        update_receiver   sửa mức ưu tiên / phòng riêng / kênh thông báo
 *        remove_receiver   gỡ tài khoản khỏi trạm
 *
 * Phân quyền: mọi tuyến trừ danh mục công khai đều đi qua requireScope(req,
 * "admin"), tức là quyền được ĐỌC LẠI từ bảng users ở từng lần gọi - Quản trị
 * thu hồi quyền là có hiệu lực ngay, không chờ phiếu phiên hết hạn.
 */
import { db } from "../../db/index.js";
import { pushSubscriptions, stationReceivers, stationRoomAudits, stationRooms, telehealthPeers, users } from "../../db/schema.js";
import { and, desc, eq, gt, inArray, ne } from "drizzle-orm";
import { authErrorResponse, requireScope, type AuthContext } from "../lib/auth.js";
import {
  adminStation,
  formatMeetingId,
  getStation,
  isWithinDutyHours,
  listStations,
  normalizeMeetingId,
  parseZoomLink,
  publicStation,
  RING_TIMEOUT_MAX,
  RING_TIMEOUT_MIN,
  writeAudit
} from "../lib/stations.js";

const headers = {
  "Content-Type": "application/json",
  "Cache-Control": "no-store",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS"
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { headers, status });
const text = (value: unknown) => String(value === undefined || value === null ? "" : value).trim();

/** Cùng ngưỡng "còn sống" với kênh signaling, để hai nơi đếm trực giống nhau. */
const PEER_TTL_MS = 45_000;
const LOBBY_ROOM = "__lobby__";
const VALID_STATUS = new Set(["ACTIVE", "PAUSED", "DISABLED"]);

/** Đếm số cán bộ đang bật công tắc trực, tách theo từng điểm trạm. */
async function dutyByStation(now: number): Promise<Map<string, number>> {
  const rows = await db
    .select()
    .from(telehealthPeers)
    .where(and(eq(telehealthPeers.roomId, LOBBY_ROOM), gt(telehealthPeers.lastSeen, now - PEER_TTL_MS)));

  const counts = new Map<string, number>();
  for (const row of rows) {
    const code = row.stationCode || "";
    if (!code) continue;
    counts.set(code, (counts.get(code) || 0) + 1);
  }
  return counts;
}

async function receiversOf(codes: string[]) {
  if (!codes.length) return [];
  return db.select().from(stationReceivers).where(inArray(stationReceivers.stationCode, codes));
}

// ---------------------------------------------------------------------------
//  Danh mục công khai (không cần đăng nhập)
// ---------------------------------------------------------------------------

/**
 * Danh sách điểm trạm cho ô chọn của người dân.
 *
 * Trạm DISABLED bị loại hẳn; trạm PAUSED vẫn trả về để giao diện hiển thị mờ
 * kèm lý do thay vì biến mất không lời giải thích. Trạm để chế độ HIDE khi
 * ngoài giờ trực cũng bị ẩn đúng như Quản trị đã chọn.
 */
async function handlePublicList(now: number) {
  const [rows, duty] = await Promise.all([listStations(), dutyByStation(now)]);
  const visible = rows.filter((row) => {
    const status = String(row.status || "ACTIVE").toUpperCase();
    if (status === "DISABLED") return false;
    if (String(row.offHoursMode || "SHOW").toUpperCase() === "HIDE" && !isWithinDutyHours(row, now)) return false;
    return true;
  });

  return json({
    success: true,
    stations: visible.map((row) => publicStation(row, now, duty.get(row.stationCode) || 0)),
    ts: now
  });
}

// ---------------------------------------------------------------------------
//  Hồ sơ đầy đủ cho Quản trị
// ---------------------------------------------------------------------------

async function handleAdminList(now: number) {
  const [rows, duty] = await Promise.all([listStations(), dutyByStation(now)]);
  const codes = rows.map((r) => r.stationCode);
  const [links, accounts] = await Promise.all([receiversOf(codes), db.select().from(users)]);
  const userById = new Map(accounts.map((u) => [u.id, u]));

  // Trạm nào đang có ai đó bật trực - hiển thị ở cột "Đang trực" của bảng danh sách.
  const onDutyUserIds = new Set(
    (
      await db
        .select()
        .from(telehealthPeers)
        .where(and(eq(telehealthPeers.roomId, LOBBY_ROOM), gt(telehealthPeers.lastSeen, now - PEER_TTL_MS)))
    )
      .map((p) => p.userId || "")
      .filter(Boolean)
  );

  const grouped = new Map<string, any[]>();
  for (const link of links) {
    const user = userById.get(link.userId);
    const entry = grouped.get(link.stationCode) || [];
    entry.push({
      id: link.id,
      userId: link.userId,
      name: user?.name || "(tài khoản đã bị xoá)",
      username: user?.username || "",
      role: user?.role || "",
      accountStatus: String(user?.status || "UNKNOWN").toUpperCase(),
      canReceiveVideo: String(user?.canReceiveVideo || "true") !== "false",
      priority: Number(link.priority || 1),
      personalZoomUrl: link.personalZoomUrl || "",
      personalMeetingId: link.personalMeetingId || "",
      personalMeetingIdPretty: formatMeetingId(link.personalMeetingId || ""),
      notifyChannels: String(link.notifyChannels || "POPUP,SOUND,PUSH").split(",").filter(Boolean),
      isActive: String(link.isActive || "true") === "true",
      onDuty: onDutyUserIds.has(link.userId)
    });
    grouped.set(link.stationCode, entry);
  }

  const stations = rows.map((row) => {
    const receivers = (grouped.get(row.stationCode) || []).sort(
      (a, b) => a.priority - b.priority || a.name.localeCompare(b.name, "vi")
    );
    const issues: string[] = [];
    if (!row.zoomJoinUrl) issues.push("Chưa gán phòng Zoom");
    if (!receivers.some((r) => r.priority === 1 && r.isActive)) issues.push("Chưa có tài khoản trực chính");
    return {
      ...adminStation(row),
      dutyCount: duty.get(row.stationCode) || 0,
      onDutyHours: isWithinDutyHours(row, now),
      receivers,
      issues,
      ready: issues.length === 0
    };
  });

  // Danh sách tài khoản đủ điều kiện gán - giao diện không phải gọi thêm API khác.
  const eligible = accounts
    .filter((u) => String(u.status || "ACTIVE").toUpperCase() === "ACTIVE" && String(u.canReceiveVideo || "true") !== "false")
    .map((u) => ({ id: u.id, name: u.name, username: u.username, role: u.role, stationCode: u.stationCode || "" }))
    .sort((a, b) => a.name.localeCompare(b.name, "vi"));

  return json({ success: true, stations, eligibleAccounts: eligible, ts: now });
}

async function handleAudit(code: string) {
  const rows = await db
    .select()
    .from(stationRoomAudits)
    .where(eq(stationRoomAudits.stationCode, code))
    .orderBy(desc(stationRoomAudits.ts))
    .limit(100);
  return json({ success: true, entries: rows });
}

// ---------------------------------------------------------------------------
//  Kiểm tra liên kết Zoom
// ---------------------------------------------------------------------------

/**
 * Phân tích liên kết và đối chiếu với các trạm khác.
 *
 * Cố ý KHÔNG gọi ra máy chủ Zoom: phòng cố định không có API kiểm tra công khai,
 * và một lần gọi mạng hỏng sẽ chặn Quản trị lưu cấu hình đúng. Việc kiểm tra ở
 * đây là phân tích cú pháp cộng đối chiếu nội bộ, chạy tức thì và tin cậy được.
 */
async function handleCheckZoom(body: Record<string, any>) {
  const parsed = parseZoomLink(text(body.zoomJoinUrl));
  if (!parsed.ok) return json({ success: false, error: parsed.error });

  const typed = normalizeMeetingId(text(body.zoomMeetingId));
  const warnings: string[] = [];
  if (typed && parsed.meetingId && typed !== parsed.meetingId) {
    warnings.push(
      `Mã phòng trong liên kết (${formatMeetingId(parsed.meetingId)}) khác ô Mã phòng đang nhập (${formatMeetingId(typed)}).`
    );
  }

  const code = text(body.stationCode);
  const meetingId = typed || parsed.meetingId || "";
  if (meetingId) {
    const clash = await db
      .select()
      .from(stationRooms)
      .where(and(eq(stationRooms.zoomMeetingId, meetingId), code ? ne(stationRooms.stationCode, code) : undefined));
    if (clash.length) {
      warnings.push(`Phòng này đang được dùng cho: ${clash.map((c) => c.stationName).join(", ")}.`);
    }
  }

  return json({
    success: true,
    meetingId,
    meetingIdPretty: formatMeetingId(meetingId),
    passcodeDetected: Boolean(parsed.passcode),
    normalizedUrl: parsed.normalizedUrl,
    warnings
  });
}

// ---------------------------------------------------------------------------
//  Tạo / sửa điểm trạm
// ---------------------------------------------------------------------------

/** Mã trạm là khoá nghiệp vụ, đã nhúng trong mã phòng và nhật ký nên không đổi được. */
function validateStationCode(code: string): string | null {
  if (!code) return "Mã điểm trạm là bắt buộc.";
  if (!/^[A-Z0-9-]{4,40}$/.test(code)) {
    return "Mã điểm trạm chỉ gồm chữ in hoa, chữ số và dấu gạch ngang, dài 4-40 ký tự.";
  }
  return null;
}

/** Gom các trường Zoom từ body và trả về bản vá đã chuẩn hoá, hoặc lỗi. */
function zoomPatch(body: Record<string, any>): { patch: Record<string, unknown> } | { error: string } {
  const patch: Record<string, unknown> = {};

  if (body.zoomJoinUrl !== undefined) {
    const raw = text(body.zoomJoinUrl);
    if (!raw) {
      // Gỡ phòng Zoom khỏi trạm: chấp nhận, nhưng trạm sẽ không bật ACTIVE được.
      patch.zoomJoinUrl = null;
      patch.zoomMeetingId = null;
    } else {
      const parsed = parseZoomLink(raw);
      if (!parsed.ok) return { error: parsed.error || "Liên kết phòng Zoom không hợp lệ." };
      patch.zoomJoinUrl = parsed.normalizedUrl;
      const typed = normalizeMeetingId(text(body.zoomMeetingId));
      patch.zoomMeetingId = typed || parsed.meetingId || null;
    }
  } else if (body.zoomMeetingId !== undefined) {
    const typed = normalizeMeetingId(text(body.zoomMeetingId));
    if (typed && (typed.length < 9 || typed.length > 12)) {
      return { error: "Mã phòng Zoom phải gồm 9-12 chữ số." };
    }
    patch.zoomMeetingId = typed || null;
  }

  if (body.zoomPasscode !== undefined) {
    const pass = text(body.zoomPasscode);
    patch.zoomPasscode = pass || null;
  }
  if (body.zoomHostEmail !== undefined) {
    const mail = text(body.zoomHostEmail);
    if (mail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)) return { error: "Email tài khoản Zoom chủ phòng không hợp lệ." };
    patch.zoomHostEmail = mail || null;
  }
  return { patch };
}

async function handleCreate(body: Record<string, any>, ctx: AuthContext, now: number) {
  const code = text(body.stationCode).toUpperCase();
  const codeError = validateStationCode(code);
  if (codeError) return json({ success: false, error: codeError }, 400);

  const name = text(body.stationName);
  if (!name) return json({ success: false, error: "Tên hiển thị của điểm trạm là bắt buộc." }, 400);
  if (name.length > 80) return json({ success: false, error: "Tên hiển thị tối đa 80 ký tự." }, 400);

  if (await getStation(code)) {
    return json({ success: false, error: `Mã điểm trạm "${code}" đã tồn tại.` }, 409);
  }

  const zoom = zoomPatch(body);
  if ("error" in zoom) return json({ success: false, error: zoom.error }, 400);

  await db.insert(stationRooms).values({
    stationCode: code,
    stationName: name,
    note: text(body.note) || null,
    fallbackStationCode: text(body.fallbackStationCode) || null,
    ringTimeoutSec: clampTimeout(body.ringTimeoutSec),
    dutyHours: text(body.dutyHours) || '{"always":true}',
    offHoursMode: text(body.offHoursMode).toUpperCase() === "HIDE" ? "HIDE" : "SHOW",
    // Trạm mới luôn bắt đầu ở PAUSED: chưa có người nhận thì chưa được nhận cuộc gọi.
    status: "PAUSED",
    displayOrder: Number(body.displayOrder) || 99,
    updatedBy: ctx.user.name,
    updatedAt: now,
    ...zoom.patch
  } as never);

  await writeAudit([{ stationCode: code, actorName: ctx.user.name, actorUsername: ctx.user.username, action: "CREATE" }], now);
  return json({ success: true, message: `Đã tạo điểm trạm ${name}. Hãy gán phòng Zoom và tài khoản nhận cuộc gọi trước khi bật hoạt động.` });
}

function clampTimeout(raw: unknown): number {
  const value = Number(raw);
  if (!Number.isFinite(value)) return 45;
  return Math.min(RING_TIMEOUT_MAX, Math.max(RING_TIMEOUT_MIN, Math.round(value)));
}

async function handleUpdate(body: Record<string, any>, ctx: AuthContext, now: number) {
  const code = text(body.stationCode).toUpperCase();
  const current = await getStation(code);
  if (!current) return json({ success: false, error: "Không tìm thấy điểm trạm." }, 404);

  const patch: Record<string, unknown> = {};

  if (body.stationName !== undefined) {
    const name = text(body.stationName);
    if (!name) return json({ success: false, error: "Tên hiển thị của điểm trạm là bắt buộc." }, 400);
    if (name.length > 80) return json({ success: false, error: "Tên hiển thị tối đa 80 ký tự." }, 400);
    patch.stationName = name;
  }
  if (body.note !== undefined) patch.note = text(body.note) || null;
  if (body.displayOrder !== undefined) patch.displayOrder = Number(body.displayOrder) || 0;
  if (body.ringTimeoutSec !== undefined) patch.ringTimeoutSec = clampTimeout(body.ringTimeoutSec);
  if (body.dutyHours !== undefined) {
    const duty = text(body.dutyHours);
    try {
      if (duty) JSON.parse(duty);
    } catch {
      return json({ success: false, error: "Khung giờ trực không đúng định dạng." }, 400);
    }
    patch.dutyHours = duty || '{"always":true}';
  }
  if (body.offHoursMode !== undefined) {
    patch.offHoursMode = text(body.offHoursMode).toUpperCase() === "HIDE" ? "HIDE" : "SHOW";
  }
  if (body.fallbackStationCode !== undefined) {
    const fallback = text(body.fallbackStationCode).toUpperCase();
    if (fallback === code) {
      return json({ success: false, error: "Trạm dự phòng không được trỏ về chính điểm trạm này." }, 400);
    }
    if (fallback && !(await getStation(fallback))) {
      return json({ success: false, error: "Trạm dự phòng không tồn tại." }, 400);
    }
    patch.fallbackStationCode = fallback || null;
  }

  const zoom = zoomPatch(body);
  if ("error" in zoom) return json({ success: false, error: zoom.error }, 400);
  Object.assign(patch, zoom.patch);

  // Trùng phòng giữa hai trạm chỉ được lưu khi Quản trị xác nhận rõ ràng.
  const nextMeetingId = patch.zoomMeetingId !== undefined ? String(patch.zoomMeetingId || "") : current.zoomMeetingId || "";
  if (nextMeetingId && body.allowSharedRoom !== true) {
    const clash = await db
      .select()
      .from(stationRooms)
      .where(and(eq(stationRooms.zoomMeetingId, nextMeetingId), ne(stationRooms.stationCode, code)));
    if (clash.length) {
      return json({
        success: false,
        code: "ROOM_SHARED",
        error: `Phòng Zoom ${formatMeetingId(nextMeetingId)} đang dùng cho ${clash
          .map((c) => c.stationName)
          .join(", ")}. Tích ô xác nhận nếu vẫn muốn hai điểm trạm dùng chung phòng.`
      }, 409);
    }
  }

  if (!Object.keys(patch).length) return json({ success: true, message: "Không có thay đổi nào." });

  patch.updatedBy = ctx.user.name;
  patch.updatedAt = now;
  await db.update(stationRooms).set(patch).where(eq(stationRooms.stationCode, code));

  const audits = Object.keys(patch)
    .filter((field) => field !== "updatedBy" && field !== "updatedAt")
    .map((field) => ({
      stationCode: code,
      actorName: ctx.user.name,
      actorUsername: ctx.user.username,
      action: "UPDATE",
      field,
      oldValue: (current as Record<string, unknown>)[field],
      newValue: patch[field]
    }));
  await writeAudit(audits, now);

  return json({ success: true, message: "Đã lưu cấu hình điểm trạm." });
}

/**
 * Bật / tạm ngưng / vô hiệu hoá một điểm trạm.
 *
 * Bật ACTIVE là cam kết với người dân rằng gọi vào đây sẽ có người nghe, nên
 * điều kiện đủ được kiểm tra ở MÁY CHỦ chứ không chỉ ở giao diện.
 */
async function handleSetStatus(body: Record<string, any>, ctx: AuthContext, now: number) {
  const code = text(body.stationCode).toUpperCase();
  const current = await getStation(code);
  if (!current) return json({ success: false, error: "Không tìm thấy điểm trạm." }, 404);

  const status = text(body.status).toUpperCase();
  if (!VALID_STATUS.has(status)) return json({ success: false, error: "Trạng thái không hợp lệ." }, 400);

  if (status === "ACTIVE") {
    const missing: string[] = [];
    if (!current.zoomJoinUrl) missing.push("liên kết phòng Zoom");
    const receivers = await db.select().from(stationReceivers).where(eq(stationReceivers.stationCode, code));
    if (!receivers.some((r) => Number(r.priority || 1) === 1 && String(r.isActive || "true") === "true")) {
      missing.push("tài khoản nhận cuộc gọi mức ưu tiên 1");
    }
    if (missing.length) {
      return json({
        success: false,
        code: "INCOMPLETE_CONFIG",
        error: `Chưa bật hoạt động được: còn thiếu ${missing.join(" và ")}.`
      }, 400);
    }
  }

  await db.update(stationRooms).set({ status, updatedBy: ctx.user.name, updatedAt: now }).where(eq(stationRooms.stationCode, code));
  await writeAudit(
    [{ stationCode: code, actorName: ctx.user.name, actorUsername: ctx.user.username, action: "STATUS", field: "status", oldValue: current.status, newValue: status }],
    now
  );
  return json({ success: true, message: `Điểm trạm ${current.stationName} chuyển sang trạng thái ${status}.` });
}

async function handleDelete(body: Record<string, any>, ctx: AuthContext, now: number) {
  const code = text(body.stationCode).toUpperCase();
  const current = await getStation(code);
  if (!current) return json({ success: false, error: "Không tìm thấy điểm trạm." }, 404);

  const referencing = await db.select().from(stationRooms).where(eq(stationRooms.fallbackStationCode, code));
  if (referencing.length) {
    return json({
      success: false,
      error: `Không xoá được: đang là trạm dự phòng của ${referencing.map((r) => r.stationName).join(", ")}.`
    }, 400);
  }

  await db.delete(stationReceivers).where(eq(stationReceivers.stationCode, code));
  await db.delete(stationRooms).where(eq(stationRooms.stationCode, code));
  await writeAudit([{ stationCode: code, actorName: ctx.user.name, actorUsername: ctx.user.username, action: "DELETE" }], now);
  return json({ success: true, message: `Đã xoá điểm trạm ${current.stationName}.` });
}

// ---------------------------------------------------------------------------
//  Tài khoản nhận cuộc gọi
// ---------------------------------------------------------------------------

function parseChannels(raw: unknown): string {
  const allowed = new Set(["POPUP", "SOUND", "PUSH", "ZALO"]);
  const list = Array.isArray(raw) ? raw : String(raw || "").split(",");
  const picked = list.map((c) => String(c).trim().toUpperCase()).filter((c) => allowed.has(c));
  // Popup là kênh tối thiểu: bỏ hết thì cán bộ không thấy cuộc gọi ở đâu cả.
  if (!picked.includes("POPUP")) picked.unshift("POPUP");
  return Array.from(new Set(picked)).join(",");
}

async function handleAddReceiver(body: Record<string, any>, ctx: AuthContext, now: number) {
  const code = text(body.stationCode).toUpperCase();
  const station = await getStation(code);
  if (!station) return json({ success: false, error: "Không tìm thấy điểm trạm." }, 404);

  const userId = text(body.userId);
  const found = await db.select().from(users).where(eq(users.id, userId));
  const account = found[0];
  if (!account) return json({ success: false, error: "Không tìm thấy tài khoản." }, 404);
  if (String(account.status || "ACTIVE").toUpperCase() !== "ACTIVE") {
    return json({ success: false, error: "Tài khoản đang bị khoá, không gán làm người nhận cuộc gọi được." }, 400);
  }
  if (String(account.canReceiveVideo || "true") === "false") {
    return json({
      success: false,
      error: 'Tài khoản chưa có "Quyền nhận cuộc gọi Video". Hãy cấp quyền tại mục Phân quyền Hệ thống trước.'
    }, 400);
  }

  const existing = await db
    .select()
    .from(stationReceivers)
    .where(and(eq(stationReceivers.stationCode, code), eq(stationReceivers.userId, userId)));
  if (existing.length) return json({ success: false, error: "Tài khoản này đã được gán vào điểm trạm." }, 409);

  const personalUrl = text(body.personalZoomUrl);
  let personalMeetingId: string | null = null;
  let normalizedPersonal: string | null = null;
  if (personalUrl) {
    const parsed = parseZoomLink(personalUrl);
    if (!parsed.ok) return json({ success: false, error: `Phòng Zoom riêng: ${parsed.error}` }, 400);
    normalizedPersonal = parsed.normalizedUrl || null;
    personalMeetingId = parsed.meetingId || null;
  }

  await db.insert(stationReceivers).values({
    id: `SR-${now}-${Math.floor(Math.random() * 10000)}`,
    stationCode: code,
    userId,
    personalZoomUrl: normalizedPersonal,
    personalMeetingId,
    priority: Math.min(9, Math.max(1, Number(body.priority) || 1)),
    notifyChannels: parseChannels(body.notifyChannels),
    isActive: "true",
    createdAt: now,
    updatedAt: now
  });

  await writeAudit(
    [{ stationCode: code, actorName: ctx.user.name, actorUsername: ctx.user.username, action: "ADD_RECEIVER", field: "receiver", newValue: account.name }],
    now
  );
  return json({ success: true, message: `Đã gán ${account.name} vào ${station.stationName}.` });
}

async function handleUpdateReceiver(body: Record<string, any>, ctx: AuthContext, now: number) {
  const id = text(body.id);
  const found = await db.select().from(stationReceivers).where(eq(stationReceivers.id, id));
  const link = found[0];
  if (!link) return json({ success: false, error: "Không tìm thấy phân công này." }, 404);

  const patch: Record<string, unknown> = { updatedAt: now };
  if (body.priority !== undefined) patch.priority = Math.min(9, Math.max(1, Number(body.priority) || 1));
  if (body.isActive !== undefined) patch.isActive = body.isActive === true || body.isActive === "true" ? "true" : "false";
  if (body.notifyChannels !== undefined) patch.notifyChannels = parseChannels(body.notifyChannels);
  if (body.personalZoomUrl !== undefined) {
    const raw = text(body.personalZoomUrl);
    if (!raw) {
      patch.personalZoomUrl = null;
      patch.personalMeetingId = null;
    } else {
      const parsed = parseZoomLink(raw);
      if (!parsed.ok) return json({ success: false, error: `Phòng Zoom riêng: ${parsed.error}` }, 400);
      patch.personalZoomUrl = parsed.normalizedUrl;
      patch.personalMeetingId = parsed.meetingId || null;
    }
  }

  // Gỡ người trực chính cuối cùng của một trạm đang hoạt động là tự tay làm mất
  // đường đổ chuông - chặn ở đây thay vì để cuộc gọi rơi vào khoảng trống.
  if (patch.isActive === "false" || (patch.priority !== undefined && Number(patch.priority) !== 1)) {
    const guard = await ensurePrimaryRemains(link.stationCode, link.id);
    if (guard) return json({ success: false, error: guard }, 400);
  }

  await db.update(stationReceivers).set(patch).where(eq(stationReceivers.id, id));
  await writeAudit(
    [{ stationCode: link.stationCode, actorName: ctx.user.name, actorUsername: ctx.user.username, action: "UPDATE_RECEIVER", field: "receiver" }],
    now
  );
  return json({ success: true, message: "Đã cập nhật phân công nhận cuộc gọi." });
}

/** Trả về thông điệp lỗi nếu bỏ bản ghi này thì trạm ACTIVE hết người trực chính. */
async function ensurePrimaryRemains(stationCode: string, excludeId: string): Promise<string | null> {
  const station = await getStation(stationCode);
  if (!station || String(station.status || "ACTIVE").toUpperCase() !== "ACTIVE") return null;

  const rest = await db.select().from(stationReceivers).where(eq(stationReceivers.stationCode, stationCode));
  const stillPrimary = rest.some(
    (r) => r.id !== excludeId && Number(r.priority || 1) === 1 && String(r.isActive || "true") === "true"
  );
  if (stillPrimary) return null;
  return `${station.stationName} đang hoạt động và đây là tài khoản trực chính cuối cùng. Hãy chuyển điểm trạm sang "Tạm ngưng" hoặc gán người trực chính khác trước.`;
}

async function handleRemoveReceiver(body: Record<string, any>, ctx: AuthContext, now: number) {
  const id = text(body.id);
  const found = await db.select().from(stationReceivers).where(eq(stationReceivers.id, id));
  const link = found[0];
  if (!link) return json({ success: false, error: "Không tìm thấy phân công này." }, 404);

  const guard = await ensurePrimaryRemains(link.stationCode, link.id);
  if (guard) return json({ success: false, error: guard }, 400);

  await db.delete(stationReceivers).where(eq(stationReceivers.id, id));
  await writeAudit(
    [{ stationCode: link.stationCode, actorName: ctx.user.name, actorUsername: ctx.user.username, action: "REMOVE_RECEIVER", field: "receiver" }],
    now
  );
  return json({ success: true, message: "Đã gỡ tài khoản khỏi điểm trạm." });
}

/** Danh sách thiết bị đã đăng ký nhận thông báo đẩy - phục vụ FR-ADM-14. */
async function handleListDevices(body: Record<string, any>) {
  const userId = text(body.userId);
  const rows = await db.select().from(pushSubscriptions).where(eq(pushSubscriptions.userId, userId));
  return json({
    success: true,
    devices: rows.map((r) => ({
      id: r.id,
      stationCode: r.stationCode || "",
      userAgent: r.userAgent || "",
      createdAt: r.createdAt,
      lastUsedAt: r.lastUsedAt
    }))
  });
}

async function handleRevokeDevice(body: Record<string, any>) {
  const id = text(body.id);
  await db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, id));
  return json({ success: true, message: "Đã thu hồi thiết bị nhận thông báo." });
}

export default async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers, status: 204 });

  const now = Date.now();
  const url = new URL(req.url);

  try {
    if (req.method === "GET") {
      // Danh mục công khai: không đòi đăng nhập, nhưng cũng không lộ gì về Zoom.
      if (url.searchParams.get("admin") !== "1" && !url.searchParams.get("audit")) {
        return await handlePublicList(now);
      }
      await requireScope(req, "admin");
      const auditCode = text(url.searchParams.get("audit"));
      if (auditCode) return await handleAudit(auditCode.toUpperCase());
      return await handleAdminList(now);
    }

    if (req.method !== "POST") return json({ success: false, error: "Method not allowed" }, 405);

    const ctx = await requireScope(req, "admin");
    const body = (await req.json().catch(() => null)) as Record<string, any> | null;
    if (!body) return json({ success: false, error: "Body không hợp lệ" }, 400);

    switch (text(body.action)) {
      case "create":
        return await handleCreate(body, ctx, now);
      case "update":
        return await handleUpdate(body, ctx, now);
      case "set_status":
        return await handleSetStatus(body, ctx, now);
      case "delete":
        return await handleDelete(body, ctx, now);
      case "check_zoom":
        return await handleCheckZoom(body);
      case "add_receiver":
        return await handleAddReceiver(body, ctx, now);
      case "update_receiver":
        return await handleUpdateReceiver(body, ctx, now);
      case "remove_receiver":
        return await handleRemoveReceiver(body, ctx, now);
      case "list_devices":
        return await handleListDevices(body);
      case "revoke_device":
        return await handleRevokeDevice(body);
      default:
        return json({ success: false, error: "Hành động không hợp lệ." }, 400);
    }
  } catch (err: any) {
    const authResponse = authErrorResponse(err, headers);
    if (authResponse) return authResponse;
    console.error("station-rooms error", err);
    return json({ success: false, error: "Không thực hiện được thao tác với điểm trạm." }, 500);
  }
};

export const config = {
  path: "/api/station-rooms"
};
