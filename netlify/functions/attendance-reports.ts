/**
 * API báo cáo tháng của Phân hệ Chấm công - Chấm trực.
 *
 * Ba báo cáo, một nguồn số:
 *
 *   GET /api/attendance/reports?view=timesheet&period=YYYY-MM   BẢNG CHẤM CÔNG THÁNG
 *   GET /api/attendance/reports?view=duty&period=YYYY-MM        BẢNG TỔNG HỢP CHẤM TRỰC THÁNG
 *   GET /api/attendance/reports?view=combined&period=YYYY-MM    TỔNG HỢP CÔNG + TRỰC (nguồn của tệp xuất)
 *   GET /api/attendance/reports?view=detail&period=&employeeId=  chi tiết từng lượt chấm của một cán bộ
 *
 * Bộ lọc dùng chung: departmentId (một bộ phận) hoặc để trống (toàn trạm),
 * employeeId (một cán bộ). Mọi con số đều do buildTimesheet() tính, nên bảng
 * chấm công, bảng chấm trực và tệp Excel/PDF không bao giờ lệch nhau.
 *
 * NGUYÊN TẮC KHÔNG ĐƯỢC PHÁ: công hành chính và công trực là hai cột số riêng.
 * Báo cáo này trả về adminDays/adminHours tách khỏi dutyShifts/dutyHours, và
 * chỉ cộng suất trực vào ngày công khi Quản trị bật countsAsAdminDay cho ca đó
 * - phần cộng ấy nằm riêng ở convertedAdminDays để người kiểm tra thấy được.
 */
import { db } from "../../db/index.js";
import {
  attDepartments,
  attDutyAssignments,
  attDutyLogs,
  attEmployees,
  attLeaves,
  attPunches,
} from "../../db/schema.js";
import { and, eq, gte, inArray, lte } from "drizzle-orm";
import { authErrorResponse } from "../lib/auth.js";
import {
  AuthError,
  JSON_HEADERS,
  WEEKDAY_SHORT,
  buildTimesheet,
  classifyDay,
  buildHolidayMap,
  formatDateVN,
  getSettings,
  isValidPeriod,
  json,
  listHolidays,
  listShifts,
  periodDates,
  periodOf,
  periodStatus,
  publicShift,
  resolveActor,
  sortEmployees,
  str,
  visibleEmployeeIds,
  vnDate,
  vnTime,
  weekdayOf,
  type ActorContext,
  type EmployeeRow,
  type EmployeeTimesheet,
  type TimesheetResult,
} from "../lib/attendance.js";

/** Nhãn tháng tiếng Việt cho tiêu đề báo cáo và tên tệp xuất. */
function periodLabel(period: string): string {
  const [year, month] = period.split("-");
  return `Tháng ${Number(month)} năm ${year}`;
}

/**
 * Nạp dữ liệu thô của một kỳ rồi giao cho buildTimesheet().
 *
 * Toàn bộ lọc theo bộ phận / cán bộ xảy ra ở bước chọn danh sách cán bộ, nên
 * mọi báo cáo phía dưới dùng đúng một phép tính - đây là điều kiện để "bảng
 * chấm công" và "bảng chấm trực" của cùng một tháng không bao giờ lệch số.
 */
