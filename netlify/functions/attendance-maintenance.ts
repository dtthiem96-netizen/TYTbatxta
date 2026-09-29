/**
 * Việc định kỳ của phân hệ chấm công (chạy mỗi ngày).
 *
 *   - Xoá ảnh selfie quá hạn lưu trữ trong Netlify Blobs (tối thiểu hoá dữ liệu,
 *     yêu cầu 19). Ảnh mẫu khuôn mặt (ref/) không bị xoá tự động.
 *   - Dọn thử thách dùng một lần và bộ đếm giới hạn tần suất đã hết hạn.
 *   - Quét phiên đăng nhập bất thường: tài khoản có từ 3 phiên sống trở lên.
 *
 * Sổ bằng chứng, cảnh báo, bản ghi điều chỉnh và nhật ký kiểm toán KHÔNG bao
 * giờ bị dọn ở đây.
 */
import { db } from "../../db/index.js";
import { attNonces, authRateLimits, authSessions } from "../../db/schema.js";
import { and, gt, isNull, lt, sql } from "drizzle-orm";
import { getSecurity, purgeExpiredSelfies, raiseAlert } from "../lib/security.js";

export default async () => {
  const now = Date.now();
  try {
    const security = await getSecurity();
    const removed = await purgeExpiredSelfies(security.selfieRetentionDays);
    await db.delete(attNonces).where(lt(attNonces.expiresAt, now - 24 * 3600 * 1000));
    await db.delete(authRateLimits).where(lt(authRateLimits.windowStart, now - 24 * 3600 * 1000));

    const crowded = await db
      .select({ userId: authSessions.userId, n: sql<number>`count(*)::int` })
      .from(authSessions)
      .where(and(isNull(authSessions.revokedAt), gt(authSessions.expiresAt, now)))
      .groupBy(authSessions.userId)
      .having(sql`count(*) >= 3`);
    for (const c of crowded) {
      await raiseAlert({
        level: "YELLOW",
        category: "SESSION_HIJACK",
        userId: c.userId,
        title: "Nhiều phiên đăng nhập cùng lúc",
        cause: `Tài khoản đang có ${c.n} phiên đăng nhập còn hiệu lực.`,
        evidence: { sessions: c.n },
      });
    }
    console.log(`[attendance-maintenance] removed selfies=${removed}, crowded accounts=${crowded.length}`);
  } catch (err) {
    console.error("[attendance-maintenance] failed", err);
  }
};

export const config = {
  schedule: "@daily",
};
