/**
 * PHÂN TRỰC THEO ĐIỂM TRẠM, KHOA/PHÒNG VÀ NƠI LÀM VIỆC.
 *
 * Bộ phân lịch đọc dữ liệu thật của hệ thống (hồ sơ cán bộ, lịch sử công tác
 * theo ngày hiệu lực, nhóm trực đã duyệt, quyết định điều động, quy tắc từng
 * điểm trạm, nghỉ phép, suất trực đã có) và dựng ra một PHƯƠNG ÁN. Phương án
 * không ghi gì xuống cơ sở dữ liệu: Quản trị xem trước, rồi mới xác nhận lưu.
 *
 * NGUYÊN TẮC (theo thứ tự áp dụng):
 *   1. Phân theo điểm trạm trước. Mỗi quy tắc gắn đúng một điểm trạm; khoa/phòng,
 *      nơi làm việc, nhóm trực là điều kiện bổ sung. Hai cán bộ khác điểm trạm
 *      không bao giờ nằm chung một vòng luân phiên.
 *   2. Cán bộ chỉ trực ngoài điểm trạm chính khi có quyết định điều động đã được
 *      Quản trị xác nhận, hoặc quy tắc bật "trực chéo" VÀ ghi đích danh cán bộ đó.
 *   3. Thời gian nghỉ giữa hai ca và chống trùng lịch là điều kiện bắt buộc,
 *      không quy tắc nào nới được.
 *   4. Không đủ người thì báo thiếu - không tự lấy người ngoài phạm vi.
 *   5. Không suy đoán điểm trạm từ tên khoa/phòng: chỉ dùng mã định danh.
 */
import { createHash } from "node:crypto";
import { db } from "../../db/index.js";
import {
  attDepartments,
  attDutyAssignments,
  attDutyGroupMembers,
  attDutyGroups,
  attDutyRules,
  attEmployeePostings,
  attEmployees,
  attLeaves,
  attSecondments,
  attWorkplaces,
  stationRooms,
} from "../../db/schema.js";
import { and, eq, gte, lte } from "drizzle-orm";
import {
  addDays,
  buildHolidayMap,
  classifyDay,
  getSettings,
  listHolidays,
  listShifts,
  sortEmployees,
  toMinutes,
  weekdayOf,
  type DayType,
  type EmployeeRow,
  type RosterRules,
  type Settings,
  type ShiftRow,
} from "./attendance.js";

export type StationRow = typeof stationRooms.$inferSelect;
export type DepartmentRow = typeof attDepartments.$inferSelect;
export type WorkplaceRow = typeof attWorkplaces.$inferSelect;
export type DutyGroupRow = typeof attDutyGroups.$inferSelect;
export type GroupMemberRow = typeof attDutyGroupMembers.$inferSelect;
export type PostingRow = typeof attEmployeePostings.$inferSelect;
export type SecondmentRow = typeof attSecondments.$inferSelect;
export type DutyRuleRow = typeof attDutyRules.$inferSelect;
export type AssignmentRow = typeof attDutyAssignments.$inferSelect;
type LeaveRow = typeof attLeaves.$inferSelect;

/** Ngày hiệu lực của bản ghi công tác gốc, sinh khi cán bộ đổi phạm vi lần đầu. */
export const BASELINE_DATE = "1900-01-01";

export const DUTY_STATUSES = ["ACTIVE", "ON_LEAVE", "SUSPENDED", "NO_DUTY"] as const;
export type DutyStatus = (typeof DUTY_STATUSES)[number];
export const DUTY_STATUS_LABEL: Record<DutyStatus, string> = {
  ACTIVE: "Đang công tác",
  ON_LEAVE: "Nghỉ phép",
  SUSPENDED: "Tạm nghỉ",
  NO_DUTY: "Không tham gia trực",
};
export const SCOPE_MODES = ["STATION", "DEPARTMENT", "WORKPLACE", "COMBINED"] as const;
export const SCOPE_MODE_LABEL: Record<RosterRules["scopeMode"], string> = {
  STATION: "Theo điểm trạm",
  DEPARTMENT: "Theo điểm trạm + khoa/phòng",
  WORKPLACE: "Theo điểm trạm + nơi làm việc",
  COMBINED: "Kết hợp điểm trạm + khoa/phòng + nơi làm việc",
};

/** Nguyên nhân một cán bộ không được chọn cho một ca. */
export const REASON_LABEL: Record<string, string> = {
  NOT_ACTIVE: "Ngừng theo dõi công",
  DUTY_STATUS: "Trạng thái không tham gia trực (nghỉ phép / tạm nghỉ / không trực)",
  NOT_STARTED: "Chưa tới ngày bắt đầu làm việc",
  NO_STATION: "Chưa gắn điểm trạm",
  OUT_OF_SCOPE: "Thuộc điểm trạm khác, chưa có quyết định điều động",
  DEPT_MISMATCH: "Khác khoa/phòng của quy tắc",
  WORKPLACE_MISMATCH: "Khác nơi làm việc của quy tắc",
  NOT_IN_GROUP: "Không thuộc nhóm trực của quy tắc",
  MULTI_GROUP_BLOCKED: "Thuộc nhiều nhóm trực nhưng cấu hình không cho phép",
  NOT_IN_LIST: "Không có tên trong danh sách đủ điều kiện",
  SHIFT_NOT_ALLOWED: "Không được phép đảm nhiệm loại ca này",
  WEEKDAY_EXCLUDED: "Quy tắc riêng: không trực thứ này",
  ON_LEAVE: "Có đơn nghỉ đã duyệt",
  SAME_DAY: "Đã có suất trực khác trong ngày",
  OVERLAP: "Trùng thời gian với ca khác",
  REST_HOURS: "Chưa đủ số giờ nghỉ giữa hai ca",
  REST_DAYS: "Chưa đủ số ngày nghỉ giữa hai suất trực",
  MAX_MONTH: "Đã đạt giới hạn số suất trong tháng",
  MAX_SPECIAL: "Đã đạt giới hạn suất cuối tuần/lễ trong tháng",
};