async function loadTimesheet(
  actor: ActorContext,
  period: string,
  filters: { departmentId?: string; employeeId?: string }
): Promise<{ result: TimesheetResult; employees: EmployeeRow[] } | Response> {
  if (!isValidPeriod(period)) return json({ success: false, error: "Kỳ báo cáo không hợp lệ." }, 400);

  const dates = periodDates(period);
  const from = dates[0];
  const to = dates[dates.length - 1];

  const allowed = await visibleEmployeeIds(actor);
  let employees = allowed === null
    ? await db.select().from(attEmployees)
    : allowed.length
      ? await db.select().from(attEmployees).where(inArray(attEmployees.id, allowed))
      : [];

  if (filters.departmentId) employees = employees.filter((e) => e.departmentId === filters.departmentId);
  if (filters.employeeId) employees = employees.filter((e) => e.id === filters.employeeId);

  // Người vào làm sau kỳ báo cáo thì không có mặt trên bảng công của kỳ đó.
  employees = sortEmployees(employees.filter((e) => !e.startDate || e.startDate <= to));

  const ids = employees.map((e) => e.id);
  const inScope = ids.length;

  const [settings, shifts, holidays, departments, punches, duties, dutyLogs, leaves, locked] = await Promise.all([
    getSettings(),
    listShifts(true),
    listHolidays(),
    db.select().from(attDepartments),
    inScope
      ? db
          .select()
          .from(attPunches)
          .where(and(inArray(attPunches.employeeId, ids), gte(attPunches.workDate, from), lte(attPunches.workDate, to)))
      : Promise.resolve([]),
    inScope
      ? db
          .select()
          .from(attDutyAssignments)
          .where(
            and(
              inArray(attDutyAssignments.employeeId, ids),
              gte(attDutyAssignments.dutyDate, from),
              lte(attDutyAssignments.dutyDate, to)
            )
          )
      : Promise.resolve([]),
    inScope
      ? db
          .select()
          .from(attDutyLogs)
          .where(
            and(inArray(attDutyLogs.employeeId, ids), gte(attDutyLogs.dutyDate, from), lte(attDutyLogs.dutyDate, to))
          )
      : Promise.resolve([]),
    inScope
      ? db
          .select()
          .from(attLeaves)
          .where(
            and(
              inArray(attLeaves.employeeId, ids),
              eq(attLeaves.status, "APPROVED"),
              lte(attLeaves.fromDate, to),
              gte(attLeaves.toDate, from)
            )
          )
      : Promise.resolve([]),
    periodStatus(period),
  ]);

  /* Cán bộ đã ngừng hoạt động vẫn phải có mặt trên bảng công của tháng họ còn
     làm việc - bỏ họ đi là làm sai số liệu quá khứ. Nhưng người đã nghỉ từ lâu
     thì không nên chiếm dòng trống ở các tháng sau, nên chỉ giữ lại khi trong
     kỳ có ít nhất một dữ liệu công, trực hoặc nghỉ phép. */
  const withData = new Set<string>([
    ...punches.map((p) => p.employeeId),
    ...duties.map((d) => d.employeeId),
    ...dutyLogs.map((l) => l.employeeId),
    ...leaves.map((l) => l.employeeId),
  ]);
  const reported = employees.filter(
    (e) => String(e.status || "ACTIVE").toUpperCase() === "ACTIVE" || withData.has(e.id)
  );

  const result = buildTimesheet({
    period,
    employees: reported,
    departments,
    shifts,
    holidays,
    punches,
    duties,
    dutyLogs,
    leaves,
    settings,
    locked: locked === "LOCKED",
  });
  return { result, employees: reported };
}

/**
 * Cột "Ghi chú" của bảng tổng hợp.
 *
 * Tự tóm tắt những điểm người kiểm tra cần biết ngay: đi muộn, về sớm, thiếu
 * lượt chấm, và suất trực đã phân mà không ai nhận ca. Không có gì đáng lưu ý
 * thì để trống, đúng như bảng viết tay.
 */
function autoNote(row: EmployeeTimesheet): string {
  const parts: string[] = [];
  if (row.totals.lateCount) parts.push(`đi muộn ${row.totals.lateCount} lần`);
  if (row.totals.earlyLeaveCount) parts.push(`về sớm ${row.totals.earlyLeaveCount} lần`);
  if (row.totals.missingCount) parts.push(`thiếu lượt chấm ${row.totals.missingCount} ngày`);
  const notChecked = row.totals.dutyShifts - row.totals.dutyCheckedIn;
  if (notChecked > 0) parts.push(`${notChecked} ca trực chưa bấm nhận ca`);
  if (row.totals.convertedAdminDays) parts.push(`quy đổi ${row.totals.convertedAdminDays} ngày công từ ca trực`);
  return parts.join("; ");
}

