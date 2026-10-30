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
 *        roster_clear_preview  số liệu sẽ bị xoá khi xoá lịch trực cả tháng
 *        roster_scope    phân trực theo điểm trạm: danh mục, quy tắc, nhóm trực,
 *                        điều động, cán bộ đủ điều kiện tại từng điểm
 *        employee_postings  lịch sử công tác của một cán bộ
 *        approvals       yêu cầu điều chỉnh / đổi ca / đơn nghỉ đang chờ
 *        not_punched     ai chưa chấm công trong một ngày
 *        periods         trạng thái khoá các kỳ
 *        audits          lịch sử thao tác
 *        roles           vai trò hệ thống + vai trò tuỳ chỉnh và danh mục quyền
 *
 *   POST /api/attendance/admin  { action: ... }
 *        Danh mục:   department_save | department_delete | employee_save |
 *                    employee_delete | shift_save | shift_delete |
 *                    holiday_save | holiday_delete | settings_save
 *        Vai trò:    role_save | role_delete (chỉ Quản trị hệ thống)
 *        Tài khoản:  account_link | account_unlink | account_grant |
 *                    account_create | account_reset_password
 *        Lịch trực:  roster_assign | roster_remove | roster_copy_previous |
 *                    roster_auto | roster_import | roster_rules_save |
 *                    roster_rules_reset (chỉ Quản trị hệ thống) |
 *                    roster_clear_month | roster_restore_snapshot |
 *                    roster_auto_preview (xem trước, không ghi)
 *        Phân trực theo điểm trạm:
 *                    workplace_save | workplace_delete | duty_group_save |
 *                    duty_group_delete | duty_rule_save | duty_rule_status |
 *                    duty_rule_delete | secondment_save |
 *                    secondment_decide (chỉ Quản trị hệ thống)
 *        Dữ liệu:    punch_save | punch_delete | duty_log_save | duty_log_void | leave_save
 *                    (không sửa/xoá bản gốc: tạo đề nghị ADMIN_ADJUST chờ người duyệt
 *                    khác, hoặc áp qua bản ghi điều chỉnh khi tắt chế độ bốn mắt)
 *        Duyệt:      decide_request | decide_leave
 *        Kỳ:         period_lock | period_unlock
 *
 * PHÂN QUYỀN: Phụ trách bộ phận chỉ xem được bộ phận mình và chỉ duyệt được
 * yêu cầu của người trong bộ phận mình (visibleEmployeeIds + assertCanManage).
 * Mọi hành động sửa danh mục, cấu hình, lịch trực và khoá kỳ là của Quản trị,
 * hoặc của vai trò tuỳ chỉnh được Quản trị cấp đúng quyền đó (requirePermission).
 * Tạo/sửa vai trò và phân vai trò cho cán bộ thì chỉ Quản trị hệ thống làm được.
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
  attRoles,
  attRosterSnapshots,
  attWorkplaces,
  attDutyGroups,
  attDutyGroupMembers,
  attDutyRules,
  attEmployeePostings,
  attSecondments,
  stationRooms,
  users,
} from "../../db/schema.js";
import {
  BASELINE_DATE,
  DUTY_STATUSES,
  DUTY_STATUS_LABEL,
  REASON_LABEL,
  SCOPE_MODES,
  SCOPE_MODE_LABEL,
  buildPlan,
  checkManualAssignment,
  dutyStatusOf,
  isActive,
  loadCatalog,
  loadPlanContext,
  parseHeadcount,
  parseIdList,
  parsePersonalRule,
  postingOn,
  ruleConflicts,
  ruleProblems,
  scopeCheck,
  type Plan,
  type PlanContext,
} from "../lib/duty-scope.js";
import { and, asc, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { AdjustmentConflict, applyDutyLogChange, applyPunchChange, type Approval, type PunchRow } from "../lib/adjustments.js";
import { getSecurity, raiseAlert } from "../lib/security.js";
import { revokeOtherSessions } from "../lib/sessions.js";
import { isImmutableViolation, isUniqueViolation } from "../lib/presence.js";
import {
  authErrorResponse,
  generateTemporaryPassword,
  hashPassword,
  isAdminRole,
  validatePasswordStrength,
  type UserRow,
} from "../lib/auth.js";
import {
  ACTIVE_DUTY_LOG,
  ACTIVE_PUNCH,
  AuthError,
  csrfCheck,
  DEFAULT_LEAVE_TYPES,
  DEFAULT_ORG,
  DEFAULT_ROSTER_RULES,
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
  deleteSetting,
  ensureSeedData,
  evaluatePunch,
  getSettings,
  hasPermission,
  isBuiltinRole,
  isValidDate,
  isValidPeriod,
  json,
  listHolidays,
  listRoles,
  parsePermissions,
  parseScope,
  PERMISSIONS,
  listShifts,
  newId,
  notify,
  notifyApprovers,
  num,
  periodDates,
  periodOf,
  periodStatus,
  publicEmployee,
  publicShift,
  requireAdmin,
  requireManager,
  requirePermission,
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
  type RosterRules,
} from "../lib/attendance.js";

/** Mã vai trò tuỳ chỉnh: chữ in hoa, số và gạch dưới, 2-30 ký tự. */
const ROLE_CODE_RE = /^[A-Z][A-Z0-9_]{1,29}$/;
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
        .where(and(eq(attPunches.workDate, today), inArray(attPunches.employeeId, ids), ACTIVE_PUNCH))
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
        .where(and(eq(attDutyLogs.dutyDate, today), inArray(attDutyLogs.employeeId, ids), ACTIVE_DUTY_LOG))
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
  const mine = (employeeId: string) => actor.role === "ADMIN" || actor.scope === "ALL" || scope.has(employeeId);

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
  requirePermission(actor, "accounts.manage");
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
  if (hasPermission(actor, "shifts.manage")) await ensureSeedData();
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
      rosterRules: DEFAULT_ROSTER_RULES,
    },
    keys: SETTING_KEYS,
  });
}

/** Lịch trực tháng dưới dạng bảng ngày x ca, kèm chỗ trống chưa phân người. */
async function handleRoster(actor: ActorContext, period: string) {
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
      .where(and(gte(attDutyLogs.dutyDate, dates[0]), lte(attDutyLogs.dutyDate, dates[dates.length - 1]), ACTIVE_DUTY_LOG)),
    periodStatus(period),
  ]);
  const catalog = await loadCatalog();
  const postingsByEmp = new Map<string, typeof catalog.postings>();
  for (const p of catalog.postings) postingsByEmp.set(p.employeeId, [...(postingsByEmp.get(p.employeeId) || []), p]);
  const stationName = new Map(catalog.stations.map((st) => [st.stationCode, st.stationName]));
  const wpName = new Map(catalog.workplaces.map((w) => [w.id, w.name]));
  const deptName = new Map(catalog.departments.map((d) => [d.id, d.name]));

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
            const emp = empById.get(a.employeeId);
            // Suất cũ chưa chốt phạm vi: tra theo lịch sử công tác (mã định danh), không theo tên.
            const posting = emp ? postingOn(emp, postingsByEmp.get(emp.id), a.dutyDate) : null;
            const st = a.stationCode || posting?.stationCode || "";
            const dp = a.departmentId || posting?.departmentId || "";
            const wp = a.workplaceId || (a.stationCode ? "" : posting?.workplaceId || "");
            return {
              assignmentId: a.id,
              stationCode: st,
              stationName: stationName.get(st) || "",
              stationInferred: !a.stationCode && Boolean(st),
              departmentId: dp,
              departmentName: deptName.get(dp) || "",
              workplaceId: wp,
              workplaceName: wpName.get(wp) || "",
              ruleId: a.ruleId || "",
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
      .map((e) => ({
        employeeId: e.id,
        fullName: e.fullName,
        code: e.code,
        shifts: counts.get(e.id) || 0,
        stationCode: postingOn(e, postingsByEmp.get(e.id), dates[0]).stationCode || "",
        departmentId: e.departmentId || "",
        workplaceId: e.workplaceId || "",
      })),
    filters: {
      stations: catalog.stations.map((st) => ({ code: st.stationCode, name: st.stationName })),
      departments: catalog.departments.map((d) => ({ id: d.id, name: d.name })),
      workplaces: catalog.workplaces.map((w) => ({ id: w.id, name: w.name, stationCode: w.stationCode })),
    },
    rules: settings.rosterRules,
    defaultRules: DEFAULT_ROSTER_RULES,
    canResetRules: actor.role === "ADMIN",
    canManageRoster: hasPermission(actor, "roster.manage"),
  });
}

