/**
 * Việc định kỳ của phân hệ chấm công (chạy mỗi ngày).
 *
 *   - Xoá ảnh selfie quá hạn lưu trữ trong Netlify Blobs (tối thiểu hoá dữ liệu,
 *     yêu cầu 19). Ảnh mẫu khuôn mặt (ref/) không bị xoá tự động.
 *   - Dọn thử thách dùng một lần và bộ đếm giới hạn tần suất đã hết hạn.
 *   - Quét phiên đăng nhập bất thường: tài khoản có từ 3 phiên sống trở lên.
 *   - Áp thay đổi công tác tới ngày hiệu lực: điểm trạm / khoa phòng / nơi làm
 *     việc hiện hành trong hồ sơ cán bộ lấy theo lịch sử công tác của hôm nay.
 *     Lịch trực đã phân không bị sửa.
 *
 * Sổ bằng chứng, cảnh báo, bản ghi điều chỉnh và nhật ký kiểm toán KHÔNG bao
 * giờ bị dọn ở đây.
 */
import { db } from "../../db/index.js";
import { attEmployeePostings, attEmployees, attNonces, authRateLimits, authSessions } from "../../db/schema.js";
import { and, eq, gt, isNull, lt, lte, sql } from "drizzle-orm";
import { getSecurity, purgeExpiredSelfies, raiseAlert } from "../lib/security.js";
import { vnDate } from "../lib/attendance.js";

/** Đưa phạm vi công tác hiện hành của hồ sơ cán bộ về đúng bản ghi công tác có hiệu lực hôm nay. */
async function applyDuePostings(): Promise<number> {
  const today = vnDate();
  const due = await db.select().from(attEmployeePostings).where(lte(attEmployeePostings.effectiveFrom, today));
  const latest = new Map<string, (typeof due)[number]>();
  for (const p of due) {
    const cur = latest.get(p.employeeId);
    if (!cur || p.effectiveFrom > cur.effectiveFrom) latest.set(p.employeeId, p);
  }
  let changed = 0;
  for (const emp of await db.select().from(attEmployees)) {
    const p = latest.get(emp.id);
    if (!p) continue;
    if (emp.stationCode === p.stationCode && emp.departmentId === p.departmentId && emp.workplaceId === p.workplaceId) continue;
    await db
      .update(attEmployees)
      .set({ stationCode: p.stationCode, departmentId: p.departmentId, workplaceId: p.workplaceId, updatedAt: Date.now() })
      .where(eq(attEmployees.id, emp.id));
    changed += 1;
  }
  return changed;
}

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
    const postings = await applyDuePostings();
    console.log(`[attendance-maintenance] removed selfies=${removed}, crowded accounts=${crowded.length}, postings applied=${postings}`);
  } catch (err) {
    console.error("[attendance-maintenance] failed", err);
  }
};

export const config = {
  schedule: "@daily",
};
