/**
 * Đăng ký / thu hồi thiết bị nhận thông báo đẩy.
 *
 *   GET  /api/notify?action=config     khoá công khai VAPID + tính năng đã bật chưa
 *   POST /api/notify { action: 'subscribe',   endpoint, keys, stationCode, userAgent }
 *   POST /api/notify { action: 'unsubscribe', endpoint }
 *   POST /api/notify { action: 'test' }       tự gửi thử tới chính thiết bị của mình
 *   POST /api/notify { action: 'pending' }    Service Worker hỏi "đang có cuộc gọi nào cho tôi"
 *
 * Tính năng suy giảm êm: chưa cấu hình đôi khoá VAPID thì mọi tuyến vẫn trả lời
 * bình thường với `configured: false`, giao diện hiện đúng trạng thái đó thay vì
 * báo lỗi. Popup và chuông trong trình duyệt không phụ thuộc gì vào tuyến này.
 */
import { db } from "../../db/index.js";
import { pushSubscriptions, stationReceivers, telehealthRooms } from "../../db/schema.js";
import { and, eq, inArray } from "drizzle-orm";
import { authErrorResponse, requireAnyScope, type AuthContext } from "../lib/auth.js";
import { pushToUsers, vapidConfigured, vapidPublicKey } from "../lib/push.js";
import { ringPlan, stationMapCached } from "../lib/stations.js";

const headers = {
  "Content-Type": "application/json",
  "Cache-Control": "no-store",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS"
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { headers, status });
const text = (value: unknown) => String(value === undefined || value === null ? "" : value).trim();

/** Trạng thái coi như còn đang đổ chuông (giống bảng định tuyến trong signal.ts). */
const RINGING_STATES = ["WAITING", "RINGING", "ESCALATED"];

async function handleSubscribe(body: Record<string, any>, ctx: AuthContext, now: number) {
  const endpoint = text(body.endpoint);
  if (!endpoint || !/^https:\/\//.test(endpoint)) {
    return json({ success: false, error: "Địa chỉ đăng ký nhận thông báo không hợp lệ." }, 400);
  }

  const keys = body.keys && typeof body.keys === "object" ? body.keys : null;
  const stationCode = text(body.stationCode).toUpperCase() || ctx.user.stationCode || null;

  /* Cùng một trình duyệt đăng ký lại (đổi tài khoản, cấp lại quyền) sẽ sinh ra
     đúng endpoint cũ. Ghi đè theo endpoint để một thiết bị chỉ có một bản ghi,
     nếu không mỗi lần đăng nhập lại là thêm một bản trùng và nhân đôi thông báo. */
  const existing = await db.select().from(pushSubscriptions).where(eq(pushSubscriptions.endpoint, endpoint));
  const payload = {
    userId: ctx.user.id,
    stationCode,
    endpoint,
    keysJson: keys ? JSON.stringify(keys) : null,
    userAgent: text(body.userAgent).slice(0, 200) || null,
    lastUsedAt: now
  };

  if (existing.length) {
    await db.update(pushSubscriptions).set(payload).where(eq(pushSubscriptions.endpoint, endpoint));
  } else {
    await db.insert(pushSubscriptions).values({
      id: `PS-${now}-${Math.floor(Math.random() * 10000)}`,
      createdAt: now,
      ...payload
    });
  }

  return json({ success: true, configured: vapidConfigured(), message: "Thiết bị này sẽ nhận thông báo cuộc gọi." });
}

async function handleUnsubscribe(body: Record<string, any>, ctx: AuthContext) {
  const endpoint = text(body.endpoint);
  if (!endpoint) return json({ success: false, error: "Thiếu địa chỉ đăng ký." }, 400);
  // Ràng theo cả tài khoản: không ai gỡ được thiết bị của người khác.
  await db
    .delete(pushSubscriptions)
    .where(and(eq(pushSubscriptions.endpoint, endpoint), eq(pushSubscriptions.userId, ctx.user.id)));
  return json({ success: true, message: "Đã tắt thông báo trên thiết bị này." });
}