/** Việc đang chờ duyệt, đã lọc theo tầm nhìn của người duyệt. */
async function handleApprovals(actor: ActorContext, status: string) {
  requirePermission(actor, "approvals.decide");
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
  requirePermission(actor, "manage.view");
  if (!isValidDate(date)) return json({ success: false, error: "Ngày không hợp lệ." }, 400);
  const employees = (await scopedEmployees(actor)).filter(
    (e) => String(e.status || "ACTIVE").toUpperCase() === "ACTIVE"
  );
  const ids = employees.map((e) => e.id);
  const settings = await getSettings();
  const dayType = classifyDay(date, buildHolidayMap(await listHolidays()), settings.workHours);
  const [punches, leaves, duties, deptNames] = await Promise.all([
    ids.length
      ? db.select().from(attPunches).where(and(eq(attPunches.workDate, date), inArray(attPunches.employeeId, ids), ACTIVE_PUNCH))
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
  requirePermission(actor, "audits.view");
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
  requirePermission(actor, "employees.manage");
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
  requirePermission(actor, "employees.manage");
  const id = str(body.id);
  const used = await db.select().from(attEmployees).where(eq(attEmployees.departmentId, id));
  if (used.length) {
    return json(
      { success: false, error: `Còn ${used.length} cán bộ thuộc bộ phận này. Chuyển họ sang bộ phận khác trước khi xoá.` },
      409
    );
  }
  const [post, wp, rule, duty] = await Promise.all([
    db.select({ id: attEmployeePostings.id }).from(attEmployeePostings).where(eq(attEmployeePostings.departmentId, id)).limit(1),
    db.select({ id: attWorkplaces.id }).from(attWorkplaces).where(eq(attWorkplaces.departmentId, id)).limit(1),
    db.select({ id: attDutyRules.id }).from(attDutyRules).where(eq(attDutyRules.departmentId, id)).limit(1),
    db.select({ id: attDutyAssignments.id }).from(attDutyAssignments).where(eq(attDutyAssignments.departmentId, id)).limit(1),
  ]);
  if (post.length || wp.length || rule.length || duty.length) {
    // Còn trong lịch sử công tác, nơi làm việc, quy tắc hoặc lịch trực: giữ lại để tra cứu.
    await db.update(attDepartments).set({ status: "INACTIVE", updatedAt: Date.now() }).where(eq(attDepartments.id, id));
    await writeAudit(actor, { entity: "department", entityId: id, action: "DEACTIVATE" });
    return json({ success: true, message: "Bộ phận còn trong lịch sử công tác, quy tắc hoặc lịch trực nên chỉ ngừng sử dụng.", deactivated: true });
  }
  await db.delete(attDepartments).where(eq(attDepartments.id, id));
  await writeAudit(actor, { entity: "department", entityId: id, action: "DELETE" });
  return json({ success: true, message: "Đã xoá bộ phận." });
}

async function saveEmployee(actor: ActorContext, body: Record<string, unknown>) {
  requirePermission(actor, "employees.manage");
  const id = str(body.id);
  const code = str(body.code).toUpperCase();
  const fullName = str(body.fullName);
  if (!code) return json({ success: false, error: "Mã cán bộ là bắt buộc." }, 400);
  if (!fullName) return json({ success: false, error: "Họ và tên là bắt buộc." }, 400);

  const clash = await db.select().from(attEmployees).where(eq(attEmployees.code, code));
  if (clash.length && clash[0].id !== id) {
    return json({ success: false, error: `Mã cán bộ "${code}" đã tồn tại.` }, 409);
  }

  const existingRows = id ? await db.select().from(attEmployees).where(eq(attEmployees.id, id)) : [];
  if (id && !existingRows.length) return json({ success: false, error: "Không tìm thấy cán bộ." }, 404);
  const currentRole = existingRows.length ? String(existingRows[0].attendanceRole || "STAFF").toUpperCase() : "STAFF";
  assertCanTouchRole(actor, currentRole);

  // Chỉ Quản trị hệ thống được phân vai trò. Người khác giữ quyền quản lý hồ sơ
  // vẫn sửa được thông tin cán bộ nhưng vai trò giữ nguyên - nếu không, họ tự
  // nâng quyền cho mình hoặc người thân quen được.
  let role = currentRole;
  if (actor.role === "ADMIN") {
    const requested = str(body.attendanceRole).toUpperCase() || "STAFF";
    if (!(await roleExists(requested))) {
      return json({ success: false, error: `Vai trò "${requested}" không tồn tại hoặc đã ngừng dùng.` }, 400);
    }
    role = requested;
  }
  const startDate = str(body.startDate);
  if (startDate && !isValidDate(startDate)) return json({ success: false, error: "Ngày bắt đầu làm việc không hợp lệ." }, 400);

  // --- Phạm vi công tác: chỉ nhận mã trong danh mục, không nhận tên tự do ---
  const stationCode = str(body.stationCode).toUpperCase() || null;
  const departmentId = str(body.departmentId) || null;
  const workplaceId = str(body.workplaceId) || null;
  if (stationCode && !(await requireStation(stationCode))) {
    return json({ success: false, error: `Điểm trạm "${stationCode}" không có trong danh mục.` }, 400);
  }
  if (departmentId) {
    const d = await db.select().from(attDepartments).where(eq(attDepartments.id, departmentId));
    if (!d.length) return json({ success: false, error: "Khoa/phòng không có trong danh mục." }, 400);
  }
  if (workplaceId) {
    const w = await db.select().from(attWorkplaces).where(eq(attWorkplaces.id, workplaceId));
    if (!w.length) return json({ success: false, error: "Nơi làm việc không có trong danh mục." }, 400);
    if (!stationCode || w[0].stationCode !== stationCode) {
      return json({ success: false, error: `Nơi làm việc ${w[0].name} không thuộc điểm trạm đã chọn.` }, 400);
    }
    if (w[0].departmentId && departmentId && w[0].departmentId !== departmentId) {
      return json({ success: false, error: `Nơi làm việc ${w[0].name} thuộc khoa/phòng khác với khoa/phòng đã chọn.` }, 400);
    }
  }
  const dutyStatusRaw = str(body.dutyStatus).toUpperCase() || "ACTIVE";
  if (!(DUTY_STATUSES as readonly string[]).includes(dutyStatusRaw)) return json({ success: false, error: "Trạng thái làm việc không hợp lệ." }, 400);
  const allowedShiftIds = parseIdList(body.allowedShiftIds);
  if (allowedShiftIds.length) {
    const found = await db.select({ id: attShifts.id }).from(attShifts).where(inArray(attShifts.id, allowedShiftIds));
    if (found.length !== allowedShiftIds.length) return json({ success: false, error: "Danh sách ca được phép có ca không tồn tại." }, 400);
  }
  const personal = parsePersonalRule(body.dutyRule);
  const hasPersonal = personal.maxPerMonth || personal.maxWeekendHolidayPerMonth || personal.excludedWeekdays.length;
  const dutyGroupIds = body.dutyGroupIds === undefined ? null : parseIdList(body.dutyGroupIds);
  if (dutyGroupIds && dutyGroupIds.length) {
    const groups = await db.select().from(attDutyGroups).where(inArray(attDutyGroups.id, dutyGroupIds));
    if (groups.length !== dutyGroupIds.length) return json({ success: false, error: "Nhóm trực không có trong danh mục." }, 400);
    if (dutyGroupIds.length > 1 && !(await getSettings()).rosterRules.allowMultiGroup) {
      return json({ success: false, error: "Cấu hình phạm vi phân trực hiện không cho phép một cán bộ thuộc nhiều nhóm trực." }, 400);
    }
  }
  const { today } = todayContext();
  const effectiveFrom = str(body.effectiveFrom) || today;
  if (!isValidDate(effectiveFrom)) return json({ success: false, error: "Ngày hiệu lực của thay đổi công tác không hợp lệ." }, 400);

  const postings = id
    ? (await db.select().from(attEmployeePostings).where(eq(attEmployeePostings.employeeId, id))).sort((a, b) =>
        a.effectiveFrom.localeCompare(b.effectiveFrom)
      )
    : [];
  const before = existingRows.length ? postingOn(existingRows[0], postings, effectiveFrom) : null;
  const scopeChanged = before
    ? before.stationCode !== stationCode || before.departmentId !== departmentId || before.workplaceId !== workplaceId
    : Boolean(stationCode || departmentId || workplaceId);
  if (scopeChanged) await assertPeriodOpen(effectiveFrom);

  const now = Date.now();
  const actorName = actor.employee?.fullName || actor.user.name;
  // Hồ sơ hiện hành = phạm vi có hiệu lực hôm nay. Thay đổi có hiệu lực ở tương
  // lai chỉ được ghi vào lịch sử công tác và tự áp dụng khi tới ngày.
  let current = { stationCode, departmentId, workplaceId };
  if (scopeChanged) {
    const projected = postings.filter((p) => p.effectiveFrom !== effectiveFrom);
    projected.push({
      id: "", employeeId: id, stationCode, departmentId, workplaceId, effectiveFrom,
      reason: null, createdBy: null, createdByName: null, createdAt: now,
    });
    if (!postings.length && existingRows.length) {
      const e = existingRows[0];
      if (e.stationCode || e.departmentId || e.workplaceId) {
        projected.push({
          id: "", employeeId: id, stationCode: e.stationCode, departmentId: e.departmentId, workplaceId: e.workplaceId,
          effectiveFrom: BASELINE_DATE, reason: null, createdBy: null, createdByName: null, createdAt: now,
        });
      }
    }
    projected.sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
    const p = postingOn(existingRows[0] || ({} as EmployeeRow), projected, today);
    current = { stationCode: p.stationCode, departmentId: p.departmentId, workplaceId: p.workplaceId };
  } else if (existingRows.length) {
    current = { stationCode: existingRows[0].stationCode, departmentId: existingRows[0].departmentId, workplaceId: existingRows[0].workplaceId };
  }

  const patch = {
    code,
    fullName,
    position: str(body.position) || null,
    departmentId: current.departmentId,
    stationCode: current.stationCode,
    workplaceId: current.workplaceId,
    dutyStatus: dutyStatusRaw,
    allowedShiftIds: JSON.stringify(allowedShiftIds),
    dutyRule: hasPersonal ? JSON.stringify(personal) : null,
    attendanceRole: role,
    phone: str(body.phone) || null,
    email: str(body.email) || null,
    startDate: startDate || null,
    status: str(body.status).toUpperCase() === "INACTIVE" ? "INACTIVE" : "ACTIVE",
    note: str(body.note) || null,
    displayOrder: num(body.displayOrder, 0),
    updatedAt: now,
  };

  let empId = id;
  if (id) {
    await db.update(attEmployees).set(patch).where(eq(attEmployees.id, id));
    await writeAudit(actor, { entity: "employee", entityId: id, action: "UPDATE", oldValue: existingRows[0], newValue: patch });
  } else {
    empId = newId("emp");
    await db.insert(attEmployees).values({ id: empId, ...patch, userId: null, createdAt: now });
    await writeAudit(actor, { entity: "employee", entityId: empId, action: "CREATE", newValue: patch });
  }

  let scopeNote = "";
  if (scopeChanged) {
    if (!postings.length && existingRows.length) {
      const e = existingRows[0];
      if ((e.stationCode || e.departmentId || e.workplaceId) && effectiveFrom > BASELINE_DATE) {
        await db.insert(attEmployeePostings).values({
          id: newId("post"), employeeId: empId, stationCode: e.stationCode, departmentId: e.departmentId,
          workplaceId: e.workplaceId, effectiveFrom: BASELINE_DATE, reason: "Phạm vi công tác trước khi ghi lịch sử",
          createdBy: actor.user.id, createdByName: actorName, createdAt: now,
        });
      }
    }
    await db
      .insert(attEmployeePostings)
      .values({
        id: newId("post"), employeeId: empId, stationCode, departmentId, workplaceId, effectiveFrom,
        reason: str(body.changeReason) || null, createdBy: actor.user.id, createdByName: actorName, createdAt: now,
      })
      .onConflictDoUpdate({
        target: [attEmployeePostings.employeeId, attEmployeePostings.effectiveFrom],
        set: { stationCode, departmentId, workplaceId, reason: str(body.changeReason) || null, createdBy: actor.user.id, createdByName: actorName, createdAt: now },
      });
    await writeAudit(actor, {
      entity: "employee_posting",
      entityId: empId,
      action: "SET",
      oldValue: before,
      newValue: { stationCode, departmentId, workplaceId, effectiveFrom },
      reason: str(body.changeReason) || null,
    });
    if (effectiveFrom > today) scopeNote = ` Thay đổi công tác có hiệu lực từ ${effectiveFrom}; hồ sơ hiện hành giữ nguyên tới ngày đó.`;
    // Không tự sửa lịch đã phân: chỉ báo để Quản trị xem lại.
    if (id) {
      const later = await db
        .select()
        .from(attDutyAssignments)
        .where(and(eq(attDutyAssignments.employeeId, id), gte(attDutyAssignments.dutyDate, effectiveFrom)));
      const affected = later.filter(
        (a) => String(a.status || "PLANNED").toUpperCase() !== "CANCELLED" && a.stationCode && a.stationCode !== stationCode
      );
      if (affected.length) {
        scopeNote += ` Có ${affected.length} suất trực đã phân từ ${effectiveFrom} ở điểm trạm cũ - lịch đó được giữ nguyên, hãy xem lại nếu cần.`;
      }
    }
  }
  if (dutyGroupIds) await syncEmployeeGroups(actor, empId, dutyGroupIds);

  return json({ success: true, message: (id ? "Đã cập nhật hồ sơ cán bộ." : "Đã thêm cán bộ.") + scopeNote, id: empId });
}

/** Đặt danh sách nhóm trực đã duyệt của một cán bộ. */
async function syncEmployeeGroups(actor: ActorContext, employeeId: string, groupIds: string[]) {
  const now = Date.now();
  const current = await db.select().from(attDutyGroupMembers).where(eq(attDutyGroupMembers.employeeId, employeeId));
  const want = new Set(groupIds);
  const approver = { approvedBy: actor.user.id, approvedByName: actor.employee?.fullName || actor.user.name, approvedAt: now };
  const changes: { added: string[]; removed: string[] } = { added: [], removed: [] };
  for (const m of current) {
    const approved = String(m.status || "APPROVED").toUpperCase() === "APPROVED";
    if (want.has(m.groupId) && !approved) {
      await db.update(attDutyGroupMembers).set({ status: "APPROVED", ...approver }).where(eq(attDutyGroupMembers.id, m.id));
      changes.added.push(m.groupId);
    } else if (!want.has(m.groupId) && approved) {
      await db.update(attDutyGroupMembers).set({ status: "REVOKED", ...approver }).where(eq(attDutyGroupMembers.id, m.id));
      changes.removed.push(m.groupId);
    }
  }
  const known = new Set(current.map((m) => m.groupId));
  const fresh = groupIds.filter((g) => !known.has(g));
  if (fresh.length) {
    await db.insert(attDutyGroupMembers).values(
      fresh.map((groupId) => ({ id: newId("dgm"), groupId, employeeId, status: "APPROVED", ...approver, createdAt: now }))
    );
    changes.added.push(...fresh);
  }
  if (changes.added.length || changes.removed.length) {
    await writeAudit(actor, { entity: "employee", entityId: employeeId, action: "DUTY_GROUPS", newValue: changes });
  }
}

/** Lịch sử công tác của một cán bộ (điểm trạm, khoa/phòng, nơi làm việc theo ngày hiệu lực). */
async function handleEmployeePostings(actor: ActorContext, employeeId: string) {
  requirePermission(actor, "employees.manage");
  const rows = await db.select().from(attEmployeePostings).where(eq(attEmployeePostings.employeeId, employeeId));
  const catalog = await loadCatalog();
  return json({
    success: true,
    postings: rows
      .sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom))
      .map((p) => ({
        id: p.id,
        effectiveFrom: p.effectiveFrom === BASELINE_DATE ? "" : p.effectiveFrom,
        stationName: p.stationCode ? catalog.stations.find((s) => s.stationCode === p.stationCode)?.stationName || p.stationCode : "",
        departmentName: p.departmentId ? catalog.departments.find((d) => d.id === p.departmentId)?.name || "" : "",
        workplaceName: p.workplaceId ? catalog.workplaces.find((w) => w.id === p.workplaceId)?.name || "" : "",
        reason: p.reason || "",
        createdByName: p.createdByName || "",
        createdAt: p.createdAt || null,
      })),
  });
}

/**
 * Ngừng theo dõi một cán bộ.
 *
 * Xoá cứng chỉ được phép khi hồ sơ chưa có bất kỳ dữ liệu công nào - nếu không,
 * bảng chấm công các tháng trước sẽ mất người và mất số. Trường hợp đã có dữ
 * liệu thì chuyển sang trạng thái INACTIVE.
 */
async function deleteEmployee(actor: ActorContext, body: Record<string, unknown>) {
  requirePermission(actor, "employees.manage");
  const id = str(body.id);
  const existing = await db.select().from(attEmployees).where(eq(attEmployees.id, id));
  if (!existing.length) return json({ success: false, error: "Không tìm thấy cán bộ." }, 404);
  assertCanTouchRole(actor, String(existing[0].attendanceRole || "STAFF").toUpperCase());

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
  requirePermission(actor, "shifts.manage");
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
  requirePermission(actor, "shifts.manage");
  const id = str(body.id);
  const used = await db.select({ id: attDutyAssignments.id }).from(attDutyAssignments).where(eq(attDutyAssignments.shiftId, id)).limit(1);
  const ruled = await db.select({ id: attDutyRules.id }).from(attDutyRules).where(eq(attDutyRules.shiftId, id)).limit(1);
  if (used.length || ruled.length) {
    // Ca đã xuất hiện trên lịch trực thì xoá đi là làm rỗng lịch cũ.
    await db.update(attShifts).set({ status: "INACTIVE", updatedAt: Date.now() }).where(eq(attShifts.id, id));
    await writeAudit(actor, { entity: "shift", entityId: id, action: "DEACTIVATE" });
    return json({
      success: true,
      message: "Ca trực đã được dùng trong lịch trực hoặc quy tắc phân trực nên chỉ ngừng sử dụng, không xoá để giữ nguyên lịch cũ.",
      deactivated: true,
    });
  }
  await db.delete(attShifts).where(eq(attShifts.id, id));
  await writeAudit(actor, { entity: "shift", entityId: id, action: "DELETE" });
  return json({ success: true, message: "Đã xoá ca trực." });
}