// ---------------------------------------------------------------------------
//  Tiện ích phân tích dữ liệu lưu dạng JSON
// ---------------------------------------------------------------------------

export function parseIdList(raw: unknown): string[] {
  let value: unknown = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw || "[]");
    } catch {
      value = [];
    }
  }
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((x) => String(x ?? "").trim()).filter(Boolean))];
}

export type PersonalRule = { maxPerMonth: number; maxWeekendHolidayPerMonth: number; excludedWeekdays: number[] };

export function parsePersonalRule(raw: unknown): PersonalRule {
  let value: Record<string, unknown> = {};
  if (typeof raw === "string" && raw) {
    try {
      value = JSON.parse(raw) || {};
    } catch {
      value = {};
    }
  } else if (raw && typeof raw === "object") {
    value = raw as Record<string, unknown>;
  }
  const n = (v: unknown) => {
    const x = Math.round(Number(v));
    return Number.isFinite(x) ? Math.min(Math.max(x, 0), 31) : 0;
  };
  const weekdays = Array.isArray(value.excludedWeekdays) ? value.excludedWeekdays : [];
  return {
    maxPerMonth: n(value.maxPerMonth),
    maxWeekendHolidayPerMonth: n(value.maxWeekendHolidayPerMonth),
    excludedWeekdays: [...new Set(weekdays.map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort(),
  };
}

export function parseHeadcount(raw: unknown): number[] {
  let value: unknown = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw || "[]");
    } catch {
      value = [];
    }
  }
  const arr = Array.isArray(value) ? value : [];
  return Array.from({ length: 7 }, (_, i) => {
    const x = Math.round(Number(arr[i]));
    return Number.isFinite(x) ? Math.min(Math.max(x, 0), 20) : 0;
  });
}

export const isActive = (status: string | null | undefined) => String(status || "ACTIVE").toUpperCase() === "ACTIVE";
export const dutyStatusOf = (e: EmployeeRow): DutyStatus => {
  const s = String(e.dutyStatus || "ACTIVE").toUpperCase();
  return (DUTY_STATUSES as readonly string[]).includes(s) ? (s as DutyStatus) : "ACTIVE";
};

// ---------------------------------------------------------------------------
//  Phạm vi công tác theo ngày
// ---------------------------------------------------------------------------

export type Posting = {
  stationCode: string | null;
  departmentId: string | null;
  workplaceId: string | null;
  effectiveFrom: string;
};

/**
 * Phạm vi công tác của cán bộ vào một ngày: bản ghi công tác mới nhất có ngày
 * hiệu lực không sau ngày đó. Chưa có lịch sử nào thì lấy giá trị hồ sơ hiện
 * hành. Có lịch sử nhưng ngày cần tra trước mọi bản ghi thì không có phạm vi.
 */
export function postingOn(emp: EmployeeRow, postings: PostingRow[] | undefined, date: string): Posting {
  if (!postings || !postings.length) {
    return {
      stationCode: emp.stationCode || null,
      departmentId: emp.departmentId || null,
      workplaceId: emp.workplaceId || null,
      effectiveFrom: BASELINE_DATE,
    };
  }
  let found: PostingRow | null = null;
  for (const p of postings) {
    if (p.effectiveFrom <= date) found = p;
    else break;
  }
  if (!found) return { stationCode: null, departmentId: null, workplaceId: null, effectiveFrom: date };
  return {
    stationCode: found.stationCode || null,
    departmentId: found.departmentId || null,
    workplaceId: found.workplaceId || null,
    effectiveFrom: found.effectiveFrom,
  };
}

// ---------------------------------------------------------------------------
//  Thời gian ca trực
// ---------------------------------------------------------------------------

const dayNumber = (date: string) => {
  const [y, m, d] = date.split("-").map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / 86400000);
};

/** Khoảng thời gian tuyệt đối (phút) của một ca trong một ngày; ca qua đêm kéo sang hôm sau. */
export function shiftInterval(shift: ShiftRow | undefined, date: string): [number, number] {
  const base = dayNumber(date) * 1440;
  const s = toMinutes(shift?.startTime) ?? 0;
  const e = toMinutes(shift?.endTime) ?? s;
  const span = e > s ? e - s : 1440 - s + e;
  return [base + s, base + s + span];
}

export function shiftFitsDay(shift: ShiftRow, dayType: DayType): boolean {
  const scope = String(shift.dayScope || "ANY").toUpperCase();
  return scope === "ANY" || scope === dayType;
}

// ---------------------------------------------------------------------------
//  Nạp dữ liệu
// ---------------------------------------------------------------------------

export type Catalog = {
  stations: StationRow[];
  departments: DepartmentRow[];
  workplaces: WorkplaceRow[];
  groups: DutyGroupRow[];
  members: GroupMemberRow[];
  postings: PostingRow[];
  secondments: SecondmentRow[];
  rules: DutyRuleRow[];
  employees: EmployeeRow[];
  shifts: ShiftRow[];
};

export async function loadCatalog(): Promise<Catalog> {
  const [stations, departments, workplaces, groups, members, postings, secondments, rules, employees, shifts] = await Promise.all([
    db.select().from(stationRooms),
    db.select().from(attDepartments),
    db.select().from(attWorkplaces),
    db.select().from(attDutyGroups),
    db.select().from(attDutyGroupMembers),
    db.select().from(attEmployeePostings),
    db.select().from(attSecondments),
    db.select().from(attDutyRules),
    db.select().from(attEmployees),
    listShifts(true),
  ]);
  const byOrder = <T extends { displayOrder?: number | null; name?: string; stationName?: string }>(rows: T[]) =>
    rows.slice().sort((a, b) => (a.displayOrder ?? 0) - (b.displayOrder ?? 0) ||
      String(a.name ?? a.stationName ?? "").localeCompare(String(b.name ?? b.stationName ?? ""), "vi"));
  return {
    stations: byOrder(stations),
    departments: byOrder(departments),
    workplaces: byOrder(workplaces),
    groups: groups.slice().sort((a, b) => a.name.localeCompare(b.name, "vi")),
    members,
    postings: postings.slice().sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom)),
    secondments,
    rules,
    employees: sortEmployees(employees),
    shifts,
  };
}

