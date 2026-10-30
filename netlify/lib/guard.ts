/**
 * Lớp bảo vệ dùng chung cho các API công khai (Module 0 - vá bảo mật khẩn).
 *
 * Gom ở một nơi những việc mà trước đây từng tuyến tự làm (hoặc bỏ sót):
 *   - Đọc phiếu phiên KHÔNG bắt buộc: tuyến công khai vẫn phục vụ người dân,
 *     nhưng biết được người gọi là cán bộ nào để mở thêm dữ liệu nội bộ.
 *   - Quy tắc quyền theo vai trò cho CMS (biên tập nội dung, xử lý đăng ký khám,
 *     quản lý người ký đơn).
 *   - Vô hiệu hoá mã HTML trong trường văn bản thuần và lọc đường dẫn nguy hiểm
 *     (javascript:, data: không phải ảnh...) ngay lúc ghi, để dữ liệu do người
 *     lạ gửi lên không bao giờ thành mã chạy trên máy cán bộ hay người dân khác.
 *   - Giới hạn tần suất theo IP dùng chung bảng auth_rate_limits.
 *   - Che số CCCD/BHYT, số điện thoại trước khi gửi văn bản ra dịch vụ AI ngoài.
 */
import { db } from "../../db/index.js";
import { telehealthRooms, users } from "../../db/schema.js";
import { eq } from "drizzle-orm";
import { isActive, isAdminRole, readBearerToken, scopesFor, verifyToken, type AuthContext } from "./auth.js";
import { rateLimit } from "./sessions.js";
import { stationFromRoomId, stationMapCached } from "./stations.js";

// ---------------------------------------------------------------------------
//  Danh tính người gọi
// ---------------------------------------------------------------------------

/** Tài khoản đang đăng nhập (phiếu hợp lệ, tài khoản còn hoạt động) hoặc null. */
export async function optionalAuth(req: Request): Promise<AuthContext | null> {
  const claims = await verifyToken(readBearerToken(req));
  if (!claims) return null;
  const found = await db.select().from(users).where(eq(users.id, claims.sub));
  const user = found[0];
  if (!user || !isActive(user)) return null;
  return { user, claims };
}

