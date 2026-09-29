/**
 * API của cán bộ trong Phân hệ Chấm công - Chấm trực.
 *
 * Đây là mặt tiếp xúc với người dùng cuối: nút CHẤM VÀO / CHẤM RA, nút nhận ca
 * và kết ca trực, bảng công cá nhân, đơn nghỉ phép và các yêu cầu cần duyệt.
 *
 *   GET  /api/attendance?view=bootstrap                 toàn bộ dữ liệu khởi động màn hình
 *   GET  /api/attendance?view=today                     trạng thái chấm công hôm nay
 *   GET  /api/attendance?view=my_timesheet&period=      bảng công cá nhân một kỳ
 *   GET  /api/attendance?view=duty_schedule&period=     lịch trực tháng (của mình hoặc toàn trạm)
 *   GET  /api/attendance?view=requests                  yêu cầu và đơn nghỉ của mình
 *   GET  /api/attendance?view=notifications             thông báo
 *   GET  /api/attendance?view=device&deviceHash=        thiết bị chấm công của mình
 *
 *   POST /api/attendance  { action: ... }
 *        challenge          xin thử thách xác minh dùng một lần (nonce + động tác)
 *        device_register    đăng ký thiết bị (chờ Quản trị duyệt)
 *        punch              chấm công vào/ra (có xác minh hiện diện)
 *        duty_check_in      nhận ca trực
 *        duty_self_check_in tự chấm trực: chọn ca, máy chủ tự sinh suất trực
 *        duty_check_out     kết ca trực
 *        request_adjust     xin điều chỉnh chấm công
 *        request_swap       xin đổi ca trực
 *        cancel_request     thu hồi yêu cầu chưa được duyệt
 *        submit_leave       gửi đơn nghỉ phép
 *        cancel_leave       thu hồi đơn nghỉ chưa được duyệt
 *        read_notifications đánh dấu đã đọc
 *        offline_sync       chuyển lượt chấm lúc mất mạng thành đề nghị điều chỉnh
 *        logout             thu hồi phiên đăng nhập
 *
 * Mỗi lượt chấm công / chấm trực đi qua verifyPresence() (netlify/lib/presence.ts):
 * nonce một lần + thiết bị đã duyệt ký số + GPS do máy chủ tính khoảng cách +
 * selfie trực tiếp có kiểm tra người thật + QR động (nếu bật). Mọi lượt thử -
 * kể cả bị từ chối - được ghi vào sổ bằng chứng att_attempts (chỉ ghi thêm).
 *
 * BA RÀO CHẮN ĐƯỢC ĐẶT Ở MÁY CHỦ, KHÔNG PHẢI Ở GIAO DIỆN:
 *   - Mọi tuyến đi qua resolveActor(), tức là phải có phiếu phiên còn hiệu lực
 *     VÀ quyền truy cập phân hệ còn được cấp (đọc lại từ cơ sở dữ liệu mỗi lần).
 *   - Cán bộ chỉ ghi được dữ liệu của CHÍNH MÌNH. Không có tham số employeeId
 *     nào trong tệp này - hồ sơ cán bộ luôn suy ra từ phiếu phiên, nên gọi thẳng
 *     API và tự điền mã người khác là vô nghĩa.
 *   - Kỳ đã khoá thì mọi đường ghi bị từ chối (assertPeriodOpen).
 */
import { db } from "../../db/index.js";
import {
  attDepartments,
  attDutyAssignments,
  attDutyLogs,
  attEmployees,
  attRoles,
  attLeaves,
  attNotifications,
  attDevices,
  attPunches,
  attRequests,
} from "../../db/schema.js";
import { and, asc, desc, eq, gte, inArray, isNull, lte, sql } from "drizzle-orm";
import { authErrorResponse } from "../lib/auth.js";
import {
  ACTIVE_DUTY_LOG,
  ACTIVE_PUNCH,
  AuthError,
  JSON_HEADERS,
  addDays,
  assertPeriodOpen,
  buildTimesheet,
  classifyDay,
  buildHolidayMap,
  csrfCheck,
  departmentNameMap,
  evaluatePunch,
  findEmployee,
  getSettings,
  isValidDate,
  isValidPeriod,
  json,
  listHolidays,
  listRoles,
  parsePermissions,
  listShifts,
  newId,
  notify,
  notifyApprovers,
  periodDates,
  periodOf,
  periodStatus,
  publicEmployee,
  publicShift,
  resolveActor,
  requireOwnEmployee,
  shiftHours,
  str,
  toMinutes,
  todayContext,
  vnDate,
  vnTime,
  weekdayOf,
  writeAudit,
  type ActorContext,
  type EmployeeRow,
} from "../lib/attendance.js";
import {
  checkInAllowed,
  checkOutAllowed,
  combineLevel,
  deviceHashOf,
  pickChallenge,
  reason,
  signingPayload,
  verifyDeviceSignature,
  type RiskReason,
  type SecuritySettings,
} from "../lib/antifraud.js";
import {
  alertForAttempt,
  analyzeSelfie,
  checkAdjustmentVolume,
  consumeNonce,
  decodeImageBase64,
  findDevice,
  getSecurity,
  issueNonce,
  otherAccountsOnDevice,
  raiseAlert,
  recordAttempt,
  storeSelfie,
  type DeviceRow,
} from "../lib/security.js";
import {
  finalizeAttempt,
  ipCountryOf,
  isUniqueViolation,
  publicReasons,
  verifyPresence,
  type PresenceKind,
  type PresenceResult,
} from "../lib/presence.js";
import { rateLimit, revokeSession } from "../lib/sessions.js";

// ---------------------------------------------------------------------------
//  Đọc dữ liệu
// ---------------------------------------------------------------------------

/** Các suất trực của một cán bộ trong khoảng ngày. */
async function dutiesOf(employeeId: string, fromDate: string, toDate: string) {
  return db
    .select()
    .from(attDutyAssignments)
    .where(
      and(
        eq(attDutyAssignments.employeeId, employeeId),
        gte(attDutyAssignments.dutyDate, fromDate),
        lte(attDutyAssignments.dutyDate, toDate)
      )
    )
    .orderBy(asc(attDutyAssignments.dutyDate));
}

/** Lượt chấm công CÒN HIỆU LỰC của một cán bộ trong một ngày. */
async function punchesOf(employeeId: string, workDate: string) {
  return db
    .select()
    .from(attPunches)
    .where(and(eq(attPunches.employeeId, employeeId), eq(attPunches.workDate, workDate), ACTIVE_PUNCH))
    .orderBy(asc(attPunches.punchAt));
}

/**
 * Trạng thái chấm công hôm nay của một cán bộ.
 *
 * Trả về đủ thứ để màn hình chính vẽ được hai nút lớn mà không phải suy luận
 * thêm: đã chấm vào chưa, buổi nào đã xong, lượt chấm kế tiếp nên là gì.
 */
async function todayState(employee: EmployeeRow) {
  const { today, period } = todayContext();
  const yesterday = addDays(today, -1);
  const settings = await getSettings();
  const holidayMap = buildHolidayMap(await listHolidays());
  const dayType = classifyDay(today, holidayMap, settings.workHours);
  const punches = await punchesOf(employee.id, today);

  const sessionsDone = {
    MORNING: { in: false, out: false },
    AFTERNOON: { in: false, out: false },
  };
  for (const p of punches) {
    const session = String(p.session || "").toUpperCase();
    if (session !== "MORNING" && session !== "AFTERNOON") continue;
    if (String(p.punchType).toUpperCase() === "IN") sessionsDone[session].in = true;
    else sessionsDone[session].out = true;
  }

  const ins = punches.filter((p) => String(p.punchType).toUpperCase() === "IN").length;
  const outs = punches.filter((p) => String(p.punchType).toUpperCase() === "OUT").length;
  // Đang trong giờ làm nghĩa là lượt chấm gần nhất là chấm VÀO.
  const openSession = ins > outs;

  // Ca trực liên quan tới hôm nay gồm suất của hôm nay, cộng suất của hôm qua
  // nếu ca đó kéo sang sáng nay (ca 16:30 - 07:30 kết ca vào ngày hôm sau).
  const [shifts, duties, logs] = await Promise.all([
    listShifts(true),
    dutiesOf(employee.id, yesterday, today),
    db
      .select()
      .from(attDutyLogs)
      .where(
        and(
          eq(attDutyLogs.employeeId, employee.id),
          gte(attDutyLogs.dutyDate, yesterday),
          lte(attDutyLogs.dutyDate, today),
          ACTIVE_DUTY_LOG
        )
      ),
  ]);
  const shiftById = new Map(shifts.map((s) => [s.id, s]));
  const logByAssignment = new Map(logs.map((l) => [l.assignmentId, l]));

  const dutyCards = duties
    .filter((d) => String(d.status || "PLANNED").toUpperCase() !== "CANCELLED")
    .map((d) => {
      const shift = shiftById.get(d.shiftId);
      const log = logByAssignment.get(d.id) || null;
      const crosses = shift ? String(shift.crossesMidnight || "false") === "true" : false;
      return {
        assignmentId: d.id,
        dutyDate: d.dutyDate,
        dayType: String(d.dayType || "WEEKDAY").toUpperCase(),
        shiftId: d.shiftId,
        shiftName: shift ? shift.name : d.shiftId,
        startTime: shift ? shift.startTime : "",
        endTime: shift ? shift.endTime : "",
        crossesMidnight: crosses,
        hours: shift ? shift.hours ?? shiftHours(shift.startTime, shift.endTime) : 0,
        color: shift?.color || "#0284c7",
        // Suất của hôm qua chỉ còn lại hành động kết ca, và chỉ khi ca qua đêm.
        actionable: d.dutyDate === today || (crosses && Boolean(log?.checkInAt) && !log?.checkOutAt),
        checkInAt: log?.checkInAt || null,
        checkOutAt: log?.checkOutAt || null,
        logStatus: log ? String(log.status || "OPEN").toUpperCase() : null,
        approvalStatus: log ? String(log.approvalStatus || "APPROVED").toUpperCase() : null,
        riskLevel: log?.riskLevel || null,
        // Khung nhận ca theo giờ máy chủ, để giao diện hiển thị trước.
        checkInWindow: shift
          ? (() => {
              const w = checkInAllowed(Date.now(), d.dutyDate, shift.startTime, shift.endTime, settings.workHours.earliestPunchMin);
              return { open: w.ok, opensAt: w.openAt, closesAt: w.closeAt };
            })()
          : null,
      };
    })
    .filter((card) => card.dutyDate === today || card.actionable);

  const selfDuty = selfDutyOptions(shifts, duties, dayType, today, settings.workHours.earliestPunchMin);

  return {
    today,
    period,
    now: vnTime(),
    weekday: weekdayOf(today),
    dayType,
    holidayName: holidayMap.get(today)?.name || null,
    isWorkDay: settings.workHours.workDays.includes(weekdayOf(today)),
    locked: (await periodStatus(period)) === "LOCKED",
    punches: punches.map((p) => ({
      id: p.id,
      punchType: String(p.punchType).toUpperCase(),
      time: vnTime(p.punchAt),
      punchAt: p.punchAt,
      session: String(p.session || "").toUpperCase(),
      status: String(p.status || "").toUpperCase(),
      minutesDelta: p.minutesDelta || 0,
      source: String(p.source || "SELF").toUpperCase(),
      note: p.note || "",
      device: p.device || "",
      riskLevel: p.riskLevel || null,
    })),
    sessionsDone,
    openSession,
    nextPunch: openSession ? "OUT" : "IN",
    duties: dutyCards,
    // Chấm trực tự động: bật mặc định, Quản trị chỉ tắt khi muốn quay về phân lịch.
    selfDuty: {
      enabled: !settings.workHours.requireDutyAssignment,
      options: selfDuty,
    },
  };
}