export type PlanContext = Catalog & {
  settings: Settings;
  general: RosterRules;
  dayTypeOf: (date: string) => DayType;
  holidayName: (date: string) => string | null;
  existing: AssignmentRow[];
  leaves: LeaveRow[];
  windowFrom: string;
  windowTo: string;
  postingsByEmp: Map<string, PostingRow[]>;
  groupsByEmp: Map<string, string[]>;
  stationById: Map<string, StationRow>;
  deptById: Map<string, DepartmentRow>;
  workplaceById: Map<string, WorkplaceRow>;
  groupById: Map<string, DutyGroupRow>;
  shiftById: Map<string, ShiftRow>;
  empById: Map<string, EmployeeRow>;
};

/** Nạp đủ dữ liệu cho khoảng ngày cần phân, cộng biên trước/sau để xét giờ nghỉ và ca qua đêm. */
export async function loadPlanContext(fromDate: string, toDate: string, general?: RosterRules): Promise<PlanContext> {
  const [catalog, settings, holidays] = await Promise.all([loadCatalog(), getSettings(), listHolidays()]);
  const rules = general || settings.rosterRules;
  const pad = Math.max(rules.minRestDays, Math.ceil(rules.minRestHours / 24), 1) + 1;
  const windowFrom = addDays(fromDate, -pad);
  const windowTo = addDays(toDate, pad);
  const [existingRaw, leaves] = await Promise.all([
    db
      .select()
      .from(attDutyAssignments)
      .where(and(gte(attDutyAssignments.dutyDate, windowFrom), lte(attDutyAssignments.dutyDate, windowTo))),
    db
      .select()
      .from(attLeaves)
      .where(and(eq(attLeaves.status, "APPROVED"), lte(attLeaves.fromDate, windowTo), gte(attLeaves.toDate, windowFrom))),
  ]);
  const holidayMap = buildHolidayMap(holidays);
  const postingsByEmp = new Map<string, PostingRow[]>();
  for (const p of catalog.postings) {
    const list = postingsByEmp.get(p.employeeId);
    if (list) list.push(p);
    else postingsByEmp.set(p.employeeId, [p]);
  }
  const groupById = new Map(catalog.groups.map((g) => [g.id, g]));
  const groupsByEmp = new Map<string, string[]>();
  for (const m of catalog.members) {
    if (String(m.status || "APPROVED").toUpperCase() !== "APPROVED") continue;
    if (!isActive(groupById.get(m.groupId)?.status)) continue;
    const list = groupsByEmp.get(m.employeeId);
    if (list) list.push(m.groupId);
    else groupsByEmp.set(m.employeeId, [m.groupId]);
  }
  return {
    ...catalog,
    settings,
    general: rules,
    dayTypeOf: (date) => classifyDay(date, holidayMap, settings.workHours),
    holidayName: (date) => holidayMap.get(date)?.name || null,
    existing: existingRaw.filter((r) => String(r.status || "PLANNED").toUpperCase() !== "CANCELLED"),
    leaves,
    windowFrom,
    windowTo,
    postingsByEmp,
    groupsByEmp,
    stationById: new Map(catalog.stations.map((s) => [s.stationCode, s])),
    deptById: new Map(catalog.departments.map((d) => [d.id, d])),
    workplaceById: new Map(catalog.workplaces.map((w) => [w.id, w])),
    groupById,
    shiftById: new Map(catalog.shifts.map((s) => [s.id, s])),
    empById: new Map(catalog.employees.map((e) => [e.id, e])),
  };
}

// ---------------------------------------------------------------------------
//  Kiểm tra quy tắc
// ---------------------------------------------------------------------------

type CatalogLookup = Pick<PlanContext, "stationById" | "deptById" | "workplaceById" | "groupById" | "shiftById">;

/** Những lỗi cấu hình khiến quy tắc không áp dụng được với phạm vi phân trực đang chọn. */
export function ruleProblems(rule: DutyRuleRow, mode: RosterRules["scopeMode"], ctx: CatalogLookup): string[] {
  const out: string[] = [];
  const station = ctx.stationById.get(rule.stationCode);
  if (!station) out.push(`Điểm trạm "${rule.stationCode}" không còn trong danh mục.`);
  else if (String(station.status || "ACTIVE").toUpperCase() === "DISABLED") out.push(`Điểm trạm ${station.stationName} đã ngừng hoạt động.`);
  if ((mode === "DEPARTMENT" || mode === "COMBINED") && !rule.departmentId) {
    out.push("Phạm vi phân trực đang chọn yêu cầu quy tắc phải ghi khoa/phòng.");
  }
  if ((mode === "WORKPLACE" || mode === "COMBINED") && !rule.workplaceId) {
    out.push("Phạm vi phân trực đang chọn yêu cầu quy tắc phải ghi nơi làm việc.");
  }
  if (rule.departmentId) {
    const d = ctx.deptById.get(rule.departmentId);
    if (!d) out.push("Khoa/phòng của quy tắc không còn trong danh mục.");
    else if (!isActive(d.status)) out.push(`Khoa/phòng ${d.name} đã ngừng sử dụng.`);
  }
  if (rule.workplaceId) {
    const w = ctx.workplaceById.get(rule.workplaceId);
    if (!w) out.push("Nơi làm việc của quy tắc không còn trong danh mục.");
    else {
      if (!isActive(w.status)) out.push(`Nơi làm việc ${w.name} đã ngừng sử dụng.`);
      if (w.stationCode !== rule.stationCode) out.push(`Nơi làm việc ${w.name} không thuộc điểm trạm của quy tắc.`);
      if (w.departmentId && rule.departmentId && w.departmentId !== rule.departmentId) {
        out.push(`Nơi làm việc ${w.name} thuộc khoa/phòng khác với khoa/phòng của quy tắc.`);
      }
    }
  }
  if (rule.dutyGroupId) {
    const g = ctx.groupById.get(rule.dutyGroupId);
    if (!g) out.push("Nhóm trực của quy tắc không còn trong danh mục.");
    else {
      if (!isActive(g.status)) out.push(`Nhóm trực ${g.name} đã ngừng sử dụng.`);
      if (g.stationCode !== rule.stationCode) out.push(`Nhóm trực ${g.name} thuộc điểm trạm khác.`);
    }
  }
  const shift = ctx.shiftById.get(rule.shiftId);
  if (!shift) out.push("Ca trực của quy tắc không còn trong danh mục.");
  else if (!isActive(shift.status)) out.push(`Ca trực ${shift.name} đã ngừng sử dụng.`);
  if (rule.effectiveTo && rule.effectiveTo < rule.effectiveFrom) out.push("Ngày kết thúc áp dụng trước ngày bắt đầu.");
  return out;
}

