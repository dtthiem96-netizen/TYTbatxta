/**
 * Phiên đăng nhập thu hồi được và giới hạn tần suất gọi API.
 *
 * Tách khỏi netlify/lib/attendance.ts và netlify/lib/security.ts để tránh vòng
 * import: resolveActor() (attendance.ts) phải kiểm tra phiên, còn security.ts lại
 * dùng ngữ cảnh người thao tác của attendance.ts.
 *
 *   - Mỗi phiếu JWT cấp qua /api/auth/login mang một jti trỏ tới một dòng
 *     auth_sessions. Phân hệ chấm công chỉ chấp nhận phiếu có phiên còn sống:
 *     đăng xuất, bị đăng nhập nơi khác đẩy ra, hay bị Quản trị thu hồi là mất
 *     hiệu lực NGAY, không phải chờ 8 giờ.
 *   - Giới hạn tần suất dùng một câu lệnh upsert nguyên tử (INSERT ... ON
 *     CONFLICT DO UPDATE ... RETURNING), không đọc-rồi-ghi, nên nhiều yêu cầu
 *     đồng thời vẫn đếm đúng.
 */
import { db } from "../../db/index.js";
import { authRateLimits, authSessions } from "../../db/schema.js";
import { and, desc, eq, gt, isNull, ne, sql } from "drizzle-orm";

export type SessionRow = typeof authSessions.$inferSelect;

const shortUa = (ua: string | null | undefined) => String(ua || "").slice(0, 250);

/** Trình duyệt + hệ điều hành rút gọn từ User-Agent, để so "cùng máy" hay không. */
export function uaFamily(ua: string | null | undefined): string {
  const s = String(ua || "");
  const os = /Android/i.test(s)
    ? "Android"
    : /iPhone|iPad|iPod/i.test(s)
      ? "iOS"
      : /Windows/i.test(s)
        ? "Windows"
        : /Mac OS X|Macintosh/i.test(s)
          ? "macOS"
          : /Linux/i.test(s)
            ? "Linux"
            : "Khác";
  const browser = /Edg\//.test(s)
    ? "Edge"
    : /OPR\//.test(s)
      ? "Opera"
      : /CriOS|Chrome\//.test(s)
        ? "Chrome"
        : /FxiOS|Firefox\//.test(s)
          ? "Firefox"
          : /Safari\//.test(s)
            ? "Safari"
            : "Khác";
  return `${browser}/${os}`;
}

