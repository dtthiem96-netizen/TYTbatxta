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
 *
 *   POST /api/attendance  { action: ... }
 *        punch              chấm công vào/ra
 *        duty_check_in      nhận ca trực
 *        duty_check_out     kết ca trực
 *        request_adjust     xin điều chỉnh chấm công
 *        request_swap       xin đổi ca trực
 *        cancel_request     thu hồi yêu cầu chưa được duyệt
 *        submit_leave       gửi đơn nghỉ phép
 *        cancel_leave       thu hồi đơn nghỉ chưa được duyệt
 *        read_notifications đánh dấu đã đọc
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
  attPunches,
  attRequests,
} from "../../db/schema.js";
import { and, asc, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { authErrorResponse } from "../lib/auth.js";
import {
  AuthError,
  JSON_HEADERS,
  addDays,
  assertPeriodOpen,
  buildTimesheet,
  classifyDay,
  buildHolidayMap,
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
  periodDates,
  periodOf,
  periodStatus,
  publicEmployee,
  publicShift,
  resolveActor,
  requireOwnEmployee,
  shiftHours,
  str,
  todayContext,
  vnDate,
  vnTime,
  weekdayOf,
  writeAudit,
  type ActorContext,
  type EmployeeRow,
} from "../lib/attendance.js";

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

/** Lượt chấm công của một cán bộ trong một ngày. */
async function punchesOf(employeeId: string, workDate: string) {
  return db
    .select()
    .from(attPunches)
    .where(and(eq(attPunches.employeeId, employeeId), eq(attPunches.workDate, workDate)))
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
          lte(attDutyLogs.dutyDate, today)
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
      };
    })
    .filter((card) => card.dutyDate === today || card.actionable);

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
    })),
    sessionsDone,
    openSession,
    nextPunch: openSession ? "OUT" : "IN",
    duties: dutyCards,
  };
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
      .where(and(eq(attPunches.employeeId, employee.id), gte(attPunches.workDate, from), lte(attPunches.workDate, to))),
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
 * CHẤM VÀO / CHẤM RA.
 *
 * Bốn điều kiện phải qua, theo đúng thứ tự này:
 *   1. Kỳ bảng công của hôm nay chưa bị khoá.
 *   2. Hôm nay là ngày làm việc, hoặc Quản trị cho phép chấm ngoài ngày làm việc.
 *   3. Giờ hiện tại nằm trong khung được phép chấm (evaluatePunch).
 *   4. Không trùng với một lượt chấm cùng loại đã có trong cùng buổi, và chấm
 *      RA phải có chấm VÀO đứng trước.
 *
 * Điều kiện 4 là thứ giữ cho dữ liệu sạch mà không cần khoá cứng: cán bộ bấm
 * hai lần vì mạng chậm sẽ nhận thông báo "đã chấm rồi" kèm giờ đã ghi, thay vì
 * tạo ra hai bản ghi và một bảng công sai.
 */