async function saveHoliday(actor: ActorContext, body: Record<string, unknown>) {
  requirePermission(actor, "shifts.manage");
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
  requirePermission(actor, "shifts.manage");
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
  requirePermission(actor, "worktime.manage");
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
//  Vai trò tuỳ chỉnh
// ---------------------------------------------------------------------------

/** Mã vai trò có dùng được để gán không: vai trò hệ thống, hoặc vai trò tuỳ chỉnh đang dùng. */
async function roleExists(code: string): Promise<boolean> {
  if (isBuiltinRole(code)) return true;
  const rows = await db.select().from(attRoles).where(eq(attRoles.code, code));
  return rows.length > 0 && String(rows[0].status || "ACTIVE").toUpperCase() === "ACTIVE";
}

/** Người không phải Quản trị hệ thống không được đụng tới hồ sơ mang vai trò Quản trị. */
function assertCanTouchRole(actor: ActorContext, roleCode: string): void {
  if (actor.role !== "ADMIN" && roleCode === "ADMIN") {
    throw new AuthError(403, "FORBIDDEN", "Chỉ Quản trị hệ thống mới được sửa hồ sơ hoặc tài khoản của Quản trị.");
  }
}

/**
 * Tài khoản đặc quyền (Quản trị cổng thông tin, hoặc gắn với hồ sơ vai trò
 * ADMIN) chỉ Quản trị hệ thống được đặt lại mật khẩu / cấp quyền - nếu không,
 * người giữ quyền quản lý tài khoản chiếm được tài khoản Quản trị.
 */
async function assertCanTouchAccount(actor: ActorContext, account: UserRow): Promise<void> {
  if (actor.role === "ADMIN") return;
  if (isAdminRole(account.role)) assertCanTouchRole(actor, "ADMIN");
  const linked = await db.select().from(attEmployees).where(eq(attEmployees.userId, account.id));
  if (linked.length) assertCanTouchRole(actor, String(linked[0].attendanceRole || "STAFF").toUpperCase());
}

async function handleRoles() {
  return json({
    success: true,
    roles: await listRoles(true),
    permissions: PERMISSIONS,
  });
}

/**
 * Tạo / sửa vai trò tuỳ chỉnh. Mã vai trò không đổi được sau khi tạo vì hồ sơ
 * cán bộ trỏ tới nó bằng mã.
 */
async function saveRole(actor: ActorContext, body: Record<string, unknown>) {
  requireAdmin(actor);
  const id = str(body.id);
  const name = str(body.name);
  if (!name) return json({ success: false, error: "Tên vai trò là bắt buộc." }, 400);
  const permissions = parsePermissions(body.permissions);
  const now = Date.now();
  const patch = {
    name,
    description: str(body.description) || null,
    scope: parseScope(body.scope),
    permissions: JSON.stringify(permissions),
    displayOrder: num(body.displayOrder, 0),
    status: str(body.status).toUpperCase() === "INACTIVE" ? "INACTIVE" : "ACTIVE",
    updatedAt: now,
  };

  if (id) {
    const existing = await db.select().from(attRoles).where(eq(attRoles.id, id));
    if (!existing.length) return json({ success: false, error: "Không tìm thấy vai trò." }, 404);
    await db.update(attRoles).set(patch).where(eq(attRoles.id, id));
    await writeAudit(actor, { entity: "role", entityId: id, action: "UPDATE", oldValue: existing[0], newValue: patch });
    return json({ success: true, message: `Đã cập nhật vai trò "${name}".`, id });
  }

  const code = str(body.code).toUpperCase();
  if (!ROLE_CODE_RE.test(code)) {
    return json({
      success: false,
      error: "Mã vai trò phải bắt đầu bằng chữ cái, chỉ gồm chữ in hoa không dấu, số và dấu gạch dưới (2-30 ký tự).",
    }, 400);
  }
  if (isBuiltinRole(code)) return json({ success: false, error: `"${code}" là mã vai trò hệ thống, hãy chọn mã khác.` }, 409);
  const clash = await db.select().from(attRoles).where(eq(attRoles.code, code));
  if (clash.length) return json({ success: false, error: `Mã vai trò "${code}" đã tồn tại.` }, 409);

  const newRoleId = newId("role");
  await db.insert(attRoles).values({ id: newRoleId, code, ...patch, createdBy: actor.user.id, createdAt: now });
  await writeAudit(actor, { entity: "role", entityId: newRoleId, action: "CREATE", newValue: { code, ...patch } });
  return json({ success: true, message: `Đã tạo vai trò "${name}".`, id: newRoleId });
}

/** Xoá vai trò tuỳ chỉnh. Vai trò đang có người mang thì chỉ cho ngừng dùng. */
async function deleteRole(actor: ActorContext, body: Record<string, unknown>) {
  requireAdmin(actor);
  const id = str(body.id);
  const existing = await db.select().from(attRoles).where(eq(attRoles.id, id));
  if (!existing.length) return json({ success: false, error: "Không tìm thấy vai trò." }, 404);
  const holders = await db.select({ id: attEmployees.id }).from(attEmployees).where(eq(attEmployees.attendanceRole, existing[0].code));
  if (holders.length) {
    return json({
      success: false,
      error: `Vai trò đang được gán cho ${holders.length} cán bộ. Hãy đổi vai trò của họ trước, hoặc chuyển vai trò sang Ngừng dùng.`,
    }, 409);
  }
  await db.delete(attRoles).where(eq(attRoles.id, id));
  await writeAudit(actor, { entity: "role", entityId: id, action: "DELETE", oldValue: existing[0] });
  return json({ success: true, message: `Đã xoá vai trò "${existing[0].name}".` });
}

// ---------------------------------------------------------------------------
//  Tài khoản đăng nhập
// ---------------------------------------------------------------------------

/** Gán một tài khoản hệ thống vào hồ sơ cán bộ và cấp quyền vào phân hệ. */
async function linkAccount(actor: ActorContext, body: Record<string, unknown>) {
  requirePermission(actor, "accounts.manage");
  const employeeId = str(body.employeeId);
  const userId = str(body.userId);
  const employee = await db.select().from(attEmployees).where(eq(attEmployees.id, employeeId));
  if (!employee.length) return json({ success: false, error: "Không tìm thấy cán bộ." }, 404);
  const account = await db.select().from(users).where(eq(users.id, userId));
  if (!account.length) return json({ success: false, error: "Không tìm thấy tài khoản." }, 404);
  assertCanTouchRole(actor, String(employee[0].attendanceRole || "STAFF").toUpperCase());
  await assertCanTouchAccount(actor, account[0]);

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
  requirePermission(actor, "accounts.manage");
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
  requirePermission(actor, "accounts.manage");
  const userId = str(body.userId);
  const granted = flag(body.granted, "false");
  const account = await db.select().from(users).where(eq(users.id, userId));
  if (!account.length) return json({ success: false, error: "Không tìm thấy tài khoản." }, 404);
  await assertCanTouchAccount(actor, account[0]);
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
  requirePermission(actor, "accounts.manage");
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
  const weak = validatePasswordStrength(password, username);
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
  requirePermission(actor, "accounts.manage");
  const userId = str(body.userId);
  const account = await db.select().from(users).where(eq(users.id, userId));
  if (!account.length) return json({ success: false, error: "Không tìm thấy tài khoản." }, 404);
  await assertCanTouchAccount(actor, account[0]);
  // Tự đổi mật khẩu của mình phải qua hộp Đổi mật khẩu (có mật khẩu hiện tại).
  if (account[0].id === actor.user.id) {
    return json({ success: false, error: "Không tự đặt lại mật khẩu của chính mình. Hãy dùng chức năng Đổi mật khẩu." }, 400);
  }
  const password = str(body.password) || generateTemporaryPassword();
  const weak = validatePasswordStrength(password, account[0].username);
  if (weak) return json({ success: false, error: weak }, 400);
  await db
    .update(users)
    .set({ passwordHash: await hashPassword(password), mustChangePassword: "true", updatedAt: Date.now() })
    .where(eq(users.id, userId));
  await revokeOtherSessions(userId, null, "PASSWORD_RESET").catch(() => 0);
  await writeAudit(actor, { entity: "account", entityId: userId, action: "RESET_PASSWORD", newValue: { username: account[0].username } });
  return json({
    success: true,
    message: `Đã đặt lại mật khẩu cho ${account[0].name}.`,
    temporaryPassword: password,
  });
}

// ---------------------------------------------------------------------------
//  Phân trực theo điểm trạm: danh mục, quy tắc, nhóm trực, điều động
// ---------------------------------------------------------------------------

const WORKPLACE_CODE_RE = /^[A-Z0-9_.-]{1,30}$/;

/** Ngày tham chiếu để xem danh sách đủ điều kiện: hôm nay, hoặc ngày đầu tháng đang lập nếu ở tương lai. */
function referenceDate(period: string): string {
  const { today } = todayContext();
  if (!isValidPeriod(period)) return today;
  const first = `${period}-01`;
  return first > today ? first : today;
}

/** Toàn bộ cấu hình phân trực theo điểm trạm cho màn hình "Thiết lập quy tắc". */
async function handleRosterScope(actor: ActorContext, period: string) {
  // Hồ sơ cán bộ cũng cần danh mục điểm trạm / nơi làm việc / nhóm trực để chọn.
  if (!hasPermission(actor, "employees.manage")) requirePermission(actor, "roster.manage");
  const refDate = referenceDate(period);
  const ctx = await loadPlanContext(refDate, refDate);
  const { conflicts } = ruleConflicts(
    ctx.rules.filter((r) => isActive(r.status)),
    ctx.general.scopeMode,
    ctx
  );
  const empName = (id: string) => ctx.empById.get(id)?.fullName || id;
  const memberCount = new Map<string, number>();
  for (const m of ctx.members) {
    if (String(m.status || "APPROVED").toUpperCase() === "APPROVED") memberCount.set(m.groupId, (memberCount.get(m.groupId) || 0) + 1);
  }

  // Cán bộ đủ điều kiện tại từng điểm vào ngày tham chiếu (người của trạm + người được điều động tới).
  const eligibility = ctx.stations.map((st) => {
    const rows = ctx.employees
      .map((e) => {
        const s = scopeCheck(ctx, e, { stationCode: st.stationCode }, refDate);
        const posting = postingOn(e, ctx.postingsByEmp.get(e.id), refDate);
        const home = posting.stationCode === st.stationCode;
        if (!home && !(s.ok && s.secondmentId)) return null;
        return {
          employeeId: e.id,
          code: e.code,
          fullName: e.fullName,
          home,
          seconded: Boolean(s.ok && s.secondmentId),
          departmentName: posting.departmentId ? ctx.deptById.get(posting.departmentId)?.name || "" : "",
          workplaceName: posting.workplaceId ? ctx.workplaceById.get(posting.workplaceId)?.name || "" : "",
          dutyStatus: dutyStatusOf(e),
          active: isActive(e.status),
          eligible: s.ok,
          reason: s.ok ? "" : REASON_LABEL[s.reason] || s.reason,
          groups: (ctx.groupsByEmp.get(e.id) || []).map((g) => ctx.groupById.get(g)?.name || g),
          allowedShifts: parseIdList(e.allowedShiftIds).map((id) => ctx.shiftById.get(id)?.name || id),
        };
      })
      .filter(Boolean);
    return {
      stationCode: st.stationCode,
      stationName: st.stationName,
      status: String(st.status || "ACTIVE").toUpperCase(),
      employees: rows,
      eligibleCount: rows.filter((r) => r && r.eligible).length,
    };
  });

  return json({
    success: true,
    referenceDate: refDate,
    general: ctx.general,
    scopeModes: SCOPE_MODES.map((code) => ({ code, label: SCOPE_MODE_LABEL[code] })),
    dutyStatuses: DUTY_STATUSES.map((code) => ({ code, label: DUTY_STATUS_LABEL[code] })),
    canApproveSecondment: actor.role === "ADMIN",
    stations: ctx.stations.map((s) => ({
      stationCode: s.stationCode,
      stationName: s.stationName,
      status: String(s.status || "ACTIVE").toUpperCase(),
      employeeCount: ctx.employees.filter((e) => isActive(e.status) && postingOn(e, ctx.postingsByEmp.get(e.id), refDate).stationCode === s.stationCode).length,
      ruleCount: ctx.rules.filter((r) => r.stationCode === s.stationCode && isActive(r.status)).length,
    })),
    departments: ctx.departments.map((d) => ({
      id: d.id,
      code: d.code,
      name: d.name,
      status: String(d.status || "ACTIVE").toUpperCase(),
      employeeCount: ctx.employees.filter((e) => isActive(e.status) && e.departmentId === d.id).length,
    })),
    workplaces: ctx.workplaces.map((w) => ({
      id: w.id,
      code: w.code,
      name: w.name,
      stationCode: w.stationCode,
      stationName: ctx.stationById.get(w.stationCode)?.stationName || w.stationCode,
      departmentId: w.departmentId || "",
      departmentName: w.departmentId ? ctx.deptById.get(w.departmentId)?.name || "" : "",
      note: w.note || "",
      displayOrder: w.displayOrder ?? 0,
      status: String(w.status || "ACTIVE").toUpperCase(),
      employeeCount: ctx.employees.filter((e) => isActive(e.status) && e.workplaceId === w.id).length,
    })),
    groups: ctx.groups.map((g) => ({
      id: g.id,
      code: g.code,
      name: g.name,
      stationCode: g.stationCode,
      stationName: ctx.stationById.get(g.stationCode)?.stationName || g.stationCode,
      note: g.note || "",
      status: String(g.status || "ACTIVE").toUpperCase(),
      memberCount: memberCount.get(g.id) || 0,
      memberIds: ctx.members
        .filter((m) => m.groupId === g.id && String(m.status || "APPROVED").toUpperCase() === "APPROVED")
        .map((m) => m.employeeId),
    })),
    rules: ctx.rules
      .slice()
      .sort((a, b) => a.stationCode.localeCompare(b.stationCode) || (b.priority ?? 0) - (a.priority ?? 0) || a.name.localeCompare(b.name, "vi"))
      .map((r) => {
        const eligibleIds = parseIdList(r.eligibleEmployeeIds);
        const target = {
          stationCode: r.stationCode,
          departmentId: r.departmentId,
          workplaceId: r.workplaceId,
          dutyGroupId: r.dutyGroupId,
          eligibleIds,
          allowCrossStation: String(r.allowCrossStation || "false") === "true",
        };
        const eligibleNow = ctx.employees.filter((e) => scopeCheck(ctx, e, target, refDate).ok);
        return {
          id: r.id,
          name: r.name,
          stationCode: r.stationCode,
          stationName: ctx.stationById.get(r.stationCode)?.stationName || r.stationCode,
          departmentId: r.departmentId || "",
          departmentName: r.departmentId ? ctx.deptById.get(r.departmentId)?.name || "" : "",
          workplaceId: r.workplaceId || "",
          workplaceName: r.workplaceId ? ctx.workplaceById.get(r.workplaceId)?.name || "" : "",
          dutyGroupId: r.dutyGroupId || "",
          dutyGroupName: r.dutyGroupId ? ctx.groupById.get(r.dutyGroupId)?.name || "" : "",
          shiftId: r.shiftId,
          shiftName: ctx.shiftById.get(r.shiftId)?.name || r.shiftId,
          weekdayHeadcount: parseHeadcount(r.weekdayHeadcount),
          holidayHeadcount: r.holidayHeadcount ?? null,
          effectiveFrom: r.effectiveFrom,
          effectiveTo: r.effectiveTo || "",
          eligibleEmployeeIds: eligibleIds,
          eligibleNames: eligibleIds.map(empName),
          eligibleNow: eligibleNow.map((e) => ({ id: e.id, fullName: e.fullName })),
          allowCrossStation: target.allowCrossStation,
          maxPerMonth: r.maxPerMonth ?? null,
          maxWeekendHolidayPerMonth: r.maxWeekendHolidayPerMonth ?? null,
          priority: r.priority ?? 0,
          status: String(r.status || "ACTIVE").toUpperCase(),
          note: r.note || "",
          problems: ruleProblems(r, ctx.general.scopeMode, ctx),
        };
      }),
    conflicts: conflicts.map((c) => ({ ...c, stationName: c.stationCode ? ctx.stationById.get(c.stationCode)?.stationName || c.stationCode : "" })),
    secondments: ctx.secondments
      .slice()
      .sort((a, b) => b.validFrom.localeCompare(a.validFrom))
      .map((s) => ({
        id: s.id,
        employeeId: s.employeeId,
        employeeName: empName(s.employeeId),
        homeStationName: (() => {
          const e = ctx.empById.get(s.employeeId);
          const code = e ? postingOn(e, ctx.postingsByEmp.get(e.id), s.validFrom).stationCode : null;
          return code ? ctx.stationById.get(code)?.stationName || code : "";
        })(),
        stationCode: s.stationCode,
        stationName: ctx.stationById.get(s.stationCode)?.stationName || s.stationCode,
        workplaceId: s.workplaceId || "",
        workplaceName: s.workplaceId ? ctx.workplaceById.get(s.workplaceId)?.name || "" : "",
        validFrom: s.validFrom,
        validTo: s.validTo,
        decisionRef: s.decisionRef || "",
        reason: s.reason || "",
        status: String(s.status || "PENDING").toUpperCase(),
        requestedByName: s.requestedByName || "",
        approvedByName: s.approvedByName || "",
        approvedAt: s.approvedAt || null,
      })),
    eligibility,
    employees: ctx.employees.map((e) => ({
      id: e.id,
      code: e.code,
      fullName: e.fullName,
      status: String(e.status || "ACTIVE").toUpperCase(),
      dutyStatus: dutyStatusOf(e),
      stationCode: postingOn(e, ctx.postingsByEmp.get(e.id), refDate).stationCode || "",
    })),
    shifts: ctx.shifts.map(publicShift),
  });
}

/** Lấy và kiểm tra một mã điểm trạm trong danh mục station_rooms. */
async function requireStation(code: string) {
  if (!code) return null;
  const rows = await db.select().from(stationRooms).where(eq(stationRooms.stationCode, code));
  return rows[0] || null;
}

async function saveWorkplace(actor: ActorContext, body: Record<string, unknown>) {
  requirePermission(actor, "roster.manage");
  const id = str(body.id);
  const code = str(body.code).toUpperCase();
  const name = str(body.name);
  const stationCode = str(body.stationCode).toUpperCase();
  const departmentId = str(body.departmentId) || null;
  if (!WORKPLACE_CODE_RE.test(code)) return json({ success: false, error: "Mã nơi làm việc là bắt buộc (chữ, số, gạch dưới, tối đa 30 ký tự)." }, 400);
  if (!name) return json({ success: false, error: "Tên nơi làm việc là bắt buộc." }, 400);
  if (!(await requireStation(stationCode))) return json({ success: false, error: "Hãy chọn điểm trạm trong danh mục." }, 400);
  if (departmentId) {
    const d = await db.select().from(attDepartments).where(eq(attDepartments.id, departmentId));
    if (!d.length) return json({ success: false, error: "Khoa/phòng không có trong danh mục." }, 400);
  }
  const clash = await db.select().from(attWorkplaces).where(eq(attWorkplaces.code, code));
  if (clash.length && clash[0].id !== id) return json({ success: false, error: `Mã nơi làm việc "${code}" đã tồn tại.` }, 409);
  // Không tạo danh mục trùng: cùng tên trong cùng điểm trạm là cùng một nơi làm việc.
  const sameName = await db.select().from(attWorkplaces).where(eq(attWorkplaces.stationCode, stationCode));
  if (sameName.some((w) => w.id !== id && w.name.trim().toLowerCase() === name.toLowerCase())) {
    return json({ success: false, error: `Điểm trạm này đã có nơi làm việc "${name}".` }, 409);
  }

  const now = Date.now();
  const patch = {
    code,
    name,
    stationCode,
    departmentId,
    note: str(body.note) || null,
    displayOrder: num(body.displayOrder, 0),
    status: str(body.status).toUpperCase() === "INACTIVE" ? "INACTIVE" : "ACTIVE",
    updatedAt: now,
  };
  if (id) {
    const existing = await db.select().from(attWorkplaces).where(eq(attWorkplaces.id, id));
    if (!existing.length) return json({ success: false, error: "Không tìm thấy nơi làm việc." }, 404);
    if (existing[0].stationCode !== stationCode) {
      const used = await db.select({ id: attEmployees.id }).from(attEmployees).where(eq(attEmployees.workplaceId, id)).limit(1);
      if (used.length) {
        return json({ success: false, error: "Nơi làm việc đang có cán bộ nên không chuyển sang điểm trạm khác được. Hãy tạo nơi làm việc mới." }, 409);
      }
    }
    await db.update(attWorkplaces).set(patch).where(eq(attWorkplaces.id, id));
    await writeAudit(actor, { entity: "workplace", entityId: id, action: "UPDATE", oldValue: existing[0], newValue: patch });
    return json({ success: true, message: "Đã cập nhật nơi làm việc.", id });
  }
  const newWpId = newId("wp");
  await db.insert(attWorkplaces).values({ id: newWpId, ...patch, createdAt: now });
  await writeAudit(actor, { entity: "workplace", entityId: newWpId, action: "CREATE", newValue: patch });
  return json({ success: true, message: "Đã thêm nơi làm việc.", id: newWpId });
}

async function deleteWorkplace(actor: ActorContext, body: Record<string, unknown>) {
  requirePermission(actor, "roster.manage");
  const id = str(body.id);
  const [emp, post, duty, rule, sec] = await Promise.all([
    db.select({ id: attEmployees.id }).from(attEmployees).where(eq(attEmployees.workplaceId, id)).limit(1),
    db.select({ id: attEmployeePostings.id }).from(attEmployeePostings).where(eq(attEmployeePostings.workplaceId, id)).limit(1),
    db.select({ id: attDutyAssignments.id }).from(attDutyAssignments).where(eq(attDutyAssignments.workplaceId, id)).limit(1),
    db.select({ id: attDutyRules.id }).from(attDutyRules).where(eq(attDutyRules.workplaceId, id)).limit(1),
    db.select({ id: attSecondments.id }).from(attSecondments).where(eq(attSecondments.workplaceId, id)).limit(1),
  ]);
  if (emp.length || post.length || duty.length || rule.length || sec.length) {
    await db.update(attWorkplaces).set({ status: "INACTIVE", updatedAt: Date.now() }).where(eq(attWorkplaces.id, id));
    await writeAudit(actor, { entity: "workplace", entityId: id, action: "DEACTIVATE" });
    return json({ success: true, message: "Nơi làm việc đã được dùng trong hồ sơ, quy tắc hoặc lịch trực nên chỉ ngừng sử dụng.", deactivated: true });
  }
  await db.delete(attWorkplaces).where(eq(attWorkplaces.id, id));
  await writeAudit(actor, { entity: "workplace", entityId: id, action: "DELETE" });
  return json({ success: true, message: "Đã xoá nơi làm việc." });
}

async function saveDutyGroup(actor: ActorContext, body: Record<string, unknown>) {
  requirePermission(actor, "roster.manage");
  const id = str(body.id);
  const code = str(body.code).toUpperCase();
  const name = str(body.name);
  const stationCode = str(body.stationCode).toUpperCase();
  if (!WORKPLACE_CODE_RE.test(code)) return json({ success: false, error: "Mã nhóm trực là bắt buộc (chữ, số, gạch dưới, tối đa 30 ký tự)." }, 400);
  if (!name) return json({ success: false, error: "Tên nhóm trực là bắt buộc." }, 400);
  if (!(await requireStation(stationCode))) return json({ success: false, error: "Hãy chọn điểm trạm của nhóm trực." }, 400);
  const clash = await db.select().from(attDutyGroups).where(eq(attDutyGroups.code, code));
  if (clash.length && clash[0].id !== id) return json({ success: false, error: `Mã nhóm trực "${code}" đã tồn tại.` }, 409);

  const settings = await getSettings();
  const memberIds = body.memberIds === undefined ? null : parseIdList(body.memberIds);
  if (memberIds) {
    const emps = memberIds.length ? await db.select().from(attEmployees).where(inArray(attEmployees.id, memberIds)) : [];
    if (emps.length !== memberIds.length) return json({ success: false, error: "Danh sách thành viên có cán bộ không tồn tại." }, 400);
    if (!settings.rosterRules.allowMultiGroup && memberIds.length) {
      const others = await db
        .select()
        .from(attDutyGroupMembers)
        .where(and(inArray(attDutyGroupMembers.employeeId, memberIds), eq(attDutyGroupMembers.status, "APPROVED")));
      const dup = others.filter((m) => m.groupId !== id);
      if (dup.length) {
        const names = [...new Set(dup.map((m) => emps.find((e) => e.id === m.employeeId)?.fullName || m.employeeId))];
        return json({
          success: false,
          error: `Cấu hình hiện không cho phép cán bộ thuộc nhiều nhóm trực: ${names.join(", ")} đã thuộc nhóm khác. Bật "Cho phép thuộc nhiều nhóm trực" trong Phạm vi phân trực hoặc gỡ họ khỏi nhóm cũ.`,
        }, 409);
      }
    }
  }

  const now = Date.now();
  const patch = {
    code,
    name,
    stationCode,
    note: str(body.note) || null,
    status: str(body.status).toUpperCase() === "INACTIVE" ? "INACTIVE" : "ACTIVE",
    updatedAt: now,
  };
  let groupId = id;
  if (id) {
    const existing = await db.select().from(attDutyGroups).where(eq(attDutyGroups.id, id));
    if (!existing.length) return json({ success: false, error: "Không tìm thấy nhóm trực." }, 404);
    await db.update(attDutyGroups).set(patch).where(eq(attDutyGroups.id, id));
    await writeAudit(actor, { entity: "duty_group", entityId: id, action: "UPDATE", oldValue: existing[0], newValue: patch });
  } else {
    groupId = newId("dgrp");
    await db.insert(attDutyGroups).values({ id: groupId, ...patch, createdAt: now });
    await writeAudit(actor, { entity: "duty_group", entityId: groupId, action: "CREATE", newValue: patch });
  }
  if (memberIds) await syncGroupMembers(actor, groupId, memberIds);
  return json({ success: true, message: id ? "Đã cập nhật nhóm trực." : "Đã thêm nhóm trực.", id: groupId });
}

/** Đặt danh sách thành viên đã duyệt của một nhóm trực; người bị gỡ được đánh dấu REVOKED (giữ dấu vết). */
async function syncGroupMembers(actor: ActorContext, groupId: string, memberIds: string[]) {
  const now = Date.now();
  const current = await db.select().from(attDutyGroupMembers).where(eq(attDutyGroupMembers.groupId, groupId));
  const want = new Set(memberIds);
  const approver = { approvedBy: actor.user.id, approvedByName: actor.employee?.fullName || actor.user.name, approvedAt: now };
  const added: string[] = [];
  const removed: string[] = [];
  for (const m of current) {
    const approved = String(m.status || "APPROVED").toUpperCase() === "APPROVED";
    if (want.has(m.employeeId) && !approved) {
      await db.update(attDutyGroupMembers).set({ status: "APPROVED", ...approver }).where(eq(attDutyGroupMembers.id, m.id));
      added.push(m.employeeId);
    } else if (!want.has(m.employeeId) && approved) {
      await db.update(attDutyGroupMembers).set({ status: "REVOKED", ...approver }).where(eq(attDutyGroupMembers.id, m.id));
      removed.push(m.employeeId);
    }
  }
  const known = new Set(current.map((m) => m.employeeId));
  const fresh = memberIds.filter((e) => !known.has(e));
  if (fresh.length) {
    await db.insert(attDutyGroupMembers).values(
      fresh.map((employeeId) => ({ id: newId("dgm"), groupId, employeeId, status: "APPROVED", ...approver, createdAt: now }))
    );
    added.push(...fresh);
  }
  if (added.length || removed.length) {
    await writeAudit(actor, { entity: "duty_group", entityId: groupId, action: "MEMBERS", newValue: { added, removed } });
  }
}

async function deleteDutyGroup(actor: ActorContext, body: Record<string, unknown>) {
  requirePermission(actor, "roster.manage");
  const id = str(body.id);
  const used = await db.select({ id: attDutyRules.id }).from(attDutyRules).where(eq(attDutyRules.dutyGroupId, id)).limit(1);
  if (used.length) {
    await db.update(attDutyGroups).set({ status: "INACTIVE", updatedAt: Date.now() }).where(eq(attDutyGroups.id, id));
    await writeAudit(actor, { entity: "duty_group", entityId: id, action: "DEACTIVATE" });
    return json({ success: true, message: "Nhóm trực đang được quy tắc sử dụng nên chỉ ngừng sử dụng.", deactivated: true });
  }
  await db.delete(attDutyGroups).where(eq(attDutyGroups.id, id));
  await writeAudit(actor, { entity: "duty_group", entityId: id, action: "DELETE" });
  return json({ success: true, message: "Đã xoá nhóm trực." });
}

/** Thêm / sửa một quy tắc phân trực theo điểm trạm. Kiểm tra mọi mã định danh ở máy chủ. */
async function saveDutyRule(actor: ActorContext, body: Record<string, unknown>) {
  requirePermission(actor, "roster.manage");
  const id = str(body.id);
  const name = str(body.name);
  const stationCode = str(body.stationCode).toUpperCase();
  const shiftId = str(body.shiftId);
  const effectiveFrom = str(body.effectiveFrom);
  const effectiveTo = str(body.effectiveTo);
  if (!name) return json({ success: false, error: "Tên quy tắc là bắt buộc." }, 400);
  if (!isValidDate(effectiveFrom)) return json({ success: false, error: "Ngày bắt đầu áp dụng không hợp lệ." }, 400);
  if (effectiveTo && (!isValidDate(effectiveTo) || effectiveTo < effectiveFrom)) {
    return json({ success: false, error: "Ngày kết thúc áp dụng phải sau ngày bắt đầu." }, 400);
  }
  const weekday = parseHeadcount(body.weekdayHeadcount);
  const holidayRaw = body.holidayHeadcount;
  const holidayHeadcount =
    holidayRaw === null || holidayRaw === undefined || holidayRaw === "" ? null : Math.min(Math.max(Math.round(num(holidayRaw, 0)), 0), 20);
  if (!weekday.some((n) => n > 0) && !holidayHeadcount) {
    return json({ success: false, error: "Hãy đặt số người cần trực cho ít nhất một ngày." }, 400);
  }
  const limit = (v: unknown) => (v === null || v === undefined || v === "" ? null : Math.min(Math.max(Math.round(num(v, 0)), 0), 31));
  const eligible = parseIdList(body.eligibleEmployeeIds);
  if (eligible.length) {
    const found = await db.select({ id: attEmployees.id }).from(attEmployees).where(inArray(attEmployees.id, eligible));
    if (found.length !== eligible.length) return json({ success: false, error: "Danh sách cán bộ đủ điều kiện có mã không tồn tại." }, 400);
  }
  const allowCross = body.allowCrossStation === true || body.allowCrossStation === "true";
  if (allowCross && !eligible.length) {
    return json({ success: false, error: "Bật trực chéo thì phải ghi đích danh cán bộ được phép trong danh sách đủ điều kiện." }, 400);
  }

  const row = {
    name,
    stationCode,
    departmentId: str(body.departmentId) || null,
    workplaceId: str(body.workplaceId) || null,
    dutyGroupId: str(body.dutyGroupId) || null,
    shiftId,
    weekdayHeadcount: JSON.stringify(weekday),
    holidayHeadcount,
    effectiveFrom,
    effectiveTo: effectiveTo || null,
    eligibleEmployeeIds: JSON.stringify(eligible),
    allowCrossStation: allowCross ? "true" : "false",
    maxPerMonth: limit(body.maxPerMonth),
    maxWeekendHolidayPerMonth: limit(body.maxWeekendHolidayPerMonth),
    priority: Math.min(Math.max(Math.round(num(body.priority, 0)), -100), 100),
    status: str(body.status).toUpperCase() === "LOCKED" ? "LOCKED" : "ACTIVE",
    note: str(body.note) || null,
    updatedAt: Date.now(),
  };
  // Kiểm tra mã định danh và quan hệ giữa chúng bằng đúng hàm bộ phân lịch dùng.
  const catalog = await loadCatalog();
  const lookup = {
    stationById: new Map(catalog.stations.map((s) => [s.stationCode, s])),
    deptById: new Map(catalog.departments.map((d) => [d.id, d])),
    workplaceById: new Map(catalog.workplaces.map((w) => [w.id, w])),
    groupById: new Map(catalog.groups.map((g) => [g.id, g])),
    shiftById: new Map(catalog.shifts.map((s) => [s.id, s])),
  };
  const settings = await getSettings();
  const problems = ruleProblems({ id: id || "new", createdBy: null, createdAt: null, ...row } as never, settings.rosterRules.scopeMode, lookup);
  if (problems.length) return json({ success: false, error: problems.join(" ") }, 400);

  if (id) {
    const existing = await db.select().from(attDutyRules).where(eq(attDutyRules.id, id));
    if (!existing.length) return json({ success: false, error: "Không tìm thấy quy tắc." }, 404);
    await db.update(attDutyRules).set(row).where(eq(attDutyRules.id, id));
    await writeAudit(actor, { entity: "duty_rule", entityId: id, action: "UPDATE", oldValue: existing[0], newValue: row });
    return json({ success: true, message: "Đã cập nhật quy tắc phân trực. Lịch đã lưu không thay đổi.", id });
  }
  const ruleId = newId("drule");
  await db.insert(attDutyRules).values({ id: ruleId, ...row, createdBy: actor.user.id, createdAt: Date.now() });
  await writeAudit(actor, { entity: "duty_rule", entityId: ruleId, action: "CREATE", newValue: row });
  return json({ success: true, message: "Đã thêm quy tắc phân trực.", id: ruleId });
}

async function setDutyRuleStatus(actor: ActorContext, body: Record<string, unknown>) {
  requirePermission(actor, "roster.manage");
  const id = str(body.id);
  const status = str(body.status).toUpperCase() === "LOCKED" ? "LOCKED" : "ACTIVE";
  const existing = await db.select().from(attDutyRules).where(eq(attDutyRules.id, id));
  if (!existing.length) return json({ success: false, error: "Không tìm thấy quy tắc." }, 404);
  if (status === "ACTIVE") {
    const catalog = await loadCatalog();
    const settings = await getSettings();
    const problems = ruleProblems(existing[0], settings.rosterRules.scopeMode, {
      stationById: new Map(catalog.stations.map((s) => [s.stationCode, s])),
      deptById: new Map(catalog.departments.map((d) => [d.id, d])),
      workplaceById: new Map(catalog.workplaces.map((w) => [w.id, w])),
      groupById: new Map(catalog.groups.map((g) => [g.id, g])),
      shiftById: new Map(catalog.shifts.map((s) => [s.id, s])),
    });
    if (problems.length) return json({ success: false, error: `Chưa kích hoạt được: ${problems.join(" ")}` }, 400);
  }
  await db.update(attDutyRules).set({ status, updatedAt: Date.now() }).where(eq(attDutyRules.id, id));
  await writeAudit(actor, { entity: "duty_rule", entityId: id, action: status === "LOCKED" ? "LOCK" : "ACTIVATE" });
  return json({ success: true, message: status === "LOCKED" ? "Đã khoá quy tắc." : "Đã kích hoạt quy tắc." });
}

async function deleteDutyRule(actor: ActorContext, body: Record<string, unknown>) {
  requirePermission(actor, "roster.manage");
  const id = str(body.id);
  const used = await db.select({ id: attDutyAssignments.id }).from(attDutyAssignments).where(eq(attDutyAssignments.ruleId, id)).limit(1);
  if (used.length) {
    // Suất đã phân giữ nguyên dấu vết quy tắc đã sinh ra nó: chỉ khoá.
    await db.update(attDutyRules).set({ status: "LOCKED", updatedAt: Date.now() }).where(eq(attDutyRules.id, id));
    await writeAudit(actor, { entity: "duty_rule", entityId: id, action: "LOCK" });
    return json({ success: true, message: "Quy tắc đã sinh suất trực nên chỉ được khoá, không xoá.", deactivated: true });
  }
  await db.delete(attDutyRules).where(eq(attDutyRules.id, id));
  await writeAudit(actor, { entity: "duty_rule", entityId: id, action: "DELETE" });
  return json({ success: true, message: "Đã xoá quy tắc." });
}

/**
 * Quyết định điều động / trực chéo. Quản trị hệ thống tạo thì có hiệu lực ngay;
 * người khác có quyền lập lịch chỉ đề nghị (PENDING) và chờ Quản trị xác nhận.
 */
async function saveSecondment(actor: ActorContext, body: Record<string, unknown>) {
  requirePermission(actor, "roster.manage");
  const employeeId = str(body.employeeId);
  const stationCode = str(body.stationCode).toUpperCase();
  const workplaceId = str(body.workplaceId) || null;
  const validFrom = str(body.validFrom);
  const validTo = str(body.validTo);
  const emp = await db.select().from(attEmployees).where(eq(attEmployees.id, employeeId));
  if (!emp.length) return json({ success: false, error: "Không tìm thấy cán bộ." }, 404);
  if (!(await requireStation(stationCode))) return json({ success: false, error: "Hãy chọn điểm trạm nhận điều động." }, 400);
  if (!isValidDate(validFrom) || !isValidDate(validTo) || validTo < validFrom) {
    return json({ success: false, error: "Khoảng ngày điều động không hợp lệ." }, 400);
  }
  if (workplaceId) {
    const w = await db.select().from(attWorkplaces).where(eq(attWorkplaces.id, workplaceId));
    if (!w.length || w[0].stationCode !== stationCode) return json({ success: false, error: "Nơi làm việc không thuộc điểm trạm nhận điều động." }, 400);
  }
  const posts = await db.select().from(attEmployeePostings).where(eq(attEmployeePostings.employeeId, employeeId));
  const home = postingOn(emp[0], posts.sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom)), validFrom).stationCode;
  if (home === stationCode) return json({ success: false, error: "Cán bộ đã thuộc điểm trạm này, không cần điều động." }, 400);

  const now = Date.now();
  const isAdmin = actor.role === "ADMIN";
  const id = newId("sec");
  const row = {
    id,
    employeeId,
    stationCode,
    workplaceId,
    validFrom,
    validTo,
    decisionRef: str(body.decisionRef) || null,
    reason: str(body.reason) || null,
    status: isAdmin ? "APPROVED" : "PENDING",
    requestedBy: actor.user.id,
    requestedByName: actor.employee?.fullName || actor.user.name,
    approvedBy: isAdmin ? actor.user.id : null,
    approvedByName: isAdmin ? actor.employee?.fullName || actor.user.name : null,
    approvedAt: isAdmin ? now : null,
    createdAt: now,
    updatedAt: now,
  };
  await db.insert(attSecondments).values(row);
  await writeAudit(actor, { entity: "secondment", entityId: id, action: isAdmin ? "APPROVE" : "REQUEST", newValue: row });
  return json({
    success: true,
    id,
    message: isAdmin ? "Đã ghi nhận và xác nhận quyết định điều động." : "Đã gửi đề nghị điều động, chờ Quản trị hệ thống xác nhận.",
  });
}

