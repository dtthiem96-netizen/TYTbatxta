import { db } from "../../db/index.js";
import { telehealthPeers, telehealthRooms, telehealthSignals, appointments } from "../../db/schema.js";
import { and, eq, gt, isNull, lt, or, sql } from "drizzle-orm";

/**
 * Signaling WebRTC không dùng WebSocket (Netlify không giữ kết nối socket lâu dài).
 * Mỗi thành viên trong phòng khám gửi/nhận bản tin signaling qua HTTP:
 *   - POST /api/signal  { action: 'join' | 'signal' | 'leave' | 'vitals' | 'notes' | 'complete', ... }
 *   - GET  /api/signal?roomId=...&peerId=...&cursor=...   (long-poll ngắn, trả về bản tin mới)
 *   - GET  /api/signal?action=rooms                       (danh sách phòng đang chờ bác sĩ)
 */

const PEER_TTL_MS = 45_000;
const SIGNAL_TTL_MS = 180_000;
// Giữ dưới ngưỡng timeout 10s của Netlify Functions.
const POLL_WINDOW_MS = 7_000;
const POLL_INTERVAL_MS = 700;

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
  await db.delete(telehealthPeers).where(lt(telehealthPeers.lastSeen, now - PEER_TTL_MS));
  await db.delete(telehealthSignals).where(lt(telehealthSignals.ts, now - SIGNAL_TTL_MS));
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

async function handleGet(url: URL) {
  const now = Date.now();

  if (url.searchParams.get("action") === "rooms") {
    await pruneStale(now);
    const peers = await db
      .select()
      .from(telehealthPeers)
      .where(gt(telehealthPeers.lastSeen, now - PEER_TTL_MS));

    const grouped = new Map<string, { roomId: string; peers: typeof peers }>();
    for (const peer of peers) {
      const entry = grouped.get(peer.roomId) || { roomId: peer.roomId, peers: [] as typeof peers };
      entry.peers.push(peer);
      grouped.set(peer.roomId, entry);
    }

    const rooms = [];
    for (const entry of grouped.values()) {
      const room = await getRoom(entry.roomId);
      rooms.push({
        roomId: entry.roomId,
        patientName: room?.patientName || null,
        symptoms: room?.symptoms || null,
        status: room?.status || "WAITING",
        vitals: room?.vitals ? JSON.parse(room.vitals) : null,
        hasDoctor: entry.peers.some((p) => p.role === "doctor"),
        waiting: entry.peers
          .filter((p) => p.role !== "doctor")
          .map((p) => ({ name: p.name, role: p.role, since: Number(p.lastSeen) }))
      });
    }

    return json({ ok: true, rooms });
  }

  const roomId = url.searchParams.get("roomId");
  const peerId = url.searchParams.get("peerId");
  if (!roomId || !peerId) {
    return json({ error: "Thiếu roomId hoặc peerId" }, 400);
  }
  const cursor = Number(url.searchParams.get("cursor") || 0);

  await db
    .update(telehealthPeers)
    .set({ lastSeen: now })
    .where(eq(telehealthPeers.id, peerId));

  // Long-poll ngắn: chờ tối đa POLL_WINDOW_MS để trả bản tin ngay khi có,
  // giúp bắt tay WebRTC nhanh gần bằng WebSocket mà vẫn chạy trên serverless.
  const deadline = now + POLL_WINDOW_MS;
  let messages = await fetchMessages(roomId, peerId, cursor);
  while (messages.length === 0 && Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    messages = await fetchMessages(roomId, peerId, cursor);
  }

  const pollNow = Date.now();
  const peers = await activePeers(roomId, pollNow);
  const room = await getRoom(roomId);
  const nextCursor = messages.length ? messages[messages.length - 1].seq : cursor;

  return json({
    ok: true,
    cursor: nextCursor,
    messages,
    room: room
      ? {
          status: room.status,
          patientName: room.patientName,
          vitals: room.vitals ? JSON.parse(room.vitals) : null,
          notes: room.notes || ""
        }
      : null,
    peers: peers.map((p) => ({ peerId: p.id, role: p.role, name: p.name }))
  });
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
    const role = (body as any).role === "doctor" ? "doctor" : "station";
    const name = String((body as any).name || "Thành viên");

    const existing = await activePeers(roomId, now);
    const others = existing.filter((p) => p.id !== peerId);

    await db
      .insert(telehealthPeers)
      .values({ id: peerId, roomId, role, name, lastSeen: now })
      .onConflictDoUpdate({
        target: telehealthPeers.id,
        set: { roomId, role, name, lastSeen: now }
      });

    const roomPatch: Record<string, unknown> = {
      status: role === "doctor" ? "IN_CALL" : others.length ? "IN_CALL" : "WAITING"
    };
    if ((body as any).patientName) roomPatch.patientName = String((body as any).patientName);
    if ((body as any).symptoms) roomPatch.symptoms = String((body as any).symptoms);
    await touchRoom(roomId, roomPatch, now);

    const cursor = await currentSeq();
    await pushSignal({ roomId, fromPeer: peerId, type: "peer-joined", payload: { role, name }, now });

    const room = await getRoom(roomId);
    return json({
      ok: true,
      cursor,
      // Người vào sau chịu trách nhiệm tạo offer -> luôn chỉ có duy nhất một bên gọi.
      shouldOffer: others.length > 0,
      peers: others.map((p) => ({ peerId: p.id, role: p.role, name: p.name })),
      room: room
        ? {
            status: room.status,
            patientName: room.patientName,
            vitals: room.vitals ? JSON.parse(room.vitals) : null,
            notes: room.notes || ""
          }
        : null
    });
  }

  if (action === "signal") {
    const type = String((body as any).type || "");
    if (!type) return json({ error: "Thiếu type" }, 400);
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
    await touchRoom(roomId, { status: "COMPLETED" }, now);
    await pushSignal({ roomId, fromPeer: peerId, type: "call-ended", payload: { reason: "completed" }, now });
    const apptId = (body as any).appointmentId;
    if (apptId) {
      await db.update(appointments).set({ status: "COMPLETED" }).where(eq(appointments.id, String(apptId)));
    }
    return json({ ok: true });
  }

  if (action === "leave") {
    await db.delete(telehealthPeers).where(eq(telehealthPeers.id, peerId));
    await pushSignal({ roomId, fromPeer: peerId, type: "peer-left", payload: null, now });
    const remaining = await activePeers(roomId, now);
    if (remaining.length === 0) {
      const room = await getRoom(roomId);
      if (room && room.status !== "COMPLETED") {
        await touchRoom(roomId, { status: "ENDED" }, now);
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