async function handlePunch(actor: ActorContext, body: Record<string, unknown>) {
  const employee = requireOwnEmployee(actor);
  const punchType = str(body.type).toUpperCase() === "OUT" ? "OUT" : "IN";
  const { today, period } = todayContext();
  await assertPeriodOpen(period);

  const settings = await getSettings();
  const holidays = await listHolidays();
  const dayType = classifyDay(today, buildHolidayMap(holidays), settings.workHours);
  if (dayType !== "WEEKDAY" && !settings.workHours.allowPunchOnNonWorkday) {
    return json(
      {
        success: false,
        error:
          dayType === "HOLIDAY"
            ? "Hôm nay là ngày nghỉ lễ, cấu hình hiện tại không cho phép chấm công hành chính."
            : "Hôm nay không phải ngày làm việc hành chính theo cấu hình của Trạm.",
      },
      409
    );
  }

  const now = Date.now();
  const timeStr = vnTime(now);
  const evaluation = evaluatePunch(punchType, timeStr, settings.workHours);
  if (evaluation.status === "OUTSIDE") {
    return json(
      {
        success: false,
        error: `${evaluation.message} Nếu chấm công ngoài giờ, hãy gửi yêu cầu điều chỉnh để Phụ trách bộ phận duyệt.`,
        canRequestAdjust: settings.workHours.allowAdjustRequest,
      },
      409
    );
  }

  const existing = await punchesOf(employee.id, today);
  const sameSession = existing.filter(
    (p) =>
      String(p.session || "").toUpperCase() === evaluation.session &&
      String(p.punchType).toUpperCase() === punchType
  );
  if (sameSession.length) {
    return json(
      {
        success: false,
        error: `Buổi ${evaluation.session === "MORNING" ? "sáng" : "chiều"} đã chấm ${
          punchType === "IN" ? "vào" : "ra"
        } lúc ${vnTime(sameSession[0].punchAt)}.`,
        alreadyPunched: true,
      },
      409
    );
  }
  if (punchType === "OUT") {
    const hasIn = existing.some((p) => String(p.punchType).toUpperCase() === "IN");
    if (!hasIn) {
      return json({ success: false, error: "Chưa có lượt chấm vào nào trong hôm nay để chấm ra." }, 409);
    }
  }

  await db.insert(attPunches).values({
    employeeId: employee.id,
    workDate: today,
    punchType,
    punchAt: now,
    session: evaluation.session,
    status: evaluation.status,
    minutesDelta: evaluation.minutesDelta,
    device: str(body.device).slice(0, 120) || null,
    ip: actor.ip || null,
    userAgent: actor.userAgent || null,
    source: "SELF",
    note: null,
    createdBy: actor.user.id,
    createdAt: now,
  });

  await writeAudit(actor, {
    entity: "punch",
    entityId: `${employee.id}/${today}`,
    action: `PUNCH_${punchType}`,
    newValue: { time: timeStr, session: evaluation.session, status: evaluation.status },
  });

  return json({
    success: true,
    message: `Đã ${punchType === "IN" ? "chấm vào" : "chấm ra"} lúc ${timeStr}. ${evaluation.message}`,
    punch: { punchType, time: timeStr, session: evaluation.session, status: evaluation.status },
    today: await todayState(employee),
  });
}

/**
 * NHẬN CA TRỰC.
 *
 * Phải có suất trực được phân sẵn mới nhận được ca (trừ khi Quản trị tắt yêu cầu
 * đó trong cấu hình). Đây là điểm tách bạch giữa chấm công và chấm trực: trực là
 * việc được phân công theo lịch, không phải việc tự nhận.
 */
async function handleDutyCheckIn(actor: ActorContext, body: Record<string, unknown>) {
  const employee = requireOwnEmployee(actor);
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

  const existing = await db.select().from(attDutyLogs).where(eq(attDutyLogs.assignmentId, assignmentId));
  if (existing.length && existing[0].checkInAt) {
    return json(
      { success: false, error: `Đã nhận ca lúc ${vnTime(existing[0].checkInAt)}.`, alreadyPunched: true },
      409
    );
  }

  const shifts = await listShifts(true);
  const shift = shifts.find((s) => s.id === duty.shiftId);
  const now = Date.now();
  await db.insert(attDutyLogs).values({
    assignmentId,
    employeeId: employee.id,
    dutyDate: duty.dutyDate,
    shiftId: duty.shiftId,
    checkInAt: now,
    // Giờ trực lấy theo ĐỊNH MỨC của ca, không lấy hiệu giờ thực bấm: kết ca
    // muộn 10 phút không được làm tăng giờ trực trên bảng tổng hợp của trạm.
    hours: shift ? shift.hours ?? shiftHours(shift.startTime, shift.endTime) : 0,
    device: str(body.device).slice(0, 120) || null,
    ip: actor.ip || null,
    status: "OPEN",
    source: "SELF",
    createdBy: actor.user.id,
    createdAt: now,
    updatedAt: now,
  });

  await writeAudit(actor, {
    entity: "duty_log",
    entityId: assignmentId,
    action: "DUTY_CHECK_IN",
    newValue: { dutyDate: duty.dutyDate, shiftId: duty.shiftId, time: vnTime(now) },
  });

  return json({
    success: true,
    message: `Đã nhận ca trực lúc ${vnTime(now)}.`,
    today: await todayState(employee),
  });
}