/** Phần đầu dùng chung của mọi báo cáo: đơn vị, tiêu đề, người lập, ký hiệu. */
function reportMeta(actor: ActorContext, period: string, result: TimesheetResult, scopeLabel: string) {
  return {
    org: result.settings.org,
    period,
    periodLabel: periodLabel(period),
    scopeLabel,
    symbols: result.settings.symbols,
    leaveTypes: result.settings.leaveTypes,
    locked: result.locked,
    preparedBy: actor.employee?.fullName || actor.user.name,
    preparedAt: `${formatDateVN(vnDate())} ${vnTime()}`,
    days: result.dates.map((d) => ({
      date: d.date,
      day: d.day,
      weekdayShort: WEEKDAY_SHORT[d.weekday],
      weekdayName: d.weekdayName,
      dayType: d.dayType,
      holidayName: d.holidayName || "",
    })),
  };
}

/** Tên bộ phận để in lên tiêu đề "Bộ phận: ..." hoặc "Toàn trạm". */
async function scopeLabelOf(departmentId: string, employeeId: string): Promise<string> {
  if (employeeId) {
    const found = await db.select().from(attEmployees).where(eq(attEmployees.id, employeeId));
    if (found.length) return `Cán bộ: ${found[0].fullName}`;
  }
  if (departmentId) {
    const found = await db.select().from(attDepartments).where(eq(attDepartments.id, departmentId));
    if (found.length) return `Bộ phận: ${found[0].name}`;
  }
  return "Toàn trạm";
}

/**
 * BẢNG CHẤM CÔNG THÁNG (mục IX).
 *
 * Mỗi dòng là một cán bộ; phần giữa là ký hiệu từng ngày 01 → hết tháng; phần
 * cuối là các cột tổng. Loại ngày của từng cột (thường / T7 / CN / lễ) đi kèm
 * để giao diện và tệp Excel tô đúng màu mà không phải tự suy luận lại.
 */
async function handleTimesheet(actor: ActorContext, period: string, departmentId: string, employeeId: string) {
  const loaded = await loadTimesheet(actor, period, { departmentId, employeeId });
  if (loaded instanceof Response) return loaded;
  const { result } = loaded;
  const meta = reportMeta(actor, period, result, await scopeLabelOf(departmentId, employeeId));

  const totals = result.rows.reduce(
    (acc, row) => {
      acc.adminDays += row.totals.adminDays;
      acc.adminHours += row.totals.adminHours;
      acc.convertedAdminDays += row.totals.convertedAdminDays;
      acc.annualLeaveDays += row.totals.annualLeaveDays;
      acc.otherLeaveDays += row.totals.otherLeaveDays;
      acc.absentDays += row.totals.absentDays;
      acc.lateCount += row.totals.lateCount;
      acc.earlyLeaveCount += row.totals.earlyLeaveCount;
      acc.missingCount += row.totals.missingCount;
      acc.dutyShifts += row.totals.dutyShifts;
      acc.dutyHours += row.totals.dutyHours;
      return acc;
    },
    {
      adminDays: 0,
      adminHours: 0,
      convertedAdminDays: 0,
      annualLeaveDays: 0,
      otherLeaveDays: 0,
      absentDays: 0,
      lateCount: 0,
      earlyLeaveCount: 0,
      missingCount: 0,
      dutyShifts: 0,
      dutyHours: 0,
    }
  );

  return json({
    success: true,
    report: "TIMESHEET",
    title: "BẢNG CHẤM CÔNG THÁNG",
    meta,
    dates: result.dates,
    rows: result.rows.map((row, index) => ({ index: index + 1, ...row })),
    grandTotals: { ...totals, adminHours: Math.round(totals.adminHours * 100) / 100, dutyHours: Math.round(totals.dutyHours * 100) / 100 },
  });
}

/**
 * BẢNG TỔNG HỢP CHẤM TRỰC THÁNG (mục X).
 *
 * Báo cáo riêng của công trực: số ca ngày thường, cuối tuần, ngày lễ, tổng ca
 * và tổng giờ. Không có một con số công hành chính nào lẫn vào đây.
 */