/** Tạo phiên mới khi đăng nhập thành công. Trả về jti để nhúng vào phiếu. */
export async function createSession(p: {
  userId: string;
  ip: string;
  userAgent: string;
  expiresAt: number;
}): Promise<{ id: string; concurrent: SessionRow[] }> {
  const now = Date.now();
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  const id = `ses_${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
  const concurrent = await db
    .select()
    .from(authSessions)
    .where(and(eq(authSessions.userId, p.userId), isNull(authSessions.revokedAt), gt(authSessions.expiresAt, now)))
    .orderBy(desc(authSessions.createdAt))
    .limit(20);
  await db.insert(authSessions).values({
    id,
    userId: p.userId,
    ip: p.ip || null,
    lastIp: p.ip || null,
    userAgent: shortUa(p.userAgent),
    createdAt: now,
    lastSeenAt: now,
    expiresAt: p.expiresAt,
  });
  return { id, concurrent };
}

/** Thu hồi mọi phiên còn sống của tài khoản, trừ phiên keepId. */
export async function revokeOtherSessions(userId: string, keepId: string | null, reason: string): Promise<number> {
  const now = Date.now();
  const conds = [eq(authSessions.userId, userId), isNull(authSessions.revokedAt)];
  if (keepId) conds.push(ne(authSessions.id, keepId));
  const rows = await db
    .update(authSessions)
    .set({ revokedAt: now, revokedReason: reason })
    .where(and(...conds))
    .returning({ id: authSessions.id });
  return rows.length;
}

export async function revokeSession(id: string, reason: string): Promise<void> {
  await db
    .update(authSessions)
    .set({ revokedAt: Date.now(), revokedReason: reason })
    .where(and(eq(authSessions.id, id), isNull(authSessions.revokedAt)));
}

export type SessionCheck =
  | { ok: true; session: SessionRow; ipChanged: boolean; uaChanged: boolean }
  | { ok: false; code: string; message: string; session?: SessionRow };

/**
 * Kiểm tra phiên của một phiếu.
 *
 * Đổi User-Agent giữa phiên (cùng phiếu nhưng từ một trình duyệt/hệ điều hành
 * khác) là dấu hiệu phiếu bị sao chép sang máy khác → phiên bị thu hồi ngay.
 * Đổi IP thì chỉ ghi nhận (điện thoại chuyển Wi-Fi ↔ 4G là chuyện thường).
 */
export async function checkSession(jti: string | undefined, ip: string, userAgent: string): Promise<SessionCheck> {
  if (!jti) {
    return { ok: false, code: "SESSION_REQUIRED", message: "Phiên đăng nhập cũ không còn được chấp nhận. Vui lòng đăng nhập lại." };
  }
  const rows = await db.select().from(authSessions).where(eq(authSessions.id, jti));
  const session = rows[0];
  const now = Date.now();
  if (!session) return { ok: false, code: "SESSION_NOT_FOUND", message: "Phiên đăng nhập không tồn tại. Vui lòng đăng nhập lại." };
  if (session.revokedAt) {
    const why =
      session.revokedReason === "SUPERSEDED"
        ? "Tài khoản vừa đăng nhập trên thiết bị khác nên phiên này đã bị đóng."
        : session.revokedReason === "LOGOUT"
          ? "Phiên đã đăng xuất."
          : "Phiên đăng nhập đã bị thu hồi.";
    return { ok: false, code: "SESSION_REVOKED", message: `${why} Vui lòng đăng nhập lại.`, session };
  }
  if (session.expiresAt <= now) return { ok: false, code: "SESSION_EXPIRED", message: "Phiên đăng nhập đã hết hạn.", session };

  const uaChanged = uaFamily(session.userAgent) !== uaFamily(userAgent);
  if (uaChanged) {
    await revokeSession(session.id, "UA_CHANGED");
    return {
      ok: false,
      code: "SESSION_HIJACK",
      message: "Phiên đăng nhập được dùng từ một trình duyệt khác nên đã bị đóng để bảo vệ tài khoản. Vui lòng đăng nhập lại.",
      session,
    };
  }
  const ipChanged = Boolean(ip && session.lastIp && ip !== session.lastIp);
  // Chỉ ghi lại "lần thấy cuối" mỗi phút một lần để không ghi DB ở mọi yêu cầu.
  if (ipChanged || !session.lastSeenAt || now - session.lastSeenAt > 60000) {
    await db
      .update(authSessions)
      .set({
        lastSeenAt: now,
        lastIp: ip || session.lastIp,
        ipChanges: ipChanged ? sql`coalesce(${authSessions.ipChanges}, 0) + 1` : authSessions.ipChanges,
      })
      .where(eq(authSessions.id, session.id));
  }
  return { ok: true, session, ipChanged, uaChanged: false };
}

/**
 * Đếm một lượt trong cửa sổ cố định windowMs. Trả về false khi đã vượt limit.
 * Lỗi cơ sở dữ liệu ở đây không chặn nghiệp vụ (fail-open có ghi log) - riêng
 * đăng nhập thì mật khẩu vẫn qua bcrypt nên không mở ra lỗ hổng.
 */
export async function rateLimit(key: string, limit: number, windowMs: number): Promise<{ allowed: boolean; count: number; retryAfterSec: number }> {
  const now = Date.now();
  const windowStart = now - (now % windowMs);
  try {
    const rows = await db
      .insert(authRateLimits)
      .values({ key, windowStart, count: 1 })
      .onConflictDoUpdate({
        target: authRateLimits.key,
        set: {
          count: sql`case when ${authRateLimits.windowStart} = ${windowStart} then ${authRateLimits.count} + 1 else 1 end`,
          windowStart: sql`${windowStart}`,
        },
      })
      .returning({ count: authRateLimits.count });
    const count = rows[0]?.count ?? 1;
    return { allowed: count <= limit, count, retryAfterSec: Math.ceil((windowStart + windowMs - now) / 1000) };
  } catch (err) {
    console.warn("[rate-limit] Không đếm được:", err);
    return { allowed: true, count: 0, retryAfterSec: 0 };
  }
}

/** Xoá bộ đếm (vd sau khi đăng nhập thành công). */
export async function resetRateLimit(key: string): Promise<void> {
  try {
    await db.delete(authRateLimits).where(eq(authRateLimits.key, key));
  } catch {
    /* không quan trọng */
  }
}