type ShiftList = Awaited<ReturnType<typeof listShifts>>;

function shiftCrossesMidnight(shift: ShiftList[number]): boolean {
  if (String(shift.crossesMidnight || "false") === "true") return true;
  const start = toMinutes(shift.startTime);
  const end = toMinutes(shift.endTime);
  return start !== null && end !== null && end <= start;
}

/**
 * Các ca cán bộ có thể TỰ nhận hôm nay, kèm ca được gợi ý tự động theo giờ
 * hiện tại (ca đang mở có giờ bắt đầu gần nhất).
 */
function selfDutyOptions(
  shifts: ShiftList,
  duties: (typeof attDutyAssignments.$inferSelect)[],
  dayType: string,
  today: string,
  earliestMin: number
) {
  const now = Date.now();
  const taken = new Set(
    duties
      .filter((d) => d.dutyDate === today && String(d.status || "PLANNED").toUpperCase() !== "CANCELLED")
      .map((d) => d.shiftId)
  );
  const options = shifts
    .filter((s) => {
      const scope = String(s.dayScope || "ANY").toUpperCase();
      return (scope === "ANY" || scope === dayType) && !taken.has(s.id);
    })
    .map((s) => {
      // Cùng một hàm với máy chủ khi nhận ca, để "đang mở" trên giao diện khớp với kiểm tra thật.
      const win = checkInAllowed(now, today, s.startTime, s.endTime, earliestMin);
      return {
        shiftId: s.id,
        shiftName: s.name,
        startTime: s.startTime,
        endTime: s.endTime,
        crossesMidnight: shiftCrossesMidnight(s),
        hours: s.hours ?? shiftHours(s.startTime, s.endTime),
        color: s.color || "#0284c7",
        open: win.ok,
        opensAt: vnTime(win.openAt).slice(0, 5),
        closesAt: vnTime(win.closeAt).slice(0, 5),
        suggested: false,
      };
    });
  let best: (typeof options)[number] | null = null;
  for (const o of options) {
    if (!o.open) continue;
    if (!best || (toMinutes(o.startTime) ?? 0) > (toMinutes(best.startTime) ?? 0)) best = o;
  }
  if (best) best.suggested = true;
  return options;
}

/** Dữ liệu khởi động màn hình: một lượt gọi duy nhất cho cả trang. */
async function handleBootstrap(actor: ActorContext) {
  const settings = await getSettings();
  const [shifts, holidays, deptNames] = await Promise.all([listShifts(true), listHolidays(), departmentNameMap()]);
  const employee = actor.employee;

  let today = null;
  let unread = 0;
  let pending = 0;
  if (employee) {
    today = await todayState(employee);
    const unreadRows = await db
      .select({ id: attNotifications.id })
      .from(attNotifications)
      .where(and(eq(attNotifications.employeeId, employee.id), sql`${attNotifications.readAt} is null`));
    unread = unreadRows.length;
    const pendingRows = await db
      .select({ id: attRequests.id })
      .from(attRequests)
      .where(and(eq(attRequests.employeeId, employee.id), eq(attRequests.status, "PENDING")));
    pending = pendingRows.length;
  }

  return json({
    success: true,
    me: {
      userId: actor.user.id,
      username: actor.user.username,
      name: actor.user.name,
      role: actor.role,
      roleCode: actor.roleCode,
      roleName: actor.roleName,
      scope: actor.scope,
      permissions: actor.role === "ADMIN" ? ["*"] : [...actor.permissions],
      mustChangePassword: String(actor.user.mustChangePassword || "false") === "true",
      employee: employee ? publicEmployee(employee, deptNames.get(employee.departmentId || "") || "") : null,
    },
    settings,
    shifts: shifts.map(publicShift),
    holidays: holidays.map((h) => ({
      id: h.id,
      name: h.name,
      startDate: h.startDate,
      endDate: h.endDate,
      dayType: String(h.dayType || "HOLIDAY").toUpperCase(),
      note: h.note || "",
    })),
    today,
    // Tên các vai trò để giao diện hiển thị nhãn cho cả vai trò tuỳ chỉnh.
    roles: (await listRoles(true)).map((r) => ({ code: r.code, name: r.name, system: r.system, status: r.status })),
    counters: { unreadNotifications: unread, pendingRequests: pending },
    security: publicRequirements(await getSecurity()),
    serverTime: Date.now(),
  });
}

