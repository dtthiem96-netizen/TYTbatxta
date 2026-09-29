/**
 * Bảng trực công khai của Phân hệ Chấm công - Chấm trực.
 *
 *   GET /api/attendance/public     số cán bộ đang trực và đang làm việc lúc này
 *
 * Đây là tuyến DUY NHẤT của phân hệ không cần đăng nhập: trang chủ dùng nó để
 * trả lời câu hỏi của người dân "bây giờ trạm có ai trực không?" ngay tại dòng
 * trạng thái đầu trang. Vì mở cho mọi người nên tuyến này:
 *   - chỉ ĐỌC, không có nhánh POST nào;
 *   - chỉ trả SỐ LƯỢNG cán bộ đang trực / đã nhận ca / đang làm việc hành chính
 *     - không họ tên, chức danh, ca trực, số điện thoại hay bất kỳ dữ liệu cá
 *     nhân nào của cán bộ;
 *   - lỗi cơ sở dữ liệu thì trả số lượng 0 kèm available=false thay vì mã
 *     500, để trang chủ tự rơi về lời mời gọi khám mà không hiện lỗi cho dân.
 */
import { db } from "../../db/index.js";
import { attDutyAssignments, attDutyLogs, attEmployees, attPunches } from "../../db/schema.js";
import { and, eq, gte, inArray, lte } from "drizzle-orm";
import { ACTIVE_DUTY_LOG, ACTIVE_PUNCH, addDays, listShifts, sortEmployees, vnDate, vnEpoch, vnTime } from "../lib/attendance.js";

const HEADERS = {
  "Content-Type": "application/json",
  // Cache ngắn ở CDN: trang chủ có thể được rất nhiều người mở cùng lúc, còn bảng
  // trực chỉ đổi vài lần một ngày - 60 giây trễ là chấp nhận được.
  "Cache-Control": "public, max-age=0, must-revalidate",
  "Netlify-CDN-Cache-Control": "public, max-age=60, stale-while-revalidate=120",
  "Access-Control-Allow-Origin": "*",
};

const DAY_MS = 24 * 60 * 60 * 1000;

const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { headers: HEADERS, status });

export default async (req: Request) => {
  if (req.method !== "GET") return reply({ success: false, error: "Method not allowed" }, 405);

  const now = Date.now();
  const today = vnDate(now);
  const yesterday = addDays(today, -1);

  try {
    // Ca trực đêm của hôm qua (16:30 - 07:30) vẫn đang diễn ra vào sáng nay, nên
    // phải xét lịch của cả hai ngày.
    const [assignments, shifts] = await Promise.all([
      db
        .select()
        .from(attDutyAssignments)
        .where(and(gte(attDutyAssignments.dutyDate, yesterday), lte(attDutyAssignments.dutyDate, today))),
      listShifts(true),
    ]);
    const shiftById = new Map(shifts.map((s) => [s.id, s]));

    const active = assignments.filter((a) => {
      if (String(a.status || "PLANNED").toUpperCase() === "CANCELLED") return false;
      const shift = shiftById.get(a.shiftId);
      if (!shift) return false;
      const start = vnEpoch(a.dutyDate, shift.startTime);
      let end = vnEpoch(a.dutyDate, shift.endTime);
      if (end <= start) end += DAY_MS;
      return now >= start && now < end;
    });

    // Ai đã bấm "Nhận ca" mà chưa "Kết ca" - có mặt thật, không chỉ có tên trên lịch.
    const openLogs = active.length
      ? await db
          .select()
          .from(attDutyLogs)
          .where(and(inArray(attDutyLogs.assignmentId, active.map((a) => a.id)), ACTIVE_DUTY_LOG))
      : [];
    const checkedIn = new Set(openLogs.filter((l) => l.checkInAt && !l.checkOutAt).map((l) => l.assignmentId));

    // Cán bộ hành chính: lượt chấm cuối cùng hôm nay là VÀO nghĩa là đang ở trạm.
    const punches = await db.select().from(attPunches).where(and(eq(attPunches.workDate, today), ACTIVE_PUNCH));
    const lastPunch = new Map<string, (typeof punches)[number]>();
    for (const p of punches) {
      const prev = lastPunch.get(p.employeeId);
      if (!prev || Number(p.punchAt) > Number(prev.punchAt)) lastPunch.set(p.employeeId, p);
    }
    const workingIds = [...lastPunch.values()]
      .filter((p) => String(p.punchType).toUpperCase() === "IN")
      .map((p) => p.employeeId);

    const employeeIds = [...new Set([...active.map((a) => a.employeeId), ...workingIds])];
    const employees = employeeIds.length
      ? sortEmployees(
          (await db.select().from(attEmployees).where(inArray(attEmployees.id, employeeIds))).filter(
            (e) => String(e.status || "ACTIVE").toUpperCase() === "ACTIVE"
          )
        )
      : [];
    const byId = new Map(employees.map((e) => [e.id, e]));

    // Chỉ trả SỐ LƯỢNG: trang chủ không hiển thị danh tính cán bộ trực nên không
    // có lý do gì để một tuyến công khai phát tán họ tên, chức danh hay ca trực.
    const onDutyAssignments = active.filter((a) => byId.has(a.employeeId));
    const onDutyCount = new Set(onDutyAssignments.map((a) => a.employeeId)).size;
    const checkedInCount = new Set(
      onDutyAssignments.filter((a) => checkedIn.has(a.id)).map((a) => a.employeeId)
    ).size;

    const dutyIds = new Set(active.map((a) => a.employeeId));
    const workingCount = employees.filter((e) => workingIds.includes(e.id) && !dutyIds.has(e.id)).length;

    return reply({ success: true, available: true, date: today, time: vnTime(now), onDutyCount, checkedInCount, workingCount });
  } catch (err) {
    console.error("attendance-public error", err);
    return reply({ success: true, available: false, date: today, time: vnTime(now), onDutyCount: 0, checkedInCount: 0, workingCount: 0 });
  }
};

export const config = {
  path: "/api/attendance/public",
};