const ruleKey = (r: DutyRuleRow) =>
  [r.stationCode, r.departmentId || "*", r.workplaceId || "*", r.dutyGroupId || "*", r.shiftId].join("|");
const ruleSpecificity = (r: DutyRuleRow) => [r.departmentId, r.workplaceId, r.dutyGroupId].filter(Boolean).length;
const rangesOverlap = (aFrom: string, aTo: string | null, bFrom: string, bTo: string | null) =>
  aFrom <= (bTo || "9999-12-31") && bFrom <= (aTo || "9999-12-31");

export function headcountOn(rule: DutyRuleRow, date: string, dayType: DayType): number {
  if (dayType === "HOLIDAY" && rule.holidayHeadcount !== null && rule.holidayHeadcount !== undefined) {
    return Math.max(0, rule.holidayHeadcount);
  }
  return parseHeadcount(rule.weekdayHeadcount)[weekdayOf(date)] || 0;
}

export type RuleConflict = {
  kind: "RULE_INVALID" | "RULE_OVERLAP" | "RULE_OVERRIDE" | "MULTI_GROUP";
  blocking: boolean;
  ruleIds: string[];
  stationCode: string | null;
  message: string;
};

/** Xung đột giữa các quy tắc đang kích hoạt trong khoảng ngày cần phân. */
export function ruleConflicts(rules: DutyRuleRow[], mode: RosterRules["scopeMode"], ctx: CatalogLookup): {
  valid: DutyRuleRow[];
  conflicts: RuleConflict[];
} {
  const conflicts: RuleConflict[] = [];
  const valid: DutyRuleRow[] = [];
  for (const r of rules) {
    const problems = ruleProblems(r, mode, ctx);
    if (problems.length) {
      conflicts.push({
        kind: "RULE_INVALID",
        blocking: true,
        ruleIds: [r.id],
        stationCode: r.stationCode,
        message: `Quy tắc "${r.name}": ${problems.join(" ")}`,
      });
    } else valid.push(r);
  }
  for (let i = 0; i < valid.length; i++) {
    for (let j = i + 1; j < valid.length; j++) {
      const a = valid[i];
      const b = valid[j];
      if (ruleKey(a) !== ruleKey(b)) continue;
      if (!rangesOverlap(a.effectiveFrom, a.effectiveTo, b.effectiveFrom, b.effectiveTo)) continue;
      const pa = a.priority ?? 0;
      const pb = b.priority ?? 0;
      if (pa === pb) {
        conflicts.push({
          kind: "RULE_OVERLAP",
          blocking: true,
          ruleIds: [a.id, b.id],
          stationCode: a.stationCode,
          message: `Quy tắc "${a.name}" và "${b.name}" cùng phạm vi, cùng ca, trùng ngày áp dụng và cùng độ ưu tiên (${pa}). Hãy khoá một quy tắc, đổi khoảng ngày hoặc đặt độ ưu tiên khác nhau.`,
        });
      } else {
        const [win, lose] = pa > pb ? [a, b] : [b, a];
        conflicts.push({
          kind: "RULE_OVERRIDE",
          blocking: false,
          ruleIds: [win.id, lose.id],
          stationCode: a.stationCode,
          message: `Quy tắc "${win.name}" (ưu tiên ${win.priority ?? 0}) thay thế "${lose.name}" (ưu tiên ${lose.priority ?? 0}) trong những ngày trùng nhau.`,
        });
      }
    }
  }
  return { valid, conflicts };
}

// ---------------------------------------------------------------------------
//  Kiểm tra một cán bộ với một ca
// ---------------------------------------------------------------------------

type Booked = {
  date: string;
  shiftId: string;
  start: number;
  end: number;
  planned: boolean;
  special: boolean;
  inPeriod: boolean;
};

export type ScopeTarget = {
  stationCode: string;
  departmentId?: string | null;
  workplaceId?: string | null;
  dutyGroupId?: string | null;
  eligibleIds?: string[];
  allowCrossStation?: boolean;
};

export type ScopeResult =
  | { ok: true; cross: boolean; secondmentId: string | null; departmentId: string | null; workplaceId: string | null }
  | { ok: false; reason: string };

