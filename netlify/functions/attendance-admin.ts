/**
 * API quản trị Phân hệ Chấm công - Chấm trực.
 *
 * Tất cả những gì Quản trị và Phụ trách bộ phận cần: danh mục bộ phận và cán
 * bộ, tài khoản đăng nhập, cấu hình giờ hành chính, ca trực, ngày lễ, lịch trực
 * tháng, duyệt yêu cầu, khoá kỳ bảng công và lịch sử thao tác.
 *
 *   GET  /api/attendance/admin?view=...
 *        overview        số liệu điều hành hôm nay + số việc đang chờ
 *        departments     danh mục bộ phận
 *        employees       danh sách cán bộ (kèm tài khoản nếu có)
 *        accounts        tài khoản hệ thống để gán vào hồ sơ cán bộ
 *        shifts          danh mục ca trực
 *        holidays        danh mục ngày nghỉ lễ
 *        settings        cấu hình (giờ hành chính, ký hiệu, loại nghỉ, đơn vị)
 *        roster          lịch trực một tháng
 *        approvals       yêu cầu điều chỉnh / đổi ca / đơn nghỉ đang chờ
 *        not_punched     ai chưa chấm công trong một ngày
 *        periods         trạng thái khoá các kỳ
 *        audits          lịch sử thao tác
 *
 *   POST /api/attendance/admin  { action: ... }
 *        Danh mục:   department_save | department_delete | employee_save |
 *                    employee_delete | shift_save | shift_delete |
 *                    holiday_save | holiday_delete | settings_save
 *        Tài khoản:  account_link | account_unlink | account_grant |
 *                    account_create | account_reset_password
 *        Lịch trực:  roster_assign | roster_remove | roster_copy_previous |
 *                    roster_auto | roster_import
 *        Dữ liệu:    punch_save | punch_delete | duty_log_save | leave_save
 *        Duyệt:      decide_request | decide_leave
 *        Kỳ:         period_lock | period_unlock
 *
 * PHÂN QUYỀN: Phụ trách bộ phận chỉ xem được bộ phận mình và chỉ duyệt được
 * yêu cầu của người trong bộ phận mình (visibleEmployeeIds + assertCanManage).
 * Mọi hành động sửa danh mục, cấu hình, lịch trực và khoá kỳ là của Quản trị.
 */