async function handleDuty(actor: ActorContext, period: string, departmentId: string, employeeId: string) {
  const loaded = await loadTimesheet(actor, period, { departmentId, employeeId });
  if (loaded instanceof Response) return loaded;
  const { result } = loaded;
  const meta = reportMeta(actor, period, result, await scopeLabelOf(departmentId, employeeId));
  const shifts = await listShifts(true);

  const rows = result.rows.map((row, index) => {
    // Số ca theo từng loại ca, để đơn vị đối chiếu với định mức của ca đó.
    const byShift: Record<string, number> = {};
    for (const day of row.days) {
      for (const name of day.dutyNames) byShift[name] = (byShift[name] || 0) + 1;
    }
    return {
      index: index + 1,
      employeeId: row.employee.id,
      code: row.employee.code,
      fullName: row.employee.fullName,
      position: row.employee.position,
      departmentName: row.employee.departmentName,
      dutyWeekday: row.totals.dutyWeekday,
      dutyWeekend: row.totals.dutyWeekend,
      dutyHoliday: row.totals.dutyHoliday,
      dutyShifts: row.totals.dutyShifts,
      dutyHours: row.totals.dutyHours,
      dutyCheckedIn: row.totals.dutyCheckedIn,
      // Suất đã phân nhưng không có ai bấm nhận ca - việc cần Phụ trách rà lại.
      dutyNotCheckedIn: row.totals.dutyShifts - row.totals.dutyCheckedIn,
      byShift,
      dates: row.days.filter((d) => d.dutyShifts > 0).map((d) => ({
        date: d.date,
        day: d.day,
        dayType: d.dayType,
        shifts: d.dutyNames,
        hours: d.dutyHours,
        checkedIn: d.dutyCheckedIn,
      })),
    };
  });

  const totals = rows.reduce(
    (acc, row) => {
      acc.dutyWeekday += row.dutyWeekday;
      acc.dutyWeekend += row.dutyWeekend;
      acc.dutyHoliday += row.dutyHoliday;
      acc.dutyShifts += row.dutyShifts;
      acc.dutyHours += row.dutyHours;
      acc.dutyCheckedIn += row.dutyCheckedIn;
      return acc;
    },
    { dutyWeekday: 0, dutyWeekend: 0, dutyHoliday: 0, dutyShifts: 0, dutyHours: 0, dutyCheckedIn: 0 }
  );

  return json({
    success: true,
    report: "DUTY",
    title: "BẢNG TỔNG HỢP CHẤM TRỰC THÁNG",
    meta,
    shifts: shifts.map(publicShift),
    rows,
    grandTotals: { ...totals, dutyHours: Math.round(totals.dutyHours * 100) / 100 },
  });
}

/**
 * TỔNG HỢP CÔNG + TRỰC (mục VII và mục XI.3).
 *
 * Đây là bảng mà đơn vị dùng để ký: một dòng một cán bộ, bên trái là công hành
 * chính, bên phải là công trực, hai bên KHÔNG cộng vào nhau. Cột
 * convertedAdminDays chỉ khác 0 khi Quản trị đã bật quy định quy đổi cho một ca
 * cụ thể, và luôn đứng riêng để người kiểm tra biết con số ấy từ đâu ra.
 */