/** Cán bộ có nằm trong phạm vi được phép của ca (điểm trạm + điều kiện bổ sung) vào ngày này không. */
export function scopeCheck(ctx: PlanContext, emp: EmployeeRow, target: ScopeTarget, date: string): ScopeResult {
  if (!isActive(emp.status)) return { ok: false, reason: "NOT_ACTIVE" };
  if (dutyStatusOf(emp) !== "ACTIVE") return { ok: false, reason: "DUTY_STATUS" };
  if (emp.startDate && emp.startDate > date) return { ok: false, reason: "NOT_STARTED" };
  const eligible = target.eligibleIds || [];
  if (eligible.length && !eligible.includes(emp.id)) return { ok: false, reason: "NOT_IN_LIST" };

  const posting = postingOn(emp, ctx.postingsByEmp.get(emp.id), date);
  let cross = false;
  let secondmentId: string | null = null;
  let workplaceId = posting.workplaceId;
  if (posting.stationCode !== target.stationCode) {
    const sec = ctx.secondments.find(
      (s) =>
        s.employeeId === emp.id &&
        s.stationCode === target.stationCode &&
        String(s.status || "").toUpperCase() === "APPROVED" &&
        s.validFrom <= date &&
        s.validTo >= date
    );
    if (sec) {
      secondmentId = sec.id;
      workplaceId = sec.workplaceId || null;
    } else if (!(target.allowCrossStation && eligible.includes(emp.id) && posting.stationCode)) {
      return { ok: false, reason: posting.stationCode ? "OUT_OF_SCOPE" : "NO_STATION" };
    }
    cross = true;
  }
  if (target.departmentId && posting.departmentId !== target.departmentId) return { ok: false, reason: "DEPT_MISMATCH" };
  if (target.workplaceId && workplaceId !== target.workplaceId) return { ok: false, reason: "WORKPLACE_MISMATCH" };
  if (target.dutyGroupId) {
    const groups = ctx.groupsByEmp.get(emp.id) || [];
    if (!groups.includes(target.dutyGroupId)) return { ok: false, reason: "NOT_IN_GROUP" };
    if (groups.length > 1 && !ctx.general.allowMultiGroup) return { ok: false, reason: "MULTI_GROUP_BLOCKED" };
  }
  return { ok: true, cross, secondmentId, departmentId: posting.departmentId, workplaceId };
}

type Limits = { maxPerMonth: number; maxSpecial: number };

/** Sổ đặt chỗ: mọi suất của từng cán bộ (có sẵn + dự kiến), để xét trùng giờ và giờ nghỉ. */
class Ledger {
  private byEmp = new Map<string, Booked[]>();
  total = new Map<string, number>();
  special = new Map<string, number>();
  constructor(private ctx: PlanContext, private periodFrom: string, private periodTo: string) {}

  isSpecial(date: string) {
    const t = this.ctx.dayTypeOf(date);
    return t === "WEEKEND" || t === "HOLIDAY";
  }

  add(employeeId: string, date: string, shiftId: string, planned: boolean) {
    const [start, end] = shiftInterval(this.ctx.shiftById.get(shiftId), date);
    const inPeriod = date >= this.periodFrom && date <= this.periodTo;
    const special = this.isSpecial(date);
    const list = this.byEmp.get(employeeId) || [];
    list.push({ date, shiftId, start, end, planned, special, inPeriod });
    this.byEmp.set(employeeId, list);
    if (inPeriod) {
      this.total.set(employeeId, (this.total.get(employeeId) || 0) + 1);
      if (special) this.special.set(employeeId, (this.special.get(employeeId) || 0) + 1);
    }
  }

  list(employeeId: string) {
    return this.byEmp.get(employeeId) || [];
  }

  /** Nguyên nhân không thể nhận thêm ca này (null = được). */
  blocker(employeeId: string, date: string, shiftId: string, limits: Limits | null): string | null {
    const [start, end] = shiftInterval(this.ctx.shiftById.get(shiftId), date);
    const restMin = Math.max(0, this.ctx.general.minRestHours) * 60;
    const restDays = Math.max(0, this.ctx.general.minRestDays);
    for (const b of this.list(employeeId)) {
      if (b.date === date) return "SAME_DAY";
      if (start < b.end && b.start < end) return "OVERLAP";
      if (restMin && (start < b.end + restMin && b.start < end + restMin)) return "REST_HOURS";
      if (restDays && Math.abs(dayNumber(b.date) - dayNumber(date)) <= restDays) return "REST_DAYS";
    }
    if (limits) {
      if (limits.maxPerMonth && (this.total.get(employeeId) || 0) >= limits.maxPerMonth) return "MAX_MONTH";
      if (this.isSpecial(date) && limits.maxSpecial && (this.special.get(employeeId) || 0) >= limits.maxSpecial) return "MAX_SPECIAL";
    }
    return null;
  }
}

const onLeave = (ctx: PlanContext, employeeId: string, date: string) =>
  ctx.leaves.some((l) => l.employeeId === employeeId && l.fromDate <= date && l.toDate >= date);

function shiftAllowed(emp: EmployeeRow, shiftId: string) {
  const allowed = parseIdList(emp.allowedShiftIds);
  return !allowed.length || allowed.includes(shiftId);
}

const minNonZero = (...values: number[]) => {
  const nz = values.filter((v) => v > 0);
  return nz.length ? Math.min(...nz) : 0;
};

// ---------------------------------------------------------------------------
//  Lập phương án
// ---------------------------------------------------------------------------

export type Proposal = {
  date: string;
  shiftId: string;
  employeeId: string;
  stationCode: string;
  departmentId: string | null;
  workplaceId: string | null;
  ruleId: string;
  dayType: DayType;
  cross: boolean;
  secondmentId: string | null;
};

export type Shortage = {
  date: string;
  shiftId: string;
  stationCode: string;
  ruleId: string;
  needed: number;
  filled: number;
  missing: number;
  reasons: Record<string, number>;
  suggestions: { employeeId: string; stationCode: string | null; note: string }[];
};

export type Violation = {
  kind: "OVERLAP" | "REST_HOURS" | "REST_DAYS" | "OUT_OF_SCOPE";
  blocking: boolean;
  source: "PLANNED" | "EXISTING";
  employeeId: string;
  date: string;
  shiftId: string;
  otherDate?: string;
  otherShiftId?: string;
  message: string;
};

export type Plan = {
  proposals: Proposal[];
  shortages: Shortage[];
  conflicts: RuleConflict[];
  violations: Violation[];
  warnings: string[];
  rulesUsed: string[];
  stations: string[];
  fingerprint: string;
};