async function decideSecondment(actor: ActorContext, body: Record<string, unknown>) {
  requireAdmin(actor);
  const id = str(body.id);
  const decision = str(body.decision).toUpperCase();
  if (!["APPROVED", "REVOKED"].includes(decision)) return json({ success: false, error: "Quyết định không hợp lệ." }, 400);
  const existing = await db.select().from(attSecondments).where(eq(attSecondments.id, id));
  if (!existing.length) return json({ success: false, error: "Không tìm thấy quyết định điều động." }, 404);
  const now = Date.now();
  await db
    .update(attSecondments)
    .set({ status: decision, approvedBy: actor.user.id, approvedByName: actor.employee?.fullName || actor.user.name, approvedAt: now, updatedAt: now })
    .where(eq(attSecondments.id, id));
  await writeAudit(actor, { entity: "secondment", entityId: id, action: decision === "APPROVED" ? "APPROVE" : "REVOKE", oldValue: existing[0] });
  return json({
    success: true,
    message: decision === "APPROVED"
      ? "Đã xác nhận quyết định điều động."
      : "Đã thu hồi quyết định điều động. Suất trực đã phân trước đó được giữ nguyên - xem lại lịch nếu cần.",
  });
}

// ---------------------------------------------------------------------------
//  Lịch trực tháng
// ---------------------------------------------------------------------------