async function handleTest(ctx: AuthContext, now: number) {
  if (!vapidConfigured()) {
    return json({
      success: false,
      configured: false,
      error: "Chưa cấu hình đôi khoá VAPID nên chưa gửi được thông báo đẩy. Popup và chuông trong trình duyệt vẫn hoạt động."
    });
  }
  const result = await pushToUsers([ctx.user.id], now);
  if (!result.sent) {
    return json({
      success: false,
      error:
        result.skipped === "no-subscription"
          ? "Tài khoản chưa đăng ký thiết bị nào. Hãy bật thông báo trên trình duyệt trước."
          : "Không gửi được thông báo thử tới thiết bị nào."
    });
  }
  return json({ success: true, message: `Đã gửi thông báo thử tới ${result.sent} thiết bị.` });
}

/**
 * Service Worker hỏi lại chi tiết sau khi nhận cú gõ cửa rỗng.
 *
 * Đây chính là mắt xích khiến thông báo đẩy không cần mang nội dung: mọi thông
 * tin hiển thị đều lấy ở đây, sau khi đã kiểm tra danh tính người hỏi. Trả về
 * cuộc gọi ĐANG chờ và ĐANG đổ chuông tới đúng mức ưu tiên của người này.
 */
async function handlePending(ctx: AuthContext, now: number) {
  const links = await db.select().from(stationReceivers).where(eq(stationReceivers.userId, ctx.user.id));
  const active = links.filter((l) => String(l.isActive || "true") === "true");
  if (!active.length) return json({ success: true, calls: [] });

  const codes = Array.from(new Set(active.map((l) => l.stationCode)));
  const priorityByStation = new Map(active.map((l) => [l.stationCode, Number(l.priority || 1)]));

  const [stations, rows] = await Promise.all([
    stationMapCached(now),
    db
      .select()
      .from(telehealthRooms)
      .where(and(inArray(telehealthRooms.stationCode, codes), inArray(telehealthRooms.routingState, RINGING_STATES)))
  ]);

  const calls = rows
    .map((room) => {
      const plan = ringPlan(room.stationCode || "", Number(room.ringingSince || now), stations, now);
      return { room, plan };
    })
    // Cuộc gọi mới lan tới mức ưu tiên nào thì chỉ những người ở mức đó trở lên mới thấy.
    .filter(({ room, plan }) => plan.maxPriority >= (priorityByStation.get(room.stationCode || "") || 99))
    .map(({ room, plan }) => ({
      roomId: room.id,
      // Cố ý không kèm liên kết Zoom: thông báo chỉ để gọi người, vào phòng là bước sau.
      patientName: room.patientName || "Người dân",
      symptoms: room.symptoms || "",
      stationCode: room.stationCode || "",
      stationName: stations.get(room.stationCode || "")?.stationName || "",
      escalated: plan.escalated,
      remainingSec: plan.remainingSec,
      since: Number(room.ringingSince || now)
    }));

  return json({ success: true, calls, ts: now });
}

export default async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers, status: 204 });

  const now = Date.now();

  try {
    if (req.method === "GET") {
      // Khoá công khai là dữ liệu công khai theo thiết kế của Web Push.
      return json({ success: true, configured: vapidConfigured(), publicKey: vapidPublicKey() });
    }

    if (req.method !== "POST") return json({ success: false, error: "Method not allowed" }, 405);

    // Cán bộ điểm trạm và bác sĩ tuyến trên đều có thể nhận cuộc gọi -> nhận thông báo.
    const ctx = await requireAnyScope(req, ["station", "doctor", "admin"]);
    const body = (await req.json().catch(() => null)) as Record<string, any> | null;
    if (!body) return json({ success: false, error: "Body không hợp lệ" }, 400);

    switch (text(body.action)) {
      case "subscribe":
        return await handleSubscribe(body, ctx, now);
      case "unsubscribe":
        return await handleUnsubscribe(body, ctx);
      case "test":
        return await handleTest(ctx, now);
      case "pending":
        return await handlePending(ctx, now);
      default:
        return json({ success: false, error: "Hành động không hợp lệ." }, 400);
    }
  } catch (err: any) {
    const authResponse = authErrorResponse(err, headers);
    if (authResponse) return authResponse;
    console.error("notify error", err);
    return json({ success: false, error: "Không xử lý được yêu cầu thông báo." }, 500);
  }
};

export const config = {
  path: "/api/notify"
};