import { db } from "../../db/index.js";
import {
  attDepartments,
  attDutyAssignments,
  attDutyLogs,
  attEmployees,
  attHolidays,
  attLeaves,
  attNotifications,
  attPeriods,
  attPunches,
  attRequests,
  attShifts,
  attAudits,
  users,
} from "../../db/schema.js";
import { and, asc, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import {
  authErrorResponse,
  generateTemporaryPassword,
  hashPassword,
  isAdminRole,
  validatePasswordStrength,
  type UserRow,
} from "../lib/auth.js";
import {
  AuthError,
  DEFAULT_LEAVE_TYPES,
  DEFAULT_ORG,
  DEFAULT_SYMBOLS,
  DEFAULT_WORK_HOURS,
  JSON_HEADERS,
  SETTING_KEYS,
  accountsFor,
  addDays,
  assertCanManage,
  assertPeriodOpen,
  buildHolidayMap,
  classifyDay,
  crossesMidnight,
  daysInPeriod,
  departmentNameMap,
  ensureSeedData,
  evaluatePunch,
  getSettings,
  isValidDate,
  isValidPeriod,
  json,
  listHolidays,
  listShifts,
  newId,
  notify,
  num,
  periodDates,
  periodOf,
  periodStatus,
  publicEmployee,
  publicShift,
  requireAdmin,
  requireManager,
  resolveActor,
  saveSetting,
  shiftHours,
  sortEmployees,
  str,
  todayContext,
  visibleEmployeeIds,
  vnDate,
  vnEpoch,
  vnTime,
  weekdayOf,
  writeAudit,
  type ActorContext,
  type DayType,
  type EmployeeRow,
  type ShiftRow,
} from "../lib/attendance.js";

const ROLES = new Set(["STAFF", "MANAGER", "ADMIN"]);
const DAY_SCOPES = new Set(["ANY", "WEEKDAY", "WEEKEND", "HOLIDAY"]);
const DAY_TYPES = new Set(["HOLIDAY", "TET", "OTHER"]);
const flag = (value: unknown, fallback: "true" | "false" = "false"): "true" | "false" => {
  if (value === true || value === "true") return "true";
  if (value === false || value === "false") return "false";
  return fallback;
};

// ---------------------------------------------------------------------------
//  Đọc dữ liệu
// ---------------------------------------------------------------------------

/** Danh sách cán bộ trong tầm nhìn của người đang thao tác. */
async function scopedEmployees(actor: ActorContext): Promise<EmployeeRow[]> {
  const ids = await visibleEmployeeIds(actor);
  const rows = ids === null
    ? await db.select().from(attEmployees)
    : ids.length
      ? await db.select().from(attEmployees).where(inArray(attEmployees.id, ids))
      : [];
  return sortEmployees(rows);
}

/**
 * Bảng điều hành: hôm nay ai đã chấm, ai chưa, ai đang trực, việc gì đang chờ.
 *
 * Đây là màn hình Phụ trách bộ phận mở đầu ngày, nên phải trả lời đúng câu hỏi
 * "ai chưa chấm công" mà không cần bấm thêm - yêu cầu ở mục II.2.
 */
async function handleOverview(actor: ActorContext) {
  const { today, period } = todayContext();
  const employees = (await scopedEmployees(actor)).filter(
    (e) => String(e.status || "ACTIVE").toUpperCase() === "ACTIVE"
  );
  const ids = employees.map((e) => e.id);
  const settings = await getSettings();
  const holidayMap = buildHolidayMap(await listHolidays());
  const dayType = classifyDay(today, holidayMap, settings.workHours);
  const deptNames = await departmentNameMap();

  const punches = ids.length
    ? await db
        .select()
        .from(attPunches)
        .where(and(eq(attPunches.workDate, today), inArray(attPunches.employeeId, ids)))
    : [];
  const duties = ids.length
    ? await db
        .select()
        .from(attDutyAssignments)
        .where(and(eq(attDutyAssignments.dutyDate, today), inArray(attDutyAssignments.employeeId, ids)))
    : [];
  const dutyLogs = ids.length
    ? await db
        .select()
        .from(attDutyLogs)
        .where(and(eq(attDutyLogs.dutyDate, today), inArray(attDutyLogs.employeeId, ids)))
    : [];
  const leaves = ids.length
    ? await db
        .select()
        .from(attLeaves)
        .where(
          and(
            inArray(attLeaves.employeeId, ids),
            eq(attLeaves.status, "APPROVED"),
            lte(attLeaves.fromDate, today),
            gte(attLeaves.toDate, today)
          )
        )
    : [];

  const punchesBy = new Map<string, typeof punches>();
  for (const p of punches) {
    const list = punchesBy.get(p.employeeId);
    if (list) list.push(p);
    else punchesBy.set(p.employeeId, [p]);
  }
  const onLeave = new Set(leaves.map((l) => l.employeeId));
  const dutyToday = new Set(duties.filter((d) => String(d.status || "PLANNED").toUpperCase() !== "CANCELLED").map((d) => d.employeeId));
  const checkedIn = new Set(dutyLogs.filter((l) => l.checkInAt).map((l) => l.employeeId));

  const rows = employees.map((e) => {
    const list = (punchesBy.get(e.id) || []).sort((a, b) => (a.punchAt || 0) - (b.punchAt || 0));
    const ins = list.filter((p) => String(p.punchType).toUpperCase() === "IN");
    const outs = list.filter((p) => String(p.punchType).toUpperCase() === "OUT");
    return {
      employeeId: e.id,
      code: e.code,
      fullName: e.fullName,
      position: e.position || "",
      departmentName: deptNames.get(e.departmentId || "") || "",
      firstIn: ins.length ? vnTime(ins[0].punchAt) : "",
      lastOut: outs.length ? vnTime(outs[outs.length - 1].punchAt) : "",
      late: ins.some((p) => String(p.status || "").toUpperCase() === "LATE"),
      earlyLeave: outs.some((p) => String(p.status || "").toUpperCase() === "EARLY_LEAVE"),
      punched: list.length > 0,
      onLeave: onLeave.has(e.id),
      onDuty: dutyToday.has(e.id),
      dutyCheckedIn: checkedIn.has(e.id),
    };
  });

  // "Chưa chấm công" chỉ có nghĩa trong ngày làm việc và với người không nghỉ phép.
  const expected = dayType === "WEEKDAY";
  const notPunched = expected ? rows.filter((r) => !r.punched && !r.onLeave) : [];

  const pendingRequests = await db.select().from(attRequests).where(eq(attRequests.status, "PENDING"));
  const pendingLeaves = await db.select().from(attLeaves).where(eq(attLeaves.status, "PENDING"));
  const scope = new Set(ids);
  const mine = (employeeId: string) => actor.role === "ADMIN" || scope.has(employeeId);

  return json({
    success: true,
    today,
    period,
    dayType,
    holidayName: holidayMap.get(today)?.name || null,
    weekday: weekdayOf(today),
    expectAdminWork: expected,
    locked: (await periodStatus(period)) === "LOCKED",
    rows,
    summary: {
      total: rows.length,
      punched: rows.filter((r) => r.punched).length,
      notPunched: notPunched.length,
      late: rows.filter((r) => r.late).length,
      onLeave: rows.filter((r) => r.onLeave).length,
      onDuty: rows.filter((r) => r.onDuty).length,
      dutyCheckedIn: rows.filter((r) => r.dutyCheckedIn).length,
      pendingRequests: pendingRequests.filter((r) => mine(r.employeeId)).length,
      pendingLeaves: pendingLeaves.filter((l) => mine(l.employeeId)).length,
    },
    notPunched,
  });
}

async function handleDepartments() {
  const rows = await db.select().from(attDepartments).orderBy(asc(attDepartments.displayOrder), asc(attDepartments.name));
  const employees = await db.select().from(attEmployees);
  return json({
    success: true,
    departments: rows.map((d) => ({
      id: d.id,
      code: d.code,
      name: d.name,
      headEmployeeId: d.headEmployeeId || "",
      headName: employees.find((e) => e.id === d.headEmployeeId)?.fullName || "",
      note: d.note || "",
      displayOrder: d.displayOrder ?? 0,
      status: String(d.status || "ACTIVE").toUpperCase(),
      employeeCount: employees.filter((e) => e.departmentId === d.id).length,
    })),
  });
}

async function handleEmployees(actor: ActorContext) {
  const rows = await scopedEmployees(actor);
  const [deptNames, accounts] = await Promise.all([departmentNameMap(), accountsFor(rows)]);
  return json({
    success: true,
    employees: rows.map((e) => publicEmployee(e, deptNames.get(e.departmentId || "") || "", accounts.get(e.id) || null)),
  });
}

/** Tài khoản hệ thống, để Quản trị gán vào hồ sơ cán bộ. */
async function handleAccounts(actor: ActorContext) {
  requireAdmin(actor);
  const rows = await db.select().from(users).orderBy(asc(users.name));
  const employees = await db.select().from(attEmployees);
  const empByUser = new Map(employees.filter((e) => e.userId).map((e) => [e.userId as string, e]));
  return json({
    success: true,
    accounts: rows.map((u) => ({
      id: u.id,
      username: u.username,
      name: u.name,
      role: u.role,
      email: u.email || "",
      phone: u.phone || "",
      status: String(u.status || "ACTIVE").toUpperCase(),
      attendanceAccess: String(u.attendanceAccess || "false") === "true" || isAdminRole(u.role),
      mustChangePassword: String(u.mustChangePassword || "false") === "true",
      linkedEmployeeId: empByUser.get(u.id)?.id || "",
      linkedEmployeeName: empByUser.get(u.id)?.fullName || "",
    })),
  });
}

async function handleShifts(actor: ActorContext) {
  // Lần đầu Quản trị mở danh mục trên cơ sở dữ liệu còn trắng thì gieo ca mẫu,
  // để có cái sửa thay vì một danh sách rỗng. Không gieo ở đường đọc của cán bộ.
  if (actor.role === "ADMIN") await ensureSeedData();
  const rows = await listShifts(true);
  return json({ success: true, shifts: rows.map(publicShift) });
}

async function handleHolidays() {
  const rows = await listHolidays();
  return json({
    success: true,
    holidays: rows.map((h) => ({
      id: h.id,
      name: h.name,
      startDate: h.startDate,
      endDate: h.endDate,
      dayType: String(h.dayType || "HOLIDAY").toUpperCase(),
      note: h.note || "",
    })),
  });
}

async function handleSettings() {
  const settings = await getSettings();
  return json({
    success: true,
    settings,
    defaults: {
      workHours: DEFAULT_WORK_HOURS,
      symbols: DEFAULT_SYMBOLS,
      leaveTypes: DEFAULT_LEAVE_TYPES,
      org: DEFAULT_ORG,
    },
    keys: SETTING_KEYS,
  });
}

/** Lịch trực tháng dưới dạng bảng ngày x ca, kèm chỗ trống chưa phân người. */
async function handleRoster(period: string) {
  if (!isValidPeriod(period)) return json({ success: false, error: "Kỳ không hợp lệ." }, 400);
  const dates = periodDates(period);
  const [assignments, shifts, employees, holidays, settings, logs, locked] = await Promise.all([
    db
      .select()
      .from(attDutyAssignments)
      .where(and(gte(attDutyAssignments.dutyDate, dates[0]), lte(attDutyAssignments.dutyDate, dates[dates.length - 1])))
      .orderBy(asc(attDutyAssignments.dutyDate)),
    listShifts(true),
    db.select().from(attEmployees),
    listHolidays(),
    getSettings(),
    db
      .select()
      .from(attDutyLogs)
      .where(and(gte(attDutyLogs.dutyDate, dates[0]), lte(attDutyLogs.dutyDate, dates[dates.length - 1]))),
    periodStatus(period),
  ]);

  const holidayMap = buildHolidayMap(holidays);
  const empById = new Map(employees.map((e) => [e.id, e]));
  const shiftById = new Map(shifts.map((s) => [s.id, s]));
  const logByAssignment = new Map(logs.map((l) => [l.assignmentId, l]));
  const active = assignments.filter((a) => String(a.status || "PLANNED").toUpperCase() !== "CANCELLED");

  const counts = new Map<string, number>();
  for (const a of active) counts.set(a.employeeId, (counts.get(a.employeeId) || 0) + 1);

  return json({
    success: true,
    period,
    locked: locked === "LOCKED",
    shifts: shifts.map(publicShift),
    days: dates.map((date) => {
      const dayType = classifyDay(date, holidayMap, settings.workHours);
      return {
        date,
        day: Number(date.slice(8, 10)),
        weekday: weekdayOf(date),
        dayType,
        holidayName: holidayMap.get(date)?.name || null,
        entries: active
          .filter((a) => a.dutyDate === date)
          .map((a) => {
            const log = logByAssignment.get(a.id);
            return {
              assignmentId: a.id,
              employeeId: a.employeeId,
              employeeName: empById.get(a.employeeId)?.fullName || a.employeeId,
              employeeCode: empById.get(a.employeeId)?.code || "",
              shiftId: a.shiftId,
              shiftName: shiftById.get(a.shiftId)?.name || a.shiftId,
              color: shiftById.get(a.shiftId)?.color || "#0284c7",
              note: a.note || "",
              swappedFromEmployeeId: a.swappedFromEmployeeId || "",
              swappedFromName: a.swappedFromEmployeeId
                ? empById.get(a.swappedFromEmployeeId)?.fullName || ""
                : "",
              checkInAt: log?.checkInAt || null,
              checkOutAt: log?.checkOutAt || null,
            };
          }),
      };
    }),
    // Số suất mỗi người trong tháng, để Quản trị thấy ngay việc phân có đều không.
    workload: sortEmployees(employees)
      .filter((e) => String(e.status || "ACTIVE").toUpperCase() === "ACTIVE")
      .map((e) => ({ employeeId: e.id, fullName: e.fullName, code: e.code, shifts: counts.get(e.id) || 0 })),
  });
}

/** Việc đang chờ duyệt, đã lọc theo tầm nhìn của người duyệt. */
async function handleApprovals(actor: ActorContext, status: string) {
  requireManager(actor);
  const want = ["PENDING", "APPROVED", "REJECTED", "CANCELLED", "ALL"].includes(status.toUpperCase())
    ? status.toUpperCase()
    : "PENDING";
  const ids = await visibleEmployeeIds(actor);
  const scope = ids === null ? null : new Set(ids);

  const [requests, leaves, employees, shifts] = await Promise.all([
    want === "ALL"
      ? db.select().from(attRequests).orderBy(desc(attRequests.createdAt)).limit(200)
      : db.select().from(attRequests).where(eq(attRequests.status, want)).orderBy(desc(attRequests.createdAt)).limit(200),
    want === "ALL"
      ? db.select().from(attLeaves).orderBy(desc(attLeaves.createdAt)).limit(200)
      : db.select().from(attLeaves).where(eq(attLeaves.status, want)).orderBy(desc(attLeaves.createdAt)).limit(200),
    db.select().from(attEmployees),
    listShifts(true),
  ]);

  const empById = new Map(employees.map((e) => [e.id, e]));
  const shiftById = new Map(shifts.map((s) => [s.id, s]));
  const inScope = (employeeId: string) => scope === null || scope.has(employeeId);
  const settings = await getSettings();
  const leaveTypeName = (code: string) =>
    settings.leaveTypes.find((t) => t.code.toUpperCase() === code.toUpperCase())?.name || code;

  return json({
    success: true,
    status: want,
    requests: requests.filter((r) => inScope(r.employeeId)).map((r) => {
      let payload: Record<string, unknown> = {};
      try {
        payload = r.payload ? JSON.parse(r.payload) : {};
      } catch {
        payload = {};
      }
      const toEmployeeId = str(payload.toEmployeeId);
      const shiftId = str(payload.shiftId);
      return {
        id: r.id,
        kind: String(r.kind).toUpperCase(),
        employeeId: r.employeeId,
        employeeName: empById.get(r.employeeId)?.fullName || r.employeeId,
        employeeCode: empById.get(r.employeeId)?.code || "",
        targetDate: r.targetDate || "",
        payload,
        shiftName: shiftId ? shiftById.get(shiftId)?.name || shiftId : "",
        toEmployeeId,
        toEmployeeName: toEmployeeId ? empById.get(toEmployeeId)?.fullName || toEmployeeId : "",
        reason: r.reason || "",
        status: String(r.status || "PENDING").toUpperCase(),
        decidedByName: r.decidedByName || "",
        decidedAt: r.decidedAt || null,
        decisionNote: r.decisionNote || "",
        createdAt: r.createdAt || null,
      };
    }),
    leaves: leaves.filter((l) => inScope(l.employeeId)).map((l) => ({
      id: l.id,
      employeeId: l.employeeId,
      employeeName: empById.get(l.employeeId)?.fullName || l.employeeId,
      employeeCode: empById.get(l.employeeId)?.code || "",
      leaveType: l.leaveType,
      leaveTypeName: leaveTypeName(l.leaveType),
      fromDate: l.fromDate,
      toDate: l.toDate,
      days: l.days ?? 0,
      session: String(l.session || "FULL").toUpperCase(),
      reason: l.reason || "",
      status: String(l.status || "PENDING").toUpperCase(),
      decidedByName: l.decidedByName || "",
      decidedAt: l.decidedAt || null,
      decisionNote: l.decisionNote || "",
      createdAt: l.createdAt || null,
    })),
  });
}

/** Ai chưa chấm công trong một ngày cụ thể. */
async function handleNotPunched(actor: ActorContext, date: string) {
  requireManager(actor);
  if (!isValidDate(date)) return json({ success: false, error: "Ngày không hợp lệ." }, 400);
  const employees = (await scopedEmployees(actor)).filter(
    (e) => String(e.status || "ACTIVE").toUpperCase() === "ACTIVE"
  );
  const ids = employees.map((e) => e.id);
  const settings = await getSettings();
  const dayType = classifyDay(date, buildHolidayMap(await listHolidays()), settings.workHours);
  const [punches, leaves, duties, deptNames] = await Promise.all([
    ids.length
      ? db.select().from(attPunches).where(and(eq(attPunches.workDate, date), inArray(attPunches.employeeId, ids)))
      : Promise.resolve([]),
    ids.length
      ? db
          .select()
          .from(attLeaves)
          .where(
            and(
              inArray(attLeaves.employeeId, ids),
              eq(attLeaves.status, "APPROVED"),
              lte(attLeaves.fromDate, date),
              gte(attLeaves.toDate, date)
            )
          )
      : Promise.resolve([]),
    ids.length
      ? db
          .select()
          .from(attDutyAssignments)
          .where(and(eq(attDutyAssignments.dutyDate, date), inArray(attDutyAssignments.employeeId, ids)))
      : Promise.resolve([]),
    departmentNameMap(),
  ]);

  const punched = new Set(punches.map((p) => p.employeeId));
  const onLeave = new Set(leaves.map((l) => l.employeeId));
  const onDuty = new Set(duties.map((d) => d.employeeId));

  return json({
    success: true,
    date,
    dayType,
    expectAdminWork: dayType === "WEEKDAY",
    rows: employees
      .filter((e) => !punched.has(e.id))
      .map((e) => ({
        employeeId: e.id,
        code: e.code,
        fullName: e.fullName,
        departmentName: deptNames.get(e.departmentId || "") || "",
        onLeave: onLeave.has(e.id),
        onDuty: onDuty.has(e.id),
      })),
  });
}

async function handlePeriods() {
  const rows = await db.select().from(attPeriods).orderBy(desc(attPeriods.id)).limit(36);
  return json({
    success: true,
    periods: rows.map((p) => ({
      id: p.id,
      status: String(p.status || "OPEN").toUpperCase(),
      lockedByName: p.lockedByName || "",
      lockedAt: p.lockedAt || null,
      note: p.note || "",
    })),
  });
}

async function handleAudits(actor: ActorContext, url: URL) {
  requireAdmin(actor);
  const entity = str(url.searchParams.get("entity"));
  const entityId = str(url.searchParams.get("entityId"));
  const limit = Math.min(Math.max(num(url.searchParams.get("limit"), 100), 1), 500);
  const conditions = [];
  if (entity) conditions.push(eq(attAudits.entity, entity));
  if (entityId) conditions.push(eq(attAudits.entityId, entityId));
  const rows = conditions.length
    ? await db.select().from(attAudits).where(and(...conditions)).orderBy(desc(attAudits.ts)).limit(limit)
    : await db.select().from(attAudits).orderBy(desc(attAudits.ts)).limit(limit);
  return json({
    success: true,
    audits: rows.map((a) => ({
      id: a.id,
      entity: a.entity,
      entityId: a.entityId || "",
      action: a.action,
      field: a.field || "",
      oldValue: a.oldValue || "",
      newValue: a.newValue || "",
      actorName: a.actorName || "",
      actorUsername: a.actorUsername || "",
      ip: a.ip || "",
      ts: a.ts,
    })),
  });
}

// ---------------------------------------------------------------------------
//  Danh mục
// ---------------------------------------------------------------------------

async function saveDepartment(actor: ActorContext, body: Record<string, unknown>) {
  requireAdmin(actor);
  const id = str(body.id);
  const name = str(body.name);
  const code = str(body.code).toUpperCase();
  if (!name) return json({ success: false, error: "Tên bộ phận là bắt buộc." }, 400);
  if (!code) return json({ success: false, error: "Mã bộ phận là bắt buộc." }, 400);

  const clash = await db.select().from(attDepartments).where(eq(attDepartments.code, code));
  if (clash.length && clash[0].id !== id) {
    return json({ success: false, error: `Mã bộ phận "${code}" đã tồn tại.` }, 409);
  }

  const now = Date.now();
  const patch = {
    code,
    name,
    headEmployeeId: str(body.headEmployeeId) || null,
    note: str(body.note) || null,
    displayOrder: num(body.displayOrder, 0),
    status: str(body.status).toUpperCase() === "INACTIVE" ? "INACTIVE" : "ACTIVE",
    updatedAt: now,
  };

  if (id) {
    const existing = await db.select().from(attDepartments).where(eq(attDepartments.id, id));
    if (!existing.length) return json({ success: false, error: "Không tìm thấy bộ phận." }, 404);
    await db.update(attDepartments).set(patch).where(eq(attDepartments.id, id));
    await writeAudit(actor, { entity: "department", entityId: id, action: "UPDATE", oldValue: existing[0], newValue: patch });
    return json({ success: true, message: "Đã cập nhật bộ phận.", id });
  }

  const newDeptId = newId("dept");
  await db.insert(attDepartments).values({ id: newDeptId, ...patch, createdAt: now });
  await writeAudit(actor, { entity: "department", entityId: newDeptId, action: "CREATE", newValue: patch });
  return json({ success: true, message: "Đã thêm bộ phận.", id: newDeptId });
}

async function deleteDepartment(actor: ActorContext, body: Record<string, unknown>) {
  requireAdmin(actor);
  const id = str(body.id);
  const used = await db.select().from(attEmployees).where(eq(attEmployees.departmentId, id));
  if (used.length) {
    return json(
      { success: false, error: `Còn ${used.length} cán bộ thuộc bộ phận này. Chuyển họ sang bộ phận khác trước khi xoá.` },
      409
    );
  }
  await db.delete(attDepartments).where(eq(attDepartments.id, id));
  await writeAudit(actor, { entity: "department", entityId: id, action: "DELETE" });
  return json({ success: true, message: "Đã xoá bộ phận." });
}

async function saveEmployee(actor: ActorContext, body: Record<string, unknown>) {
  requireAdmin(actor);
  const id = str(body.id);
  const code = str(body.code).toUpperCase();
  const fullName = str(body.fullName);
  if (!code) return json({ success: false, error: "Mã cán bộ là bắt buộc." }, 400);
  if (!fullName) return json({ success: false, error: "Họ và tên là bắt buộc." }, 400);

  const clash = await db.select().from(attEmployees).where(eq(attEmployees.code, code));
  if (clash.length && clash[0].id !== id) {
    return json({ success: false, error: `Mã cán bộ "${code}" đã tồn tại.` }, 409);
  }

  const role = ROLES.has(str(body.attendanceRole).toUpperCase()) ? str(body.attendanceRole).toUpperCase() : "STAFF";
  const startDate = str(body.startDate);
  if (startDate && !isValidDate(startDate)) return json({ success: false, error: "Ngày bắt đầu làm việc không hợp lệ." }, 400);

  const now = Date.now();
  const patch = {
    code,
    fullName,
    position: str(body.position) || null,
    departmentId: str(body.departmentId) || null,
    attendanceRole: role,
    phone: str(body.phone) || null,
    email: str(body.email) || null,
    startDate: startDate || null,
    status: str(body.status).toUpperCase() === "INACTIVE" ? "INACTIVE" : "ACTIVE",
    note: str(body.note) || null,
    displayOrder: num(body.displayOrder, 0),
    updatedAt: now,
  };

  if (id) {
    const existing = await db.select().from(attEmployees).where(eq(attEmployees.id, id));
    if (!existing.length) return json({ success: false, error: "Không tìm thấy cán bộ." }, 404);
    await db.update(attEmployees).set(patch).where(eq(attEmployees.id, id));
    await writeAudit(actor, { entity: "employee", entityId: id, action: "UPDATE", oldValue: existing[0], newValue: patch });
    return json({ success: true, message: "Đã cập nhật hồ sơ cán bộ.", id });
  }

  const newEmpId = newId("emp");
  await db.insert(attEmployees).values({ id: newEmpId, ...patch, userId: null, createdAt: now });
  await writeAudit(actor, { entity: "employee", entityId: newEmpId, action: "CREATE", newValue: patch });
  return json({ success: true, message: "Đã thêm cán bộ.", id: newEmpId });
}

/**
 * Ngừng theo dõi một cán bộ.
 *
 * Xoá cứng chỉ được phép khi hồ sơ chưa có bất kỳ dữ liệu công nào - nếu không,
 * bảng chấm công các tháng trước sẽ mất người và mất số. Trường hợp đã có dữ
 * liệu thì chuyển sang trạng thái INACTIVE.
 */
async function deleteEmployee(actor: ActorContext, body: Record<string, unknown>) {
  requireAdmin(actor);
  const id = str(body.id);
  const existing = await db.select().from(attEmployees).where(eq(attEmployees.id, id));
  if (!existing.length) return json({ success: false, error: "Không tìm thấy cán bộ." }, 404);

  const [punches, duties, leaves] = await Promise.all([
    db.select({ id: attPunches.id }).from(attPunches).where(eq(attPunches.employeeId, id)).limit(1),
    db.select({ id: attDutyAssignments.id }).from(attDutyAssignments).where(eq(attDutyAssignments.employeeId, id)).limit(1),
    db.select({ id: attLeaves.id }).from(attLeaves).where(eq(attLeaves.employeeId, id)).limit(1),
  ]);
  const hasData = punches.length || duties.length || leaves.length;

  if (hasData) {
    await db.update(attEmployees).set({ status: "INACTIVE", updatedAt: Date.now() }).where(eq(attEmployees.id, id));
    await writeAudit(actor, { entity: "employee", entityId: id, action: "DEACTIVATE" });
    return json({
      success: true,
      message: `${existing[0].fullName} đã có dữ liệu chấm công nên được chuyển sang trạng thái Ngừng hoạt động, không xoá để giữ nguyên bảng công các tháng trước.`,
      deactivated: true,
    });
  }

  await db.delete(attEmployees).where(eq(attEmployees.id, id));
  await writeAudit(actor, { entity: "employee", entityId: id, action: "DELETE", oldValue: existing[0] });
  return json({ success: true, message: "Đã xoá hồ sơ cán bộ." });
}

async function saveShift(actor: ActorContext, body: Record<string, unknown>) {
  requireAdmin(actor);
  const id = str(body.id);
  const code = str(body.code).toUpperCase();
  const name = str(body.name);
  const startTime = str(body.startTime);
  const endTime = str(body.endTime);
  if (!code) return json({ success: false, error: "Mã ca là bắt buộc." }, 400);
  if (!name) return json({ success: false, error: "Tên ca là bắt buộc." }, 400);
  if (!/^\d{1,2}:\d{2}$/.test(startTime) || !/^\d{1,2}:\d{2}$/.test(endTime)) {
    return json({ success: false, error: "Giờ bắt đầu và giờ kết thúc phải ở dạng HH:MM." }, 400);
  }

  const clash = await db.select().from(attShifts).where(eq(attShifts.code, code));
  if (clash.length && clash[0].id !== id) {
    return json({ success: false, error: `Mã ca "${code}" đã tồn tại.` }, 409);
  }

  const now = Date.now();
  const patch = {
    code,
    name,
    startTime,
    endTime,
    crossesMidnight: crossesMidnight(startTime, endTime) ? "true" : "false",
    // Số giờ tính sẵn theo giờ bắt đầu/kết thúc, nhưng Quản trị ghi đè được:
    // có ca trực đêm được tính giờ theo quy định riêng của đơn vị.
    hours: body.hours === undefined || body.hours === null || body.hours === ""
      ? shiftHours(startTime, endTime)
      : num(body.hours, shiftHours(startTime, endTime)),
    dayScope: DAY_SCOPES.has(str(body.dayScope).toUpperCase()) ? str(body.dayScope).toUpperCase() : "ANY",
    coefficient: body.coefficient === undefined ? 1 : num(body.coefficient, 1),
    // Mặc định "false": một ca trực KHÔNG tự thành ngày công hành chính.
    countsAsAdminDay: flag(body.countsAsAdminDay, "false"),
    adminDayValue: num(body.adminDayValue, 0),
    color: str(body.color) || "#0284c7",
    note: str(body.note) || null,
    displayOrder: num(body.displayOrder, 0),
    status: str(body.status).toUpperCase() === "INACTIVE" ? "INACTIVE" : "ACTIVE",
    updatedAt: now,
  };

  if (id) {
    const existing = await db.select().from(attShifts).where(eq(attShifts.id, id));
    if (!existing.length) return json({ success: false, error: "Không tìm thấy ca trực." }, 404);
    await db.update(attShifts).set(patch).where(eq(attShifts.id, id));
    await writeAudit(actor, { entity: "shift", entityId: id, action: "UPDATE", oldValue: existing[0], newValue: patch });
    return json({ success: true, message: "Đã cập nhật ca trực.", id });
  }

  const newShiftId = newId("shift");
  await db.insert(attShifts).values({ id: newShiftId, ...patch, createdAt: now });
  await writeAudit(actor, { entity: "shift", entityId: newShiftId, action: "CREATE", newValue: patch });
  return json({ success: true, message: "Đã thêm ca trực.", id: newShiftId });
}

async function deleteShift(actor: ActorContext, body: Record<string, unknown>) {
  requireAdmin(actor);
  const id = str(body.id);
  const used = await db.select({ id: attDutyAssignments.id }).from(attDutyAssignments).where(eq(attDutyAssignments.shiftId, id)).limit(1);
  if (used.length) {
    // Ca đã xuất hiện trên lịch trực thì xoá đi là làm rỗng lịch cũ.
    await db.update(attShifts).set({ status: "INACTIVE", updatedAt: Date.now() }).where(eq(attShifts.id, id));
    await writeAudit(actor, { entity: "shift", entityId: id, action: "DEACTIVATE" });
    return json({
      success: true,
      message: "Ca trực đã được dùng trong lịch trực nên chỉ ngừng sử dụng, không xoá để giữ nguyên lịch cũ.",
      deactivated: true,
    });
  }
  await db.delete(attShifts).where(eq(attShifts.id, id));
  await writeAudit(actor, { entity: "shift", entityId: id, action: "DELETE" });
  return json({ success: true, message: "Đã xoá ca trực." });
}

async function saveHoliday(actor: ActorContext, body: Record<string, unknown>) {
  requireAdmin(actor);
  const id = str(body.id);
  const name = str(body.name);
  const startDate = str(body.startDate);
  const endDate = str(body.endDate) || startDate;
  if (!name) return json({ success: false, error: "Tên ngày nghỉ là bắt buộc." }, 400);
  if (!isValidDate(startDate) || !isValidDate(endDate)) {
    return json({ success: false, error: "Ngày bắt đầu hoặc ngày kết thúc không hợp lệ." }, 400);
  }
  if (endDate < startDate) return json({ success: false, error: "Ngày kết thúc phải sau ngày bắt đầu." }, 400);

  const now = Date.now();
  const patch = {
    name,
    startDate,
    endDate,
    dayType: DAY_TYPES.has(str(body.dayType).toUpperCase()) ? str(body.dayType).toUpperCase() : "HOLIDAY",
    note: str(body.note) || null,
    updatedAt: now,
  };

  if (id) {
    const existing = await db.select().from(attHolidays).where(eq(attHolidays.id, id));
    if (!existing.length) return json({ success: false, error: "Không tìm thấy ngày nghỉ." }, 404);
    await db.update(attHolidays).set(patch).where(eq(attHolidays.id, id));
    await writeAudit(actor, { entity: "holiday", entityId: id, action: "UPDATE", oldValue: existing[0], newValue: patch });
    return json({ success: true, message: "Đã cập nhật ngày nghỉ.", id });
  }

  const newHolidayId = newId("hol");
  await db.insert(attHolidays).values({ id: newHolidayId, ...patch, createdBy: actor.user.id, createdAt: now });
  await writeAudit(actor, { entity: "holiday", entityId: newHolidayId, action: "CREATE", newValue: patch });
  return json({ success: true, message: "Đã thêm ngày nghỉ.", id: newHolidayId });
}

async function deleteHoliday(actor: ActorContext, body: Record<string, unknown>) {
  requireAdmin(actor);
  const id = str(body.id);
  await db.delete(attHolidays).where(eq(attHolidays.id, id));
  await writeAudit(actor, { entity: "holiday", entityId: id, action: "DELETE" });
  return json({ success: true, message: "Đã xoá ngày nghỉ." });
}

/**
 * CÀI ĐẶT: giờ hành chính, ký hiệu bảng công, loại nghỉ, thông tin đơn vị.
 *
 * Kiểm tra ở đây là tuyến phòng thủ cuối: giờ vào phải trước giờ ra, buổi sáng
 * phải trước buổi chiều, và phải có ít nhất một ngày làm việc trong tuần. Một
 * cấu hình sai ở đây sẽ làm sai toàn bộ bảng công của tháng.
 */
async function saveSettings(actor: ActorContext, body: Record<string, unknown>) {
  requireAdmin(actor);
  const key = str(body.key);
  const value = body.value;
  if (value === null || typeof value !== "object") {
    return json({ success: false, error: "Giá trị cấu hình không hợp lệ." }, 400);
  }

  if (key === SETTING_KEYS.WORK_HOURS) {
    const wh = value as Record<string, any>;
    const morning = (wh.morning || {}) as Record<string, unknown>;
    const afternoon = (wh.afternoon || {}) as Record<string, unknown>;
    const pairs: [Record<string, unknown>, string][] = [
      [morning, "buổi sáng"],
      [afternoon, "buổi chiều"],
    ];
    for (const [block, label] of pairs) {
      if (block.enabled === false) continue;
      if (!/^\d{1,2}:\d{2}$/.test(str(block.start)) || !/^\d{1,2}:\d{2}$/.test(str(block.end))) {
        return json({ success: false, error: `Giờ ${label} phải ở dạng HH:MM.` }, 400);
      }
      if (str(block.end) <= str(block.start)) {
        return json({ success: false, error: `Giờ kết thúc ${label} phải sau giờ bắt đầu ${label}.` }, 400);
      }
    }
    if (morning.enabled !== false && afternoon.enabled !== false && str(afternoon.start) < str(morning.end)) {
      return json({ success: false, error: "Buổi chiều phải bắt đầu sau khi buổi sáng kết thúc." }, 400);
    }
    if (morning.enabled === false && afternoon.enabled === false) {
      return json({ success: false, error: "Phải bật ít nhất một buổi làm việc hành chính." }, 400);
    }
    const workDays = Array.isArray(wh.workDays)
      ? wh.workDays.map((d: unknown) => num(d, -1)).filter((d: number) => d >= 0 && d <= 6)
      : [];
    if (!workDays.length) return json({ success: false, error: "Phải chọn ít nhất một ngày làm việc trong tuần." }, 400);
    wh.workDays = [...new Set(workDays)].sort((a, b) => a - b);
    // Số phút dung sai âm sẽ làm đảo chiều phép so giờ trong evaluatePunch.
    for (const field of ["lateGraceMin", "earlyGraceMin", "earliestPunchMin", "latestPunchMin"]) {
      if (wh[field] !== undefined && num(wh[field], -1) < 0) {
        return json({ success: false, error: `Giá trị "${field}" không được là số âm.` }, 400);
      }
    }
  }

  if (key === SETTING_KEYS.SYMBOLS) {
    const sym = value as Record<string, unknown>;
    const required: [string, string][] = [
      ["present", "đi làm"],
      ["duty", "trực"],
      ["leave", "nghỉ phép"],
    ];
    for (const [field, label] of required) {
      if (sym[field] !== undefined && !str(sym[field])) {
        return json({ success: false, error: `Ký hiệu ${label} không được để trống.` }, 400);
      }
    }
  }

  // Danh mục loại nghỉ lưu dạng mảng, đúng như getSettings() đọc lại.
  if (key === SETTING_KEYS.LEAVE_TYPES) {
    const list = Array.isArray(value) ? (value as unknown[]) : null;
    if (!list || !list.length) {
      return json({ success: false, error: "Danh mục loại nghỉ không được để trống." }, 400);
    }
    const codes = new Set<string>();
    for (const item of list) {
      const row = item as Record<string, unknown>;
      const code = str(row.code).toUpperCase();
      if (!code || !str(row.name)) {
        return json({ success: false, error: "Mỗi loại nghỉ phải có mã và tên." }, 400);
      }
      if (codes.has(code)) return json({ success: false, error: `Mã loại nghỉ "${code}" bị trùng.` }, 409);
      codes.add(code);
    }
  }

  if (key === SETTING_KEYS.ORG) {
    if (!str((value as Record<string, unknown>).name)) {
      return json({ success: false, error: "Tên đơn vị không được để trống." }, 400);
    }
  }

  const fieldByKey: Record<string, keyof Awaited<ReturnType<typeof getSettings>>> = {
    [SETTING_KEYS.WORK_HOURS]: "workHours",
    [SETTING_KEYS.SYMBOLS]: "symbols",
    [SETTING_KEYS.LEAVE_TYPES]: "leaveTypes",
    [SETTING_KEYS.ORG]: "org",
  };
  const field = fieldByKey[key];
  if (!field) return json({ success: false, error: "Khoá cấu hình không hợp lệ." }, 400);

  const before = await getSettings();
  await saveSetting(key, value, actor);
  await writeAudit(actor, {
    entity: "settings",
    entityId: key,
    action: "UPDATE",
    oldValue: before[field],
    newValue: value,
  });
  return json({ success: true, message: "Đã lưu cấu hình.", settings: await getSettings() });
}

// ---------------------------------------------------------------------------
//  Tài khoản đăng nhập
// ---------------------------------------------------------------------------

/** Gán một tài khoản hệ thống vào hồ sơ cán bộ và cấp quyền vào phân hệ. */
async function linkAccount(actor: ActorContext, body: Record<string, unknown>) {
  requireAdmin(actor);
  const employeeId = str(body.employeeId);
  const userId = str(body.userId);
  const employee = await db.select().from(attEmployees).where(eq(attEmployees.id, employeeId));
  if (!employee.length) return json({ success: false, error: "Không tìm thấy cán bộ." }, 404);
  const account = await db.select().from(users).where(eq(users.id, userId));
  if (!account.length) return json({ success: false, error: "Không tìm thấy tài khoản." }, 404);

  const taken = await db.select().from(attEmployees).where(eq(attEmployees.userId, userId));
  if (taken.length && taken[0].id !== employeeId) {
    return json({ success: false, error: `Tài khoản này đã gán cho ${taken[0].fullName}.` }, 409);
  }

  await db.update(attEmployees).set({ userId, updatedAt: Date.now() }).where(eq(attEmployees.id, employeeId));
  await db.update(users).set({ attendanceAccess: "true", updatedAt: Date.now() }).where(eq(users.id, userId));
  await writeAudit(actor, {
    entity: "employee",
    entityId: employeeId,
    action: "ACCOUNT_LINK",
    newValue: { userId, username: account[0].username },
  });
  return json({ success: true, message: `Đã gán tài khoản ${account[0].username} cho ${employee[0].fullName}.` });
}

async function unlinkAccount(actor: ActorContext, body: Record<string, unknown>) {
  requireAdmin(actor);
  const employeeId = str(body.employeeId);
  const employee = await db.select().from(attEmployees).where(eq(attEmployees.id, employeeId));
  if (!employee.length) return json({ success: false, error: "Không tìm thấy cán bộ." }, 404);
  const userId = employee[0].userId;
  await db.update(attEmployees).set({ userId: null, updatedAt: Date.now() }).where(eq(attEmployees.id, employeeId));
  await writeAudit(actor, { entity: "employee", entityId: employeeId, action: "ACCOUNT_UNLINK", oldValue: { userId } });
  return json({ success: true, message: "Đã bỏ gán tài khoản. Cán bộ vẫn còn trên bảng chấm công." });
}

/** Cấp hoặc thu hồi quyền vào phân hệ của một tài khoản. */
async function grantAccess(actor: ActorContext, body: Record<string, unknown>) {
  requireAdmin(actor);
  const userId = str(body.userId);
  const granted = flag(body.granted, "false");
  const account = await db.select().from(users).where(eq(users.id, userId));
  if (!account.length) return json({ success: false, error: "Không tìm thấy tài khoản." }, 404);
  await db.update(users).set({ attendanceAccess: granted, updatedAt: Date.now() }).where(eq(users.id, userId));
  await writeAudit(actor, {
    entity: "account",
    entityId: userId,
    action: granted === "true" ? "GRANT_ATTENDANCE" : "REVOKE_ATTENDANCE",
    newValue: { username: account[0].username },
  });
  return json({
    success: true,
    message: `Đã ${granted === "true" ? "cấp" : "thu hồi"} quyền truy cập phân hệ cho ${account[0].name}.`,
  });
}

/**
 * Tạo tài khoản đăng nhập cho một cán bộ chưa có tài khoản.
 *
 * Mật khẩu tạm chỉ trả về đúng một lần trong phản hồi này - hệ thống chỉ lưu
 * chuỗi băm bcrypt nên không có cách nào đọc lại. Cờ mustChangePassword bắt cán
 * bộ tự đổi ở lần đăng nhập đầu tiên.
 */
async function createAccount(actor: ActorContext, body: Record<string, unknown>) {
  requireAdmin(actor);
  const employeeId = str(body.employeeId);
  const username = str(body.username).toLowerCase();
  const employee = await db.select().from(attEmployees).where(eq(attEmployees.id, employeeId));
  if (!employee.length) return json({ success: false, error: "Không tìm thấy cán bộ." }, 404);
  if (employee[0].userId) return json({ success: false, error: "Cán bộ này đã có tài khoản đăng nhập." }, 409);
  if (!username || username.length < 4 || /\s/.test(username)) {
    return json({ success: false, error: "Tên đăng nhập phải dài từ 4 ký tự và không chứa dấu cách." }, 400);
  }
  const clash = await db.select().from(users).where(eq(users.username, username));
  if (clash.length) return json({ success: false, error: `Tên đăng nhập "${username}" đã tồn tại.` }, 409);

  const password = str(body.password) || generateTemporaryPassword();
  const weak = validatePasswordStrength(password);
  if (weak) return json({ success: false, error: weak }, 400);

  const now = Date.now();
  const row = {
    id: `U${now}${Math.floor(Math.random() * 1000)}`,
    username,
    name: employee[0].fullName,
    role: "Cán bộ Trạm Y tế",
    email: employee[0].email || null,
    phone: employee[0].phone || null,
    canReceiveVideo: "false",
    stationAccess: "false",
    doctorAccess: "false",
    attendanceAccess: "true",
    status: "ACTIVE",
    passwordHash: await hashPassword(password),
    mustChangePassword: "true",
    createdAt: now,
    updatedAt: now,
    lastLoginAt: null,
  };
  await db.insert(users).values(row);
  await db.update(attEmployees).set({ userId: row.id, updatedAt: now }).where(eq(attEmployees.id, employeeId));
  await writeAudit(actor, {
    entity: "account",
    entityId: row.id,
    action: "CREATE",
    newValue: { username, employeeId, employeeName: employee[0].fullName },
  });

  return json({
    success: true,
    message: `Đã tạo tài khoản ${username} cho ${employee[0].fullName}.`,
    username,
    temporaryPassword: password,
  });
}

async function resetAccountPassword(actor: ActorContext, body: Record<string, unknown>) {
  requireAdmin(actor);
  const userId = str(body.userId);
  const account = await db.select().from(users).where(eq(users.id, userId));
  if (!account.length) return json({ success: false, error: "Không tìm thấy tài khoản." }, 404);
  const password = str(body.password) || generateTemporaryPassword();
  const weak = validatePasswordStrength(password);
  if (weak) return json({ success: false, error: weak }, 400);
  await db
    .update(users)
    .set({ passwordHash: await hashPassword(password), mustChangePassword: "true", updatedAt: Date.now() })
    .where(eq(users.id, userId));
  await writeAudit(actor, { entity: "account", entityId: userId, action: "RESET_PASSWORD", newValue: { username: account[0].username } });
  return json({
    success: true,
    message: `Đã đặt lại mật khẩu cho ${account[0].name}.`,
    temporaryPassword: password,
  });
}

// ---------------------------------------------------------------------------
//  Lịch trực tháng
// ---------------------------------------------------------------------------

/** Ca trực có được dùng cho loại ngày này không (ANY / WEEKDAY / WEEKEND / HOLIDAY). */
function shiftFitsDay(shift: ShiftRow, dayType: DayType): boolean {
  const scope = String(shift.dayScope || "ANY").toUpperCase();
  return scope === "ANY" || scope === dayType;
}

async function assignDuty(actor: ActorContext, body: Record<string, unknown>) {
  requireAdmin(actor);
  const dutyDate = str(body.dutyDate);
  const shiftId = str(body.shiftId);
  const employeeId = str(body.employeeId);
  if (!isValidDate(dutyDate)) return json({ success: false, error: "Ngày trực không hợp lệ." }, 400);
  if (!shiftId || !employeeId) return json({ success: false, error: "Thiếu ca trực hoặc cán bộ trực." }, 400);
  await assertPeriodOpen(dutyDate);

  const [shifts, employee, settings, holidays] = await Promise.all([
    listShifts(true),
    db.select().from(attEmployees).where(eq(attEmployees.id, employeeId)),
    getSettings(),
    listHolidays(),
  ]);
  const shift = shifts.find((s) => s.id === shiftId);
  if (!shift) return json({ success: false, error: "Không tìm thấy ca trực." }, 404);
  if (!employee.length) return json({ success: false, error: "Không tìm thấy cán bộ." }, 404);

  const dayType = classifyDay(dutyDate, buildHolidayMap(holidays), settings.workHours);
  const existing = await db
    .select()
    .from(attDutyAssignments)
    .where(
      and(
        eq(attDutyAssignments.dutyDate, dutyDate),
        eq(attDutyAssignments.shiftId, shiftId),
        eq(attDutyAssignments.employeeId, employeeId)
      )
    );
  if (existing.length) {
    if (String(existing[0].status || "PLANNED").toUpperCase() === "CANCELLED") {
      await db
        .update(attDutyAssignments)
        .set({ status: "PLANNED", updatedAt: Date.now() })
        .where(eq(attDutyAssignments.id, existing[0].id));
      return json({ success: true, message: "Đã phục hồi suất trực.", id: existing[0].id });
    }
    return json({ success: false, error: `${employee[0].fullName} đã được phân ca này trong ngày ${dutyDate}.` }, 409);
  }

  const now = Date.now();
  const id = newId("duty");
  await db.insert(attDutyAssignments).values({
    id,
    dutyDate,
    shiftId,
    employeeId,
    dayType,
    status: "PLANNED",
    note: str(body.note) || null,
    createdBy: actor.user.id,
    createdAt: now,
    updatedAt: now,
  });
  await writeAudit(actor, {
    entity: "duty_assignment",
    entityId: id,
    action: "CREATE",
    newValue: { dutyDate, shiftId, employeeId, dayType },
  });
  await notify(
    employeeId,
    "Phân công trực",
    `Bạn được phân ca "${shift.name}" ngày ${dutyDate}.`,
    "DUTY",
    id
  );
  return json({ success: true, message: `Đã phân ${employee[0].fullName} trực ngày ${dutyDate}.`, id });
}

async function removeDuty(actor: ActorContext, body: Record<string, unknown>) {
  requireAdmin(actor);
  const id = str(body.id);
  const found = await db.select().from(attDutyAssignments).where(eq(attDutyAssignments.id, id));
  if (!found.length) return json({ success: false, error: "Không tìm thấy suất trực." }, 404);
  await assertPeriodOpen(found[0].dutyDate);

  const logs = await db.select().from(attDutyLogs).where(eq(attDutyLogs.assignmentId, id));
  if (logs.length) {
    // Đã nhận ca thì bỏ suất trực là xoá dấu vết công việc đã làm - chỉ huỷ.
    await db
      .update(attDutyAssignments)
      .set({ status: "CANCELLED", updatedAt: Date.now() })
      .where(eq(attDutyAssignments.id, id));
    await writeAudit(actor, { entity: "duty_assignment", entityId: id, action: "CANCEL", oldValue: found[0] });
    return json({ success: true, message: "Ca trực đã được nhận nên chỉ đánh dấu huỷ, dữ liệu chấm trực vẫn giữ." });
  }

  await db.delete(attDutyAssignments).where(eq(attDutyAssignments.id, id));
  await writeAudit(actor, { entity: "duty_assignment", entityId: id, action: "DELETE", oldValue: found[0] });
  await notify(found[0].employeeId, "Huỷ phân công trực", `Suất trực ngày ${found[0].dutyDate} đã được huỷ.`, "DUTY", id);
  return json({ success: true, message: "Đã xoá suất trực." });
}

/**
 * Sao chép lịch trực tháng trước sang tháng đang lập.
 *
 * Ánh xạ theo NGÀY TRONG THÁNG (mùng 3 sang mùng 3), bỏ những ngày tháng mới
 * không có (31 → tháng 30 ngày), và phân loại lại ngày vì thứ và ngày lễ đã
 * khác. Bỏ qua các suất đã tồn tại nên bấm hai lần cũng không sinh trùng.
 */
async function copyPreviousRoster(actor: ActorContext, body: Record<string, unknown>) {
  requireAdmin(actor);
  const period = str(body.period);
  if (!isValidPeriod(period)) return json({ success: false, error: "Kỳ không hợp lệ." }, 400);
  await assertPeriodOpen(period);

  const [year, month] = period.split("-").map(Number);
  const prevMonth = month === 1 ? 12 : month - 1;
  const prevYear = month === 1 ? year - 1 : year;
  const source = `${prevYear}-${String(prevMonth).padStart(2, "0")}`;
  const sourceDates = periodDates(source);
  const targetLength = daysInPeriod(period);

  const [sourceRows, settings, holidays, shifts, employees] = await Promise.all([
    db
      .select()
      .from(attDutyAssignments)
      .where(
        and(
          gte(attDutyAssignments.dutyDate, sourceDates[0]),
          lte(attDutyAssignments.dutyDate, sourceDates[sourceDates.length - 1])
        )
      ),
    getSettings(),
    listHolidays(),
    listShifts(true),
    db.select().from(attEmployees),
  ]);
  const planned = sourceRows.filter((r) => String(r.status || "PLANNED").toUpperCase() !== "CANCELLED");
  if (!planned.length) return json({ success: false, error: `Tháng ${prevMonth}/${prevYear} chưa có lịch trực để sao chép.` }, 404);

  const targetDates = periodDates(period);
  const existing = await db
    .select()
    .from(attDutyAssignments)
    .where(and(gte(attDutyAssignments.dutyDate, targetDates[0]), lte(attDutyAssignments.dutyDate, targetDates[targetDates.length - 1])));
  const taken = new Set(existing.map((r) => `${r.dutyDate}|${r.shiftId}|${r.employeeId}`));
  const holidayMap = buildHolidayMap(holidays);
  const activeShifts = new Set(shifts.filter((s) => String(s.status || "ACTIVE").toUpperCase() === "ACTIVE").map((s) => s.id));
  const activeEmps = new Set(
    employees.filter((e) => String(e.status || "ACTIVE").toUpperCase() === "ACTIVE").map((e) => e.id)
  );

  const now = Date.now();
  const rows: (typeof attDutyAssignments.$inferInsert)[] = [];
  let skipped = 0;
  for (const src of planned) {
    const day = Number(src.dutyDate.slice(8, 10));
    if (day > targetLength) {
      skipped += 1;
      continue;
    }
    if (!activeShifts.has(src.shiftId) || !activeEmps.has(src.employeeId)) {
      skipped += 1;
      continue;
    }
    const dutyDate = `${period}-${String(day).padStart(2, "0")}`;
    const key = `${dutyDate}|${src.shiftId}|${src.employeeId}`;
    if (taken.has(key)) {
      skipped += 1;
      continue;
    }
    taken.add(key);
    rows.push({
      id: newId("duty"),
      dutyDate,
      shiftId: src.shiftId,
      employeeId: src.employeeId,
      dayType: classifyDay(dutyDate, holidayMap, settings.workHours),
      status: "PLANNED",
      note: src.note || null,
      createdBy: actor.user.id,
      createdAt: now,
      updatedAt: now,
    });
  }

  if (rows.length) await db.insert(attDutyAssignments).values(rows);
  await writeAudit(actor, {
    entity: "duty_assignment",
    entityId: period,
    action: "ROSTER_COPY",
    newValue: { source, created: rows.length, skipped },
  });
  return json({
    success: true,
    message: `Đã sao chép ${rows.length} suất trực từ tháng ${prevMonth}/${prevYear}${
      skipped ? `, bỏ qua ${skipped} suất (trùng, ngoài số ngày của tháng, hoặc ca/cán bộ đã ngừng dùng)` : ""
    }.`,
    created: rows.length,
    skipped,
  });
}

/**
 * Phân trực tự động cho cả tháng.
 *
 * Luật phân: quay vòng danh sách cán bộ được chọn, mỗi ngày mỗi ca lấy người
 * kế tiếp, nhưng BỎ QUA người đã trực hôm trước (không trực hai đêm liền) và
 * người đang có đơn nghỉ đã duyệt trong ngày đó. Những ngày đã có người trực
 * thì giữ nguyên - lịch do Quản trị đặt tay luôn thắng.
 */
async function autoAssignRoster(actor: ActorContext, body: Record<string, unknown>) {
  requireAdmin(actor);
  const period = str(body.period);
  if (!isValidPeriod(period)) return json({ success: false, error: "Kỳ không hợp lệ." }, 400);
  await assertPeriodOpen(period);

  const shiftIds = Array.isArray(body.shiftIds) ? body.shiftIds.map((v) => str(v)).filter(Boolean) : [];
  const employeeIds = Array.isArray(body.employeeIds) ? body.employeeIds.map((v) => str(v)).filter(Boolean) : [];
  if (!shiftIds.length) return json({ success: false, error: "Chọn ít nhất một ca trực cần phân." }, 400);
  if (employeeIds.length < 1) return json({ success: false, error: "Chọn danh sách cán bộ tham gia trực." }, 400);
  const perShift = Math.min(Math.max(num(body.peoplePerShift, 1), 1), 10);

  const dates = periodDates(period);
  const [allShifts, allEmployees, settings, holidays, existing, leaves] = await Promise.all([
    listShifts(true),
    db.select().from(attEmployees),
    getSettings(),
    listHolidays(),
    db
      .select()
      .from(attDutyAssignments)
      .where(and(gte(attDutyAssignments.dutyDate, dates[0]), lte(attDutyAssignments.dutyDate, dates[dates.length - 1]))),
    db
      .select()
      .from(attLeaves)
      .where(and(eq(attLeaves.status, "APPROVED"), lte(attLeaves.fromDate, dates[dates.length - 1]), gte(attLeaves.toDate, dates[0]))),
  ]);

  const shifts = shiftIds
    .map((id) => allShifts.find((s) => s.id === id))
    .filter((s): s is ShiftRow => Boolean(s) && String(s!.status || "ACTIVE").toUpperCase() === "ACTIVE");
  if (!shifts.length) return json({ success: false, error: "Các ca đã chọn không còn hiệu lực." }, 400);

  const pool = employeeIds
    .map((id) => allEmployees.find((e) => e.id === id))
    .filter((e): e is EmployeeRow => Boolean(e) && String(e!.status || "ACTIVE").toUpperCase() === "ACTIVE");
  if (!pool.length) return json({ success: false, error: "Danh sách cán bộ đã chọn không còn hiệu lực." }, 400);

  const holidayMap = buildHolidayMap(holidays);
  const active = existing.filter((r) => String(r.status || "PLANNED").toUpperCase() !== "CANCELLED");
  const taken = new Set(active.map((r) => `${r.dutyDate}|${r.shiftId}|${r.employeeId}`));
  const filledDayShift = new Map<string, number>();
  for (const r of active) {
    const key = `${r.dutyDate}|${r.shiftId}`;
    filledDayShift.set(key, (filledDayShift.get(key) || 0) + 1);
  }
  const busy = new Set(active.map((r) => `${r.dutyDate}|${r.employeeId}`));
  const onLeave = (employeeId: string, date: string) =>
    leaves.some((l) => l.employeeId === employeeId && l.fromDate <= date && l.toDate >= date);

  const now = Date.now();
  const rows: (typeof attDutyAssignments.$inferInsert)[] = [];
  let cursor = 0;
  let unfilled = 0;

  for (const date of dates) {
    const dayType = classifyDay(date, holidayMap, settings.workHours);
    const yesterday = addDays(date, -1);
    for (const shift of shifts) {
      if (!shiftFitsDay(shift, dayType)) continue;
      const key = `${date}|${shift.id}`;
      let need = perShift - (filledDayShift.get(key) || 0);
      if (need <= 0) continue;

      // Hai lượt quét: lượt đầu tránh người trực hôm trước, lượt sau nới điều
      // kiện đó ra để không bỏ trống ca khi danh sách quá ngắn.
      for (let relax = 0; relax < 2 && need > 0; relax++) {
        for (let step = 0; step < pool.length && need > 0; step++) {
          const candidate = pool[(cursor + step) % pool.length];
          if (busy.has(`${date}|${candidate.id}`)) continue;
          if (taken.has(`${date}|${shift.id}|${candidate.id}`)) continue;
          if (onLeave(candidate.id, date)) continue;
          if (relax === 0 && busy.has(`${yesterday}|${candidate.id}`)) continue;

          rows.push({
            id: newId("duty"),
            dutyDate: date,
            shiftId: shift.id,
            employeeId: candidate.id,
            dayType,
            status: "PLANNED",
            note: null,
            createdBy: actor.user.id,
            createdAt: now,
            updatedAt: now,
          });
          taken.add(`${date}|${shift.id}|${candidate.id}`);
          busy.add(`${date}|${candidate.id}`);
          filledDayShift.set(key, (filledDayShift.get(key) || 0) + 1);
          cursor = (cursor + step + 1) % pool.length;
          need -= 1;
        }
      }
      unfilled += Math.max(need, 0);
    }
  }

  if (rows.length) await db.insert(attDutyAssignments).values(rows);
  await writeAudit(actor, {
    entity: "duty_assignment",
    entityId: period,
    action: "ROSTER_AUTO",
    newValue: { created: rows.length, unfilled, shiftIds, employees: pool.length, peoplePerShift: perShift },
  });
  return json({
    success: true,
    message: `Đã phân tự động ${rows.length} suất trực cho tháng ${period}${
      unfilled ? `. Còn ${unfilled} suất chưa có người - hãy bổ sung cán bộ hoặc phân tay.` : "."
    }`,
    created: rows.length,
    unfilled,
  });
}

/**
 * Nhập lịch trực từ Excel.
 *
 * Giao diện đọc tệp và gửi lên các dòng đã tách: { date, shift, employee }.
 * Ca và cán bộ nhận theo MÃ hoặc TÊN để người lập lịch dán thẳng từ bảng cũ.
 * Toàn bộ dòng lỗi được trả về kèm số dòng, không dừng ở dòng lỗi đầu tiên.
 */
async function importRoster(actor: ActorContext, body: Record<string, unknown>) {
  requireAdmin(actor);
  const period = str(body.period);
  if (!isValidPeriod(period)) return json({ success: false, error: "Kỳ không hợp lệ." }, 400);
  await assertPeriodOpen(period);
  const rowsIn = Array.isArray(body.rows) ? body.rows : [];
  if (!rowsIn.length) return json({ success: false, error: "Không có dòng dữ liệu nào để nhập." }, 400);

  const [shifts, employees, settings, holidays, existing] = await Promise.all([
    listShifts(true),
    db.select().from(attEmployees),
    getSettings(),
    listHolidays(),
    db
      .select()
      .from(attDutyAssignments)
      .where(
        and(
          gte(attDutyAssignments.dutyDate, `${period}-01`),
          lte(attDutyAssignments.dutyDate, `${period}-${String(daysInPeriod(period)).padStart(2, "0")}`)
        )
      ),
  ]);

  const norm = (value: string) => value.trim().toLowerCase();
  const shiftLookup = new Map<string, ShiftRow>();
  for (const s of shifts) {
    shiftLookup.set(norm(s.code), s);
    shiftLookup.set(norm(s.name), s);
    shiftLookup.set(norm(s.id), s);
  }
  const empLookup = new Map<string, EmployeeRow>();
  for (const e of employees) {
    empLookup.set(norm(e.code), e);
    empLookup.set(norm(e.fullName), e);
    empLookup.set(norm(e.id), e);
  }

  const holidayMap = buildHolidayMap(holidays);
  const taken = new Set(
    existing
      .filter((r) => String(r.status || "PLANNED").toUpperCase() !== "CANCELLED")
      .map((r) => `${r.dutyDate}|${r.shiftId}|${r.employeeId}`)
  );
  const now = Date.now();
  const inserts: (typeof attDutyAssignments.$inferInsert)[] = [];
  const errors: string[] = [];

  rowsIn.forEach((item, index) => {
    const row = item as Record<string, unknown>;
    const line = index + 1;
    // Ô ngày nhận cả "2026-09-05" và "5" (số ngày trong tháng đang nhập).
    let date = str(row.date);
    if (/^\d{1,2}$/.test(date)) date = `${period}-${date.padStart(2, "0")}`;
    if (!isValidDate(date)) {
      errors.push(`Dòng ${line}: ngày "${str(row.date)}" không hợp lệ.`);
      return;
    }
    if (periodOf(date) !== period) {
      errors.push(`Dòng ${line}: ngày ${date} không thuộc tháng ${period}.`);
      return;
    }
    const shift = shiftLookup.get(norm(str(row.shift) || str(row.shiftId) || str(row.shiftCode)));
    if (!shift) {
      errors.push(`Dòng ${line}: không tìm thấy ca trực "${str(row.shift)}".`);
      return;
    }
    const employee = empLookup.get(norm(str(row.employee) || str(row.employeeId) || str(row.employeeCode)));
    if (!employee) {
      errors.push(`Dòng ${line}: không tìm thấy cán bộ "${str(row.employee)}".`);
      return;
    }
    const key = `${date}|${shift.id}|${employee.id}`;
    if (taken.has(key)) {
      errors.push(`Dòng ${line}: ${employee.fullName} đã có ca "${shift.name}" ngày ${date}.`);
      return;
    }
    taken.add(key);
    inserts.push({
      id: newId("duty"),
      dutyDate: date,
      shiftId: shift.id,
      employeeId: employee.id,
      dayType: classifyDay(date, holidayMap, settings.workHours),
      status: "PLANNED",
      note: str(row.note) || null,
      createdBy: actor.user.id,
      createdAt: now,
      updatedAt: now,
    });
  });

  if (inserts.length) await db.insert(attDutyAssignments).values(inserts);
  await writeAudit(actor, {
    entity: "duty_assignment",
    entityId: period,
    action: "ROSTER_IMPORT",
    newValue: { created: inserts.length, errors: errors.length },
  });
  return json({
    success: true,
    message: `Đã nhập ${inserts.length} suất trực${errors.length ? `, ${errors.length} dòng bị bỏ qua` : ""}.`,
    created: inserts.length,
    errors,
  });
}

// ---------------------------------------------------------------------------
//  Sửa dữ liệu công (có lịch sử)
// ---------------------------------------------------------------------------

/**
 * Quản trị thêm hoặc sửa một lượt chấm công.
 *
 * Sổ chấm công là sổ ghi thêm: sửa giờ nghĩa là ghi bản ghi mới với
 * source = ADMIN và lưu giá trị cũ vào lịch sử, không ghi đè im lặng.
 */
async function savePunch(actor: ActorContext, body: Record<string, unknown>) {
  requireAdmin(actor);
  const employeeId = str(body.employeeId);
  const workDate = str(body.workDate);
  const punchType = str(body.punchType).toUpperCase() === "OUT" ? "OUT" : "IN";
  const time = str(body.time);
  if (!isValidDate(workDate)) return json({ success: false, error: "Ngày chấm công không hợp lệ." }, 400);
  if (!/^\d{1,2}:\d{2}$/.test(time)) return json({ success: false, error: "Giờ chấm công phải ở dạng HH:MM." }, 400);
  const employee = await assertCanManage(actor, employeeId);
  await assertPeriodOpen(workDate);

  const settings = await getSettings();
  const evaluation = evaluatePunch(punchType, time, settings.workHours);
  const punchAt = vnEpoch(workDate, time);
  const id = num(body.id, 0);
  const now = Date.now();

  if (id) {
    const existing = await db.select().from(attPunches).where(eq(attPunches.id, id));
    if (!existing.length) return json({ success: false, error: "Không tìm thấy lượt chấm công." }, 404);
    await db
      .update(attPunches)
      .set({
        punchType,
        punchAt,
        session: evaluation.session,
        status: evaluation.status,
        minutesDelta: evaluation.minutesDelta,
        source: "ADMIN",
        note: str(body.note) || existing[0].note,
      })
      .where(eq(attPunches.id, id));
    await writeAudit(actor, {
      entity: "punch",
      entityId: String(id),
      action: "ADMIN_UPDATE",
      field: "punchAt",
      oldValue: { time: vnTime(existing[0].punchAt), punchType: existing[0].punchType },
      newValue: { time, punchType, employee: employee.fullName, workDate },
    });
    await notify(employeeId, "Điều chỉnh chấm công", `Lượt chấm công ngày ${workDate} được điều chỉnh thành ${time}.`, "ADJUST", String(id));
    return json({ success: true, message: `Đã cập nhật lượt chấm công ngày ${workDate}.` });
  }

  await db.insert(attPunches).values({
    employeeId,
    workDate,
    punchType,
    punchAt,
    session: evaluation.session,
    status: evaluation.status,
    minutesDelta: evaluation.minutesDelta,
    device: "Quản trị bổ sung",
    ip: actor.ip || null,
    source: "ADMIN",
    note: str(body.note) || null,
    createdBy: actor.user.id,
    createdAt: now,
  });
  await writeAudit(actor, {
    entity: "punch",
    entityId: `${employeeId}/${workDate}`,
    action: "ADMIN_CREATE",
    newValue: { time, punchType, employee: employee.fullName },
  });
  await notify(employeeId, "Bổ sung chấm công", `Quản trị đã bổ sung lượt chấm ${punchType === "IN" ? "vào" : "ra"} ${time} ngày ${workDate}.`, "ADJUST", null);
  return json({ success: true, message: `Đã bổ sung lượt chấm công ngày ${workDate}.` });
}

async function deletePunch(actor: ActorContext, body: Record<string, unknown>) {
  requireAdmin(actor);
  const id = num(body.id, 0);
  const existing = await db.select().from(attPunches).where(eq(attPunches.id, id));
  if (!existing.length) return json({ success: false, error: "Không tìm thấy lượt chấm công." }, 404);
  await assertPeriodOpen(existing[0].workDate);
  await db.delete(attPunches).where(eq(attPunches.id, id));
  await writeAudit(actor, {
    entity: "punch",
    entityId: String(id),
    action: "ADMIN_DELETE",
    oldValue: { workDate: existing[0].workDate, time: vnTime(existing[0].punchAt), punchType: existing[0].punchType },
  });
  return json({ success: true, message: "Đã xoá lượt chấm công." });
}

/** Quản trị ghi nhận một ca trực đã hoàn thành (cán bộ quên bấm). */
async function saveDutyLog(actor: ActorContext, body: Record<string, unknown>) {
  requireAdmin(actor);
  const assignmentId = str(body.assignmentId);
  const found = await db.select().from(attDutyAssignments).where(eq(attDutyAssignments.id, assignmentId));
  if (!found.length) return json({ success: false, error: "Không tìm thấy suất trực." }, 404);
  const duty = found[0];
  await assertPeriodOpen(duty.dutyDate);
  await assertCanManage(actor, duty.employeeId);

  const shifts = await listShifts(true);
  const shift = shifts.find((s) => s.id === duty.shiftId);
  const checkInTime = str(body.checkInTime) || (shift ? shift.startTime : "");
  const checkOutTime = str(body.checkOutTime) || (shift ? shift.endTime : "");
  if (!/^\d{1,2}:\d{2}$/.test(checkInTime)) return json({ success: false, error: "Giờ nhận ca không hợp lệ." }, 400);

  const checkInAt = vnEpoch(duty.dutyDate, checkInTime);
  // Ca qua đêm kết thúc vào ngày hôm sau, nên mốc kết ca phải cộng một ngày.
  const crosses = shift ? String(shift.crossesMidnight || "false") === "true" : false;
  const checkOutAt = /^\d{1,2}:\d{2}$/.test(checkOutTime)
    ? vnEpoch(crosses ? addDays(duty.dutyDate, 1) : duty.dutyDate, checkOutTime)
    : null;
  const hours = shift ? shift.hours ?? shiftHours(shift.startTime, shift.endTime) : 0;

  const existing = await db.select().from(attDutyLogs).where(eq(attDutyLogs.assignmentId, assignmentId));
  const now = Date.now();
  if (existing.length) {
    await db
      .update(attDutyLogs)
      .set({
        checkInAt,
        checkOutAt,
        hours,
        status: checkOutAt ? "ADMIN" : "OPEN",
        source: "ADMIN",
        note: str(body.note) || existing[0].note,
        updatedAt: now,
      })
      .where(eq(attDutyLogs.id, existing[0].id));
    await writeAudit(actor, {
      entity: "duty_log",
      entityId: assignmentId,
      action: "ADMIN_UPDATE",
      oldValue: { checkInAt: existing[0].checkInAt, checkOutAt: existing[0].checkOutAt },
      newValue: { checkInTime, checkOutTime },
    });
  } else {
    await db.insert(attDutyLogs).values({
      assignmentId,
      employeeId: duty.employeeId,
      dutyDate: duty.dutyDate,
      shiftId: duty.shiftId,
      checkInAt,
      checkOutAt,
      hours,
      device: "Quản trị ghi nhận",
      ip: actor.ip || null,
      status: checkOutAt ? "ADMIN" : "OPEN",
      source: "ADMIN",
      note: str(body.note) || null,
      createdBy: actor.user.id,
      createdAt: now,
      updatedAt: now,
    });
    await writeAudit(actor, {
      entity: "duty_log",
      entityId: assignmentId,
      action: "ADMIN_CREATE",
      newValue: { dutyDate: duty.dutyDate, checkInTime, checkOutTime },
    });
  }

  await notify(duty.employeeId, "Ghi nhận ca trực", `Ca trực ngày ${duty.dutyDate} đã được Quản trị ghi nhận.`, "DUTY", assignmentId);
  return json({ success: true, message: `Đã ghi nhận ca trực ngày ${duty.dutyDate}.` });
}

/** Quản trị/Phụ trách ghi trực tiếp một kỳ nghỉ cho cán bộ (đã duyệt sẵn). */
async function saveLeave(actor: ActorContext, body: Record<string, unknown>) {
  requireManager(actor);
  const employeeId = str(body.employeeId);
  const employee = await assertCanManage(actor, employeeId);
  const settings = await getSettings();
  const leaveType = settings.leaveTypes.find((t) => t.code.toUpperCase() === str(body.leaveType).toUpperCase());
  if (!leaveType) return json({ success: false, error: "Loại nghỉ không có trong danh mục." }, 400);

  const fromDate = str(body.fromDate);
  const toDate = str(body.toDate) || fromDate;
  if (!isValidDate(fromDate) || !isValidDate(toDate)) return json({ success: false, error: "Ngày nghỉ không hợp lệ." }, 400);
  if (toDate < fromDate) return json({ success: false, error: "Ngày kết thúc phải sau ngày bắt đầu." }, 400);
  await assertPeriodOpen(fromDate);

  const session = ["FULL", "MORNING", "AFTERNOON"].includes(str(body.session).toUpperCase())
    ? str(body.session).toUpperCase()
    : "FULL";
  const holidayMap = buildHolidayMap(await listHolidays());
  let days = 0;
  let cursor = fromDate;
  for (let guard = 0; guard < 400; guard++) {
    if (classifyDay(cursor, holidayMap, settings.workHours) === "WEEKDAY") days += 1;
    if (cursor >= toDate) break;
    cursor = addDays(cursor, 1);
  }
  if (session !== "FULL") days = settings.workHours.halfDayValue;

  const now = Date.now();
  const id = newId("leave");
  await db.insert(attLeaves).values({
    id,
    employeeId,
    leaveType: leaveType.code,
    fromDate,
    toDate,
    days,
    session,
    reason: str(body.reason) || "Quản trị ghi nhận",
    status: "APPROVED",
    decidedBy: actor.user.id,
    decidedByName: actor.employee?.fullName || actor.user.name,
    decidedAt: now,
    decisionNote: "Ghi nhận trực tiếp",
    createdBy: actor.user.id,
    createdAt: now,
    updatedAt: now,
  });
  await writeAudit(actor, {
    entity: "leave",
    entityId: id,
    action: "ADMIN_CREATE",
    newValue: { employee: employee.fullName, leaveType: leaveType.code, fromDate, toDate, days },
  });
  await notify(employeeId, "Ghi nhận nghỉ phép", `${leaveType.name} từ ${fromDate} đến ${toDate} đã được ghi nhận.`, "LEAVE", id);
  return json({ success: true, message: `Đã ghi nhận ${days} ngày ${leaveType.name.toLowerCase()} cho ${employee.fullName}.`, id, days });
}

// ---------------------------------------------------------------------------
//  Duyệt yêu cầu
// ---------------------------------------------------------------------------

/**
 * Duyệt hoặc từ chối yêu cầu điều chỉnh chấm công / đổi ca trực.
 *
 * Khi duyệt điều chỉnh, máy chủ tự sinh lượt chấm mới với source = REQUEST và
 * con trỏ requestId về yêu cầu gốc: người kiểm tra sau này luôn lần được từ số
 * trên bảng công về tận lá đơn.
 */
async function decideRequest(actor: ActorContext, body: Record<string, unknown>) {
  requireManager(actor);
  const id = str(body.id);
  const approve = str(body.decision).toUpperCase() !== "REJECT";
  const note = str(body.note);

  const found = await db.select().from(attRequests).where(eq(attRequests.id, id));
  if (!found.length) return json({ success: false, error: "Không tìm thấy yêu cầu." }, 404);
  const request = found[0];
  if (String(request.status || "PENDING").toUpperCase() !== "PENDING") {
    return json({ success: false, error: "Yêu cầu đã được xử lý." }, 409);
  }
  const employee = await assertCanManage(actor, request.employeeId);
  if (request.targetDate) await assertPeriodOpen(request.targetDate);

  let payload: Record<string, unknown> = {};
  try {
    payload = request.payload ? JSON.parse(request.payload) : {};
  } catch {
    payload = {};
  }

  const now = Date.now();
  const kind = String(request.kind).toUpperCase();

  if (approve && kind === "ADJUST_PUNCH") {
    const workDate = str(request.targetDate);
    const wanted = Array.isArray(payload.punches) ? payload.punches : [];
    const settings = await getSettings();
    const rows: (typeof attPunches.$inferInsert)[] = [];
    for (const item of wanted) {
      const entry = item as Record<string, unknown>;
      const time = str(entry.time);
      if (!/^\d{1,2}:\d{2}$/.test(time)) continue;
      const punchType = str(entry.type).toUpperCase() === "OUT" ? "OUT" : "IN";
      const evaluation = evaluatePunch(punchType, time, settings.workHours);
      rows.push({
        employeeId: request.employeeId,
        workDate,
        punchType,
        punchAt: vnEpoch(workDate, time),
        session: evaluation.session,
        status: evaluation.status,
        minutesDelta: evaluation.minutesDelta,
        device: "Duyệt yêu cầu điều chỉnh",
        ip: actor.ip || null,
        source: "REQUEST",
        requestId: request.id,
        note: note || request.reason,
        createdBy: actor.user.id,
        createdAt: now,
      });
    }
    if (!rows.length) return json({ success: false, error: "Yêu cầu không có mốc giờ hợp lệ để ghi nhận." }, 400);

    // Lượt chấm cũ cùng buổi cùng loại được thay bằng số đã duyệt, bản cũ vào lịch sử.
    const existing = await db
      .select()
      .from(attPunches)
      .where(and(eq(attPunches.employeeId, request.employeeId), eq(attPunches.workDate, workDate)));
    for (const row of rows) {
      const replaced = existing.find(
        (p) =>
          String(p.punchType).toUpperCase() === row.punchType &&
          String(p.session || "").toUpperCase() === row.session
      );
      if (replaced) {
        await db.delete(attPunches).where(eq(attPunches.id, replaced.id));
        await writeAudit(actor, {
          entity: "punch",
          entityId: String(replaced.id),
          action: "REPLACED_BY_REQUEST",
          field: "punchAt",
          oldValue: { time: vnTime(replaced.punchAt), punchType: replaced.punchType },
          newValue: { time: vnTime(row.punchAt as number), requestId: request.id },
        });
      }
    }
    await db.insert(attPunches).values(rows);
  }

  if (approve && kind === "SWAP_DUTY") {
    const assignmentId = str(payload.assignmentId);
    const toEmployeeId = str(payload.toEmployeeId);
    const duty = await db.select().from(attDutyAssignments).where(eq(attDutyAssignments.id, assignmentId));
    if (!duty.length) return json({ success: false, error: "Suất trực trong yêu cầu không còn tồn tại." }, 404);
    await db
      .update(attDutyAssignments)
      .set({ employeeId: toEmployeeId, swappedFromEmployeeId: request.employeeId, updatedAt: now })
      .where(eq(attDutyAssignments.id, assignmentId));
    // Người cũ đã nhận ca trước đó thì bản ghi chấm trực phải theo người mới.
    await db
      .update(attDutyLogs)
      .set({ employeeId: toEmployeeId, updatedAt: now })
      .where(eq(attDutyLogs.assignmentId, assignmentId));
    await writeAudit(actor, {
      entity: "duty_assignment",
      entityId: assignmentId,
      action: "SWAP_APPROVED",
      field: "employeeId",
      oldValue: request.employeeId,
      newValue: toEmployeeId,
    });
    await notify(
      toEmployeeId,
      "Nhận ca trực thay",
      `Bạn nhận ca trực ngày ${duty[0].dutyDate} thay cho ${employee.fullName}.`,
      "DUTY",
      assignmentId
    );
  }

  await db
    .update(attRequests)
    .set({
      status: approve ? "APPROVED" : "REJECTED",
      decidedBy: actor.user.id,
      decidedByName: actor.employee?.fullName || actor.user.name,
      decidedAt: now,
      decisionNote: note || null,
      updatedAt: now,
    })
    .where(eq(attRequests.id, id));

  await writeAudit(actor, {
    entity: "request",
    entityId: id,
    action: approve ? "APPROVE" : "REJECT",
    newValue: { kind, employee: employee.fullName, note },
  });
  await notify(
    request.employeeId,
    approve ? "Yêu cầu được duyệt" : "Yêu cầu bị từ chối",
    `${kind === "ADJUST_PUNCH" ? "Yêu cầu điều chỉnh chấm công" : "Yêu cầu đổi ca trực"} ngày ${
      request.targetDate || ""
    } ${approve ? "đã được duyệt" : "không được duyệt"}.${note ? ` Ý kiến: ${note}` : ""}`,
    "REQUEST",
    id
  );

  return json({ success: true, message: approve ? "Đã duyệt yêu cầu." : "Đã từ chối yêu cầu." });
}

async function decideLeave(actor: ActorContext, body: Record<string, unknown>) {
  requireManager(actor);
  const id = str(body.id);
  const approve = str(body.decision).toUpperCase() !== "REJECT";
  const note = str(body.note);

  const found = await db.select().from(attLeaves).where(eq(attLeaves.id, id));
  if (!found.length) return json({ success: false, error: "Không tìm thấy đơn nghỉ." }, 404);
  const leave = found[0];
  if (String(leave.status || "PENDING").toUpperCase() !== "PENDING") {
    return json({ success: false, error: "Đơn nghỉ đã được xử lý." }, 409);
  }
  const employee = await assertCanManage(actor, leave.employeeId);
  await assertPeriodOpen(leave.fromDate);

  const now = Date.now();
  await db
    .update(attLeaves)
    .set({
      status: approve ? "APPROVED" : "REJECTED",
      decidedBy: actor.user.id,
      decidedByName: actor.employee?.fullName || actor.user.name,
      decidedAt: now,
      decisionNote: note || null,
      updatedAt: now,
    })
    .where(eq(attLeaves.id, id));

  await writeAudit(actor, {
    entity: "leave",
    entityId: id,
    action: approve ? "APPROVE" : "REJECT",
    newValue: { employee: employee.fullName, fromDate: leave.fromDate, toDate: leave.toDate, note },
  });
  await notify(
    leave.employeeId,
    approve ? "Đơn nghỉ được duyệt" : "Đơn nghỉ bị từ chối",
    `Đơn nghỉ ${leave.fromDate} - ${leave.toDate} ${approve ? "đã được duyệt" : "không được duyệt"}.${
      note ? ` Ý kiến: ${note}` : ""
    }`,
    "LEAVE",
    id
  );
  return json({ success: true, message: approve ? "Đã duyệt đơn nghỉ." : "Đã từ chối đơn nghỉ." });
}

// ---------------------------------------------------------------------------
//  Khoá kỳ bảng công
// ---------------------------------------------------------------------------

/**
 * Khoá / mở kỳ bảng công.
 *
 * Khoá là điều kiện để con số trên bảng công tháng có giá trị đối chiếu: sau
 * khi khoá, không ai - kể cả Quản trị - ghi thêm được dữ liệu của tháng đó.
 * Mở lại được phép nhưng để lại dấu trong lịch sử thao tác.
 */
async function setPeriodLock(actor: ActorContext, body: Record<string, unknown>, lock: boolean) {
  requireAdmin(actor);
  const period = str(body.period);
  if (!isValidPeriod(period)) return json({ success: false, error: "Kỳ không hợp lệ." }, 400);

  const now = Date.now();
  const existing = await db.select().from(attPeriods).where(eq(attPeriods.id, period));
  const patch = {
    status: lock ? "LOCKED" : "OPEN",
    lockedBy: lock ? actor.user.id : null,
    lockedByName: lock ? actor.employee?.fullName || actor.user.name : null,
    lockedAt: lock ? now : null,
    note: str(body.note) || null,
    updatedAt: now,
  };
  if (existing.length) await db.update(attPeriods).set(patch).where(eq(attPeriods.id, period));
  else await db.insert(attPeriods).values({ id: period, ...patch });

  await writeAudit(actor, {
    entity: "period",
    entityId: period,
    action: lock ? "LOCK" : "UNLOCK",
    newValue: { note: str(body.note) },
  });
  return json({
    success: true,
    message: lock
      ? `Đã khoá bảng công kỳ ${period}. Mọi thao tác ghi dữ liệu của kỳ này bị từ chối.`
      : `Đã mở lại bảng công kỳ ${period}.`,
  });
}

// ---------------------------------------------------------------------------
//  Điều phối
// ---------------------------------------------------------------------------

export default async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: JSON_HEADERS, status: 204 });

  try {
    const actor = await resolveActor(req);
    const url = new URL(req.url);

    if (req.method === "GET") {
      const view = str(url.searchParams.get("view")) || "overview";
      const period = str(url.searchParams.get("period")) || periodOf(vnDate());
      switch (view) {
        case "overview":
          requireManager(actor);
          return await handleOverview(actor);
        case "departments":
          requireManager(actor);
          return await handleDepartments();
        case "employees":
          requireManager(actor);
          return await handleEmployees(actor);
        case "accounts":
          return await handleAccounts(actor);
        case "shifts":
          return await handleShifts(actor);
        case "holidays":
          return await handleHolidays();
        case "settings":
          return await handleSettings();
        case "roster":
          requireManager(actor);
          return await handleRoster(period);
        case "approvals":
          return await handleApprovals(actor, str(url.searchParams.get("status")));
        case "not_punched":
          return await handleNotPunched(actor, str(url.searchParams.get("date")) || vnDate());
        case "periods":
          requireManager(actor);
          return await handlePeriods();
        case "audits":
          return await handleAudits(actor, url);
        default:
          return json({ success: false, error: "Yêu cầu xem dữ liệu không hợp lệ." }, 400);
      }
    }

    if (req.method !== "POST") return json({ success: false, error: "Method not allowed" }, 405);

    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return json({ success: false, error: "Nội dung yêu cầu không hợp lệ." }, 400);

    switch (str(body.action)) {
      // Danh mục
      case "department_save":
        return await saveDepartment(actor, body);
      case "department_delete":
        return await deleteDepartment(actor, body);
      case "employee_save":
        return await saveEmployee(actor, body);
      case "employee_delete":
        return await deleteEmployee(actor, body);
      case "shift_save":
        return await saveShift(actor, body);
      case "shift_delete":
        return await deleteShift(actor, body);
      case "holiday_save":
        return await saveHoliday(actor, body);
      case "holiday_delete":
        return await deleteHoliday(actor, body);
      case "settings_save":
        return await saveSettings(actor, body);
      case "seed_defaults":
        requireAdmin(actor);
        await ensureSeedData();
        await writeAudit(actor, { entity: "settings", entityId: "seed", action: "SEED_DEFAULTS" });
        return json({ success: true, message: "Đã nạp danh mục ca trực mẫu.", shifts: (await listShifts(true)).map(publicShift) });

      // Tài khoản
      case "account_link":
        return await linkAccount(actor, body);
      case "account_unlink":
        return await unlinkAccount(actor, body);
      case "account_grant":
        return await grantAccess(actor, body);
      case "account_create":
        return await createAccount(actor, body);
      case "account_reset_password":
        return await resetAccountPassword(actor, body);

      // Lịch trực
      case "roster_assign":
        return await assignDuty(actor, body);
      case "roster_remove":
        return await removeDuty(actor, body);
      case "roster_copy_previous":
        return await copyPreviousRoster(actor, body);
      case "roster_auto":
        return await autoAssignRoster(actor, body);
      case "roster_import":
        return await importRoster(actor, body);

      // Dữ liệu công
      case "punch_save":
        return await savePunch(actor, body);
      case "punch_delete":
        return await deletePunch(actor, body);
      case "duty_log_save":
        return await saveDutyLog(actor, body);
      case "leave_save":
        return await saveLeave(actor, body);

      // Duyệt
      case "decide_request":
        return await decideRequest(actor, body);
      case "decide_leave":
        return await decideLeave(actor, body);

      // Kỳ bảng công
      case "period_lock":
        return await setPeriodLock(actor, body, true);
      case "period_unlock":
        return await setPeriodLock(actor, body, false);

      default:
        return json({ success: false, error: "Hành động không hợp lệ." }, 400);
    }
  } catch (err: unknown) {
    const authResponse = authErrorResponse(err, JSON_HEADERS);
    if (authResponse) return authResponse;
    if (err instanceof AuthError) {
      return json({ success: false, code: err.code, error: err.message }, err.status);
    }
    console.error("attendance-admin error", err);
    return json({ success: false, error: "Hệ thống chấm công đang gián đoạn. Vui lòng thử lại." }, 500);
  }
};

export const config = {
  path: "/api/attendance/admin",
};