/** KẾT CA TRỰC. Chấp nhận kết ca sang ngày hôm sau cho ca qua đêm. */
async function handleDutyCheckOut(actor: ActorContext, body: Record<string, unknown>) {
  const employee = requireOwnEmployee(actor);
  const assignmentId = str(body.assignmentId);
  if (!assignmentId) return json({ success: false, error: "Thiếu suất trực cần kết ca." }, 400);

  const logs = await db
    .select()
    .from(attDutyLogs)
    .where(and(eq(attDutyLogs.assignmentId, assignmentId), eq(attDutyLogs.employeeId, employee.id)));
  if (!logs.length) return json({ success: false, error: "Chưa nhận ca nên không thể kết ca." }, 409);
  const log = logs[0];
  if (log.checkOutAt) {
    return json({ success: false, error: `Ca trực đã kết lúc ${vnTime(log.checkOutAt)}.`, alreadyPunched: true }, 409);
  }
  await assertPeriodOpen(log.dutyDate);

  const now = Date.now();
  await db
    .update(attDutyLogs)
    .set({ checkOutAt: now, status: "DONE", note: str(body.note) || log.note, updatedAt: now })
    .where(eq(attDutyLogs.id, log.id));

  await writeAudit(actor, {
    entity: "duty_log",
    entityId: assignmentId,
    action: "DUTY_CHECK_OUT",
    newValue: { time: vnTime(now) },
  });

  return json({ success: true, message: `Đã kết ca trực lúc ${vnTime(now)}.`, today: await todayState(employee) });
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
  const settings = await getSettings();
  if (!settings.workHours.allowAdjustRequest) {
    return json({ success: false, error: "Trạm đang tắt chức năng gửi yêu cầu điều chỉnh chấm công." }, 403);
  }

  const targetDate = str(body.targetDate);
  if (!isValidDate(targetDate)) return json({ success: false, error: "Ngày cần điều chỉnh không hợp lệ." }, 400);
  if (targetDate > vnDate()) return json({ success: false, error: "Không điều chỉnh cho ngày chưa tới." }, 400);
  await assertPeriodOpen(targetDate);

  const reason = str(body.reason);
  if (reason.length < 5) return json({ success: false, error: "Vui lòng nêu lý do điều chỉnh (tối thiểu 5 ký tự)." }, 400);

  const rawPunches = Array.isArray(body.punches) ? body.punches : [];
  const wanted = rawPunches
    .map((item) => {
      const entry = item as Record<string, unknown>;
      const type = str(entry.type).toUpperCase() === "OUT" ? "OUT" : "IN";
      const time = str(entry.time);
      return { type, time };
    })
    .filter((p) => /^\d{1,2}:\d{2}$/.test(p.time));
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

  return json({ success: true, message: "Đã gửi yêu cầu điều chỉnh, chờ Phụ trách bộ phận duyệt.", id });
}

/** YÊU CẦU ĐỔI CA TRỰC với một cán bộ khác. */
async function handleRequestSwap(actor: ActorContext, body: Record<string, unknown>) {
  const employee = requireOwnEmployee(actor);
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

/**
 * Thông báo tới những người có quyền duyệt yêu cầu của một cán bộ: phụ trách bộ
 * phận của người đó, những cán bộ giữ vai trò MANAGER/ADMIN trong phân hệ, và
 * những cán bộ mang vai trò tuỳ chỉnh có quyền duyệt (theo phạm vi của vai trò).
 */
async function notifyApprovers(employee: EmployeeRow, title: string, bodyText: string, refId: string) {
  try {
    const customRoles = (await db.select().from(attRoles)).filter(
      (r) =>
        String(r.status || "ACTIVE").toUpperCase() === "ACTIVE" &&
        parsePermissions(r.permissions).includes("approvals.decide") &&
        String(r.scope || "SELF").toUpperCase() !== "SELF"
    );
    const allScope = new Set(["ADMIN", ...customRoles.filter((r) => String(r.scope).toUpperCase() === "ALL").map((r) => r.code)]);
    const rows = await db
      .select()
      .from(attEmployees)
      .where(inArray(attEmployees.attendanceRole, ["MANAGER", "ADMIN", ...customRoles.map((r) => r.code)]));
    const ids = rows
      .filter((r) => r.id !== employee.id)
      .filter(
        (r) =>
          allScope.has(String(r.attendanceRole || "").toUpperCase()) ||
          !employee.departmentId ||
          r.departmentId === employee.departmentId
      )
      .map((r) => r.id);
    await notify(ids, title, bodyText, "REQUEST", refId);
  } catch (err) {
    console.warn("[attendance] Không thông báo được tới người duyệt:", err);
  }
}

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
        default:
          return json({ success: false, error: "Yêu cầu xem dữ liệu không hợp lệ." }, 400);
      }
    }

    if (req.method !== "POST") return json({ success: false, error: "Method not allowed" }, 405);

    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return json({ success: false, error: "Nội dung yêu cầu không hợp lệ." }, 400);

    switch (str(body.action)) {
      case "punch":
        return await handlePunch(actor, body);
      case "duty_check_in":
        return await handleDutyCheckIn(actor, body);
      case "duty_check_out":
        return await handleDutyCheckOut(actor, body);
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