async function assignDuty(actor: ActorContext, body: Record<string, unknown>) {
  requirePermission(actor, "roster.manage");
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

  // Phạm vi phân trực: đúng điểm trạm của cán bộ vào ngày trực, hoặc điểm trạm
  // khác khi có quyết định điều động đã duyệt / Quản trị hệ thống xác nhận ngay.
  const ctx = await loadPlanContext(dutyDate, dutyDate);
  const emp = ctx.empById.get(employeeId)!;
  const posting = postingOn(emp, ctx.postingsByEmp.get(emp.id), dutyDate);
  const stationCode = str(body.stationCode).toUpperCase() || posting.stationCode;
  if (!stationCode) {
    return json({ success: false, error: `${emp.fullName} chưa được gắn điểm trạm vào ngày ${dutyDate}. Cập nhật hồ sơ cán bộ trước khi phân trực.` }, 400);
  }
  if (!ctx.stationById.has(stationCode)) return json({ success: false, error: "Điểm trạm không có trong danh mục." }, 400);
  const confirmCross = body.confirmCrossStation === true && actor.role === "ADMIN";
  const check = checkManualAssignment(ctx, emp, dutyDate, shiftId, stationCode, confirmCross);
  if (check.blocker) {
    const stationName = ctx.stationById.get(stationCode)?.stationName || stationCode;
    if (check.blocker === "OUT_OF_SCOPE") {
      const home = posting.stationCode ? ctx.stationById.get(posting.stationCode)?.stationName || posting.stationCode : "";
      return json({
        success: false,
        error: `${emp.fullName} thuộc ${home}. Chỉ phân trực tại ${stationName} khi có quyết định điều động đã được Quản trị hệ thống xác nhận${
          actor.role === "ADMIN" ? " - hoặc xác nhận điều động ngay trong hộp thoại phân người" : ""
        }.`,
        needsCrossConfirm: actor.role === "ADMIN",
      }, 409);
    }
    return json({ success: false, error: `Không phân được ${emp.fullName} ngày ${dutyDate}: ${REASON_LABEL[check.blocker] || check.blocker}.` }, 409);
  }

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
    note: str(body.note) || (check.cross ? "Điều động trực tại điểm trạm khác (đã xác nhận)" : null),
    stationCode,
    departmentId: check.departmentId,
    workplaceId: check.workplaceId,
    createdBy: actor.user.id,
    createdAt: now,
    updatedAt: now,
  });
  await writeAudit(actor, {
    entity: "duty_assignment",
    entityId: id,
    action: check.cross ? "CREATE_CROSS_STATION" : "CREATE",
    newValue: { dutyDate, shiftId, employeeId, dayType, stationCode, cross: check.cross, adminConfirmed: confirmCross },
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
  requirePermission(actor, "roster.manage");
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
  requirePermission(actor, "roster.manage");
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

  const ctx = await loadPlanContext(targetDates[0], targetDates[targetDates.length - 1]);
  const now = Date.now();
  const rows: (typeof attDutyAssignments.$inferInsert)[] = [];
  let skipped = 0;
  let outOfScope = 0;
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
    // Cán bộ đã chuyển điểm trạm / ngừng trực từ ngày đó thì không chép suất cũ sang.
    const emp = ctx.empById.get(src.employeeId);
    const stationCode = src.stationCode || (emp ? postingOn(emp, ctx.postingsByEmp.get(emp.id), dutyDate).stationCode : null);
    let scope: { departmentId: string | null; workplaceId: string | null } = { departmentId: src.departmentId, workplaceId: src.workplaceId };
    if (emp && stationCode) {
      const sc = scopeCheck(ctx, emp, { stationCode, departmentId: src.departmentId, workplaceId: src.workplaceId }, dutyDate);
      if (!sc.ok) {
        skipped += 1;
        outOfScope += 1;
        continue;
      }
      scope = { departmentId: sc.departmentId, workplaceId: sc.workplaceId };
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
      stationCode,
      departmentId: scope.departmentId,
      workplaceId: scope.workplaceId,
      ruleId: src.ruleId || null,
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
    newValue: { source, created: rows.length, skipped, outOfScope },
  });
  return json({
    success: true,
    message: `Đã sao chép ${rows.length} suất trực từ tháng ${prevMonth}/${prevYear}${
      skipped ? `, bỏ qua ${skipped} suất (trùng, ngoài số ngày của tháng, hoặc ca/cán bộ đã ngừng dùng)` : ""
    }${outOfScope ? `. Trong đó ${outOfScope} suất bị bỏ vì cán bộ đã đổi phạm vi công tác hoặc không còn tham gia trực` : ""}.`,
    created: rows.length,
    skipped,
  });
}

/** Chuẩn hoá quy tắc phân trực gửi lên: giới hạn số, bỏ mã rỗng và trùng. */
function normalizeRosterRules(raw: Record<string, unknown>): RosterRules {
  const ids = (v: unknown) => [...new Set((Array.isArray(v) ? v : []).map((x) => str(x)).filter(Boolean))];
  const clamp = (v: unknown, fallback: number, min: number, max: number) =>
    Math.min(Math.max(Math.round(num(v, fallback)), min), max);
  return {
    shiftIds: ids(raw.shiftIds),
    employeeIds: ids(raw.employeeIds),
    peoplePerShift: clamp(raw.peoplePerShift, DEFAULT_ROSTER_RULES.peoplePerShift, 1, 10),
    strategy: str(raw.strategy).toUpperCase() === "BALANCED" ? "BALANCED" : "ROUND_ROBIN",
    minRestDays: clamp(raw.minRestDays, DEFAULT_ROSTER_RULES.minRestDays, 0, 7),
    maxPerMonth: clamp(raw.maxPerMonth, 0, 0, 31),
    maxWeekendHolidayPerMonth: clamp(raw.maxWeekendHolidayPerMonth, 0, 0, 31),
    skipOnLeave: raw.skipOnLeave === undefined ? DEFAULT_ROSTER_RULES.skipOnLeave : Boolean(raw.skipOnLeave),
    relaxWhenShort: raw.relaxWhenShort === undefined ? DEFAULT_ROSTER_RULES.relaxWhenShort : Boolean(raw.relaxWhenShort),
    scopeMode: (SCOPE_MODES as readonly string[]).includes(str(raw.scopeMode).toUpperCase())
      ? (str(raw.scopeMode).toUpperCase() as RosterRules["scopeMode"])
      : DEFAULT_ROSTER_RULES.scopeMode,
    allowMultiGroup: raw.allowMultiGroup === undefined ? DEFAULT_ROSTER_RULES.allowMultiGroup : Boolean(raw.allowMultiGroup),
    minRestHours: clamp(raw.minRestHours, DEFAULT_ROSTER_RULES.minRestHours, 0, 48),
  };
}

/** Lưu quy tắc phân trực tự động để các lần phân sau dùng lại. */
async function saveRosterRules(actor: ActorContext, body: Record<string, unknown>) {
  requirePermission(actor, "roster.manage");
  const raw = body.rules;
  if (!raw || typeof raw !== "object") return json({ success: false, error: "Quy tắc phân trực không hợp lệ." }, 400);
  const rules = normalizeRosterRules(raw as Record<string, unknown>);
  const before = (await getSettings()).rosterRules;
  await saveSetting(SETTING_KEYS.ROSTER_RULES, rules, actor);
  await writeAudit(actor, {
    entity: "settings",
    entityId: SETTING_KEYS.ROSTER_RULES,
    action: "UPDATE",
    oldValue: before,
    newValue: rules,
  });
  return json({ success: true, message: "Đã lưu quy tắc phân trực tự động.", rules });
}

/**
 * Khôi phục quy tắc phân trực về mặc định của hệ thống.
 *
 * Chỉ Quản trị hệ thống được làm: quy tắc đã lưu là thoả thuận chung của cả
 * đơn vị, người được cấp quyền lập lịch có thể sửa nhưng không được xoá trắng.
 * Lịch trực đã phân KHÔNG bị ảnh hưởng - chỉ các lần phân tự động sau mới dùng
 * quy tắc mặc định.
 */
async function resetRosterRules(actor: ActorContext) {
  requireAdmin(actor);
  const before = (await getSettings()).rosterRules;
  await deleteSetting(SETTING_KEYS.ROSTER_RULES);
  await writeAudit(actor, {
    entity: "settings",
    entityId: SETTING_KEYS.ROSTER_RULES,
    action: "RESET",
    oldValue: before,
    newValue: DEFAULT_ROSTER_RULES,
  });
  return json({
    success: true,
    message: "Đã khôi phục quy tắc phân trực về mặc định. Lịch trực đã phân được giữ nguyên.",
    rules: DEFAULT_ROSTER_RULES,
  });
}

/**
 * PHÂN LỊCH TỰ ĐỘNG THEO ĐIỂM TRẠM - hai bước: xem trước rồi xác nhận lưu.
 *
 *   roster_auto_preview  dựng phương án từ dữ liệu thật, KHÔNG ghi gì. Trả về
 *                        các suất đề xuất, ca thiếu người (ngày, ca, điểm trạm,
 *                        số người thiếu, nguyên nhân, đề xuất bổ sung), xung đột
 *                        quy tắc, vi phạm và dấu vân tay của phương án.
 *   roster_auto          dựng lại phương án và chỉ lưu khi dấu vân tay khớp bản
 *                        Quản trị đã xem (dữ liệu không đổi trong lúc xem), không
 *                        có xung đột/vi phạm chặn, và nếu còn thiếu người thì
 *                        Quản trị đã xác nhận lưu phần đã phân được.
 *
 * Phạm vi: tháng (period) và danh sách điểm trạm (stationCodes, rỗng = mọi điểm
 * trạm có quy tắc). Những suất đã có luôn được giữ nguyên và tính vào nhu cầu.
 */
type PlanRequest = { period: string; stations: string[]; rules: RosterRules; dates: string[] };

async function readPlanRequest(body: Record<string, unknown>): Promise<PlanRequest | Response> {
  const period = str(body.period);
  if (!isValidPeriod(period)) return json({ success: false, error: "Tháng/năm cần phân lịch không hợp lệ." }, 400);
  const settings = await getSettings();
  const stations = parseIdList(body.stationCodes);
  return { period, stations, rules: normalizeRosterRules(settings.rosterRules as unknown as Record<string, unknown>), dates: periodDates(period) };
}

function describePlan(ctx: PlanContext, plan: Plan) {
  const empName = (id: string) => ctx.empById.get(id)?.fullName || id;
  const stationName = (code: string | null) => (code ? ctx.stationById.get(code)?.stationName || code : "");
  const shiftName = (id: string) => ctx.shiftById.get(id)?.name || id;
  const ruleName = (id: string) => ctx.rules.find((r) => r.id === id)?.name || "";
  const wpName = (id: string | null) => (id ? ctx.workplaceById.get(id)?.name || "" : "");
  const deptName = (id: string | null) => (id ? ctx.deptById.get(id)?.name || "" : "");
  const blockingConflicts = plan.conflicts.filter((c) => c.blocking);
  const blockingViolations = plan.violations.filter((v) => v.blocking);
  const missing = plan.shortages.reduce((n, s) => n + s.missing, 0);
  return {
    fingerprint: plan.fingerprint,
    scopeMode: ctx.general.scopeMode,
    scopeModeLabel: SCOPE_MODE_LABEL[ctx.general.scopeMode],
    stations: plan.stations.map((code) => ({ code, name: stationName(code) })),
    proposals: plan.proposals.map((p) => ({
      ...p,
      employeeName: empName(p.employeeId),
      employeeCode: ctx.empById.get(p.employeeId)?.code || "",
      stationName: stationName(p.stationCode),
      shiftName: shiftName(p.shiftId),
      ruleName: ruleName(p.ruleId),
      workplaceName: wpName(p.workplaceId),
      departmentName: deptName(p.departmentId),
    })),
    shortages: plan.shortages.map((s) => ({
      ...s,
      stationName: stationName(s.stationCode),
      shiftName: shiftName(s.shiftId),
      ruleName: ruleName(s.ruleId),
      reasons: Object.entries(s.reasons)
        .sort((a, b) => b[1] - a[1])
        .map(([code, count]) => ({ code, label: REASON_LABEL[code] || code, count })),
      suggestions: s.suggestions.map((g) => ({ ...g, employeeName: empName(g.employeeId), stationName: stationName(g.stationCode) })),
    })),
    conflicts: plan.conflicts.map((c) => ({ ...c, stationName: stationName(c.stationCode) })),
    violations: plan.violations.slice(0, 300).map((v) => ({ ...v, employeeName: empName(v.employeeId), shiftName: shiftName(v.shiftId) })),
    warnings: plan.warnings,
    summary: {
      proposed: plan.proposals.length,
      employees: new Set(plan.proposals.map((p) => p.employeeId)).size,
      cross: plan.proposals.filter((p) => p.cross).length,
      shortageSlots: plan.shortages.length,
      missing,
      shortageDays: new Set(plan.shortages.map((s) => s.date)).size,
      blockingConflicts: blockingConflicts.length,
      blockingViolations: blockingViolations.length,
      existingViolations: plan.violations.filter((v) => !v.blocking).length,
      rules: plan.rulesUsed.length,
    },
    canSave: !blockingConflicts.length && !blockingViolations.length && plan.proposals.length > 0,
  };
}