/** Bảng công cá nhân của một kỳ. */
async function handleMyTimesheet(actor: ActorContext, period: string) {
  const employee = requireOwnEmployee(actor);
  if (!isValidPeriod(period)) return json({ success: false, error: "Kỳ bảng công không hợp lệ." }, 400);

  const dates = periodDates(period);
  const from = dates[0];
  const to = dates[dates.length - 1];
  const settings = await getSettings();
  const [shifts, holidays, punches, duties, dutyLogs, leaves, departments, locked] = await Promise.all([
    listShifts(true),
    listHolidays(),
    db
      .select()
      .from(attPunches)
      .where(
        and(eq(attPunches.employeeId, employee.id), gte(attPunches.workDate, from), lte(attPunches.workDate, to), ACTIVE_PUNCH)
      ),
    dutiesOf(employee.id, from, to),
    db
      .select()
      .from(attDutyLogs)
      .where(
        and(eq(attDutyLogs.employeeId, employee.id), gte(attDutyLogs.dutyDate, from), lte(attDutyLogs.dutyDate, to))
      ),
    db
      .select()
      .from(attLeaves)
      .where(and(eq(attLeaves.employeeId, employee.id), lte(attLeaves.fromDate, to), gte(attLeaves.toDate, from))),
    db.select().from(attDepartments),
    periodStatus(period),
  ]);

  const result = buildTimesheet({
    period,
    employees: [employee],
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

  return json({ success: true, timesheet: result });
}

/** Lịch trực tháng. Cán bộ thấy cả lịch của trạm - đó là yêu cầu nghiệp vụ. */
async function handleDutySchedule(period: string) {
  if (!isValidPeriod(period)) return json({ success: false, error: "Kỳ không hợp lệ." }, 400);
  const dates = periodDates(period);
  const from = dates[0];
  const to = dates[dates.length - 1];

  const [assignments, shifts, employees, holidays, settings] = await Promise.all([
    db
      .select()
      .from(attDutyAssignments)
      .where(and(gte(attDutyAssignments.dutyDate, from), lte(attDutyAssignments.dutyDate, to)))
      .orderBy(asc(attDutyAssignments.dutyDate)),
    listShifts(true),
    db.select().from(attEmployees),
    listHolidays(),
    getSettings(),
  ]);

  const empById = new Map(employees.map((e) => [e.id, e]));
  const shiftById = new Map(shifts.map((s) => [s.id, s]));
  const holidayMap = buildHolidayMap(holidays);

  return json({
    success: true,
    period,
    days: dates.map((date) => {
      const dayType = classifyDay(date, holidayMap, settings.workHours);
      return {
        date,
        day: Number(date.slice(8, 10)),
        weekday: weekdayOf(date),
        dayType,
        holidayName: holidayMap.get(date)?.name || null,
        entries: assignments
          .filter((a) => a.dutyDate === date && String(a.status || "PLANNED").toUpperCase() !== "CANCELLED")
          .map((a) => {
            const shift = shiftById.get(a.shiftId);
            const emp = empById.get(a.employeeId);
            return {
              assignmentId: a.id,
              employeeId: a.employeeId,
              employeeName: emp ? emp.fullName : a.employeeId,
              employeeCode: emp ? emp.code : "",
              shiftId: a.shiftId,
              shiftName: shift ? shift.name : a.shiftId,
              startTime: shift ? shift.startTime : "",
              endTime: shift ? shift.endTime : "",
              color: shift?.color || "#0284c7",
              note: a.note || "",
              swapped: Boolean(a.swappedFromEmployeeId),
            };
          }),
      };
    }),
  });
}

/** Yêu cầu điều chỉnh, đổi ca và đơn nghỉ phép của chính mình. */
async function handleMyRequests(actor: ActorContext) {
  const employee = requireOwnEmployee(actor);
  const [requests, leaves, shifts, employees] = await Promise.all([
    db
      .select()
      .from(attRequests)
      .where(eq(attRequests.employeeId, employee.id))
      .orderBy(desc(attRequests.createdAt))
      .limit(100),
    db
      .select()
      .from(attLeaves)
      .where(eq(attLeaves.employeeId, employee.id))
      .orderBy(desc(attLeaves.createdAt))
      .limit(100),
    listShifts(true),
    db.select().from(attEmployees),
  ]);

  const shiftById = new Map(shifts.map((s) => [s.id, s]));
  const empById = new Map(employees.map((e) => [e.id, e]));

  return json({
    success: true,
    requests: requests.map((r) => decorateRequest(r, shiftById, empById)),
    leaves: leaves.map((l) => ({
      id: l.id,
      leaveType: l.leaveType,
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

/** Bản chiếu một yêu cầu, đã gắn kèm tên ca và tên người liên quan. */
export function decorateRequest(
  r: typeof attRequests.$inferSelect,
  shiftById: Map<string, { name: string; startTime: string; endTime: string }>,
  empById: Map<string, { fullName: string; code: string }>
) {
  let payload: Record<string, unknown> = {};
  try {
    payload = r.payload ? JSON.parse(r.payload) : {};
  } catch {
    payload = {};
  }
  const shiftId = str(payload.shiftId);
  const toEmployeeId = str(payload.toEmployeeId);
  return {
    id: r.id,
    kind: String(r.kind).toUpperCase(),
    employeeId: r.employeeId,
    employeeName: empById.get(r.employeeId)?.fullName || r.employeeId,
    employeeCode: empById.get(r.employeeId)?.code || "",
    targetDate: r.targetDate || "",
    payload,
    shiftName: shiftId ? shiftById.get(shiftId)?.name || shiftId : "",
    toEmployeeName: toEmployeeId ? empById.get(toEmployeeId)?.fullName || toEmployeeId : "",
    reason: r.reason || "",
    status: String(r.status || "PENDING").toUpperCase(),
    decidedByName: r.decidedByName || "",
    decidedAt: r.decidedAt || null,
    decisionNote: r.decisionNote || "",
    createdAt: r.createdAt || null,
  };
}

async function handleNotifications(actor: ActorContext) {
  const employee = requireOwnEmployee(actor);
  const rows = await db
    .select()
    .from(attNotifications)
    .where(eq(attNotifications.employeeId, employee.id))
    .orderBy(desc(attNotifications.ts))
    .limit(80);
  return json({
    success: true,
    notifications: rows.map((n) => ({
      id: n.id,
      title: n.title,
      body: n.body || "",
      kind: String(n.kind || "INFO").toUpperCase(),
      refId: n.refId || "",
      read: Boolean(n.readAt),
      ts: n.ts,
    })),
  });
}

// ---------------------------------------------------------------------------
//  Ghi dữ liệu
// ---------------------------------------------------------------------------

/**
 * Giới hạn tần suất các thao tác ghi của một tài khoản (chống bấm dồn / gọi API
 * tự động). Vượt ngưỡng → 429 và cảnh báo VÀNG.
 */
async function assertWriteRate(actor: ActorContext) {
  const rl = await rateLimit(`att-write:${actor.user.id}`, 30, 60000);
  if (!rl.allowed) {
    await raiseAlert({
      level: "YELLOW",
      category: "RATE_LIMIT",
      employeeId: actor.employee?.id || null,
      userId: actor.user.id,
      title: "Gọi API chấm công dồn dập",
      cause: `${rl.count} thao tác ghi trong 1 phút từ IP ${actor.ip || "?"}.`,
      evidence: { count: rl.count, ip: actor.ip, userAgent: actor.userAgent },
    });
    throw new AuthError(429, "TOO_MANY_REQUESTS", "Thao tác quá nhanh. Vui lòng chờ một phút rồi thử lại.");
  }
}

/** Phản hồi chung cho một lượt chấm bị từ chối: có mã lượt thử để đối chiếu khi khiếu nại. */
function rejected(message: string, final: { attemptId: number; level: string; reasons: RiskReason[] }, extra: Record<string, unknown> = {}) {
  return json(
    {
      success: false,
      error: message,
      attemptId: final.attemptId,
      riskLevel: final.level,
      reasons: publicReasons(final.reasons),
      canRequestAdjust: true,
      ...extra,
    },
    409
  );
}

/** Thông báo gọn cho lượt chấm bị chặn bởi lý do ĐỎ. */
function redMessage(reasons: RiskReason[]) {
  const reds = reasons.filter((r) => r.level === "RED");
  return `Lượt chấm KHÔNG được ghi nhận: ${reds.map((r) => r.message).join(" ")} Nếu bạn thực sự có mặt, hãy gửi đề nghị điều chỉnh để được xem xét.`;
}

/**
 * THỬ THÁCH XÁC MINH.
 *
 * Trước mỗi lượt chấm, giao diện xin một thử thách dùng một lần: mã nonce (để
 * thiết bị ký), động tác ngẫu nhiên cho khung hình thứ hai và các yêu cầu hiện
 * hành (selfie, QR, vùng chấm công). Nonce hết hạn sau challengeTtlSec giây.
 */
async function handleChallenge(actor: ActorContext, body: Record<string, unknown>) {
  requireOwnEmployee(actor);
  await assertWriteRate(actor);
  const security = await getSecurity();
  const purpose = str(body.purpose).toUpperCase() === "DEVICE" ? "DEVICE" : "PRESENCE";
  const challenge = pickChallenge();
  const nonce = await issueNonce(actor, purpose, security.challengeTtlSec, challenge.code);
  const deviceHash = str(body.deviceHash).toLowerCase().slice(0, 64);
  const device = deviceHash ? await findDevice(actor.user.id, deviceHash) : null;
  return json({
    success: true,
    nonce: nonce.id,
    expiresAt: nonce.expiresAt,
    serverTime: Date.now(),
    challenge: { code: challenge.code, label: challenge.label },
    requirements: publicRequirements(security),
    device: device ? publicDevice(device) : null,
  });
}

/** Phần cấu hình an toàn mà giao diện cán bộ cần biết (không có bí mật nào). */
function publicRequirements(security: SecuritySettings) {
  return {
    requireDevice: security.requireDevice,
    selfieMode: security.selfieMode,
    qrMode: security.qrMode,
    challengeTtlSec: security.challengeTtlSec,
    geofence: {
      enabled: security.geofence.enabled,
      configured: security.geofence.lat !== null && security.geofence.lng !== null,
      lat: security.geofence.lat,
      lng: security.geofence.lng,
      radiusM: security.geofence.radiusM,
      maxAccuracyM: security.geofence.maxAccuracyM,
    },
  };
}

function publicDevice(d: DeviceRow) {
  return {
    id: d.id,
    deviceHash: d.deviceHash,
    label: d.label || "",
    platform: d.platform || "",
    status: String(d.status || "PENDING").toUpperCase(),
    createdAt: d.createdAt,
    lastSeenAt: d.lastSeenAt,
    decidedByName: d.decidedByName || "",
    decidedAt: d.decidedAt,
    decisionNote: d.decisionNote || "",
  };
}

/** Thiết bị của chính mình. */
async function handleMyDevices(actor: ActorContext, deviceHash: string) {
  const rows = await db
    .select()
    .from(attDevices)
    .where(eq(attDevices.userId, actor.user.id))
    .orderBy(desc(attDevices.createdAt));
  const current = rows.find((d) => d.deviceHash === deviceHash.toLowerCase()) || null;
  return json({
    success: true,
    current: current ? publicDevice(current) : null,
    devices: rows.map(publicDevice),
    requirements: publicRequirements(await getSecurity()),
  });
}

/**
 * ĐĂNG KÝ THIẾT BỊ (yêu cầu 3).
 *
 * Trình duyệt tự sinh cặp khoá ECDSA P-256 KHÔNG xuất được (khoá riêng không
 * bao giờ rời máy), gửi khoá công khai + chữ ký lên thử thách DEVICE + một ảnh
 * selfie trực tiếp. Máy chủ:
 *   - kiểm chữ ký (chứng minh máy đang giữ khoá riêng),
 *   - chặn ĐỎ nếu cùng khoá đang gắn với một tài khoản khác (chấm hộ),
 *   - ghi thiết bị ở trạng thái PENDING - chỉ dùng được sau khi Quản trị duyệt,
 *   - giữ ảnh selfie làm ứng viên ảnh mẫu khuôn mặt khi duyệt.
 */
async function handleDeviceRegister(req: Request, actor: ActorContext, body: Record<string, unknown>) {
  const employee = requireOwnEmployee(actor);
  await assertWriteRate(actor);
  const security = await getSecurity();
  const now = Date.now();
  const publicKey = typeof body.publicKey === "string" ? body.publicKey : JSON.stringify(body.publicKey || null);
  if (publicKey.length > 1000) return json({ success: false, error: "Khoá thiết bị không hợp lệ." }, 400);
  const deviceHash = await deviceHashOf(publicKey);
  if (!deviceHash) return json({ success: false, error: "Khoá thiết bị không hợp lệ." }, 400);

  const reasons: RiskReason[] = [];
  const nonce = await consumeNonce(str(body.nonce).slice(0, 80), actor.user.id, "DEVICE");
  if (!nonce) reasons.push(reason("NONCE_INVALID", "RED", "Phiên đăng ký đã hết hạn. Vui lòng thử lại."));

  const selfieBytes = decodeImageBase64(body.selfie);
  const analyzed = selfieBytes ? await analyzeSelfie(selfieBytes) : null;
  const selfie = analyzed && !("error" in analyzed) ? analyzed : null;
  if (security.selfieMode !== "OFF") {
    if (!analyzed) reasons.push(reason("SELFIE_MISSING", "RED", "Cần chụp một ảnh selfie trực tiếp để đăng ký thiết bị."));
    else if ("error" in analyzed) reasons.push(analyzed.error);
  }

  let signatureOk = false;
  if (nonce) {
    signatureOk = await verifyDeviceSignature(
      publicKey,
      signingPayload({ nonce: nonce.id, action: "DEVICE_REGISTER", type: deviceHash, selfieSha256: selfie?.sha256 || null }),
      str(body.signature)
    );
    if (!signatureOk) reasons.push(reason("DEVICE_SIGNATURE", "RED", "Chữ ký thiết bị không hợp lệ."));
  }

  const others = await otherAccountsOnDevice(actor.user.id, deviceHash);
  if (others.length) {
    reasons.push(
      reason("SHARED_DEVICE", "RED", "Thiết bị này đã được đăng ký cho một tài khoản khác. Mỗi thiết bị chỉ dùng chấm công cho một người.")
    );
  }

  const existing = await findDevice(actor.user.id, deviceHash);
  if (existing) {
    const status = String(existing.status || "PENDING").toUpperCase();
    if (status === "APPROVED") return json({ success: true, message: "Thiết bị đã được duyệt.", device: publicDevice(existing) });
    if (status === "PENDING") {
      return json({ success: true, message: "Thiết bị đang chờ Quản trị duyệt.", device: publicDevice(existing) });
    }
    reasons.push(reason("DEVICE_REVOKED", "RED", "Thiết bị đã bị từ chối/thu hồi. Liên hệ Quản trị viên."));
  }

  let selfieKey: string | null = null;
  if (selfie && nonce) {
    // Ảnh đăng ký là ứng viên ảnh mẫu: lưu ngoài vùng tự xoá theo thời hạn (att/).
    selfieKey = `ref/${employee.id}/${now}-${selfie.sha256.slice(0, 12)}.jpg`;
    await storeSelfie(selfieKey, selfie.bytes, { employeeId: employee.id, kind: "DEVICE_REGISTER", ts: now, frame: "neutral" });
  }
  const accepted = combineLevel(reasons) !== "RED";
  const attemptId = await recordAttempt({
    userId: actor.user.id,
    employeeId: employee.id,
    kind: "DEVICE_REGISTER",
    serverTs: now,
    workDate: vnDate(now),
    result: accepted ? "ACCEPTED" : "REJECTED",
    riskLevel: accepted ? "YELLOW" : "RED",
    reasons: accepted ? [...reasons, reason("DEVICE_PENDING", "YELLOW", "Thiết bị mới chờ Quản trị duyệt.")] : reasons,
    rejectMessage: accepted ? null : reasons.filter((r) => r.level === "RED").map((r) => r.message).join(" "),
    deviceHash,
    deviceSignatureOk: signatureOk ? "true" : "false",
    sessionId: actor.sessionId,
    ip: actor.ip || null,
    userAgent: actor.userAgent || null,
    ipGeo: ipCountryOf(req),
    selfieKey,
    selfieSha256: selfie?.sha256 || null,
    selfieDhash: selfie?.dhash || null,
    nonceId: nonce?.id || null,
    refType: "device",
  });

  if (!accepted) {
    await alertForAttempt({
      attemptId,
      level: "RED",
      reasons,
      employeeId: employee.id,
      userId: actor.user.id,
      deviceHash,
      kindLabel: "Đăng ký thiết bị",
      evidence: { otherAccounts: others.map((o) => o.userId), ip: actor.ip },
    });
    return json(
      { success: false, error: reasons.filter((r) => r.level === "RED").map((r) => r.message).join(" "), reasons: publicReasons(reasons) },
      409
    );
  }

  const id = newId("dev");
  try {
    await db.insert(attDevices).values({
      id,
      userId: actor.user.id,
      employeeId: employee.id,
      deviceHash,
      publicKey,
      label: str(body.label).slice(0, 80) || "Thiết bị chấm công",
      platform: str(body.platform).slice(0, 80) || null,
      userAgent: actor.userAgent || null,
      status: "PENDING",
      requestReason: str(body.reason).slice(0, 300) || null,
      registrationAttemptId: attemptId,
      firstIp: actor.ip || null,
      lastIp: actor.ip || null,
      createdAt: now,
      lastSeenAt: now,
    });
  } catch (err) {
    if (isUniqueViolation(err)) return json({ success: true, message: "Thiết bị đang chờ Quản trị duyệt." });
    throw err;
  }
  const approved = await db
    .select({ id: attDevices.id })
    .from(attDevices)
    .where(and(eq(attDevices.userId, actor.user.id), eq(attDevices.status, "APPROVED")));
  await raiseAlert({
    level: "YELLOW",
    category: "DEVICE_PENDING",
    employeeId: employee.id,
    userId: actor.user.id,
    deviceHash,
    attemptId,
    title: approved.length ? "Cán bộ xin đổi / thêm thiết bị chấm công" : "Thiết bị mới chờ duyệt",
    cause: `${employee.fullName} đăng ký thiết bị "${str(body.label) || "không tên"}"${
      approved.length ? ` trong khi đã có ${approved.length} thiết bị được duyệt` : ""
    }.`,
    evidence: { deviceId: id, ip: actor.ip, userAgent: actor.userAgent, reason: str(body.reason) },
    dedupeKey: `DEVICE_PENDING|${id}`,
  });
  await writeAudit(actor, {
    entity: "device",
    entityId: id,
    action: "DEVICE_REGISTER",
    newValue: { deviceHash, label: str(body.label), status: "PENDING" },
    reason: str(body.reason) || null,
  });
  await notifyApprovers(employee, "Thiết bị chấm công chờ duyệt", `${employee.fullName} đăng ký thiết bị chấm công mới.`, id);
  const rows = await db.select().from(attDevices).where(eq(attDevices.id, id));
  return json({ success: true, message: "Đã gửi đăng ký thiết bị. Vui lòng chờ Quản trị viên duyệt.", device: publicDevice(rows[0]) });
}

/**
 * CHẤM VÀO / CHẤM RA.
 *
 * Thứ tự kiểm tra, tất cả ở máy chủ (yêu cầu 1, 2, 8):
 *   1. Kỳ chưa khoá, hôm nay được phép chấm, giờ MÁY CHỦ nằm trong khung chấm.
 *   2. Xác minh hiện diện (verifyPresence): nonce, thiết bị + chữ ký, GPS,
 *      selfie + người thật, QR.
 *   3. Nghiệp vụ: không trùng lượt cùng buổi, chấm RA phải có chấm VÀO đang mở.
 * Có lý do ĐỎ → không ghi lượt chấm, chỉ ghi bằng chứng + cảnh báo. Chỉ có lý
 * do VÀNG → ghi lượt chấm kèm mức rủi ro để người phụ trách xem lại.
 * Chống trùng cuối cùng là chỉ mục duy nhất dedupe_key: hai yêu cầu đồng thời
 * thì chỉ một bản ghi được chèn.
 */
async function handlePunch(req: Request, actor: ActorContext, body: Record<string, unknown>) {
  const employee = requireOwnEmployee(actor);
  await assertWriteRate(actor);
  const punchType = str(body.type).toUpperCase() === "OUT" ? "OUT" : "IN";
  const kind: PresenceKind = punchType === "IN" ? "PUNCH_IN" : "PUNCH_OUT";
  const security = await getSecurity();
  const presence = await verifyPresence(req, actor, { ...body, type: punchType }, kind, security);
  // Giờ chấm là giờ MÁY CHỦ tại thời điểm nhận yêu cầu, không bao giờ lấy giờ máy khách.
  const now = presence.serverTs;
  const today = vnDate(now);
  await assertPeriodOpen(today);

  const settings = await getSettings();
  const holidays = await listHolidays();
  const dayType = classifyDay(today, buildHolidayMap(holidays), settings.workHours);
  const extra: RiskReason[] = [];
  if (dayType !== "WEEKDAY" && !settings.workHours.allowPunchOnNonWorkday) {
    extra.push(
      reason(
        "OUTSIDE_SHIFT",
        "RED",
        dayType === "HOLIDAY"
          ? "Hôm nay là ngày nghỉ lễ, cấu hình hiện tại không cho phép chấm công hành chính."
          : "Hôm nay không phải ngày làm việc hành chính theo cấu hình của Trạm."
      )
    );
  }

  const timeStr = vnTime(now);
  const evaluation = evaluatePunch(punchType, timeStr, settings.workHours);
  if (evaluation.status === "OUTSIDE") extra.push(reason("OUTSIDE_SHIFT", "RED", evaluation.message));

  const existing = await punchesOf(employee.id, today);
  const sameSession = existing.filter(
    (p) => String(p.session || "").toUpperCase() === evaluation.session && String(p.punchType).toUpperCase() === punchType
  );
  if (sameSession.length) {
    extra.push(
      reason(
        "DUPLICATE",
        "RED",
        `Buổi ${evaluation.session === "MORNING" ? "sáng" : "chiều"} đã chấm ${punchType === "IN" ? "vào" : "ra"} lúc ${vnTime(
          sameSession[0].punchAt
        )}.`
      )
    );
  }
  if (punchType === "OUT") {
    const ins = existing.filter((p) => String(p.punchType).toUpperCase() === "IN").length;
    const outs = existing.filter((p) => String(p.punchType).toUpperCase() === "OUT").length;
    if (ins <= outs) extra.push(reason("NO_OPEN_IN", "RED", "Chưa có lượt chấm VÀO đang mở để chấm RA."));
  }

  const all = [...presence.reasons, ...extra];
  if (combineLevel(all) === "RED") {
    const final = await finalizeAttempt({ actor, kind, presence, extraReasons: extra, accepted: false, rejectMessage: redMessage(all), workDate: today });
    return rejected(redMessage(all), final, { alreadyPunched: extra.some((r) => r.code === "DUPLICATE") });
  }

  // Khoá chống trùng: người | ngày | buổi | loại. Nếu lượt cũ đã bị huỷ hiệu lực
  // qua điều chỉnh, khoá được nối thêm id lượt cũ để vẫn chấm lại được (và vẫn
  // xác định, nên hai yêu cầu đồng thời vẫn đụng nhau).
  const baseKey = `${employee.id}|${today}|${evaluation.session}|${punchType}`;
  const inactive = await db
    .select({ id: attPunches.id })
    .from(attPunches)
    .where(and(eq(attPunches.dedupeKey, baseKey), sql`coalesce(${attPunches.state}, 'ACTIVE') <> 'ACTIVE'`));
  const dedupeKey = inactive.length ? `${baseKey}|after:${Math.max(...inactive.map((r) => r.id))}` : baseKey;

  let punchId: number;
  try {
    const rows = await db
      .insert(attPunches)
      .values({
        employeeId: employee.id,
        workDate: today,
        punchType,
        punchAt: now,
        session: evaluation.session,
        status: evaluation.status,
        minutesDelta: evaluation.minutesDelta,
        device: presence.device ? `${presence.device.id} ${presence.device.label || ""}`.trim().slice(0, 120) : null,
        ip: actor.ip || null,
        userAgent: actor.userAgent || null,
        source: "SELF",
        note: null,
        createdBy: actor.user.id,
        createdAt: now,
        dedupeKey,
      })
      .returning({ id: attPunches.id });
    punchId = rows[0].id;
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    const dup = [reason("DUPLICATE", "RED", "Lượt chấm này vừa được ghi nhận từ một yêu cầu khác (bấm trùng).")];
    const final = await finalizeAttempt({ actor, kind, presence, extraReasons: [...extra, ...dup], accepted: false, rejectMessage: dup[0].message, workDate: today });
    return rejected(dup[0].message, final, { alreadyPunched: true });
  }

  let final;
  try {
    final = await finalizeAttempt({ actor, kind, presence, extraReasons: extra, accepted: true, workDate: today, refType: "punch", refId: String(punchId) });
  } catch (err) {
    // Không có bằng chứng thì lượt chấm không có hiệu lực.
    await db.update(attPunches).set({ state: "VOIDED" }).where(eq(attPunches.id, punchId)).catch(() => undefined);
    throw err;
  }
  await db
    .update(attPunches)
    .set({ attemptId: final.attemptId, riskLevel: final.level })
    .where(and(eq(attPunches.id, punchId), isNull(attPunches.attemptId)));

  await writeAudit(actor, {
    entity: "punch",
    entityId: String(punchId),
    action: `PUNCH_${punchType}`,
    newValue: {
      employeeId: employee.id,
      workDate: today,
      time: timeStr,
      session: evaluation.session,
      status: evaluation.status,
      attemptId: final.attemptId,
      riskLevel: final.level,
      distanceM: presence.distanceM,
    },
  });

  const flagged = final.level === "YELLOW";
  return json({
    success: true,
    message: `Đã ${punchType === "IN" ? "chấm vào" : "chấm ra"} lúc ${timeStr}. ${evaluation.message}${
      flagged ? " Lượt chấm có điểm cần xác minh thêm, người phụ trách sẽ xem lại." : ""
    }`,
    punch: { id: punchId, punchType, time: timeStr, session: evaluation.session, status: evaluation.status },
    attemptId: final.attemptId,
    riskLevel: final.level,
    reasons: publicReasons(final.reasons),
    today: await todayState(employee),
  });
}

/** Định mức giờ của ca (không lấy hiệu giờ thực bấm). */
const normHours = (shift: ShiftList[number] | undefined) => (shift ? shift.hours ?? shiftHours(shift.startTime, shift.endTime) : 0);

/**
 * Lõi NHẬN CA: dùng chung cho nhận ca theo lịch và tự nhận ca.
 *
 * Luôn đòi một suất trực hợp lệ (yêu cầu 9) và giờ máy chủ nằm trong khung nhận
 * ca: từ trước giờ bắt đầu earliestPunchMin phút tới nửa thời lượng ca. Ca qua
 * đêm (vd 17:00 - 07:00) được tính trên mốc thời gian tuyệt đối nên không nhầm
 * ngày.
 */
async function dutyCheckInCore(
  actor: ActorContext,
  target: { assignment?: typeof attDutyAssignments.$inferSelect; selfShift?: ShiftList[number]; dayType?: string },
  presence: PresenceResult
) {
  const employee = requireOwnEmployee(actor);
  const settings = await getSettings();
  const shifts = await listShifts(true);
  const now = presence.serverTs;
  const shiftId = target.assignment ? target.assignment.shiftId : target.selfShift!.id;
  const dutyDate = target.assignment ? target.assignment.dutyDate : vnDate(now);
  const shift = shifts.find((s) => s.id === shiftId);
  const extra: RiskReason[] = [];
  const selfDuty = !target.assignment;

  if (!shift) extra.push(reason("NO_ROSTER", "RED", "Ca trực không còn trong danh mục."));
  else {
    const win = checkInAllowed(now, dutyDate, shift.startTime, shift.endTime, settings.workHours.earliestPunchMin);
    if (!win.ok) {
      extra.push(
        reason(
          "OUTSIDE_SHIFT",
          "RED",
          `Ngoài khung nhận ${shift.name}: được nhận ca từ ${vnTime(win.openAt).slice(0, 5)} ${vnDate(win.openAt)} đến ${vnTime(win.closeAt).slice(0, 5)} ${vnDate(win.closeAt)}.`
        )
      );
    }
  }
  if (target.assignment) {
    const existing = await db
      .select()
      .from(attDutyLogs)
      .where(and(eq(attDutyLogs.assignmentId, target.assignment.id), ACTIVE_DUTY_LOG));
    if (existing.length && existing[0].checkInAt) {
      extra.push(reason("DUPLICATE", "RED", `Đã nhận ca lúc ${vnTime(existing[0].checkInAt)}.`));
    }
  }
  if (selfDuty) {
    extra.push(reason("SELF_DUTY_PENDING", "YELLOW", "Ca tự nhận (không có trong lịch trực) - chỉ được tính giờ sau khi người duyệt xác nhận."));
  }

  const all = [...presence.reasons, ...extra];
  if (combineLevel(all) === "RED") {
    const final = await finalizeAttempt({ actor, kind: "DUTY_IN", presence, extraReasons: extra, accepted: false, rejectMessage: redMessage(all), workDate: dutyDate });
    return rejected(redMessage(all), final, { alreadyPunched: extra.some((r) => r.code === "DUPLICATE") });
  }

  // Tự nhận ca: chỉ sinh suất trực SAU KHI qua mọi kiểm tra.
  let assignmentId = target.assignment?.id || "";
  if (selfDuty) {
    const found = await db
      .select()
      .from(attDutyAssignments)
      .where(and(eq(attDutyAssignments.dutyDate, dutyDate), eq(attDutyAssignments.shiftId, shiftId), eq(attDutyAssignments.employeeId, employee.id)));
    if (found.length) {
      assignmentId = found[0].id;
      if (String(found[0].status || "PLANNED").toUpperCase() === "CANCELLED") {
        await db.update(attDutyAssignments).set({ status: "PLANNED", note: "Tự chấm trực (chờ duyệt)", updatedAt: now }).where(eq(attDutyAssignments.id, assignmentId));
      }
    } else {
      assignmentId = newId("duty");
      try {
        await db.insert(attDutyAssignments).values({
          id: assignmentId,
          dutyDate,
          shiftId,
          employeeId: employee.id,
          dayType: target.dayType || "WEEKDAY",
          status: "PLANNED",
          note: "Tự chấm trực (chờ duyệt)",
          createdBy: actor.user.id,
          createdAt: now,
          updatedAt: now,
        });
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
        const again = await db
          .select()
          .from(attDutyAssignments)
          .where(and(eq(attDutyAssignments.dutyDate, dutyDate), eq(attDutyAssignments.shiftId, shiftId), eq(attDutyAssignments.employeeId, employee.id)));
        assignmentId = again[0]?.id || assignmentId;
      }
      await writeAudit(actor, {
        entity: "duty_assignment",
        entityId: assignmentId,
        action: "SELF_CREATE",
        newValue: { dutyDate, shiftId, employeeId: employee.id, approvalStatus: "PENDING" },
      });
    }
  }

  let logId: number;
  try {
    const rows = await db
      .insert(attDutyLogs)
      .values({
        assignmentId,
        employeeId: employee.id,
        dutyDate,
        shiftId,
        checkInAt: now,
        // Giờ trực lấy theo ĐỊNH MỨC của ca, không lấy hiệu giờ thực bấm.
        hours: normHours(shift),
        device: presence.device ? `${presence.device.id} ${presence.device.label || ""}`.trim().slice(0, 120) : null,
        ip: actor.ip || null,
        status: "OPEN",
        source: "SELF",
        createdBy: actor.user.id,
        createdAt: now,
        updatedAt: now,
        approvalStatus: selfDuty ? "PENDING" : "APPROVED",
        dedupeKey: assignmentId,
      })
      .returning({ id: attDutyLogs.id });
    logId = rows[0].id;
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    const dup = [reason("DUPLICATE", "RED", "Suất trực này đã được nhận ca (bấm trùng hoặc đã có nhật ký trực).")];
    const final = await finalizeAttempt({ actor, kind: "DUTY_IN", presence, extraReasons: [...extra, ...dup], accepted: false, rejectMessage: dup[0].message, workDate: dutyDate });
    return rejected(dup[0].message, final, { alreadyPunched: true });
  }

  let final;
  try {
    final = await finalizeAttempt({ actor, kind: "DUTY_IN", presence, extraReasons: extra, accepted: true, workDate: dutyDate, refType: "duty_log", refId: String(logId) });
  } catch (err) {
    await db.update(attDutyLogs).set({ state: "VOIDED" }).where(eq(attDutyLogs.id, logId)).catch(() => undefined);
    throw err;
  }
  await db
    .update(attDutyLogs)
    .set({ checkInAttemptId: final.attemptId, riskLevel: final.level })
    .where(and(eq(attDutyLogs.id, logId), isNull(attDutyLogs.checkInAttemptId)));

  await writeAudit(actor, {
    entity: "duty_log",
    entityId: String(logId),
    action: selfDuty ? "DUTY_SELF_CHECK_IN" : "DUTY_CHECK_IN",
    newValue: { assignmentId, dutyDate, shiftId, time: vnTime(now), attemptId: final.attemptId, riskLevel: final.level, approvalStatus: selfDuty ? "PENDING" : "APPROVED" },
  });

  if (selfDuty) {
    await raiseAlert({
      level: "YELLOW",
      category: "SELF_DUTY_PENDING",
      employeeId: employee.id,
      userId: actor.user.id,
      attemptId: final.attemptId,
      title: "Ca tự nhận chờ duyệt",
      cause: `${employee.fullName} tự nhận ${shift?.name || shiftId} ngày ${dutyDate} lúc ${vnTime(now)} - không có trong lịch trực.`,
      evidence: { assignmentId, logId, dutyDate, shiftId, attemptId: final.attemptId },
      dedupeKey: `SELF_DUTY_PENDING|${assignmentId}`,
    });
    await notifyApprovers(
      employee,
      "Ca trực tự nhận chờ duyệt",
      `${employee.fullName} đã tự nhận ${shift?.name || shiftId} ngày ${dutyDate} lúc ${vnTime(now)}. Cần xác nhận để tính giờ trực.`,
      assignmentId
    );
  }

  return json({
    success: true,
    message: selfDuty
      ? `Đã ghi nhận ca tự nhận lúc ${vnTime(now)}. Ca này CHỜ DUYỆT, chỉ được tính giờ trực sau khi người duyệt xác nhận.`
      : `Đã nhận ca trực lúc ${vnTime(now)}.${final.level === "YELLOW" ? " Lượt nhận ca có điểm cần xác minh thêm." : ""}`,
    attemptId: final.attemptId,
    riskLevel: final.level,
    reasons: publicReasons(final.reasons),
    approvalStatus: selfDuty ? "PENDING" : "APPROVED",
    today: await todayState(employee),
  });
}

/** NHẬN CA TRỰC theo lịch đã phân. */
async function handleDutyCheckIn(req: Request, actor: ActorContext, body: Record<string, unknown>) {
  const employee = requireOwnEmployee(actor);
  await assertWriteRate(actor);
  const assignmentId = str(body.assignmentId);
  if (!assignmentId) return json({ success: false, error: "Thiếu suất trực cần nhận ca." }, 400);

  const found = await db.select().from(attDutyAssignments).where(eq(attDutyAssignments.id, assignmentId));
  if (!found.length) return json({ success: false, error: "Không tìm thấy suất trực." }, 404);
  const duty = found[0];
  if (duty.employeeId !== employee.id) {
    return json({ success: false, error: "Suất trực này không được phân cho bạn." }, 403);
  }
  if (String(duty.status || "PLANNED").toUpperCase() === "CANCELLED") {
    return json({ success: false, error: "Suất trực đã bị huỷ." }, 409);
  }
  await assertPeriodOpen(duty.dutyDate);
  const security = await getSecurity();
  const presence = await verifyPresence(req, actor, { ...body, type: assignmentId }, "DUTY_IN", security);
  return dutyCheckInCore(actor, { assignment: duty }, presence);
}

/**
 * TỰ CHẤM TRỰC (giữ lại theo quyết định của Trạm, nhưng CHỜ DUYỆT).
 *
 * Người trực chọn ca khi không có trong lịch. Máy chủ vẫn kiểm tra đầy đủ: ca
 * hợp loại ngày, đúng khung giờ, xác minh hiện diện. Nhật ký trực được ghi với
 * approval_status = PENDING, mức VÀNG, và KHÔNG được tính vào bảng công cho tới
 * khi Người duyệt xác nhận ở màn hình An toàn chấm công.
 */
async function handleDutySelfCheckIn(req: Request, actor: ActorContext, body: Record<string, unknown>) {
  requireOwnEmployee(actor);
  await assertWriteRate(actor);
  const settings = await getSettings();
  if (settings.workHours.requireDutyAssignment) {
    return json(
      { success: false, error: "Trạm đang yêu cầu phân lịch trực trước. Liên hệ Phụ trách để được phân ca." },
      403
    );
  }
  const shiftId = str(body.shiftId);
  if (!shiftId) return json({ success: false, error: "Chưa chọn ca trực." }, 400);

  const today = vnDate();
  await assertPeriodOpen(today);

  const [shifts, holidays] = await Promise.all([listShifts(true), listHolidays()]);
  const shift = shifts.find((s) => s.id === shiftId);
  if (!shift) return json({ success: false, error: "Không tìm thấy ca trực." }, 404);

  const dayType = classifyDay(today, buildHolidayMap(holidays), settings.workHours);
  const scope = String(shift.dayScope || "ANY").toUpperCase();
  if (scope !== "ANY" && scope !== dayType) {
    return json({ success: false, error: `${shift.name} không áp dụng cho ngày hôm nay.` }, 400);
  }
  const security = await getSecurity();
  const presence = await verifyPresence(req, actor, { ...body, type: `shift:${shiftId}` }, "DUTY_IN", security);
  return dutyCheckInCore(actor, { selfShift: shift, dayType }, presence);
}

/**
 * KẾT CA TRỰC. Ca qua đêm kết vào sáng hôm sau là bình thường. Kết ca sớm hơn
 * giờ kết thúc quá 30 phút → VÀNG; quá muộn (sau giờ kết thúc 4 giờ) → phải đi
 * luồng điều chỉnh. Giờ kết ca chỉ ghi một lần (UPDATE ... WHERE check_out_at
 * IS NULL, được trigger CSDL bảo vệ thêm).
 */
async function handleDutyCheckOut(req: Request, actor: ActorContext, body: Record<string, unknown>) {
  const employee = requireOwnEmployee(actor);
  await assertWriteRate(actor);
  const assignmentId = str(body.assignmentId);
  if (!assignmentId) return json({ success: false, error: "Thiếu suất trực cần kết ca." }, 400);

  const logs = await db
    .select()
    .from(attDutyLogs)
    .where(and(eq(attDutyLogs.assignmentId, assignmentId), eq(attDutyLogs.employeeId, employee.id), ACTIVE_DUTY_LOG));
  if (!logs.length || !logs[0].checkInAt) return json({ success: false, error: "Chưa nhận ca nên không thể kết ca." }, 409);
  const log = logs[0];
  if (log.checkOutAt) {
    return json({ success: false, error: `Ca trực đã kết lúc ${vnTime(log.checkOutAt)}.`, alreadyPunched: true }, 409);
  }
  await assertPeriodOpen(log.dutyDate);

  const security = await getSecurity();
  const presence = await verifyPresence(req, actor, { ...body, type: assignmentId }, "DUTY_OUT", security);
  const now = presence.serverTs;
  const shift = (await listShifts(true)).find((s) => s.id === log.shiftId);
  const extra: RiskReason[] = [];
  if (shift) {
    const win = checkOutAllowed(now, log.dutyDate, shift.startTime, shift.endTime);
    if (!win.ok) {
      extra.push(reason("OUTSIDE_SHIFT", "RED", `Đã quá hạn kết ${shift.name} (kết thúc ${vnTime(win.window.endAt).slice(0, 5)} ${vnDate(win.window.endAt)}). Hãy gửi đề nghị điều chỉnh.`));
    } else if (win.early) {
      extra.push(reason("EARLY_CHECKOUT", "YELLOW", `Kết ca sớm so với giờ kết thúc ${vnTime(win.window.endAt).slice(0, 5)}.`));
    }
  }
  const all = [...presence.reasons, ...extra];
  if (combineLevel(all) === "RED") {
    const final = await finalizeAttempt({ actor, kind: "DUTY_OUT", presence, extraReasons: extra, accepted: false, rejectMessage: redMessage(all), workDate: log.dutyDate });
    return rejected(redMessage(all), final);
  }

  const updated = await db
    .update(attDutyLogs)
    .set({ checkOutAt: now, status: "DONE", note: str(body.note).slice(0, 500) || log.note, updatedAt: now })
    .where(and(eq(attDutyLogs.id, log.id), isNull(attDutyLogs.checkOutAt)))
    .returning({ id: attDutyLogs.id });
  if (!updated.length) {
    const dup = [reason("DUPLICATE", "RED", "Ca trực vừa được kết từ một yêu cầu khác.")];
    const final = await finalizeAttempt({ actor, kind: "DUTY_OUT", presence, extraReasons: [...extra, ...dup], accepted: false, rejectMessage: dup[0].message, workDate: log.dutyDate });
    return rejected(dup[0].message, final, { alreadyPunched: true });
  }
  const final = await finalizeAttempt({ actor, kind: "DUTY_OUT", presence, extraReasons: extra, accepted: true, workDate: log.dutyDate, refType: "duty_log", refId: String(log.id) });
  const rank: Record<string, number> = { GREEN: 0, YELLOW: 1, RED: 2 };
  const worst = (rank[String(log.riskLevel)] ?? 0) > rank[final.level] ? String(log.riskLevel) : final.level;
  await db
    .update(attDutyLogs)
    .set({ checkOutAttemptId: final.attemptId, riskLevel: worst })
    .where(and(eq(attDutyLogs.id, log.id), isNull(attDutyLogs.checkOutAttemptId)));

  await writeAudit(actor, {
    entity: "duty_log",
    entityId: String(log.id),
    action: "DUTY_CHECK_OUT",
    newValue: { assignmentId, time: vnTime(now), attemptId: final.attemptId, riskLevel: final.level },
  });

  return json({
    success: true,
    message: `Đã kết ca trực lúc ${vnTime(now)}.${final.level === "YELLOW" ? " Lượt kết ca có điểm cần xác minh thêm." : ""}`,
    attemptId: final.attemptId,
    riskLevel: final.level,
    reasons: publicReasons(final.reasons),
    today: await todayState(employee),
  });
}

/**
 * ĐỒNG BỘ LƯỢT CHẤM NGOẠI TUYẾN.
 *
 * Khi mất mạng, giao diện chỉ lưu tạm "ý định chấm" kèm giờ máy khách. Giờ máy
 * khách KHÔNG được tin (yêu cầu 2), nên các lượt này KHÔNG bao giờ thành lượt
 * chấm trực tiếp: máy chủ chuyển chúng thành đề nghị điều chỉnh chờ duyệt, và
 * sinh cảnh báo VÀNG để người duyệt đối chiếu.
 */
async function handleOfflineSync(actor: ActorContext, body: Record<string, unknown>) {
  const employee = requireOwnEmployee(actor);
  await assertWriteRate(actor);
  const items = (Array.isArray(body.items) ? body.items : []).slice(0, 10) as Record<string, unknown>[];
  const now = Date.now();
  const byDate = new Map<string, { type: string; time: string }[]>();
  for (const item of items) {
    const ts = Number(item.clientTs);
    if (!Number.isFinite(ts) || ts > now + 5 * 60000 || ts < now - 7 * 24 * 3600 * 1000) continue;
    const date = vnDate(ts);
    const list = byDate.get(date) || [];
    list.push({ type: str(item.type).toUpperCase() === "OUT" ? "OUT" : "IN", time: vnTime(ts).slice(0, 5) });
    byDate.set(date, list);
  }
  if (!byDate.size) return json({ success: false, error: "Không có lượt chấm ngoại tuyến hợp lệ để đồng bộ." }, 400);
  const created: string[] = [];
  for (const [date, punches] of byDate) {
    try {
      await assertPeriodOpen(date);
    } catch {
      continue;
    }
    const id = newId("req");
    await db.insert(attRequests).values({
      id,
      kind: "ADJUST_PUNCH",
      employeeId: employee.id,
      targetDate: date,
      payload: JSON.stringify({ punches, offline: true }),
      reason: `Chấm khi mất kết nối (giờ theo máy khách, chưa được máy chủ xác minh). ${str(body.reason).slice(0, 200)}`.trim(),
      status: "PENDING",
      createdAt: now,
      updatedAt: now,
    });
    created.push(id);
    await writeAudit(actor, { entity: "request", entityId: id, action: "OFFLINE_SYNC", newValue: { targetDate: date, punches } });
  }
  if (created.length) {
    await raiseAlert({
      level: "YELLOW",
      category: "OFFLINE_SYNC",
      employeeId: employee.id,
      userId: actor.user.id,
      title: "Lượt chấm ngoại tuyến cần duyệt",
      cause: `${employee.fullName} đồng bộ ${items.length} lượt chấm khi mất mạng; đã chuyển thành ${created.length} đề nghị điều chỉnh.`,
      evidence: { requests: created, ip: actor.ip },
    });
    await notifyApprovers(employee, "Lượt chấm ngoại tuyến", `${employee.fullName} có lượt chấm khi mất kết nối cần duyệt.`, created[0]);
    await checkAdjustmentVolume(employee.id, actor.user.id, (await getSecurity()).maxAdjustmentsPerMonth);
  }
  return json({
    success: true,
    message: created.length
      ? `Đã chuyển ${created.length} ngày chấm ngoại tuyến thành đề nghị điều chỉnh chờ duyệt.`
      : "Các ngày này đã khoá kỳ, không đồng bộ được.",
    requests: created,
  });
}

/** ĐĂNG XUẤT: thu hồi phiên ngay ở máy chủ. */
async function handleLogout(actor: ActorContext) {
  if (actor.sessionId) await revokeSession(actor.sessionId, "LOGOUT");
  await writeAudit(actor, { entity: "session", entityId: actor.sessionId, action: "LOGOUT" });
  return json({ success: true });
}

/**
 * YÊU CẦU ĐIỀU CHỈNH CHẤM CÔNG.
 *
 * Cán bộ không bao giờ tự sửa được sổ chấm công. Yêu cầu chỉ ghi lại mong muốn;
 * khi Phụ trách/Quản trị duyệt thì máy chủ mới sinh ra lượt chấm mới với
 * source = REQUEST và con trỏ về yêu cầu gốc, còn dữ liệu cũ vẫn nguyên.
 */
async function handleRequestAdjust(actor: ActorContext, body: Record<string, unknown>) {
  const employee = requireOwnEmployee(actor);
  await assertWriteRate(actor);
  const settings = await getSettings();
  if (!settings.workHours.allowAdjustRequest) {
    return json({ success: false, error: "Trạm đang tắt chức năng gửi yêu cầu điều chỉnh chấm công." }, 403);
  }

  const targetDate = str(body.targetDate);
  if (!isValidDate(targetDate)) return json({ success: false, error: "Ngày cần điều chỉnh không hợp lệ." }, 400);
  if (targetDate > vnDate()) return json({ success: false, error: "Không điều chỉnh cho ngày chưa tới." }, 400);
  await assertPeriodOpen(targetDate);

  const reason = str(body.reason).slice(0, 1000);
  if (reason.length < 5) return json({ success: false, error: "Vui lòng nêu lý do điều chỉnh (tối thiểu 5 ký tự)." }, 400);

  const rawPunches = Array.isArray(body.punches) ? body.punches : [];
  const wanted = rawPunches
    .map((item) => {
      const entry = item as Record<string, unknown>;
      const type = str(entry.type).toUpperCase() === "OUT" ? "OUT" : "IN";
      const time = str(entry.time);
      return { type, time };
    })
    .filter((p) => /^([01]?\d|2[0-3]):[0-5]\d$/.test(p.time))
    .slice(0, 8);
  if (!wanted.length) {
    return json({ success: false, error: "Vui lòng nhập ít nhất một mốc giờ cần ghi nhận (dạng HH:MM)." }, 400);
  }

  const now = Date.now();
  const id = newId("req");
  await db.insert(attRequests).values({
    id,
    kind: "ADJUST_PUNCH",
    employeeId: employee.id,
    targetDate,
    payload: JSON.stringify({ punches: wanted }),
    reason,
    status: "PENDING",
    createdAt: now,
    updatedAt: now,
  });

  await writeAudit(actor, {
    entity: "request",
    entityId: id,
    action: "REQUEST_ADJUST_CREATE",
    newValue: { targetDate, punches: wanted, reason },
  });
  await notifyApprovers(employee, "Yêu cầu điều chỉnh chấm công", `${employee.fullName} xin điều chỉnh chấm công ngày ${targetDate}.`, id);
  await checkAdjustmentVolume(employee.id, actor.user.id, (await getSecurity()).maxAdjustmentsPerMonth);

  return json({ success: true, message: "Đã gửi yêu cầu điều chỉnh, chờ Phụ trách bộ phận duyệt.", id });
}

/** YÊU CẦU ĐỔI CA TRỰC với một cán bộ khác. */
async function handleRequestSwap(actor: ActorContext, body: Record<string, unknown>) {
  const employee = requireOwnEmployee(actor);
  await assertWriteRate(actor);
  const settings = await getSettings();
  if (!settings.workHours.allowSwapRequest) {
    return json({ success: false, error: "Trạm đang tắt chức năng gửi yêu cầu đổi ca trực." }, 403);
  }

  const assignmentId = str(body.assignmentId);
  const toEmployeeId = str(body.toEmployeeId);
  const reason = str(body.reason);
  if (!assignmentId || !toEmployeeId) return json({ success: false, error: "Thiếu suất trực hoặc người nhận ca." }, 400);
  if (toEmployeeId === employee.id) return json({ success: false, error: "Không thể đổi ca cho chính mình." }, 400);
  if (reason.length < 5) return json({ success: false, error: "Vui lòng nêu lý do đổi ca (tối thiểu 5 ký tự)." }, 400);

  const found = await db.select().from(attDutyAssignments).where(eq(attDutyAssignments.id, assignmentId));
  if (!found.length) return json({ success: false, error: "Không tìm thấy suất trực." }, 404);
  const duty = found[0];
  if (duty.employeeId !== employee.id) return json({ success: false, error: "Suất trực này không phải của bạn." }, 403);
  if (duty.dutyDate < vnDate()) return json({ success: false, error: "Không đổi ca cho ngày đã qua." }, 400);
  await assertPeriodOpen(duty.dutyDate);
  // Ca đã nhận thì người trực thật đã được ghi bằng chứng - không đổi người được nữa.
  const started = await db
    .select({ id: attDutyLogs.id })
    .from(attDutyLogs)
    .where(and(eq(attDutyLogs.assignmentId, assignmentId), ACTIVE_DUTY_LOG));
  if (started.length) return json({ success: false, error: "Ca trực đã được nhận, không thể đổi người." }, 409);

  const target = await findEmployee(toEmployeeId);
  if (!target || String(target.status || "ACTIVE").toUpperCase() !== "ACTIVE") {
    return json({ success: false, error: "Cán bộ nhận ca không hợp lệ." }, 400);
  }

  // Người nhận ca đã có suất trực cùng ca cùng ngày thì đổi ca là vô nghĩa.
  const clash = await db
    .select()
    .from(attDutyAssignments)
    .where(
      and(
        eq(attDutyAssignments.dutyDate, duty.dutyDate),
        eq(attDutyAssignments.shiftId, duty.shiftId),
        eq(attDutyAssignments.employeeId, toEmployeeId)
      )
    );
  if (clash.length) {
    return json({ success: false, error: `${target.fullName} đã có suất trực này trong ngày ${duty.dutyDate}.` }, 409);
  }

  const now = Date.now();
  const id = newId("req");
  await db.insert(attRequests).values({
    id,
    kind: "SWAP_DUTY",
    employeeId: employee.id,
    targetDate: duty.dutyDate,
    payload: JSON.stringify({ assignmentId, shiftId: duty.shiftId, toEmployeeId }),
    reason,
    status: "PENDING",
    createdAt: now,
    updatedAt: now,
  });

  await writeAudit(actor, {
    entity: "request",
    entityId: id,
    action: "REQUEST_SWAP_CREATE",
    newValue: { assignmentId, toEmployeeId, dutyDate: duty.dutyDate },
  });
  await notify(
    toEmployeeId,
    "Đề nghị nhận ca trực",
    `${employee.fullName} đề nghị bạn nhận ca trực ngày ${duty.dutyDate}. Yêu cầu đang chờ Phụ trách duyệt.`,
    "SWAP",
    id
  );
  await notifyApprovers(employee, "Yêu cầu đổi ca trực", `${employee.fullName} xin đổi ca trực ngày ${duty.dutyDate}.`, id);
  await checkAdjustmentVolume(employee.id, actor.user.id, (await getSecurity()).maxAdjustmentsPerMonth);

  return json({ success: true, message: "Đã gửi yêu cầu đổi ca, chờ Phụ trách bộ phận duyệt.", id });
}

/** Thu hồi yêu cầu của chính mình khi chưa ai duyệt. */
async function handleCancelRequest(actor: ActorContext, body: Record<string, unknown>) {
  const employee = requireOwnEmployee(actor);
  const id = str(body.id);
  const found = await db.select().from(attRequests).where(eq(attRequests.id, id));
  if (!found.length || found[0].employeeId !== employee.id) {
    return json({ success: false, error: "Không tìm thấy yêu cầu." }, 404);
  }
  if (String(found[0].status || "PENDING").toUpperCase() !== "PENDING") {
    return json({ success: false, error: "Yêu cầu đã được xử lý, không thu hồi được." }, 409);
  }
  await db
    .update(attRequests)
    .set({ status: "CANCELLED", updatedAt: Date.now() })
    .where(eq(attRequests.id, id));
  await writeAudit(actor, { entity: "request", entityId: id, action: "REQUEST_CANCEL" });
  return json({ success: true, message: "Đã thu hồi yêu cầu." });
}

/** GỬI ĐƠN NGHỈ PHÉP. */
async function handleSubmitLeave(actor: ActorContext, body: Record<string, unknown>) {
  const employee = requireOwnEmployee(actor);
  const settings = await getSettings();
  const leaveType = str(body.leaveType).toUpperCase();
  const type = settings.leaveTypes.find((t) => t.code.toUpperCase() === leaveType);
  if (!type) return json({ success: false, error: "Loại nghỉ không có trong danh mục của Trạm." }, 400);

  const fromDate = str(body.fromDate);
  const toDate = str(body.toDate) || fromDate;
  if (!isValidDate(fromDate) || !isValidDate(toDate)) {
    return json({ success: false, error: "Ngày nghỉ không hợp lệ." }, 400);
  }
  if (toDate < fromDate) return json({ success: false, error: "Ngày kết thúc phải sau ngày bắt đầu." }, 400);
  await assertPeriodOpen(fromDate);

  const session = ["FULL", "MORNING", "AFTERNOON"].includes(str(body.session).toUpperCase())
    ? str(body.session).toUpperCase()
    : "FULL";
  if (session !== "FULL" && fromDate !== toDate) {
    return json({ success: false, error: "Nghỉ nửa ngày chỉ áp dụng cho một ngày." }, 400);
  }

  const reason = str(body.reason);
  if (reason.length < 5) return json({ success: false, error: "Vui lòng nêu lý do nghỉ (tối thiểu 5 ký tự)." }, 400);

  // Số ngày nghỉ đếm theo ngày làm việc trong tuần, không đếm T7/CN và ngày lễ.
  const holidayMap = buildHolidayMap(await listHolidays());
  let days = 0;
  let cursor = fromDate;
  for (let guard = 0; guard < 400; guard++) {
    if (classifyDay(cursor, holidayMap, settings.workHours) === "WEEKDAY") days += 1;
    if (cursor >= toDate) break;
    cursor = addDays(cursor, 1);
  }
  if (session !== "FULL") days = settings.workHours.halfDayValue;

  // Đơn trùng khoảng ngày với một đơn còn hiệu lực là dấu hiệu gửi trùng.
  const overlapping = await db
    .select()
    .from(attLeaves)
    .where(
      and(
        eq(attLeaves.employeeId, employee.id),
        lte(attLeaves.fromDate, toDate),
        gte(attLeaves.toDate, fromDate),
        inArray(attLeaves.status, ["PENDING", "APPROVED"])
      )
    );
  if (overlapping.length) {
    return json(
      {
        success: false,
        error: `Đã có đơn nghỉ ${overlapping[0].fromDate} - ${overlapping[0].toDate} đang chờ duyệt hoặc đã duyệt trùng khoảng ngày này.`,
      },
      409
    );
  }

  const now = Date.now();
  const id = newId("leave");
  await db.insert(attLeaves).values({
    id,
    employeeId: employee.id,
    leaveType: type.code,
    fromDate,
    toDate,
    days,
    session,
    reason,
    status: "PENDING",
    createdBy: actor.user.id,
    createdAt: now,
    updatedAt: now,
  });

  await writeAudit(actor, {
    entity: "leave",
    entityId: id,
    action: "LEAVE_CREATE",
    newValue: { leaveType: type.code, fromDate, toDate, session, days },
  });
  await notifyApprovers(
    employee,
    "Đơn xin nghỉ phép",
    `${employee.fullName} xin ${type.name.toLowerCase()} từ ${fromDate} đến ${toDate} (${days} ngày).`,
    id
  );

  return json({ success: true, message: `Đã gửi đơn nghỉ ${days} ngày, chờ duyệt.`, id, days });
}

async function handleCancelLeave(actor: ActorContext, body: Record<string, unknown>) {
  const employee = requireOwnEmployee(actor);
  const id = str(body.id);
  const found = await db.select().from(attLeaves).where(eq(attLeaves.id, id));
  if (!found.length || found[0].employeeId !== employee.id) {
    return json({ success: false, error: "Không tìm thấy đơn nghỉ." }, 404);
  }
  const current = String(found[0].status || "PENDING").toUpperCase();
  if (current !== "PENDING") {
    return json({ success: false, error: "Đơn đã được xử lý, liên hệ Phụ trách để điều chỉnh." }, 409);
  }
  await db.update(attLeaves).set({ status: "CANCELLED", updatedAt: Date.now() }).where(eq(attLeaves.id, id));
  await writeAudit(actor, { entity: "leave", entityId: id, action: "LEAVE_CANCEL" });
  return json({ success: true, message: "Đã thu hồi đơn nghỉ." });
}

async function handleReadNotifications(actor: ActorContext) {
  const employee = requireOwnEmployee(actor);
  await db
    .update(attNotifications)
    .set({ readAt: Date.now() })
    .where(and(eq(attNotifications.employeeId, employee.id), sql`${attNotifications.readAt} is null`));
  return json({ success: true });
}

// ---------------------------------------------------------------------------
//  Tiện ích nội bộ
// ---------------------------------------------------------------------------


export default async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: JSON_HEADERS, status: 204 });

  try {
    const actor = await resolveActor(req);
    const url = new URL(req.url);

    if (req.method === "GET") {
      const view = str(url.searchParams.get("view")) || "bootstrap";
      const period = str(url.searchParams.get("period")) || periodOf(vnDate());
      switch (view) {
        case "bootstrap":
          return await handleBootstrap(actor);
        case "today":
          return json({ success: true, today: await todayState(requireOwnEmployee(actor)) });
        case "my_timesheet":
          return await handleMyTimesheet(actor, period);
        case "duty_schedule":
          return await handleDutySchedule(period);
        case "requests":
          return await handleMyRequests(actor);
        case "notifications":
          return await handleNotifications(actor);
        case "device":
          return await handleMyDevices(actor, str(url.searchParams.get("deviceHash")));
        default:
          return json({ success: false, error: "Yêu cầu xem dữ liệu không hợp lệ." }, 400);
      }
    }

    if (req.method !== "POST") return json({ success: false, error: "Method not allowed" }, 405);
    // Chống CSRF: API chỉ nhận JSON (trình duyệt không gửi được JSON chéo trang
    // mà không qua preflight CORS - và API không bật CORS) và từ chối Origin lạ.
    const csrf = csrfCheck(req);
    if (csrf) return csrf;

    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return json({ success: false, error: "Nội dung yêu cầu không hợp lệ." }, 400);

    switch (str(body.action)) {
      case "challenge":
        return await handleChallenge(actor, body);
      case "device_register":
        return await handleDeviceRegister(req, actor, body);
      case "punch":
        return await handlePunch(req, actor, body);
      case "duty_check_in":
        return await handleDutyCheckIn(req, actor, body);
      case "duty_self_check_in":
        return await handleDutySelfCheckIn(req, actor, body);
      case "duty_check_out":
        return await handleDutyCheckOut(req, actor, body);
      case "offline_sync":
        return await handleOfflineSync(actor, body);
      case "logout":
        return await handleLogout(actor);
      case "request_adjust":
        return await handleRequestAdjust(actor, body);
      case "request_swap":
        return await handleRequestSwap(actor, body);
      case "cancel_request":
        return await handleCancelRequest(actor, body);
      case "submit_leave":
        return await handleSubmitLeave(actor, body);
      case "cancel_leave":
        return await handleCancelLeave(actor, body);
      case "read_notifications":
        return await handleReadNotifications(actor);
      default:
        return json({ success: false, error: "Hành động không hợp lệ." }, 400);
    }
  } catch (err: unknown) {
    const authResponse = authErrorResponse(err, JSON_HEADERS);
    if (authResponse) return authResponse;
    if (err instanceof AuthError) {
      return json({ success: false, code: err.code, error: err.message }, err.status);
    }
    console.error("attendance error", err);
    return json({ success: false, error: "Hệ thống chấm công đang gián đoạn. Vui lòng thử lại." }, 500);
  }
};

export const config = {
  path: "/api/attendance",
};