/**
 * Dựng phương án phân lịch cho các ngày [dates], trong phạm vi điểm trạm
 * stationFilter (rỗng = mọi điểm trạm có quy tắc).
 */
export function buildPlan(ctx: PlanContext, dates: string[], stationFilter: string[]): Plan {
  const periodFrom = dates[0];
  const periodTo = dates[dates.length - 1];
  const general = ctx.general;
  const warnings: string[] = [];

  const candidatesRules = ctx.rules.filter(
    (r) =>
      isActive(r.status) &&
      (!stationFilter.length || stationFilter.includes(r.stationCode)) &&
      rangesOverlap(r.effectiveFrom, r.effectiveTo, periodFrom, periodTo)
  );
  const { valid, conflicts } = ruleConflicts(candidatesRules, general.scopeMode, ctx);
  const blockedPairs = new Set(
    conflicts.filter((c) => c.kind === "RULE_OVERLAP").flatMap((c) => c.ruleIds)
  );

  // Cán bộ thuộc nhiều nhóm trực khi cấu hình không cho phép: báo để xử lý.
  if (!general.allowMultiGroup) {
    for (const [empId, groups] of ctx.groupsByEmp) {
      const emp = ctx.empById.get(empId);
      if (groups.length > 1 && emp && isActive(emp.status)) {
        conflicts.push({
          kind: "MULTI_GROUP",
          blocking: false,
          ruleIds: [],
          stationCode: null,
          message: `${emp.fullName} thuộc ${groups.length} nhóm trực (${groups
            .map((g) => ctx.groupById.get(g)?.name || g)
            .join(", ")}) nhưng cấu hình không cho phép thuộc nhiều nhóm - cán bộ này bị loại khỏi các quy tắc theo nhóm.`,
        });
      }
    }
  }

  const stations = [...new Set((stationFilter.length ? stationFilter : valid.map((r) => r.stationCode)))];
  for (const code of stationFilter) {
    if (!valid.some((r) => r.stationCode === code)) {
      warnings.push(`Điểm trạm ${ctx.stationById.get(code)?.stationName || code} chưa có quy tắc phân trực nào đang kích hoạt trong tháng này.`);
    }
  }
  const unplaced = ctx.employees.filter(
    (e) => isActive(e.status) && dutyStatusOf(e) === "ACTIVE" && !postingOn(e, ctx.postingsByEmp.get(e.id), periodFrom).stationCode
  );
  if (unplaced.length) {
    warnings.push(
      `${unplaced.length} cán bộ đang công tác chưa gắn điểm trạm nên không được phân trực: ${unplaced
        .slice(0, 12)
        .map((e) => e.fullName)
        .join(", ")}${unplaced.length > 12 ? "…" : ""}.`
    );
  }

  // Sổ đặt chỗ ban đầu: toàn bộ suất đã có trong cửa sổ, ở MỌI điểm trạm -
  // một người không thể trùng giờ dù hai ca thuộc hai trạm khác nhau.
  const ledger = new Ledger(ctx, periodFrom, periodTo);
  const existingBySlot = new Map<string, AssignmentRow[]>();
  for (const a of ctx.existing) {
    ledger.add(a.employeeId, a.dutyDate, a.shiftId, false);
    if (a.dutyDate < periodFrom || a.dutyDate > periodTo) continue;
    const k = `${a.dutyDate}|${a.shiftId}`;
    const list = existingBySlot.get(k);
    if (list) list.push(a);
    else existingBySlot.set(k, [a]);
  }

  // Nhu cầu: ngày x quy tắc thắng (theo ưu tiên) x số người.
  type Demand = { date: string; rule: DutyRuleRow; need: number; dayType: DayType };
  const demands: Demand[] = [];
  const unfitWarned = new Set<string>();
  for (const date of dates) {
    const dayType = ctx.dayTypeOf(date);
    const today = valid.filter(
      (r) => !blockedPairs.has(r.id) && r.effectiveFrom <= date && (!r.effectiveTo || r.effectiveTo >= date)
    );
    const byKey = new Map<string, DutyRuleRow>();
    for (const r of today) {
      const cur = byKey.get(ruleKey(r));
      if (!cur || (r.priority ?? 0) > (cur.priority ?? 0)) byKey.set(ruleKey(r), r);
    }
    for (const r of byKey.values()) {
      const need = headcountOn(r, date, dayType);
      if (need <= 0) continue;
      const shift = ctx.shiftById.get(r.shiftId)!;
      if (!shiftFitsDay(shift, dayType)) {
        if (!unfitWarned.has(r.id)) {
          unfitWarned.add(r.id);
          warnings.push(`Quy tắc "${r.name}": ca ${shift.name} chỉ dùng cho loại ngày ${shift.dayScope}, những ngày khác được bỏ qua.`);
        }
        continue;
      }
      demands.push({ date, rule: r, need, dayType });
    }
  }
  demands.sort(
    (a, b) =>
      a.date.localeCompare(b.date) ||
      ruleSpecificity(b.rule) - ruleSpecificity(a.rule) ||
      (toMinutes(ctx.shiftById.get(a.rule.shiftId)?.startTime) ?? 0) - (toMinutes(ctx.shiftById.get(b.rule.shiftId)?.startTime) ?? 0) ||
      a.rule.stationCode.localeCompare(b.rule.stationCode)
  );

  const proposals: Proposal[] = [];
  const shortages: Shortage[] = [];
  const cursor = new Map<string, number>();
  const rulesUsed = new Set<string>();

  for (const demand of demands) {
    const { date, rule, dayType } = demand;
    rulesUsed.add(rule.id);
    const target: ScopeTarget = {
      stationCode: rule.stationCode,
      departmentId: rule.departmentId,
      workplaceId: rule.workplaceId,
      dutyGroupId: rule.dutyGroupId,
      eligibleIds: parseIdList(rule.eligibleEmployeeIds),
      allowCrossStation: String(rule.allowCrossStation || "false") === "true",
    };

    // Suất đã có (phân tay, sao chép, lần phân trước) tính vào nhu cầu nếu đúng phạm vi.
    const slot = existingBySlot.get(`${date}|${rule.shiftId}`) || [];
    let filled = 0;
    for (let i = slot.length - 1; i >= 0 && filled < demand.need; i--) {
      const a = slot[i];
      const emp = ctx.empById.get(a.employeeId);
      if (!emp) continue;
      const station = a.stationCode || postingOn(emp, ctx.postingsByEmp.get(emp.id), date).stationCode;
      if (station !== rule.stationCode) continue;
      // Suất sinh từ một quy tắc khác phạm vi thì thuộc nhu cầu của quy tắc đó.
      if (a.ruleId && a.ruleId !== rule.id) {
        const origin = ctx.rules.find((r) => r.id === a.ruleId);
        if (!origin || ruleKey(origin) !== ruleKey(rule)) continue;
      }
      if (!a.ruleId) {
        const s = scopeCheck(ctx, emp, { ...target, eligibleIds: [] }, date);
        if (!s.ok && s.reason !== "DUTY_STATUS" && s.reason !== "NOT_ACTIVE") continue;
      }
      filled += 1;
      slot.splice(i, 1);
    }
    let need = demand.need - filled;
    if (need <= 0) continue;

    const limits: Limits = {
      maxPerMonth: rule.maxPerMonth ?? general.maxPerMonth,
      maxSpecial: rule.maxWeekendHolidayPerMonth ?? general.maxWeekendHolidayPerMonth,
    };
    const pool = target.eligibleIds!.length
      ? target.eligibleIds!.map((id) => ctx.empById.get(id)).filter((e): e is EmployeeRow => Boolean(e))
      : ctx.employees;

    const reasons: Record<string, number> = {};
    const ok: { emp: EmployeeRow; scope: Extract<ScopeResult, { ok: true }>; rank: number }[] = [];
    const start = cursor.get(rule.id) || 0;
    pool.forEach((emp, idx) => {
      const rank = (idx - start + pool.length) % pool.length;
      const scope = scopeCheck(ctx, emp, target, date);
      if (!scope.ok) {
        // Cán bộ trạm khác không phải "lý do thiếu" của trạm này - chỉ đếm khi danh sách ghi đích danh.
        if (scope.reason !== "OUT_OF_SCOPE" && scope.reason !== "NO_STATION" && scope.reason !== "NOT_ACTIVE") {
          reasons[scope.reason] = (reasons[scope.reason] || 0) + 1;
        } else if (target.eligibleIds!.length) reasons[scope.reason] = (reasons[scope.reason] || 0) + 1;
        return;
      }
      if (!shiftAllowed(emp, rule.shiftId)) return void (reasons.SHIFT_NOT_ALLOWED = (reasons.SHIFT_NOT_ALLOWED || 0) + 1);
      const personal = parsePersonalRule(emp.dutyRule);
      if (personal.excludedWeekdays.includes(weekdayOf(date))) {
        return void (reasons.WEEKDAY_EXCLUDED = (reasons.WEEKDAY_EXCLUDED || 0) + 1);
      }
      if (onLeave(ctx, emp.id, date)) return void (reasons.ON_LEAVE = (reasons.ON_LEAVE || 0) + 1);
      const mine: Limits = {
        maxPerMonth: minNonZero(limits.maxPerMonth, personal.maxPerMonth),
        maxSpecial: minNonZero(limits.maxSpecial, personal.maxWeekendHolidayPerMonth),
      };
      const block = ledger.blocker(emp.id, date, rule.shiftId, mine);
      if (block) return void (reasons[block] = (reasons[block] || 0) + 1);
      ok.push({ emp, scope, rank });
    });

    const special = dayType === "WEEKEND" || dayType === "HOLIDAY";
    ok.sort((a, b) => {
      // Ưu tiên người thuộc chính điểm trạm/nơi làm việc trước người được điều động.
      if (a.scope.cross !== b.scope.cross) return a.scope.cross ? 1 : -1;
      if (general.strategy === "BALANCED") {
        if (special) {
          const ds = (ledger.special.get(a.emp.id) || 0) - (ledger.special.get(b.emp.id) || 0);
          if (ds) return ds;
        }
        const dt = (ledger.total.get(a.emp.id) || 0) - (ledger.total.get(b.emp.id) || 0);
        if (dt) return dt;
      }
      return a.rank - b.rank;
    });

    for (const c of ok) {
      if (need <= 0) break;
      proposals.push({
        date,
        shiftId: rule.shiftId,
        employeeId: c.emp.id,
        stationCode: rule.stationCode,
        departmentId: c.scope.departmentId,
        workplaceId: c.scope.workplaceId,
        ruleId: rule.id,
        dayType,
        cross: c.scope.cross,
        secondmentId: c.scope.secondmentId,
      });
      ledger.add(c.emp.id, date, rule.shiftId, true);
      const idx = pool.indexOf(c.emp);
      cursor.set(rule.id, (idx + 1) % pool.length);
      need -= 1;
    }

    if (need > 0) {
      // Đề xuất bổ sung: cán bộ trạm khác rảnh đúng ca đó - chỉ để Quản trị cân nhắc ra quyết định điều động.
      const suggestions: Shortage["suggestions"] = [];
      for (const emp of ctx.employees) {
        if (suggestions.length >= 5) break;
        if (!isActive(emp.status) || dutyStatusOf(emp) !== "ACTIVE") continue;
        const home = postingOn(emp, ctx.postingsByEmp.get(emp.id), date).stationCode;
        if (!home || home === rule.stationCode) continue;
        if (!shiftAllowed(emp, rule.shiftId) || onLeave(ctx, emp.id, date)) continue;
        if (ledger.blocker(emp.id, date, rule.shiftId, null)) continue;
        suggestions.push({
          employeeId: emp.id,
          stationCode: home,
          note: "Rảnh ca này - cần quyết định điều động được Quản trị xác nhận hoặc bật trực chéo kèm tên trong quy tắc.",
        });
      }
      shortages.push({
        date,
        shiftId: rule.shiftId,
        stationCode: rule.stationCode,
        ruleId: rule.id,
        needed: demand.need,
        filled: demand.need - need,
        missing: need,
        reasons,
        suggestions,
      });
    }
  }

  const violations = validatePlan(ctx, proposals, periodFrom, periodTo);
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify(
        proposals
          .map((p) => [p.date, p.shiftId, p.employeeId, p.stationCode, p.ruleId, p.workplaceId || ""])
          .sort((a, b) => a.join("|").localeCompare(b.join("|")))
      )
    )
    .digest("hex");

  return { proposals, shortages, conflicts, violations, warnings, rulesUsed: [...rulesUsed], stations, fingerprint };
}