async function handleCombined(actor: ActorContext, period: string, departmentId: string, employeeId: string) {
  const loaded = await loadTimesheet(actor, period, { departmentId, employeeId });
  if (loaded instanceof Response) return loaded;
  const { result } = loaded;
  const meta = reportMeta(actor, period, result, await scopeLabelOf(departmentId, employeeId));

  const rows = result.rows.map((row, index) => ({
    index: index + 1,
    employeeId: row.employee.id,
    code: row.employee.code,
    fullName: row.employee.fullName,
    position: row.employee.position,
    departmentName: row.employee.departmentName,
    // Công hành chính
    adminDays: row.totals.adminDays,
    adminHours: row.totals.adminHours,
    lateCount: row.totals.lateCount,
    earlyLeaveCount: row.totals.earlyLeaveCount,
    missingCount: row.totals.missingCount,
    absentDays: row.totals.absentDays,
    annualLeaveDays: row.totals.annualLeaveDays,
    otherLeaveDays: row.totals.otherLeaveDays,
    // Công trực - tách hoàn toàn
    dutyShifts: row.totals.dutyShifts,
    dutyHours: row.totals.dutyHours,
    dutyWeekday: row.totals.dutyWeekday,
    dutyWeekend: row.totals.dutyWeekend,
    dutyHoliday: row.totals.dutyHoliday,
    // Phần quy đổi, chỉ khác 0 khi có quy định của Quản trị
    convertedAdminDays: row.totals.convertedAdminDays,
    note: autoNote(row),
    days: row.days.map((d) => ({
      day: d.day,
      date: d.date,
      dayType: d.dayType,
      symbol: d.symbol,
      adminDays: d.adminDays,
      adminHours: d.adminHours,
      dutyShifts: d.dutyShifts,
      dutyHours: d.dutyHours,
      firstIn: d.firstIn,
      lastOut: d.lastOut,
    })),
  }));

  return json({
    success: true,
    report: "COMBINED",
    title: "BẢNG CHẤM CÔNG VÀ CHẤM TRỰC",
    meta,
    dates: result.dates,
    rows,
    grandTotals: rows.reduce(
      (acc, row) => ({
        adminDays: acc.adminDays + row.adminDays,
        adminHours: Math.round((acc.adminHours + row.adminHours) * 100) / 100,
        dutyShifts: acc.dutyShifts + row.dutyShifts,
        dutyHours: Math.round((acc.dutyHours + row.dutyHours) * 100) / 100,
        dutyWeekday: acc.dutyWeekday + row.dutyWeekday,
        dutyWeekend: acc.dutyWeekend + row.dutyWeekend,
        dutyHoliday: acc.dutyHoliday + row.dutyHoliday,
        convertedAdminDays: acc.convertedAdminDays + row.convertedAdminDays,
        annualLeaveDays: acc.annualLeaveDays + row.annualLeaveDays,
        otherLeaveDays: acc.otherLeaveDays + row.otherLeaveDays,
      }),
      {
        adminDays: 0,
        adminHours: 0,
        dutyShifts: 0,
        dutyHours: 0,
        dutyWeekday: 0,
        dutyWeekend: 0,
        dutyHoliday: 0,
        convertedAdminDays: 0,
        annualLeaveDays: 0,
        otherLeaveDays: 0,
      }
    ),
  });
}

/**
 * Chi tiết từng lượt chấm của một cán bộ trong kỳ.
 *
 * Phục vụ việc đối chiếu khi cán bộ khiếu nại: thấy đủ giờ bấm, nguồn dữ liệu
 * (tự bấm / Quản trị nhập / do duyệt yêu cầu) và ghi chú của từng lượt.
 */