export function clientIp(req: Request): string {
  return (
    req.headers.get("x-nf-client-connection-ip") ||
    (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() ||
    "unknown"
  );
}

/** Đếm một lượt; trả về số giây phải chờ nếu đã vượt ngưỡng, ngược lại 0. */
export async function throttle(key: string, limit: number, windowMs: number): Promise<number> {
  const r = await rateLimit(key, limit, windowMs);
  return r.allowed ? 0 : Math.max(1, r.retryAfterSec);
}

// ---------------------------------------------------------------------------
//  Quyền theo vai trò
// ---------------------------------------------------------------------------

export function isEditorRole(role: string | null | undefined): boolean {
  return /biên tập|bien tap|editor|truyền thông|truyen thong/i.test(String(role || ""));
}

/** Đăng, sửa, xoá nội dung cổng thông tin (tin, tài liệu, dịch vụ, video...). */
export function canEditContent(ctx: AuthContext | null): boolean {
  return Boolean(ctx && (isAdminRole(ctx.user.role) || isEditorRole(ctx.user.role)));
}

/** Xem và xử lý đăng ký khám (dữ liệu cá nhân + sức khoẻ của người dân). */
export function canHandleAppointments(ctx: AuthContext | null): boolean {
  if (!ctx) return false;
  const s = scopesFor(ctx.user);
  return s.includes("admin") || s.includes("station") || s.includes("doctor");
}

/** Thấy đăng ký khám của mọi điểm trạm (không bị giới hạn theo trạm). */
export function servesAllStations(ctx: AuthContext | null): boolean {
  if (!ctx) return false;
  const s = scopesFor(ctx.user);
  return s.includes("admin") || s.includes("doctor");
}

/** Quản lý người ký đơn thuốc và chữ ký số. */
export function canManageSigners(ctx: AuthContext | null): boolean {
  if (!ctx) return false;
  const s = scopesFor(ctx.user);
  return s.includes("admin") || s.includes("doctor");
}

export function boundStationOf(ctx: AuthContext | null): string {
  return String(ctx?.user.stationCode || "").trim().toUpperCase();
}

/**
 * Cán bộ có được đọc/ghi hồ sơ (sinh hiệu, phiếu khám) của một phòng khám hay
 * không. Bác sĩ tuyến trên và Quản trị phục vụ mọi trạm. Cán bộ điểm trạm chỉ
 * được phòng của trạm mình, phòng đang đổ chuông tới trạm mình (trạm dự phòng),
 * hoặc phòng mà chính mình đã tiếp nhận. Phòng không gắn được với trạm nào (mã
 * phòng kiểu cũ) vẫn mở để không chặn nhầm luồng khám đang chạy.
 */
export async function canAccessRoom(ctx: AuthContext, roomId: string): Promise<boolean> {
  if (servesAllStations(ctx)) return true;
  const bound = boundStationOf(ctx);
  const [room] = await db.select().from(telehealthRooms).where(eq(telehealthRooms.id, roomId));
  if (room && room.acceptedBy && room.acceptedBy === ctx.user.id) return true;
  const stations = await stationMapCached(Date.now());
  const roomStation = String(room?.stationCode || stationFromRoomId(roomId, stations.keys()) || "").toUpperCase();
  if (!roomStation) return true;
  if (!bound) return false;
  return roomStation === bound || String(room?.ringingStation || "").toUpperCase() === bound;
}

export const roomForbidden = (headers: Record<string, string>) =>
  new Response(
    JSON.stringify({ success: false, code: "STATION_MISMATCH", error: "Phòng khám này không thuộc điểm trạm của tài khoản." }),
    { headers, status: 403 }
  );

// ---------------------------------------------------------------------------
//  Làm sạch dữ liệu đầu vào
// ---------------------------------------------------------------------------

/**
 * Văn bản thuần: bỏ ký tự điều khiển, thay < > " ' bằng ký tự trông tương tự
 * nhưng không có nghĩa trong HTML. Giao diện hiện dựng nhiều đoạn HTML bằng
 * chuỗi ghép, nên đây là chốt chặn đặt ở máy chủ cho mọi bản ghi mới.
 */
export function plainText(value: unknown, max = 2000): string {
  if (value === null || value === undefined) return "";
  return String(value)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/</g, "‹")
    .replace(/>/g, "›")
    .replace(/"/g, "”")
    .replace(/'/g, "’")
    .replace(/`/g, "’")
    .slice(0, max);
}

const SAFE_IMAGE_DATA = /^data:image\/(png|jpe?g|gif|webp|avif|bmp|heic|heif);base64,[A-Za-z0-9+/=\s]+$/i;

/**
 * Đường dẫn an toàn để đặt vào href/src: http(s), đường dẫn tương đối trong
 * site, "#", hoặc (khi cho phép) ảnh nhúng base64. Còn lại trả về chuỗi rỗng.
 */
export function safeUrl(value: unknown, opts: { allowImageData?: boolean; max?: number } = {}): string {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  if (opts.allowImageData && SAFE_IMAGE_DATA.test(raw)) return raw.replace(/\s/g, "");
  const max = opts.max ?? 2000;
  if (raw.length > max) return "";
  const ok = raw === "#" || /^https?:\/\//i.test(raw) || (raw.startsWith("/") && !raw.startsWith("//"));
  if (!ok) return "";
  return raw.replace(/["'<>`\s]/g, (c) => encodeURIComponent(c));
}

/** Mã định danh bản ghi: chữ, số, gạch nối, gạch dưới, chấm. */
export function safeId(value: unknown, max = 120): string {
  const id = String(value ?? "").trim();
  return /^[A-Za-z0-9_.\-]+$/.test(id) && id.length <= max ? id : "";
}

// ---------------------------------------------------------------------------
//  Dữ liệu gửi tới AI bên ngoài
// ---------------------------------------------------------------------------

/**
 * Che số định danh trước khi văn bản rời hệ thống: số CCCD/CMND (9 hoặc 12 chữ
 * số), mã thẻ BHYT (2 chữ cái + 13 chữ số), số điện thoại Việt Nam, email.
 * AI vẫn hiểu được câu hỏi; chỉ con số nhận diện được người dân bị thay nhãn.
 */
export function redactPersonalData(text: string): string {
  return String(text || "")
    .replace(/\b[A-Z]{2}\s?\d{1,2}\s?\d{2}\s?\d{10}\b/gi, "[mã BHYT đã ẩn]")
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[email đã ẩn]")
    .replace(/(?<!\d)(?:\+?84|0)(?:[\s.-]?\d){9,10}(?!\d)/g, "[số điện thoại đã ẩn]")
    .replace(/(?<!\d)\d{12}(?!\d)/g, "[số CCCD đã ẩn]")
    .replace(/(?<!\d)\d{9}(?!\d)/g, "[số CMND đã ẩn]");
}