/**
 * Kiểm tra toàn bộ lịch dự kiến (suất có sẵn + suất đề xuất) trước khi lưu:
 * trùng giờ, giờ nghỉ, ngày nghỉ và phạm vi. Vi phạm có dính suất đề xuất là
 * vi phạm chặn lưu; vi phạm chỉ giữa các suất có sẵn được báo để Quản trị xem lại.
 */
export function validatePlan(ctx: PlanContext, proposals: Proposal[], periodFrom: string, periodTo: string): Violation[] {
  type Item = { employeeId: string; date: string; shiftId: string; planned: boolean; start: number; end: number };
  const byEmp = new Map<string, Item[]>();
  const push = (i: Item) => {
    const list = byEmp.get(i.employeeId);
    if (list) list.push(i);
    else byEmp.set(i.employeeId, [i]);
  };
  for (const a of ctx.existing) {
    const [start, end] = shiftInterval(ctx.shiftById.get(a.shiftId), a.dutyDate);
    push({ employeeId: a.employeeId, date: a.dutyDate, shiftId: a.shiftId, planned: false, start, end });
  }
  for (const p of proposals) {
    const [start, end] = shiftInterval(ctx.shiftById.get(p.shiftId), p.date);
    push({ employeeId: p.employeeId, date: p.date, shiftId: p.shiftId, planned: true, start, end });
  }
  const out: Violation[] = [];
  const restMin = Math.max(0, ctx.general.minRestHours) * 60;
  const restDays = Math.max(0, ctx.general.minRestDays);
  for (const [employeeId, items] of byEmp) {
    items.sort((a, b) => a.start - b.start);
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        const a = items[i];
        const b = items[j];
        if (!a.planned && !b.planned) {
          // Chỉ báo vi phạm cũ nằm trong tháng đang xét.
          if (a.date < periodFrom && b.date < periodFrom) continue;
          if (a.date > periodTo && b.date > periodTo) continue;
        }
        let kind: Violation["kind"] | null = null;
        if (b.start < a.end) kind = "OVERLAP";
        else if (restMin && b.start < a.end + restMin) kind = "REST_HOURS";
        else if (restDays && a.date !== b.date && dayNumber(b.date) - dayNumber(a.date) <= restDays) kind = "REST_DAYS";
        if (!kind) {
          if (b.start >= a.end + Math.max(restMin, (restDays + 1) * 1440)) break;
          continue;
        }
        const emp = ctx.empById.get(employeeId);
        const sa = ctx.shiftById.get(a.shiftId)?.name || a.shiftId;
        const sb = ctx.shiftById.get(b.shiftId)?.name || b.shiftId;
        const label = kind === "OVERLAP" ? "trùng thời gian" : kind === "REST_HOURS" ? "không đủ giờ nghỉ" : "không đủ ngày nghỉ";
        out.push({
          kind,
          blocking: a.planned || b.planned,
          source: a.planned || b.planned ? "PLANNED" : "EXISTING",
          employeeId,
          date: b.date,
          shiftId: b.shiftId,
          otherDate: a.date,
          otherShiftId: a.shiftId,
          message: `${emp?.fullName || employeeId}: ${sa} ngày ${a.date} và ${sb} ngày ${b.date} ${label}.`,
        });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
//  Phân tay một suất trực
// ---------------------------------------------------------------------------

/**
 * Kiểm tra một suất phân tay: phạm vi điểm trạm (hoặc điều động đã duyệt),
 * trạng thái trực, ca được phép, nghỉ phép, trùng giờ và giờ nghỉ. Trả về
 * nguyên nhân chặn (null = được) và phạm vi chốt cho suất trực.
 */
export function checkManualAssignment(
  ctx: PlanContext,
  emp: EmployeeRow,
  date: string,
  shiftId: string,
  stationCode: string,
  adminConfirmedCross: boolean
): { blocker: string | null; cross: boolean; departmentId: string | null; workplaceId: string | null } {
  const posting = postingOn(emp, ctx.postingsByEmp.get(emp.id), date);
  let scope = scopeCheck(ctx, emp, { stationCode }, date);
  if (!scope.ok && scope.reason === "OUT_OF_SCOPE" && adminConfirmedCross) {
    scope = { ok: true, cross: true, secondmentId: null, departmentId: posting.departmentId, workplaceId: null };
  }
  if (!scope.ok) return { blocker: scope.reason, cross: false, departmentId: null, workplaceId: null };
  if (!shiftAllowed(emp, shiftId)) return { blocker: "SHIFT_NOT_ALLOWED", cross: scope.cross, departmentId: null, workplaceId: null };
  if (onLeave(ctx, emp.id, date)) return { blocker: "ON_LEAVE", cross: scope.cross, departmentId: null, workplaceId: null };
  const ledger = new Ledger(ctx, date, date);
  for (const a of ctx.existing) {
    if (a.dutyDate === date && a.shiftId === shiftId && a.employeeId === emp.id) continue;
    ledger.add(a.employeeId, a.dutyDate, a.shiftId, false);
  }
  const block = ledger.blocker(emp.id, date, shiftId, null);
  return { blocker: block, cross: scope.cross, departmentId: scope.departmentId, workplaceId: scope.workplaceId };
}