async function previewAutoRoster(actor: ActorContext, body: Record<string, unknown>) {
  requirePermission(actor, "roster.manage");
  const req = await readPlanRequest(body);
  if (req instanceof Response) return req;
  const ctx = await loadPlanContext(req.dates[0], req.dates[req.dates.length - 1], req.rules);
  const plan = buildPlan(ctx, req.dates, req.stations);
  return json({ success: true, period: req.period, locked: (await periodStatus(req.period)) === "LOCKED", ...describePlan(ctx, plan) });
}

async function autoAssignRoster(actor: ActorContext, body: Record<string, unknown>) {
  requirePermission(actor, "roster.manage");
  const req = await readPlanRequest(body);
  if (req instanceof Response) return req;
  await assertPeriodOpen(req.period);
  const fingerprint = str(body.fingerprint);
  if (!fingerprint) {
    return json({ success: false, error: "Hãy xem trước phương án phân lịch rồi mới xác nhận lưu." }, 400);
  }

  const ctx = await loadPlanContext(req.dates[0], req.dates[req.dates.length - 1], req.rules);
  const plan = buildPlan(ctx, req.dates, req.stations);
  const view = describePlan(ctx, plan);
  if (plan.fingerprint !== fingerprint) {
    return json(
      { success: false, error: "Dữ liệu cán bộ, quy tắc hoặc lịch trực đã thay đổi kể từ lúc xem trước. Hãy xem trước lại.", stale: true, ...view },
      409
    );
  }
  if (view.summary.blockingConflicts) {
    return json({ success: false, error: "Còn xung đột quy tắc chưa xử lý. Không có suất nào được lưu.", ...view }, 409);
  }
  if (view.summary.blockingViolations) {
    return json({ success: false, error: "Phương án vi phạm điều kiện bắt buộc (trùng ca / thời gian nghỉ). Không có suất nào được lưu.", ...view }, 409);
  }
  if (!plan.proposals.length) {
    return json({ success: false, error: "Phương án không có suất trực mới nào để lưu.", ...view }, 400);
  }
  if (view.summary.missing && body.acceptShortage !== true) {
    return json(
      { success: false, error: `Còn ${view.summary.missing} suất thiếu người. Xác nhận lưu phần đã phân được hoặc điều chỉnh quy tắc/bổ sung nhân lực.`, needsShortageAck: true, ...view },
      409
    );
  }

  const now = Date.now();
  const rows: (typeof attDutyAssignments.$inferInsert)[] = plan.proposals.map((p) => ({
    id: newId("duty"),
    dutyDate: p.date,
    shiftId: p.shiftId,
    employeeId: p.employeeId,
    dayType: p.dayType,
    status: "PLANNED",
    note: p.secondmentId ? "Điều động theo quyết định đã duyệt" : p.cross ? "Trực chéo theo quy tắc đã duyệt" : null,
    stationCode: p.stationCode,
    departmentId: p.departmentId,
    workplaceId: p.workplaceId,
    ruleId: p.ruleId,
    createdBy: actor.user.id,
    createdAt: now,
    updatedAt: now,
  }));
  // Một giao dịch: lỗi ở bất kỳ dòng nào thì không dòng nào được ghi.
  try {
    await db.transaction(async (tx) => {
      for (let i = 0; i < rows.length; i += 500) await tx.insert(attDutyAssignments).values(rows.slice(i, i + 500));
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      return json({ success: false, error: "Lịch trực tháng này vừa được thay đổi trong lúc lưu. Không có suất nào được tạo - hãy xem trước lại." }, 409);
    }
    throw err;
  }
  for (const empId of new Set(rows.map((r) => r.employeeId))) {
    const mine = rows.filter((r) => r.employeeId === empId).length;
    await notify(empId, "Lịch trực mới", `Bạn được phân ${mine} suất trực trong tháng ${req.period}.`, "DUTY", req.period);
  }
  await writeAudit(actor, {
    entity: "duty_assignment",
    entityId: req.period,
    action: "ROSTER_AUTO",
    newValue: {
      created: rows.length,
      stations: plan.stations,
      scopeMode: req.rules.scopeMode,
      rules: plan.rulesUsed.length,
      missing: view.summary.missing,
      shortageSlots: view.summary.shortageSlots,
      cross: view.summary.cross,
      acceptedShortage: body.acceptShortage === true,
      fingerprint,
    },
  });
  return json({
    success: true,
    message: `Đã lưu ${rows.length} suất trực tháng ${req.period}${
      view.summary.missing ? `. Còn ${view.summary.missing} suất thiếu người tại ${view.summary.shortageSlots} ca - xem báo cáo thiếu nhân lực.` : "."
    }`,
    created: rows.length,
    unfilled: view.summary.missing,
    ...view,
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
  requirePermission(actor, "roster.manage");
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
  // Nhập từ Excel cũng chịu đúng phạm vi phân trực như phân tay: điểm trạm của
  // cán bộ (hoặc cột "điểm trạm" khi có quyết định điều động), không trùng giờ,
  // đủ giờ nghỉ, không nghỉ phép.
  const ctx = await loadPlanContext(`${period}-01`, `${period}-${String(daysInPeriod(period)).padStart(2, "0")}`);
  const stationLookup = new Map<string, string>();
  for (const st of ctx.stations) {
    stationLookup.set(norm(st.stationCode), st.stationCode);
    stationLookup.set(norm(st.stationName), st.stationCode);
  }
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
    const stationText = str(row.station) || str(row.stationCode);
    const stationCode = stationText
      ? stationLookup.get(norm(stationText)) || ""
      : postingOn(employee, ctx.postingsByEmp.get(employee.id), date).stationCode || "";
    if (!stationCode) {
      errors.push(`Dòng ${line}: ${stationText ? `không tìm thấy điểm trạm "${stationText}"` : `${employee.fullName} chưa được gắn điểm trạm`}.`);
      return;
    }
    const check = checkManualAssignment(ctx, employee, date, shift.id, stationCode, false);
    if (check.blocker) {
      errors.push(`Dòng ${line}: ${employee.fullName} ngày ${date} - ${REASON_LABEL[check.blocker] || check.blocker}.`);
      return;
    }
    ctx.existing.push({ dutyDate: date, shiftId: shift.id, employeeId: employee.id, status: "PLANNED" } as AssignmentRow);
    taken.add(key);
    inserts.push({
      id: newId("duty"),
      dutyDate: date,
      shiftId: shift.id,
      employeeId: employee.id,
      dayType: classifyDay(date, holidayMap, settings.workHours),
      status: "PLANNED",
      note: str(row.note) || null,
      stationCode,
      departmentId: check.departmentId,
      workplaceId: check.workplaceId,
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
//  Xoá toàn bộ lịch trực một tháng (để phân lại tự động)
// ---------------------------------------------------------------------------

type DbTx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type DbExec = typeof db | DbTx;
type AssignmentRow = typeof attDutyAssignments.$inferSelect;

/** Lỗi nghiệp vụ trong giao dịch xoá lịch: ném ra để rollback, trả về đúng mã HTTP. */
class RosterClearError extends Error {
  constructor(public status: number, message: string, public extra: Record<string, unknown> = {}) {
    super(message);
  }
}

/** "2026-09" → "09/2026" - chuỗi người dùng phải gõ lại để xác nhận lần cuối. */
function periodMonthLabel(period: string): string {
  return `${period.slice(5, 7)}/${period.slice(0, 4)}`;
}

/** Điều kiện tháng/năm bắt buộc cho MỌI lệnh đọc/xoá lịch trực hàng loạt. */
function monthRange(period: string) {
  const dates = periodDates(period);
  return and(gte(attDutyAssignments.dutyDate, dates[0]), lte(attDutyAssignments.dutyDate, dates[dates.length - 1]));
}

/**
 * Lập phương án xoá lịch trực của một tháng.
 *
 * Suất trực nào đã phát sinh dữ liệu chấm trực (có bất kỳ dòng att_duty_logs
 * nào, kể cả dòng đã bị thay thế/huỷ) hoặc đang có đề nghị điều chỉnh công chờ
 * duyệt trỏ tới thì được GIỮ NGUYÊN: xoá chúng là làm mất dấu vết chấm công.
 * Những suất đó phải xử lý theo quy trình điều chỉnh riêng. Đề nghị đổi ca đang
 * chờ của các suất bị xoá sẽ được huỷ kèm, vì suất trực gốc không còn nữa.
 */
async function planRosterClear(q: DbExec, period: string, lock = false) {
  const dates = periodDates(period);
  const base = q.select().from(attDutyAssignments).where(monthRange(period));
  // Tuần tự, không Promise.all: trong giao dịch mọi truy vấn đi chung một kết nối.
  const assignments = (await (lock ? base.for("update") : base)) as AssignmentRow[];
  const logs = await q
    .select({ assignmentId: attDutyLogs.assignmentId })
    .from(attDutyLogs)
    .where(and(gte(attDutyLogs.dutyDate, dates[0]), lte(attDutyLogs.dutyDate, addDays(dates[dates.length - 1], 1))));
  const pending = await q
    .select({ id: attRequests.id, kind: attRequests.kind, payload: attRequests.payload })
    .from(attRequests)
    .where(and(eq(attRequests.status, "PENDING"), inArray(attRequests.kind, ["SWAP_DUTY", "ADMIN_ADJUST"])));

  const ids = new Set(assignments.map((a) => a.id));
  const logged = new Set(logs.map((l) => l.assignmentId).filter((id) => ids.has(id)));
  // Ca trực qua đêm có thể có nhật ký ghi ngày khác: soát thêm theo mã suất trực.
  const unknown = assignments.filter((a) => !logged.has(a.id)).map((a) => a.id);
  if (unknown.length) {
    const extra = await q
      .select({ assignmentId: attDutyLogs.assignmentId })
      .from(attDutyLogs)
      .where(inArray(attDutyLogs.assignmentId, unknown));
    for (const l of extra) logged.add(l.assignmentId);
  }

  const adjusting = new Set<string>();
  const swapsByAssignment = new Map<string, string[]>();
  for (const r of pending) {
    let payload: Record<string, unknown> = {};
    try {
      payload = JSON.parse(r.payload || "{}");
    } catch {
      continue;
    }
    const assignmentId = str(payload.assignmentId);
    if (!ids.has(assignmentId)) continue;
    if (r.kind === "ADMIN_ADJUST") adjusting.add(assignmentId);
    else swapsByAssignment.set(assignmentId, [...(swapsByAssignment.get(assignmentId) || []), r.id]);
  }

  const kept = assignments.filter((a) => logged.has(a.id) || adjusting.has(a.id));
  const removable = assignments.filter((a) => !logged.has(a.id) && !adjusting.has(a.id));
  const isActive = (a: AssignmentRow) => String(a.status || "PLANNED").toUpperCase() !== "CANCELLED";
  const activeRemovable = removable.filter(isActive);
  const swapRequestIds = removable.flatMap((a) => swapsByAssignment.get(a.id) || []);

  return {
    removable,
    kept,
    swapRequestIds,
    summary: {
      period,
      label: periodMonthLabel(period),
      // Số ngày có ít nhất một suất trực sẽ bị xoá và số lượt trực (suất đang hiệu lực).
      days: new Set(activeRemovable.map((a) => a.dutyDate)).size,
      duties: activeRemovable.length,
      // Bản ghi đã huỷ trước đó, cũng được dọn cùng.
      cancelledRecords: removable.length - activeRemovable.length,
      records: removable.length,
      employees: new Set(activeRemovable.map((a) => a.employeeId)).size,
      keptWithAttendance: kept.filter((a) => logged.has(a.id)).length,
      keptPendingAdjust: kept.filter((a) => !logged.has(a.id)).length,
      kept: kept.length,
      pendingSwapRequests: swapRequestIds.length,
    },
  };
}

/** Xem trước số liệu sẽ bị xoá + các bản sao lưu gần nhất của tháng. */
async function handleRosterClearPreview(actor: ActorContext, period: string) {
  requirePermission(actor, "roster.manage");
  if (!isValidPeriod(period)) return json({ success: false, error: "Thiếu hoặc sai tháng/năm cần xoá lịch trực." }, 400);
  const [plan, locked, snapshots] = await Promise.all([
    planRosterClear(db, period),
    periodStatus(period),
    db
      .select({
        id: attRosterSnapshots.id,
        rowCount: attRosterSnapshots.rowCount,
        createdAt: attRosterSnapshots.createdAt,
        createdByName: attRosterSnapshots.createdByName,
        restoredAt: attRosterSnapshots.restoredAt,
      })
      .from(attRosterSnapshots)
      .where(eq(attRosterSnapshots.period, period))
      .orderBy(desc(attRosterSnapshots.createdAt))
      .limit(5),
  ]);
  return json({ success: true, locked: locked === "LOCKED", ...plan.summary, snapshots });
}

/**
 * Xoá toàn bộ lịch trực của ĐÚNG tháng đang chọn.
 *
 * Bắt buộc: quyền roster.manage, kỳ chưa khoá, tháng hợp lệ, chuỗi xác nhận
 * gõ lại đúng "MM/YYYY" và số liệu khớp với lần xem trước (lịch bị người khác
 * sửa giữa chừng thì từ chối, để không xoá thứ người dùng chưa nhìn thấy).
 * Chụp bản sao lưu, xoá và huỷ đề nghị đổi ca nằm trong MỘT giao dịch: lỗi ở
 * bất kỳ bước nào thì rollback toàn bộ, lịch trực giữ nguyên như trước.
 * Danh mục cán bộ, ca, quy tắc, ngày lễ và dữ liệu chấm công không bị đụng tới.
 */
async function clearRosterMonth(actor: ActorContext, body: Record<string, unknown>) {
  const period = str(body.period);
  try {
    requirePermission(actor, "roster.manage");
  } catch (err) {
    await writeAudit(actor, {
      entity: "duty_assignment",
      entityId: isValidPeriod(period) ? period : null,
      action: "ROSTER_CLEAR_DENIED",
      newValue: { result: "FORBIDDEN" },
    });
    throw err;
  }
  if (!isValidPeriod(period)) return json({ success: false, error: "Thiếu hoặc sai tháng/năm cần xoá lịch trực." }, 400);
  const label = periodMonthLabel(period);
  if (str(body.confirm) !== label) {
    return json({ success: false, error: `Xác nhận không khớp. Hãy gõ đúng "${label}" để xoá lịch trực tháng này.` }, 400);
  }
  await assertPeriodOpen(period);

  const expectedDuties = Math.round(num(body.expectedDuties, -1));
  const expectedKept = Math.round(num(body.expectedKept, -1));
  const snapshotId = newId("rsnap");
  const now = Date.now();

  try {
    const result = await db.transaction(async (tx) => {
      const plan = await planRosterClear(tx, period, true);
      if (plan.summary.duties !== expectedDuties || plan.summary.kept !== expectedKept) {
        throw new RosterClearError(
          409,
          "Lịch trực tháng này vừa thay đổi kể từ lúc xem trước. Hãy mở lại chức năng xoá để kiểm tra số liệu mới.",
          { summary: plan.summary }
        );
      }
      if (!plan.removable.length) {
        throw new RosterClearError(404, `Tháng ${label} không có suất trực nào có thể xoá.`, { summary: plan.summary });
      }

      await tx.insert(attRosterSnapshots).values({
        id: snapshotId,
        period,
        reason: "CLEAR_MONTH",
        rowCount: plan.removable.length,
        rows: JSON.stringify(plan.removable),
        createdBy: actor.user.id,
        createdByName: actor.employee?.fullName || actor.user.name,
        createdAt: now,
      });

      const removableIds = plan.removable.map((a) => a.id);
      const deleted: { id: string }[] = [];
      for (let i = 0; i < removableIds.length; i += 500) {
        const chunk = removableIds.slice(i, i + 500);
        deleted.push(
          ...(await tx
            .delete(attDutyAssignments)
            .where(and(monthRange(period), inArray(attDutyAssignments.id, chunk)))
            .returning({ id: attDutyAssignments.id }))
        );
      }
      if (deleted.length !== removableIds.length) {
        throw new RosterClearError(409, "Số suất trực xoá được không khớp phương án. Đã huỷ thao tác, lịch trực giữ nguyên.");
      }

      if (plan.swapRequestIds.length) {
        await tx
          .update(attRequests)
          .set({
            status: "CANCELLED",
            decidedBy: actor.user.id,
            decidedByName: actor.employee?.fullName || actor.user.name,
            decidedAt: now,
            decisionNote: `Tự huỷ: lịch trực tháng ${label} đã bị xoá để phân lại.`,
            updatedAt: now,
          })
          .where(and(inArray(attRequests.id, plan.swapRequestIds), eq(attRequests.status, "PENDING")));
      }
      return plan;
    });

    const summary = result.summary;
    await writeAudit(actor, {
      entity: "duty_assignment",
      entityId: period,
      action: "ROSTER_CLEAR_MONTH",
      oldValue: { records: summary.records, duties: summary.duties, days: summary.days, snapshotId },
      newValue: {
        result: "SUCCESS",
        deleted: summary.records,
        kept: summary.kept,
        keptWithAttendance: summary.keptWithAttendance,
        cancelledSwapRequests: summary.pendingSwapRequests,
      },
    });
    const affected = [...new Set(result.removable.filter((a) => String(a.status || "PLANNED").toUpperCase() !== "CANCELLED").map((a) => a.employeeId))];
    if (affected.length) {
      await notify(affected, "Lịch trực tháng được lập lại", `Lịch trực tháng ${label} đã được xoá để phân lại. Vui lòng theo dõi lịch mới.`, "DUTY", period);
    }
    return json({
      success: true,
      message: `Đã xóa lịch trực tháng ${label}. Có thể tiến hành phân lịch tự động.`,
      ...summary,
      snapshotId,
    });
  } catch (err) {
    await writeAudit(actor, {
      entity: "duty_assignment",
      entityId: period,
      action: "ROSTER_CLEAR_FAILED",
      newValue: {
        result: err instanceof RosterClearError ? "REJECTED" : "ERROR",
        message: err instanceof Error ? err.message.slice(0, 300) : "unknown",
      },
    });
    if (err instanceof RosterClearError) return json({ success: false, error: err.message, ...err.extra }, err.status);
    if (isImmutableViolation(err)) {
      return json({ success: false, code: "IMMUTABLE", error: "Có dữ liệu chấm trực gắn với lịch tháng này nên không xoá được. Lịch trực giữ nguyên." }, 409);
    }
    console.error("roster clear failed", err);
    return json({ success: false, error: "Không xoá được lịch trực, hệ thống đã hoàn tác. Lịch trực vẫn giữ nguyên như trước." }, 500);
  }
}

/**
 * Khôi phục lịch trực từ bản sao lưu đã chụp lúc xoá tháng.
 *
 * Chỉ khôi phục khi tháng chưa có lịch mới (ngoài các suất được giữ lại vì đã
 * chấm trực) - trộn lịch cũ với lịch phân lại sẽ làm sai quy tắc phân trực.
 */
async function restoreRosterSnapshot(actor: ActorContext, body: Record<string, unknown>) {
  requirePermission(actor, "roster.manage");
  const period = str(body.period);
  const snapshotId = str(body.snapshotId);
  if (!isValidPeriod(period) || !snapshotId) return json({ success: false, error: "Thiếu tháng hoặc bản sao lưu cần khôi phục." }, 400);
  await assertPeriodOpen(period);
  const label = periodMonthLabel(period);

  try {
    const restored = await db.transaction(async (tx) => {
      const found = await tx
        .select()
        .from(attRosterSnapshots)
        .where(and(eq(attRosterSnapshots.id, snapshotId), eq(attRosterSnapshots.period, period)))
        .for("update");
      if (!found.length) throw new RosterClearError(404, "Không tìm thấy bản sao lưu của tháng này.");
      if (found[0].restoredAt) throw new RosterClearError(409, "Bản sao lưu này đã được khôi phục trước đó.");

      const plan = await planRosterClear(tx, period, true);
      if (plan.removable.length) {
        throw new RosterClearError(
          409,
          `Tháng ${label} đã có lịch trực mới. Hãy xoá lịch hiện tại trước khi khôi phục bản sao lưu.`
        );
      }
      const keptIds = new Set(plan.kept.map((a) => a.id));
      const keptKeys = new Set(plan.kept.map((a) => `${a.dutyDate}|${a.shiftId}|${a.employeeId}`));
      const rows = (JSON.parse(found[0].rows) as AssignmentRow[]).filter(
        (r) => periodOf(r.dutyDate) === period && !keptIds.has(r.id) && !keptKeys.has(`${r.dutyDate}|${r.shiftId}|${r.employeeId}`)
      );
      // Danh mục có thể đã đổi sau khi chụp bản sao: liên kết tới quy tắc / nơi
      // làm việc / điểm trạm / khoa phòng không còn thì để trống thay vì vi phạm khoá ngoại.
      const [ruleIds, wpIds, stCodes, deptIds] = await Promise.all([
        tx.select({ id: attDutyRules.id }).from(attDutyRules),
        tx.select({ id: attWorkplaces.id }).from(attWorkplaces),
        tx.select({ id: stationRooms.stationCode }).from(stationRooms),
        tx.select({ id: attDepartments.id }).from(attDepartments),
      ]).then((all) => all.map((list) => new Set(list.map((x) => x.id))));
      const keep = (set: Set<string>, v: string | null | undefined) => (v && set.has(v) ? v : null);
      for (const r of rows) {
        r.ruleId = keep(ruleIds, r.ruleId);
        r.workplaceId = keep(wpIds, r.workplaceId);
        r.stationCode = keep(stCodes, r.stationCode);
        r.departmentId = keep(deptIds, r.departmentId);
      }
      for (let i = 0; i < rows.length; i += 500) {
        await tx.insert(attDutyAssignments).values(rows.slice(i, i + 500));
      }
      await tx
        .update(attRosterSnapshots)
        .set({ restoredAt: Date.now(), restoredBy: actor.user.id })
        .where(eq(attRosterSnapshots.id, snapshotId));
      return rows.length;
    });
    await writeAudit(actor, {
      entity: "duty_assignment",
      entityId: period,
      action: "ROSTER_RESTORE",
      newValue: { result: "SUCCESS", snapshotId, restored },
    });
    return json({ success: true, message: `Đã khôi phục ${restored} suất trực tháng ${label} từ bản sao lưu.`, restored });
  } catch (err) {
    await writeAudit(actor, {
      entity: "duty_assignment",
      entityId: period,
      action: "ROSTER_RESTORE_FAILED",
      newValue: { snapshotId, message: err instanceof Error ? err.message.slice(0, 300) : "unknown" },
    });
    if (err instanceof RosterClearError) return json({ success: false, error: err.message }, err.status);
    console.error("roster restore failed", err);
    return json({ success: false, error: "Không khôi phục được lịch trực, hệ thống đã hoàn tác." }, 500);
  }
}

// ---------------------------------------------------------------------------
//  Điều chỉnh dữ liệu công - KHÔNG sửa/xoá bản gốc (yêu cầu 10, 16)
// ---------------------------------------------------------------------------

/** Nội dung một đề nghị điều chỉnh do Quản trị/Phụ trách khởi tạo. */
type AdminChange = {
  target: "PUNCH" | "DUTY_LOG";
  operation: "CREATE" | "REPLACE" | "VOID";
  employeeId: string;
  workDate: string;
  originalId: number | null;
  punchType?: "IN" | "OUT";
  time?: string;
  assignmentId?: string;
  checkInTime?: string;
  checkOutTime?: string;
  note?: string;
  requestedBy?: string;
  requestedByName?: string;
};

const TIME_RE = /^([01]?\d|2[0-3]):[0-5]\d$/;

/** Không ai được tự điều chỉnh / tự duyệt dữ liệu công của chính mình. */
function assertNotSelf(actor: ActorContext, employeeId: string, what: string) {
  if (actor.employee && actor.employee.id === employeeId) {
    throw new AuthError(403, "SELF_ACTION", `Không được ${what} dữ liệu công của chính mình. Hãy gửi đề nghị để người khác duyệt.`);
  }
}

/**
 * Gửi một thay đổi dữ liệu công. Khi bật "bốn mắt" (mặc định), thay đổi thành
 * đề nghị ADMIN_ADJUST chờ MỘT NGƯỜI DUYỆT KHÁC; khi tắt, thay đổi được áp ngay
 * nhưng vẫn qua bản ghi điều chỉnh và sinh cảnh báo VÀNG để hậu kiểm.
 */
async function submitAdminChange(actor: ActorContext, employee: EmployeeRow, change: AdminChange, reasonText: string) {
  const security = await getSecurity();
  const now = Date.now();
  const requestedByName = actor.employee?.fullName || actor.user.name;
  if (security.fourEyes) {
    const id = newId("req");
    await db.insert(attRequests).values({
      id,
      kind: "ADMIN_ADJUST",
      employeeId: change.employeeId,
      targetDate: change.workDate,
      payload: JSON.stringify({ ...change, requestedBy: actor.user.id, requestedByName }),
      reason: reasonText,
      status: "PENDING",
      createdAt: now,
      updatedAt: now,
    });
    await writeAudit(actor, {
      entity: "request",
      entityId: id,
      action: "ADMIN_ADJUST_REQUEST",
      newValue: change,
      reason: reasonText,
    });
    await notifyApprovers(employee, "Đề nghị điều chỉnh dữ liệu công", `${requestedByName} đề nghị điều chỉnh dữ liệu công của ${employee.fullName} ngày ${change.workDate}.`, id);
    return json({
      success: true,
      pending: true,
      message: "Đã tạo đề nghị điều chỉnh. Thay đổi chỉ có hiệu lực khi một người duyệt KHÁC phê duyệt.",
      requestId: id,
    });
  }
  const result = await executeChange(change, {
    reason: reasonText,
    requestId: null,
    requestedBy: actor.user.id,
    requestedByName,
    requestedAt: now,
    approver: actor,
    selfApproved: true,
  });
  await raiseAlert({
    level: "YELLOW",
    category: "ADMIN_ADJUSTMENT",
    employeeId: change.employeeId,
    userId: actor.user.id,
    title: "Quản trị tự điều chỉnh dữ liệu công",
    cause: `${requestedByName} đã ${change.operation === "VOID" ? "huỷ hiệu lực" : change.operation === "REPLACE" ? "thay thế" : "bổ sung"} dữ liệu công của ${employee.fullName} ngày ${change.workDate} (không qua người duyệt thứ hai). Lý do: ${reasonText}`,
    evidence: { adjustmentId: result.adjustmentId, change },
    dedupeKey: `ADMIN_ADJUSTMENT|${result.adjustmentId}`,
  });
  await notify(change.employeeId, "Điều chỉnh dữ liệu công", `Dữ liệu công ngày ${change.workDate} của bạn vừa được điều chỉnh. Lý do: ${reasonText}`, "ADJUST", result.adjustmentId);
  return json({ success: true, message: `Đã điều chỉnh dữ liệu công ngày ${change.workDate}.`, adjustmentId: result.adjustmentId });
}

/** Áp một thay đổi đã được duyệt (dùng chung cho tự duyệt và duyệt bốn mắt). */
async function executeChange(change: AdminChange, approval: Approval) {
  await assertPeriodOpen(change.workDate);
  const settings = await getSettings();
  if (change.target === "PUNCH") {
    let original: PunchRow | null = null;
    if (change.originalId) {
      const rows = await db.select().from(attPunches).where(eq(attPunches.id, change.originalId));
      original = rows[0] || null;
      if (!original || original.employeeId !== change.employeeId) throw new AdjustmentConflict("Không tìm thấy lượt chấm công gốc.");
      if (String(original.state || "ACTIVE").toUpperCase() !== "ACTIVE") {
        throw new AdjustmentConflict("Lượt chấm công gốc đã bị thay thế/huỷ trước đó.");
      }
    }
    let values = null;
    if (change.operation !== "VOID") {
      const punchType = change.punchType === "OUT" ? "OUT" : "IN";
      const time = String(change.time || "");
      const evaluation = evaluatePunch(punchType, time, settings.workHours);
      values = {
        punchType,
        punchAt: vnEpoch(change.workDate, time),
        session: evaluation.session,
        status: evaluation.status,
        minutesDelta: evaluation.minutesDelta,
        device: approval.requestId ? "Điều chỉnh đã duyệt" : "Quản trị điều chỉnh",
        ip: approval.approver.ip || null,
        userAgent: approval.approver.userAgent || null,
        source: approval.requestId ? "REQUEST" : "ADMIN",
        requestId: approval.requestId || null,
        note: change.note || approval.reason,
      };
    }
    return applyPunchChange({
      operation: change.operation,
      employeeId: change.employeeId,
      workDate: change.workDate,
      original,
      values,
      approval,
    });
  }

  // DUTY_LOG
  const found = await db.select().from(attDutyAssignments).where(eq(attDutyAssignments.id, String(change.assignmentId || "")));
  if (!found.length) throw new AdjustmentConflict("Không tìm thấy suất trực.");
  const duty = found[0];
  const logs = await db
    .select()
    .from(attDutyLogs)
    .where(and(eq(attDutyLogs.assignmentId, duty.id), ACTIVE_DUTY_LOG));
  const original = logs[0] || null;
  if (change.originalId && original?.id !== change.originalId) {
    throw new AdjustmentConflict("Nhật ký trực gốc đã thay đổi kể từ lúc tạo đề nghị. Vui lòng tạo đề nghị mới.");
  }
  if (change.operation === "VOID" && !original) throw new AdjustmentConflict("Không có nhật ký trực để huỷ hiệu lực.");
  let values = null;
  let operation = change.operation;
  if (operation !== "VOID") {
    if (original) operation = "REPLACE";
    const shifts = await listShifts(true);
    const shift = shifts.find((s) => s.id === duty.shiftId);
    const checkInTime = change.checkInTime || shift?.startTime || "";
    const checkOutTime = change.checkOutTime || shift?.endTime || "";
    const overnight = shift ? String(shift.crossesMidnight || "false") === "true" || crossesMidnight(shift.startTime, shift.endTime) : false;
    if (!TIME_RE.test(checkInTime)) throw new AdjustmentConflict("Giờ nhận ca không hợp lệ.");
    const checkInAt = vnEpoch(duty.dutyDate, checkInTime);
    // Ca qua đêm: giờ kết ca thuộc ngày hôm sau.
    const checkOutAt = TIME_RE.test(checkOutTime)
      ? vnEpoch(overnight ? addDays(duty.dutyDate, 1) : duty.dutyDate, checkOutTime)
      : null;
    const now = Date.now();
    values = {
      assignmentId: duty.id,
      employeeId: duty.employeeId,
      dutyDate: duty.dutyDate,
      shiftId: duty.shiftId,
      checkInAt,
      checkOutAt,
      hours: shift ? shift.hours ?? shiftHours(shift.startTime, shift.endTime) : 0,
      device: approval.requestId ? "Điều chỉnh đã duyệt" : "Quản trị điều chỉnh",
      ip: approval.approver.ip || null,
      status: checkOutAt ? "ADMIN" : "OPEN",
      source: "ADMIN",
      note: change.note || approval.reason,
      approvalStatus: "APPROVED",
      approvedBy: approval.approver.user.id,
      approvedByName: approval.approver.employee?.fullName || approval.approver.user.name,
      approvedAt: now,
    };
  }
  return applyDutyLogChange({
    operation,
    original,
    values,
    employeeId: duty.employeeId,
    dutyDate: duty.dutyDate,
    approval,
  });
}

/** Lý do điều chỉnh là bắt buộc (yêu cầu 10). */
function adjustReason(body: Record<string, unknown>): string {
  const text = (str(body.reason) || str(body.note)).slice(0, 1000);
  if (text.length < 5) throw new AuthError(400, "REASON_REQUIRED", "Vui lòng nêu lý do điều chỉnh (tối thiểu 5 ký tự).");
  return text;
}

/**
 * Quản trị bổ sung (không có id) hoặc thay thế (có id) một lượt chấm công.
 * Không bao giờ UPDATE bản gốc: bản mới được chèn, bản gốc chuyển SUPERSEDED.
 */
async function savePunch(actor: ActorContext, body: Record<string, unknown>) {
  requirePermission(actor, "timedata.edit");
  const employeeId = str(body.employeeId);
  const workDate = str(body.workDate);
  const punchType = str(body.punchType).toUpperCase() === "OUT" ? "OUT" : "IN";
  const time = str(body.time);
  if (!isValidDate(workDate)) return json({ success: false, error: "Ngày chấm công không hợp lệ." }, 400);
  if (!TIME_RE.test(time)) return json({ success: false, error: "Giờ chấm công phải ở dạng HH:MM." }, 400);
  if (workDate > vnDate()) return json({ success: false, error: "Không điều chỉnh cho ngày chưa tới." }, 400);
  const employee = await assertCanManage(actor, employeeId);
  assertNotSelf(actor, employeeId, "tự điều chỉnh");
  await assertPeriodOpen(workDate);
  const reasonText = adjustReason(body);

  const id = num(body.id, 0);
  if (id) {
    const existing = await db.select().from(attPunches).where(eq(attPunches.id, id));
    if (!existing.length || existing[0].employeeId !== employeeId) return json({ success: false, error: "Không tìm thấy lượt chấm công." }, 404);
    if (String(existing[0].state || "ACTIVE").toUpperCase() !== "ACTIVE") {
      return json({ success: false, error: "Lượt chấm công này đã bị thay thế/huỷ, không điều chỉnh tiếp được." }, 409);
    }
  }
  return submitAdminChange(
    actor,
    employee,
    { target: "PUNCH", operation: id ? "REPLACE" : "CREATE", employeeId, workDate, originalId: id || null, punchType, time, note: str(body.note).slice(0, 500) },
    reasonText
  );
}

/** "Xoá" lượt chấm công = huỷ hiệu lực (VOIDED). Bản gốc và bằng chứng còn nguyên. */
async function deletePunch(actor: ActorContext, body: Record<string, unknown>) {
  requirePermission(actor, "timedata.edit");
  const id = num(body.id, 0);
  const existing = await db.select().from(attPunches).where(eq(attPunches.id, id));
  if (!existing.length) return json({ success: false, error: "Không tìm thấy lượt chấm công." }, 404);
  const punch = existing[0];
  if (String(punch.state || "ACTIVE").toUpperCase() !== "ACTIVE") {
    return json({ success: false, error: "Lượt chấm công này đã bị thay thế/huỷ trước đó." }, 409);
  }
  const employee = await assertCanManage(actor, punch.employeeId);
  assertNotSelf(actor, punch.employeeId, "tự huỷ");
  await assertPeriodOpen(punch.workDate);
  const reasonText = adjustReason(body);
  return submitAdminChange(
    actor,
    employee,
    { target: "PUNCH", operation: "VOID", employeeId: punch.employeeId, workDate: punch.workDate, originalId: punch.id },
    reasonText
  );
}

/** Ghi nhận / thay thế / huỷ nhật ký một ca trực (cán bộ quên bấm, bấm sai). */
async function saveDutyLog(actor: ActorContext, body: Record<string, unknown>) {
  requirePermission(actor, "timedata.edit");
  const assignmentId = str(body.assignmentId);
  const found = await db.select().from(attDutyAssignments).where(eq(attDutyAssignments.id, assignmentId));
  if (!found.length) return json({ success: false, error: "Không tìm thấy suất trực." }, 404);
  const duty = found[0];
  await assertPeriodOpen(duty.dutyDate);
  const employee = await assertCanManage(actor, duty.employeeId);
  assertNotSelf(actor, duty.employeeId, "tự điều chỉnh");
  const reasonText = adjustReason(body);
  const voiding = str(body.operation).toUpperCase() === "VOID";

  const checkInTime = str(body.checkInTime);
  const checkOutTime = str(body.checkOutTime);
  if (!voiding && checkInTime && !TIME_RE.test(checkInTime)) return json({ success: false, error: "Giờ nhận ca không hợp lệ." }, 400);
  if (!voiding && checkOutTime && !TIME_RE.test(checkOutTime)) return json({ success: false, error: "Giờ kết ca không hợp lệ." }, 400);

  const logs = await db
    .select()
    .from(attDutyLogs)
    .where(and(eq(attDutyLogs.assignmentId, assignmentId), ACTIVE_DUTY_LOG));
  const original = logs[0] || null;
  if (voiding && !original) return json({ success: false, error: "Chưa có nhật ký trực để huỷ." }, 404);
  return submitAdminChange(
    actor,
    employee,
    {
      target: "DUTY_LOG",
      operation: voiding ? "VOID" : original ? "REPLACE" : "CREATE",
      employeeId: duty.employeeId,
      workDate: duty.dutyDate,
      originalId: original?.id ?? null,
      assignmentId,
      checkInTime,
      checkOutTime,
      note: str(body.note).slice(0, 500),
    },
    reasonText
  );
}

/** Quản trị/Phụ trách ghi trực tiếp một kỳ nghỉ cho cán bộ (đã duyệt sẵn). */
async function saveLeave(actor: ActorContext, body: Record<string, unknown>) {
  requirePermission(actor, "leave.record");
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
  requirePermission(actor, "approvals.decide");
  const id = str(body.id);
  const approve = str(body.decision).toUpperCase() !== "REJECT";
  const note = str(body.note).slice(0, 1000);

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
  const kind = String(request.kind).toUpperCase();

  // Không ai tự duyệt yêu cầu của chính mình, kể cả Quản trị (nguyên tắc bốn mắt).
  const selfDecision =
    (actor.employee && actor.employee.id === request.employeeId) ||
    (kind === "ADMIN_ADJUST" && str(payload.requestedBy) === actor.user.id);
  if (selfDecision) {
    await raiseAlert({
      level: "YELLOW",
      category: "SELF_APPROVAL",
      employeeId: request.employeeId,
      userId: actor.user.id,
      title: "Cố tự duyệt yêu cầu của chính mình",
      cause: `${actor.employee?.fullName || actor.user.name} cố duyệt yêu cầu ${kind} do chính mình tạo / của chính mình. Hệ thống đã chặn.`,
      evidence: { requestId: id, kind },
      dedupeKey: `SELF_APPROVAL|${id}|${actor.user.id}`,
    });
    return json({ success: false, error: "Không được tự duyệt yêu cầu của chính mình. Yêu cầu phải do một người duyệt khác xử lý." }, 403);
  }

  // Giữ chỗ nguyên tử: chỉ một người duyệt thắng khi hai người bấm cùng lúc.
  const now = Date.now();
  const claimed = await db
    .update(attRequests)
    .set({
      status: approve ? "APPROVED" : "REJECTED",
      decidedBy: actor.user.id,
      decidedByName: actor.employee?.fullName || actor.user.name,
      decidedAt: now,
      decisionNote: note || null,
      updatedAt: now,
    })
    .where(and(eq(attRequests.id, id), sql`coalesce(${attRequests.status}, 'PENDING') = 'PENDING'`))
    .returning({ id: attRequests.id });
  if (!claimed.length) return json({ success: false, error: "Yêu cầu vừa được người khác xử lý." }, 409);

  const approval: Approval = {
    reason: request.reason || note || "Duyệt yêu cầu",
    requestId: request.id,
    requestedBy: str(payload.requestedBy) || request.employeeId,
    requestedByName: str(payload.requestedByName) || employee.fullName,
    requestedAt: request.createdAt || now,
    approver: actor,
    selfApproved: false,
  };

  try {
    if (approve && kind === "ADJUST_PUNCH") {
      const workDate = str(request.targetDate);
      const wanted = (Array.isArray(payload.punches) ? payload.punches : []) as Record<string, unknown>[];
      const valid = wanted.filter((e) => TIME_RE.test(str(e.time))).slice(0, 8);
      if (!valid.length) throw new AdjustmentConflict("Yêu cầu không có mốc giờ hợp lệ để ghi nhận.");
      const settings = await getSettings();
      for (const entry of valid) {
        const time = str(entry.time);
        const punchType = str(entry.type).toUpperCase() === "OUT" ? "OUT" : "IN";
        const evaluation = evaluatePunch(punchType, time, settings.workHours);
        // Lượt chấm ACTIVE cùng buổi cùng loại được THAY THẾ (bản gốc chuyển SUPERSEDED, không xoá).
        const actives = await db
          .select()
          .from(attPunches)
          .where(and(eq(attPunches.employeeId, request.employeeId), eq(attPunches.workDate, workDate), ACTIVE_PUNCH));
        const replaced =
          actives.find(
            (p) => String(p.punchType).toUpperCase() === punchType && String(p.session || "").toUpperCase() === evaluation.session
          ) || null;
        await applyPunchChange({
          operation: replaced ? "REPLACE" : "CREATE",
          employeeId: request.employeeId,
          workDate,
          original: replaced,
          values: {
            punchType,
            punchAt: vnEpoch(workDate, time),
            session: evaluation.session,
            status: evaluation.status,
            minutesDelta: evaluation.minutesDelta,
            device: payload.offline ? "Chấm ngoại tuyến đã duyệt" : "Duyệt yêu cầu điều chỉnh",
            ip: actor.ip || null,
            source: "REQUEST",
            requestId: request.id,
            note: note || request.reason,
          },
          approval,
        });
      }
    }

    if (approve && kind === "ADMIN_ADJUST") {
      await executeChange(payload as unknown as AdminChange, approval);
    }

    if (approve && kind === "SWAP_DUTY") {
      const assignmentId = str(payload.assignmentId);
      const toEmployeeId = str(payload.toEmployeeId);
      const duty = await db.select().from(attDutyAssignments).where(eq(attDutyAssignments.id, assignmentId));
      if (!duty.length) throw new AdjustmentConflict("Suất trực trong yêu cầu không còn tồn tại.");
      // Ca đã có người nhận thì không đổi được: nhật ký trực gắn với người đã có mặt.
      const logs = await db
        .select({ id: attDutyLogs.id })
        .from(attDutyLogs)
        .where(and(eq(attDutyLogs.assignmentId, assignmentId), ACTIVE_DUTY_LOG));
      if (logs.length) throw new AdjustmentConflict("Ca trực này đã được nhận ca nên không đổi người được nữa.");
      await db
        .update(attDutyAssignments)
        .set({ employeeId: toEmployeeId, swappedFromEmployeeId: request.employeeId, updatedAt: now })
        .where(eq(attDutyAssignments.id, assignmentId));
      await writeAudit(actor, {
        entity: "duty_assignment",
        entityId: assignmentId,
        action: "SWAP_APPROVED",
        field: "employeeId",
        oldValue: request.employeeId,
        newValue: toEmployeeId,
        reason: request.reason || null,
        approverId: actor.user.id,
        approverName: actor.employee?.fullName || actor.user.name,
      });
      await notify(
        toEmployeeId,
        "Nhận ca trực thay",
        `Bạn nhận ca trực ngày ${duty[0].dutyDate} thay cho ${employee.fullName}.`,
        "DUTY",
        assignmentId
      );
    }
  } catch (err) {
    // Không áp được thì trả yêu cầu về trạng thái chờ để xử lý lại.
    await db
      .update(attRequests)
      .set({ status: "PENDING", decidedBy: null, decidedByName: null, decidedAt: null, decisionNote: null, updatedAt: Date.now() })
      .where(eq(attRequests.id, id));
    if (err instanceof AdjustmentConflict) return json({ success: false, error: err.message }, 409);
    throw err;
  }

  await writeAudit(actor, {
    entity: "request",
    entityId: id,
    action: approve ? "APPROVE" : "REJECT",
    oldValue: { status: "PENDING" },
    newValue: { kind, status: approve ? "APPROVED" : "REJECTED", employee: employee.fullName, note },
    reason: request.reason || null,
    approverId: actor.user.id,
    approverName: actor.employee?.fullName || actor.user.name,
  });
  const kindLabel =
    kind === "ADJUST_PUNCH" ? "Yêu cầu điều chỉnh chấm công" : kind === "ADMIN_ADJUST" ? "Đề nghị điều chỉnh dữ liệu công" : "Yêu cầu đổi ca trực";
  await notify(
    request.employeeId,
    approve ? "Yêu cầu được duyệt" : "Yêu cầu bị từ chối",
    `${kindLabel} ngày ${request.targetDate || ""} ${approve ? "đã được duyệt" : "không được duyệt"}.${note ? ` Ý kiến: ${note}` : ""}`,
    "REQUEST",
    id
  );

  return json({ success: true, message: approve ? "Đã duyệt yêu cầu." : "Đã từ chối yêu cầu." });
}

async function decideLeave(actor: ActorContext, body: Record<string, unknown>) {
  requirePermission(actor, "approvals.decide");
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
  if (actor.employee && actor.employee.id === leave.employeeId) {
    return json({ success: false, error: "Không được tự duyệt đơn nghỉ của chính mình." }, 403);
  }
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
  requirePermission(actor, "periods.lock");
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
          requirePermission(actor, "manage.view");
          return await handleOverview(actor);
        case "departments":
          requireManager(actor);
          return await handleDepartments();
        case "employees":
          requireManager(actor);
          return await handleEmployees(actor);
        case "accounts":
          return await handleAccounts(actor);
        case "roles":
          requireManager(actor);
          return await handleRoles();
        case "shifts":
          return await handleShifts(actor);
        case "holidays":
          return await handleHolidays();
        case "settings":
          return await handleSettings();
        case "roster":
          requireManager(actor);
          return await handleRoster(actor, period);
        case "roster_scope":
          return await handleRosterScope(actor, str(url.searchParams.get("period")));
        case "employee_postings":
          return await handleEmployeePostings(actor, str(url.searchParams.get("employeeId")));
        case "roster_clear_preview":
          // Không lấy tháng mặc định: thiếu tháng là yêu cầu không hợp lệ.
          return await handleRosterClearPreview(actor, str(url.searchParams.get("period")));
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
    const csrf = csrfCheck(req);
    if (csrf) return csrf;

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
        requirePermission(actor, "shifts.manage");
        await ensureSeedData();
        await writeAudit(actor, { entity: "settings", entityId: "seed", action: "SEED_DEFAULTS" });
        return json({ success: true, message: "Đã nạp danh mục ca trực mẫu.", shifts: (await listShifts(true)).map(publicShift) });

      // Vai trò
      case "role_save":
        return await saveRole(actor, body);
      case "role_delete":
        return await deleteRole(actor, body);

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
      case "roster_auto_preview":
        return await previewAutoRoster(actor, body);
      case "roster_auto":
        return await autoAssignRoster(actor, body);
      case "workplace_save":
        return await saveWorkplace(actor, body);
      case "workplace_delete":
        return await deleteWorkplace(actor, body);
      case "duty_group_save":
        return await saveDutyGroup(actor, body);
      case "duty_group_delete":
        return await deleteDutyGroup(actor, body);
      case "duty_rule_save":
        return await saveDutyRule(actor, body);
      case "duty_rule_status":
        return await setDutyRuleStatus(actor, body);
      case "duty_rule_delete":
        return await deleteDutyRule(actor, body);
      case "secondment_save":
        return await saveSecondment(actor, body);
      case "secondment_decide":
        return await decideSecondment(actor, body);
      case "roster_import":
        return await importRoster(actor, body);
      case "roster_rules_save":
        return await saveRosterRules(actor, body);
      case "roster_rules_reset":
        return await resetRosterRules(actor);
      case "roster_clear_month":
        return await clearRosterMonth(actor, body);
      case "roster_restore_snapshot":
        return await restoreRosterSnapshot(actor, body);

      // Dữ liệu công
      case "punch_save":
        return await savePunch(actor, body);
      case "punch_delete":
        return await deletePunch(actor, body);
      case "duty_log_save":
        return await saveDutyLog(actor, body);
      case "duty_log_void":
        return await saveDutyLog(actor, { ...body, operation: "VOID" });
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
    if (err instanceof AdjustmentConflict) return json({ success: false, code: "CONFLICT", error: err.message }, 409);
    if (isImmutableViolation(err)) {
      return json({ success: false, code: "IMMUTABLE", error: "Dữ liệu gốc không được sửa hoặc xoá. Hãy tạo đề nghị điều chỉnh." }, 409);
    }
    console.error("attendance-admin error", err);
    return json({ success: false, error: "Hệ thống chấm công đang gián đoạn. Vui lòng thử lại." }, 500);
  }
};

export const config = {
  path: "/api/attendance/admin",
};