async function handleDetail(actor: ActorContext, period: string, employeeId: string) {
  if (!isValidPeriod(period)) return json({ success: false, error: "Kỳ báo cáo không hợp lệ." }, 400);
  const allowed = await visibleEmployeeIds(actor);
  if (allowed !== null && !allowed.includes(employeeId)) {
    return json({ success: false, error: "Bạn không có quyền xem dữ liệu của cán bộ này." }, 403);
  }
  const employee = await db.select().from(attEmployees).where(eq(attEmployees.id, employeeId));
  if (!employee.length) return json({ success: false, error: "Không tìm thấy cán bộ." }, 404);

  const dates = periodDates(period);
  const from = dates[0];
  const to = dates[dates.length - 1];
  const [punches, duties, dutyLogs, leaves, shifts, settings, holidays] = await Promise.all([
    db
      .select()
      .from(attPunches)
      .where(and(eq(attPunches.employeeId, employeeId), gte(attPunches.workDate, from), lte(attPunches.workDate, to))),
    db
      .select()
      .from(attDutyAssignments)
      .where(
        and(
          eq(attDutyAssignments.employeeId, employeeId),
          gte(attDutyAssignments.dutyDate, from),
          lte(attDutyAssignments.dutyDate, to)
        )
      ),
    db
      .select()
      .from(attDutyLogs)
      .where(and(eq(attDutyLogs.employeeId, employeeId), gte(attDutyLogs.dutyDate, from), lte(attDutyLogs.dutyDate, to))),
    db
      .select()
      .from(attLeaves)
      .where(and(eq(attLeaves.employeeId, employeeId), lte(attLeaves.fromDate, to), gte(attLeaves.toDate, from))),
    listShifts(true),
    getSettings(),
    listHolidays(),
  ]);

  const shiftById = new Map(shifts.map((s) => [s.id, s]));
  const logByAssignment = new Map(dutyLogs.map((l) => [l.assignmentId, l]));
  const holidayMap = buildHolidayMap(holidays);

  return json({
    success: true,
    report: "DETAIL",
    employee: { id: employee[0].id, code: employee[0].code, fullName: employee[0].fullName, position: employee[0].position || "" },
    period,
    periodLabel: periodLabel(period),
    punches: punches
      .sort((a, b) => (a.punchAt || 0) - (b.punchAt || 0))
      .map((p) => ({
        id: p.id,
        workDate: p.workDate,
        dayType: classifyDay(p.workDate, holidayMap, settings.workHours),
        punchType: String(p.punchType).toUpperCase(),
        time: vnTime(p.punchAt),
        session: String(p.session || "").toUpperCase(),
        status: String(p.status || "").toUpperCase(),
        minutesDelta: p.minutesDelta || 0,
        source: String(p.source || "SELF").toUpperCase(),
        device: p.device || "",
        note: p.note || "",
      })),
    duties: duties
      .sort((a, b) => a.dutyDate.localeCompare(b.dutyDate))
      .map((d) => {
        const log = logByAssignment.get(d.id);
        const shift = shiftById.get(d.shiftId);
        return {
          assignmentId: d.id,
          dutyDate: d.dutyDate,
          dayType: String(d.dayType || "WEEKDAY").toUpperCase(),
          shiftName: shift ? shift.name : d.shiftId,
          startTime: shift ? shift.startTime : "",
          endTime: shift ? shift.endTime : "",
          status: String(d.status || "PLANNED").toUpperCase(),
          checkIn: log?.checkInAt ? vnTime(log.checkInAt) : "",
          checkOut: log?.checkOutAt ? vnTime(log.checkOutAt) : "",
          hours: log?.hours ?? shift?.hours ?? 0,
          source: log ? String(log.source || "SELF").toUpperCase() : "",
          note: d.note || "",
        };
      }),
    leaves: leaves.map((l) => ({
      id: l.id,
      leaveType: l.leaveType,
      fromDate: l.fromDate,
      toDate: l.toDate,
      days: l.days ?? 0,
      session: String(l.session || "FULL").toUpperCase(),
      status: String(l.status || "PENDING").toUpperCase(),
      reason: l.reason || "",
      decidedByName: l.decidedByName || "",
    })),
  });
}

export default async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: JSON_HEADERS, status: 204 });
  if (req.method !== "GET") return json({ success: false, error: "Method not allowed" }, 405);

  try {
    const actor = await resolveActor(req);
    const url = new URL(req.url);
    const view = str(url.searchParams.get("view")) || "timesheet";
    // Nhận cả period=YYYY-MM và cặp month=&year= cho bộ lọc "Tháng .. Năm ..".
    const month = str(url.searchParams.get("month"));
    const year = str(url.searchParams.get("year"));
    const period =
      str(url.searchParams.get("period")) ||
      (month && year ? `${year}-${String(Number(month)).padStart(2, "0")}` : periodOf(vnDate()));
    const departmentId = str(url.searchParams.get("departmentId"));
    const employeeId = str(url.searchParams.get("employeeId"));

    switch (view) {
      case "timesheet":
        return await handleTimesheet(actor, period, departmentId, employeeId);
      case "duty":
        return await handleDuty(actor, period, departmentId, employeeId);
      case "combined":
        return await handleCombined(actor, period, departmentId, employeeId);
      case "detail":
        return await handleDetail(actor, period, employeeId || actor.employee?.id || "");
      default:
        return json({ success: false, error: "Loại báo cáo không hợp lệ." }, 400);
    }
  } catch (err: unknown) {
    const authResponse = authErrorResponse(err, JSON_HEADERS);
    if (authResponse) return authResponse;
    if (err instanceof AuthError) {
      return json({ success: false, code: err.code, error: err.message }, err.status);
    }
    console.error("attendance-reports error", err);
    return json({ success: false, error: "Không lập được báo cáo. Vui lòng thử lại." }, 500);
  }
};

export const config = {
  path: "/api/attendance/reports",
};
