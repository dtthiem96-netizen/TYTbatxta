/**
 * Thư viện nghiệp vụ dùng chung của Phân hệ Chấm công - Chấm trực.
 *
 * Ba Netlify Function của phân hệ đều đọc từ đây để không tồn tại hai bản luật
 * khác nhau:
 *   - netlify/functions/attendance.ts          cán bộ tự chấm công, chấm trực, gửi yêu cầu
 *   - netlify/functions/attendance-admin.ts    quản trị danh mục, lịch trực, duyệt, khoá kỳ
 *   - netlify/functions/attendance-reports.ts  bảng chấm công tháng, tổng hợp trực, dữ liệu xuất
 *
 * BỐN ĐIỀU LUẬT ĐƯỢC CÀI VÀO ĐÂY VÀ KHÔNG NƠI NÀO KHÁC:
 *
 * 1. NGÀY LÀM VIỆC TÍNH THEO GIỜ VIỆT NAM. Hàm serverless của Netlify chạy theo
 *    UTC. Một lượt chấm vào lúc 07:30 sáng ở Lào Cai là 00:30 UTC cùng ngày -
 *    vẫn đúng ngày - nhưng cán bộ kết ca trực lúc 06:00 sáng thì là 23:00 UTC
 *    của NGÀY HÔM TRƯỚC. Lấy ngày từ dấu thời gian UTC sẽ xếp lượt chấm đó vào
 *    sai ngày và bảng công tháng lệch hẳn một dòng. Mọi phép đổi dấu thời gian
 *    thành ngày/giờ trong phân hệ đều phải đi qua vnDate()/vnTime() ở đây.
 *
 * 2. KHÔNG CỐ ĐỊNH QUY ĐỊNH TRONG MÃ NGUỒN. Giờ hành chính, ngày làm việc trong
 *    tuần, biên độ cho phép chấm sớm/muộn, ký hiệu bảng công, loại nghỉ phép -
 *    tất cả nằm trong bảng att_settings. Các hằng số DEFAULT_* dưới đây chỉ là
 *    giá trị GIEO HẠT cho lần chạy đầu tiên, không phải luật: sau khi Quản trị
 *    lưu cấu hình thì bản trong cơ sở dữ liệu là nguồn duy nhất.
 *
 * 3. CÔNG HÀNH CHÍNH KHÔNG BAO GIỜ TỰ CỘNG VỚI CÔNG TRỰC. buildTimesheet() trả
 *    về hai nhóm con số tách biệt và không có phép cộng nào nối chúng lại. Một
 *    ca trực chỉ sinh ra ngày công hành chính khi Quản trị bật cờ
 *    counts_as_admin_day trên CHÍNH ca đó, và khi ấy phần quy đổi vẫn được báo
 *    cáo ở cột riêng (convertedAdminDays) để người kiểm tra thấy được nó.
 *
 * 4. KỲ ĐÃ KHOÁ LÀ KHOÁ. assertPeriodOpen() được gọi ở đầu mọi đường ghi dữ
 *    liệu, kể cả đường của Quản trị viên. Bảng công đã nộp không được sửa sau
 *    lưng người đã ký.
 */
import { db } from "../../db/index.js";
import {
  attAudits,
  attDepartments,
  attEmployees,
  attHolidays,
  attNotifications,
  attPeriods,
  attRoles,
  attSettings,
  attShifts,
  users,
} from "../../db/schema.js";
import { and, eq, inArray } from "drizzle-orm";
import { isAdminRole, requireScope, AuthError, type AuthContext, type UserRow } from "./auth.js";

export type EmployeeRow = typeof attEmployees.$inferSelect;
export type DepartmentRow = typeof attDepartments.$inferSelect;
export type ShiftRow = typeof attShifts.$inferSelect;
export type HolidayRow = typeof attHolidays.$inferSelect;
export type RoleRow = typeof attRoles.$inferSelect;

/** Múi giờ của trạm. Bát Xát thuộc Lào Cai - UTC+7, không có giờ mùa hè. */
export const TZ = "Asia/Ho_Chi_Minh";

// ---------------------------------------------------------------------------
//  1. Ngày và giờ theo giờ Việt Nam
// ---------------------------------------------------------------------------

/**
 * Định dạng dấu thời gian thành các phần ngày/giờ theo giờ Việt Nam.
 *
 * Dùng Intl thay vì cộng thẳng 7 giờ vào dấu thời gian: cách cộng tay trông
 * đơn giản hơn nhưng sai ngay khi có ai đó chạy mã này ở múi giờ khác, còn
 * Intl thì luôn hỏi đúng cơ sở dữ liệu múi giờ của runtime.
 */
function vnParts(ts: number): Record<string, string> {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const out: Record<string, string> = {};
  for (const part of fmt.formatToParts(ts)) out[part.type] = part.value;
  return out;
}

/** Ngày dạng YYYY-MM-DD theo giờ Việt Nam. */
export function vnDate(ts: number = Date.now()): string {
  const p = vnParts(ts);
  return `${p.year}-${p.month}-${p.day}`;
}

/** Giờ dạng HH:MM theo giờ Việt Nam. */
export function vnTime(ts: number = Date.now()): string {
  const p = vnParts(ts);
  // Intl trả "24" cho nửa đêm ở một số runtime; chuẩn hoá về "00".
  const hour = p.hour === "24" ? "00" : p.hour;
  return `${hour}:${p.minute}`;
}

/** Số phút kể từ 00:00 của một mốc giờ "HH:MM". Trả null nếu chuỗi không hợp lệ. */
/**
 * Mốc thời gian tuyệt đối của một giờ theo lịch Việt Nam.
 *
 * Việt Nam dùng UTC+7 cố định, không có giờ mùa hè, nên phép trừ 7 giờ là đúng
 * cho mọi ngày trong quá khứ và tương lai. Hàm này cần thiết ở đường duyệt yêu
 * cầu điều chỉnh: cán bộ khai "07:25 ngày 12/09", máy chủ phải quy ra đúng mốc
 * epoch của giờ Việt Nam đó, không phải giờ UTC của máy chủ.
 */
export function vnEpoch(dateStr: string, timeStr: string): number {
  const [y, m, d] = dateStr.split("-").map(Number);
  const [h, mi] = timeStr.split(":").map(Number);
  return Date.UTC(y, m - 1, d, h, mi, 0, 0) - 7 * 60 * 60 * 1000;
}

export function toMinutes(hhmm: string | null | undefined): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || "").trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/** Ngược lại toMinutes: 450 -> "07:30". */
export function fromMinutes(total: number): string {
  const m = ((Math.round(total) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

/** Kiểm tra chuỗi ngày YYYY-MM-DD có thật (bắt cả 2026-02-30). */
export function isValidDate(value: string | null | undefined): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ""));
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

/** Kiểm tra chuỗi kỳ YYYY-MM. */
export function isValidPeriod(value: string | null | undefined): boolean {
  const m = /^(\d{4})-(\d{2})$/.exec(String(value || ""));
  if (!m) return false;
  const month = Number(m[2]);
  return month >= 1 && month <= 12;
}

/**
 * Thứ trong tuần của một chuỗi ngày: 0 = Chủ nhật ... 6 = Thứ 7.
 *
 * Tính qua Date.UTC nên kết quả không phụ thuộc múi giờ máy chủ - đây là lý do
 * cả phân hệ dùng ngày dạng chuỗi chứ không dùng đối tượng Date.
 */
export function weekdayOf(dateStr: string): number {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** Tên thứ tiếng Việt, dùng cho lịch trực và tiêu đề cột bảng công. */
export const WEEKDAY_NAMES = ["Chủ nhật", "Thứ 2", "Thứ 3", "Thứ 4", "Thứ 5", "Thứ 6", "Thứ 7"];
export const WEEKDAY_SHORT = ["CN", "T2", "T3", "T4", "T5", "T6", "T7"];

/** Cộng/trừ ngày trên chuỗi YYYY-MM-DD. */
export function addDays(dateStr: string, delta: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + delta));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(
    dt.getUTCDate()
  ).padStart(2, "0")}`;
}

/** Số ngày của một kỳ YYYY-MM. */
export function daysInPeriod(period: string): number {
  const [y, m] = period.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** Danh sách mọi ngày trong kỳ, thứ tự tăng dần. */
export function periodDates(period: string): string[] {
  const total = daysInPeriod(period);
  const out: string[] = [];
  for (let i = 1; i <= total; i++) out.push(`${period}-${String(i).padStart(2, "0")}`);
  return out;
}

/** Kỳ chứa một ngày: "2026-09-23" -> "2026-09". */
export function periodOf(dateStr: string): string {
  return String(dateStr || "").slice(0, 7);
}

/** Hiển thị ngày kiểu Việt Nam cho báo cáo in ra: 2026-09-23 -> 23/09/2026. */
export function formatDateVN(dateStr: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || ""));
  return m ? `${m[3]}/${m[2]}/${m[1]}` : String(dateStr || "");
}

// ---------------------------------------------------------------------------
//  2. Cấu hình (att_settings) - không có quy định nào nằm trong mã nguồn
// ---------------------------------------------------------------------------

export const SETTING_KEYS = {
  WORK_HOURS: "work_hours",
  SYMBOLS: "symbols",
  LEAVE_TYPES: "leave_types",
  ORG: "org",
} as const;

export type WorkHours = {
  /** Ngày làm việc trong tuần: 0 = Chủ nhật ... 6 = Thứ 7. */
  workDays: number[];
  morning: { start: string; end: string; enabled: boolean };
  afternoon: { start: string; end: string; enabled: boolean };
  /** Số phút được phép chấm vào muộn mà vẫn tính đúng giờ. */
  lateGraceMin: number;
  /** Số phút được phép chấm ra sớm mà vẫn tính đủ buổi. */
  earlyGraceMin: number;
  /** Được bấm chấm vào sớm nhất bao nhiêu phút trước giờ bắt đầu. */
  earliestPunchMin: number;
  /** Được bấm chấm ra muộn nhất bao nhiêu phút sau giờ kết thúc. */
  latestPunchMin: number;
  /** Giá trị công của một buổi (sáng hoặc chiều). */
  halfDayValue: number;
  /** Cho phép chấm công vào ngày không phải ngày làm việc (T7/CN/lễ). */
  allowPunchOnNonWorkday: boolean;
  /** Bắt buộc phải có suất trực được phân mới chấm trực được. */
  requireDutyAssignment: boolean;
  /** Cho phép cán bộ tự gửi yêu cầu điều chỉnh chấm công. */
  allowAdjustRequest: boolean;
  /** Cho phép cán bộ tự gửi yêu cầu đổi ca trực. */
  allowSwapRequest: boolean;
};

export const DEFAULT_WORK_HOURS: WorkHours = {
  workDays: [1, 2, 3, 4, 5],
  morning: { start: "07:30", end: "11:30", enabled: true },
  afternoon: { start: "13:30", end: "17:00", enabled: true },
  lateGraceMin: 5,
  earlyGraceMin: 5,
  earliestPunchMin: 90,
  latestPunchMin: 180,
  halfDayValue: 0.5,
  allowPunchOnNonWorkday: true,
  requireDutyAssignment: true,
  allowAdjustRequest: true,
  allowSwapRequest: true,
};

/** Ký hiệu in trong ô bảng công. Quản trị đổi được từng ký hiệu một. */
export type Symbols = {
  present: string;
  halfPresent: string;
  duty: string;
  leave: string;
  absent: string;
  holiday: string;
  weekend: string;
  missing: string;
  /** Dấu nối khi một ngày có cả công hành chính và ca trực, ví dụ "X+T". */
  separator: string;
};

export const DEFAULT_SYMBOLS: Symbols = {
  present: "X",
  halfPresent: "X/2",
  duty: "T",
  leave: "P",
  absent: "KL",
  holiday: "L",
  weekend: "-",
  missing: "?",
  separator: "+",
};

export type LeaveType = {
  code: string;
  name: string;
  symbol: string;
  /** Có tính là ngày công hay không (nghỉ phép hưởng lương thì có). */
  paid: boolean;
  /** Đếm vào cột "nghỉ phép" hay cột "nghỉ khác" của bảng tổng hợp. */
  group: "ANNUAL" | "OTHER";
};

export const DEFAULT_LEAVE_TYPES: LeaveType[] = [
  { code: "ANNUAL", name: "Nghỉ phép hằng năm", symbol: "P", paid: true, group: "ANNUAL" },
  { code: "SICK", name: "Nghỉ ốm (có hồ sơ)", symbol: "Ô", paid: true, group: "OTHER" },
  { code: "MATERNITY", name: "Nghỉ thai sản", symbol: "TS", paid: true, group: "OTHER" },
  { code: "COMP", name: "Nghỉ bù sau ca trực", symbol: "NB", paid: true, group: "OTHER" },
  { code: "TRAINING", name: "Đi học, đào tạo", symbol: "H", paid: true, group: "OTHER" },
  { code: "BUSINESS", name: "Đi công tác", symbol: "CT", paid: true, group: "OTHER" },
  { code: "UNPAID", name: "Nghỉ không hưởng lương", symbol: "KL", paid: false, group: "OTHER" },
];

/** Thông tin đơn vị in trên đầu bảng chấm công và phiếu PDF. */
export type OrgInfo = {
  name: string;
  parentName: string;
  address: string;
  preparedByTitle: string;
  checkedByTitle: string;
  approvedByTitle: string;
};

export const DEFAULT_ORG: OrgInfo = {
  name: "TRẠM Y TẾ BÁT XÁT",
  parentName: "UBND XÃ BÁT XÁT",
  address: "Thị trấn Bát Xát, huyện Bát Xát, tỉnh Lào Cai",
  preparedByTitle: "NGƯỜI LẬP BIỂU",
  checkedByTitle: "NGƯỜI KIỂM TRA",
  approvedByTitle: "PHỤ TRÁCH ĐƠN VỊ",
};

/**
 * Ca trực gieo hạt cho lần chạy đầu tiên.
 *
 * Đây là VÍ DỤ để trạm có cái sửa, không phải danh mục cứng: Quản trị xoá sạch
 * rồi tự khai báo lại từ đầu vẫn chạy bình thường. Ca trực thường kết thúc sang
 * ngày hôm sau nên hours được khai riêng (15 giờ), không lấy hiệu hai mốc giờ.
 */
export const DEFAULT_SHIFTS = [
  {
    code: "TRUC-THUONG",
    name: "Ca trực thường (ngoài giờ)",
    startTime: "16:30",
    endTime: "07:30",
    hours: 15,
    dayScope: "WEEKDAY",
    color: "#0284c7",
    displayOrder: 1,
  },
  {
    code: "TRUC-NGAY",
    name: "Ca trực ngày",
    startTime: "07:30",
    endTime: "16:30",
    hours: 9,
    dayScope: "ANY",
    color: "#059669",
    displayOrder: 2,
  },
  {
    code: "TRUC-CUOITUAN",
    name: "Ca trực cuối tuần (24 giờ)",
    startTime: "07:30",
    endTime: "07:30",
    hours: 24,
    dayScope: "WEEKEND",
    color: "#d97706",
    displayOrder: 3,
  },
  {
    code: "TRUC-LE",
    name: "Ca trực ngày lễ/tết (24 giờ)",
    startTime: "07:30",
    endTime: "07:30",
    hours: 24,
    dayScope: "HOLIDAY",
    color: "#dc2626",
    displayOrder: 4,
  },
];

/** Gộp cấu hình đã lưu lên trên giá trị mặc định, từng cấp một. */
function mergeDeep<T>(base: T, patch: unknown): T {
  if (patch === null || patch === undefined) return base;
  if (Array.isArray(base)) return (Array.isArray(patch) ? patch : base) as T;
  if (typeof base !== "object" || typeof patch !== "object") return (patch ?? base) as T;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    if (key in out) out[key] = mergeDeep((out as Record<string, unknown>)[key], value);
  }
  return out as T;
}

export type Settings = {
  workHours: WorkHours;
  symbols: Symbols;
  leaveTypes: LeaveType[];
  org: OrgInfo;
};

/**
 * Đọc toàn bộ cấu hình.
 *
 * Bảng trống không phải lỗi: phân hệ chạy được ngay bằng giá trị mặc định, và
 * Quản trị chỉ cần sửa những gì khác với trạm mình. Chính vì vậy không có lệnh
 * ghi nào ở đây - gieo hạt là việc của ensureSeedData().
 */
export async function getSettings(): Promise<Settings> {
  let rows: (typeof attSettings.$inferSelect)[] = [];
  try {
    rows = await db.select().from(attSettings);
  } catch {
    rows = [];
  }
  const byId = new Map(rows.map((r) => [r.id, r.value]));
  const parse = (key: string) => {
    const raw = byId.get(key);
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  };

  const leaveRaw = parse(SETTING_KEYS.LEAVE_TYPES);
  return {
    workHours: mergeDeep(DEFAULT_WORK_HOURS, parse(SETTING_KEYS.WORK_HOURS)),
    symbols: mergeDeep(DEFAULT_SYMBOLS, parse(SETTING_KEYS.SYMBOLS)),
    leaveTypes: Array.isArray(leaveRaw) && leaveRaw.length ? (leaveRaw as LeaveType[]) : DEFAULT_LEAVE_TYPES,
    org: mergeDeep(DEFAULT_ORG, parse(SETTING_KEYS.ORG)),
  };
}

/** Ghi một khoá cấu hình. */
export async function saveSetting(key: string, value: unknown, actor: ActorContext): Promise<void> {
  const payload = JSON.stringify(value);
  const now = Date.now();
  const existing = await db.select().from(attSettings).where(eq(attSettings.id, key));
  if (existing.length) {
    await db
      .update(attSettings)
      .set({ value: payload, updatedBy: actor.user.id, updatedAt: now })
      .where(eq(attSettings.id, key));
  } else {
    await db.insert(attSettings).values({ id: key, value: payload, updatedBy: actor.user.id, updatedAt: now });
  }
}

/**
 * Gieo hạt danh mục ca trực cho cơ sở dữ liệu còn trắng.
 *
 * Chỉ chạy khi bảng att_shifts KHÔNG CÓ bản ghi nào. Nếu Quản trị đã xoá hết ca
 * một cách có chủ ý thì lần gọi sau sẽ dựng lại - đó là lý do hàm này chỉ được
 * gọi từ đường đọc danh mục của Quản trị và bỏ qua mọi lỗi: gieo hạt là tiện
 * nghi cho lần cài đặt đầu, không phải một bước bắt buộc của hệ thống.
 */
export async function ensureSeedData(): Promise<void> {
  try {
    const existing = await db.select({ id: attShifts.id }).from(attShifts).limit(1);
    if (existing.length) return;
    const now = Date.now();
    await db.insert(attShifts).values(
      DEFAULT_SHIFTS.map((s) => ({
        id: `shift-${s.code.toLowerCase()}`,
        code: s.code,
        name: s.name,
        startTime: s.startTime,
        endTime: s.endTime,
        crossesMidnight: String(crossesMidnight(s.startTime, s.endTime)),
        hours: s.hours,
        dayScope: s.dayScope,
        coefficient: 1,
        countsAsAdminDay: "false",
        adminDayValue: 0,
        color: s.color,
        displayOrder: s.displayOrder,
        status: "ACTIVE",
        createdAt: now,
        updatedAt: now,
      }))
    );
  } catch (err) {
    console.warn("[attendance] Không gieo được danh mục ca trực mặc định:", err);
  }
}

// ---------------------------------------------------------------------------
//  3. Loại ngày: ngày thường / cuối tuần / ngày lễ
// ---------------------------------------------------------------------------

export type DayType = "WEEKDAY" | "WEEKEND" | "HOLIDAY";

/** Ca có kết thúc sang ngày hôm sau. */
export function crossesMidnight(start: string, end: string): boolean {
  const s = toMinutes(start);
  const e = toMinutes(end);
  if (s === null || e === null) return false;
  return e <= s;
}

/** Số giờ của một ca, dùng khi Quản trị không khai hours tường minh. */
export function shiftHours(start: string, end: string): number {
  const s = toMinutes(start);
  const e = toMinutes(end);
  if (s === null || e === null) return 0;
  const span = e > s ? e - s : 1440 - s + e;
  return Math.round((span / 60) * 100) / 100;
}

/** Ngày nào nằm trong khoảng nghỉ lễ nào - tra cứu nhanh theo chuỗi ngày. */
export function buildHolidayMap(holidays: HolidayRow[]): Map<string, HolidayRow> {
  const map = new Map<string, HolidayRow>();
  for (const h of holidays) {
    if (!isValidDate(h.startDate)) continue;
    const end = isValidDate(h.endDate) ? h.endDate : h.startDate;
    // Chặn vòng lặp vô tận nếu dữ liệu có end < start hoặc khoảng quá dài.
    let cursor = h.startDate;
    for (let guard = 0; guard < 400; guard++) {
      map.set(cursor, h);
      if (cursor >= end) break;
      cursor = addDays(cursor, 1);
    }
  }
  return map;
}

/**
 * Phân loại một ngày.
 *
 * Thứ tự ưu tiên: ngày lễ thắng cuối tuần, cuối tuần thắng ngày thường. "Cuối
 * tuần" ở đây nghĩa là ngày KHÔNG nằm trong danh sách ngày làm việc mà Quản trị
 * cấu hình - trạm đổi sang làm cả thứ 7 thì chỉ cần thêm số 6 vào workDays, mã
 * nguồn không phải sửa gì.
 */
export function classifyDay(
  dateStr: string,
  holidayMap: Map<string, HolidayRow>,
  workHours: WorkHours
): DayType {
  if (holidayMap.has(dateStr)) return "HOLIDAY";
  const dow = weekdayOf(dateStr);
  return workHours.workDays.includes(dow) ? "WEEKDAY" : "WEEKEND";
}

// ---------------------------------------------------------------------------
//  4. Đánh giá một lượt chấm công hành chính
// ---------------------------------------------------------------------------

export type PunchSession = "MORNING" | "AFTERNOON" | "OUTSIDE";
export type PunchStatus = "ON_TIME" | "LATE" | "EARLY_LEAVE" | "OUTSIDE";

export type PunchEvaluation = {
  session: PunchSession;
  status: PunchStatus;
  minutesDelta: number;
  message: string;
};

/**
 * Xác định lượt chấm thuộc buổi nào và đúng giờ hay không.
 *
 * Buổi được chọn theo khoảng thời gian gần nhất chứ không theo mốc giữa ngày cố
 * định: trạm có thể cấu hình chỉ làm buổi sáng, hoặc dời giờ chiều sang 14:00,
 * và cách chọn này vẫn đúng.
 */
export function evaluatePunch(
  punchType: "IN" | "OUT",
  timeStr: string,
  workHours: WorkHours
): PunchEvaluation {
  const t = toMinutes(timeStr);
  if (t === null) {
    return { session: "OUTSIDE", status: "OUTSIDE", minutesDelta: 0, message: "Giờ chấm không hợp lệ." };
  }

  const windows: { session: PunchSession; start: number; end: number }[] = [];
  if (workHours.morning.enabled) {
    const s = toMinutes(workHours.morning.start);
    const e = toMinutes(workHours.morning.end);
    if (s !== null && e !== null) windows.push({ session: "MORNING", start: s, end: e });
  }
  if (workHours.afternoon.enabled) {
    const s = toMinutes(workHours.afternoon.start);
    const e = toMinutes(workHours.afternoon.end);
    if (s !== null && e !== null) windows.push({ session: "AFTERNOON", start: s, end: e });
  }
  if (!windows.length) {
    return { session: "OUTSIDE", status: "OUTSIDE", minutesDelta: 0, message: "Chưa cấu hình giờ hành chính." };
  }

  // Buổi phù hợp nhất: buổi mà lượt chấm nằm trong, hoặc buổi có mốc gần nhất.
  const inside = windows.find((w) => t >= w.start - workHours.earliestPunchMin && t <= w.end + workHours.latestPunchMin);
  const nearest =
    inside ||
    windows.reduce((best, w) => {
      const dBest = Math.min(Math.abs(t - best.start), Math.abs(t - best.end));
      const dCur = Math.min(Math.abs(t - w.start), Math.abs(t - w.end));
      return dCur < dBest ? w : best;
    }, windows[0]);

  if (!inside) {
    return {
      session: "OUTSIDE",
      status: "OUTSIDE",
      minutesDelta: 0,
      message: `Ngoài khung giờ cho phép chấm công (${fromMinutes(nearest.start)} - ${fromMinutes(nearest.end)}).`,
    };
  }

  if (punchType === "IN") {
    const late = t - (nearest.start + workHours.lateGraceMin);
    if (late > 0) {
      return {
        session: nearest.session,
        status: "LATE",
        minutesDelta: t - nearest.start,
        message: `Đi muộn ${t - nearest.start} phút so với giờ vào ${fromMinutes(nearest.start)}.`,
      };
    }
    return { session: nearest.session, status: "ON_TIME", minutesDelta: 0, message: "Chấm vào đúng giờ." };
  }

  const early = nearest.end - workHours.earlyGraceMin - t;
  if (early > 0) {
    return {
      session: nearest.session,
      status: "EARLY_LEAVE",
      minutesDelta: nearest.end - t,
      message: `Về sớm ${nearest.end - t} phút so với giờ ra ${fromMinutes(nearest.end)}.`,
    };
  }
  return { session: nearest.session, status: "ON_TIME", minutesDelta: 0, message: "Chấm ra đúng giờ." };
}

// ---------------------------------------------------------------------------
//  5. Tổng hợp bảng công tháng
// ---------------------------------------------------------------------------

export type PunchLite = {
  employeeId: string;
  workDate: string;
  punchType: string | null;
  punchAt: number;
  session: string | null;
  status: string | null;
  minutesDelta: number | null;
  source: string | null;
  note: string | null;
};

export type DutyLite = {
  employeeId: string;
  dutyDate: string;
  shiftId: string;
  dayType: string | null;
  status: string | null;
};

export type DutyLogLite = {
  employeeId: string;
  dutyDate: string;
  shiftId: string;
  checkInAt: number | null;
  checkOutAt: number | null;
  hours: number | null;
  status: string | null;
};

export type LeaveLite = {
  employeeId: string;
  leaveType: string;
  fromDate: string;
  toDate: string;
  session: string | null;
  status: string | null;
};

export type DayCell = {
  date: string;
  day: number;
  weekday: number;
  dayType: DayType;
  holidayName: string | null;
  /** Ký hiệu in trong ô bảng công (đã ghép công hành chính + trực + nghỉ). */
  symbol: string;
  /** Ngày công hành chính của riêng ngày này (0 / 0.5 / 1). */
  adminDays: number;
  adminHours: number;
  firstIn: string | null;
  lastOut: string | null;
  late: boolean;
  earlyLeave: boolean;
  /** Có chấm vào nhưng thiếu chấm ra. */
  missing: boolean;
  /** Số ca trực được phân trong ngày và số giờ trực tương ứng. */
  dutyShifts: number;
  dutyHours: number;
  dutyNames: string[];
  /** Đã thực sự chấm trực (nhận ca) hay chỉ mới được phân lịch. */
  dutyCheckedIn: boolean;
  leaveType: string | null;
  leaveDays: number;
  note: string;
};

export type EmployeeTimesheet = {
  employee: {
    id: string;
    code: string;
    fullName: string;
    position: string;
    departmentId: string | null;
    departmentName: string;
  };
  days: DayCell[];
  totals: {
    /** Ngày công hành chính - KHÔNG bao gồm quy đổi từ ca trực. */
    adminDays: number;
    adminHours: number;
    /** Phần ngày công quy đổi từ ca trực, chỉ khác 0 khi Quản trị bật trên ca. */
    convertedAdminDays: number;
    lateCount: number;
    earlyLeaveCount: number;
    missingCount: number;
    absentDays: number;
    annualLeaveDays: number;
    otherLeaveDays: number;
    /** Ca trực - sổ riêng, không cộng vào adminDays. */
    dutyShifts: number;
    dutyHours: number;
    dutyWeekday: number;
    dutyWeekend: number;
    dutyHoliday: number;
    dutyCheckedIn: number;
  };
};

export type TimesheetResult = {
  period: string;
  dates: { date: string; day: number; weekday: number; weekdayName: string; dayType: DayType; holidayName: string | null }[];
  rows: EmployeeTimesheet[];
  settings: Settings;
  locked: boolean;
};

/**
 * Dựng bảng chấm công + chấm trực của một kỳ.
 *
 * Đây là trái tim của mục VII, VIII và IX trong yêu cầu nghiệp vụ. Hàm nhận dữ
 * liệu thô đã đọc sẵn (thay vì tự truy vấn) để cùng một phép tính dùng được cho
 * bảng của toàn trạm, của một bộ phận và của một cán bộ - và để kiểm thử được
 * mà không cần cơ sở dữ liệu.
 *
 * LƯU Ý VỀ PHÉP CỘNG: totals.adminDays chỉ gom từ những ngày có chấm công hành
 * chính. Ca trực đi vào dutyShifts/dutyHours. Hai nhóm này không bao giờ được
 * cộng vào nhau ở đây; convertedAdminDays được tính riêng và chỉ khác 0 khi
 * Quản trị đã bật counts_as_admin_day trên chính ca đó.
 */
export function buildTimesheet(input: {
  period: string;
  employees: EmployeeRow[];
  departments: DepartmentRow[];
  shifts: ShiftRow[];
  holidays: HolidayRow[];
  punches: PunchLite[];
  duties: DutyLite[];
  dutyLogs: DutyLogLite[];
  leaves: LeaveLite[];
  settings: Settings;
  locked: boolean;
}): TimesheetResult {
  const { period, settings } = input;
  const { workHours, symbols } = settings;
  const holidayMap = buildHolidayMap(input.holidays);
  const shiftById = new Map(input.shifts.map((s) => [s.id, s]));
  const deptById = new Map(input.departments.map((d) => [d.id, d]));
  const leaveTypeByCode = new Map(settings.leaveTypes.map((t) => [t.code, t]));
  const dates = periodDates(period);

  // Nhóm dữ liệu thô theo cán bộ + ngày, một lượt duy nhất cho mỗi bảng.
  const punchIndex = new Map<string, PunchLite[]>();
  for (const p of input.punches) {
    const key = `${p.employeeId}|${p.workDate}`;
    const list = punchIndex.get(key);
    if (list) list.push(p);
    else punchIndex.set(key, [p]);
  }
  const dutyIndex = new Map<string, DutyLite[]>();
  for (const d of input.duties) {
    if (String(d.status || "PLANNED").toUpperCase() === "CANCELLED") continue;
    const key = `${d.employeeId}|${d.dutyDate}`;
    const list = dutyIndex.get(key);
    if (list) list.push(d);
    else dutyIndex.set(key, [d]);
  }
  const dutyLogIndex = new Set<string>();
  for (const l of input.dutyLogs) {
    if (l.checkInAt) dutyLogIndex.add(`${l.employeeId}|${l.dutyDate}|${l.shiftId}`);
  }

  const morningStart = toMinutes(workHours.morning.start) ?? 0;
  const morningEnd = toMinutes(workHours.morning.end) ?? 0;
  const afternoonStart = toMinutes(workHours.afternoon.start) ?? 0;
  const afternoonEnd = toMinutes(workHours.afternoon.end) ?? 0;

  const rows: EmployeeTimesheet[] = input.employees.map((emp) => {
    const dept = emp.departmentId ? deptById.get(emp.departmentId) : null;
    const days: DayCell[] = [];
    const totals: EmployeeTimesheet["totals"] = {
      adminDays: 0,
      adminHours: 0,
      convertedAdminDays: 0,
      lateCount: 0,
      earlyLeaveCount: 0,
      missingCount: 0,
      absentDays: 0,
      annualLeaveDays: 0,
      otherLeaveDays: 0,
      dutyShifts: 0,
      dutyHours: 0,
      dutyWeekday: 0,
      dutyWeekend: 0,
      dutyHoliday: 0,
      dutyCheckedIn: 0,
    };

    for (const date of dates) {
      const dayType = classifyDay(date, holidayMap, workHours);
      const holiday = holidayMap.get(date) || null;
      const dayPunches = (punchIndex.get(`${emp.id}|${date}`) || [])
        .slice()
        .sort((a, b) => a.punchAt - b.punchAt);

      // --- Công hành chính ------------------------------------------------
      const ins = dayPunches.filter((p) => String(p.punchType).toUpperCase() === "IN");
      const outs = dayPunches.filter((p) => String(p.punchType).toUpperCase() === "OUT");
      const firstIn = ins.length ? ins[0] : null;
      const lastOut = outs.length ? outs[outs.length - 1] : null;

      const inMinutes = ins
        .map((p) => toMinutes(vnTime(p.punchAt)))
        .filter((v): v is number => v !== null);
      const outMinutes = outs
        .map((p) => toMinutes(vnTime(p.punchAt)))
        .filter((v): v is number => v !== null);

      /* Một buổi được tính là đã làm khi có ít nhất một lượt chấm VÀO không
         muộn hơn cuối buổi và một lượt chấm RA không sớm hơn đầu buổi. Cách này
         xử lý đúng cả trường hợp cán bộ chỉ chấm hai lần cho cả ngày (vào buổi
         sáng, ra buổi chiều) - trường hợp phổ biến nhất ở trạm. */
      const worked = (start: number, end: number, enabled: boolean): boolean => {
        if (!enabled) return false;
        const hasIn = inMinutes.some((m) => m <= end - workHours.earlyGraceMin);
        const hasOut = outMinutes.some((m) => m >= start + workHours.lateGraceMin);
        return hasIn && hasOut;
      };
      const morningWorked = worked(morningStart, morningEnd, workHours.morning.enabled);
      const afternoonWorked = worked(afternoonStart, afternoonEnd, workHours.afternoon.enabled);

      let adminDays = 0;
      if (morningWorked) adminDays += workHours.halfDayValue;
      if (afternoonWorked) adminDays += workHours.halfDayValue;

      // Giờ hành chính: phần giao giữa [lượt vào đầu, lượt ra cuối] và hai khung
      // giờ quy định. Thời gian ở trạm ngoài khung giờ không được tính thành giờ
      // hành chính - đó là giờ trực, và nó có sổ riêng.
      let adminMinutes = 0;
      if (inMinutes.length && outMinutes.length) {
        const from = Math.min(...inMinutes);
        const to = Math.max(...outMinutes);
        const overlap = (s: number, e: number) => Math.max(0, Math.min(to, e) - Math.max(from, s));
        if (workHours.morning.enabled) adminMinutes += overlap(morningStart, morningEnd);
        if (workHours.afternoon.enabled) adminMinutes += overlap(afternoonStart, afternoonEnd);
      }
      const adminHours = Math.round((adminMinutes / 60) * 100) / 100;

      const late = ins.some((p) => String(p.status || "").toUpperCase() === "LATE");
      const earlyLeave = outs.some((p) => String(p.status || "").toUpperCase() === "EARLY_LEAVE");
      const missing = ins.length > 0 && outs.length === 0;

      // --- Ca trực ---------------------------------------------------------
      const dayDuties = dutyIndex.get(`${emp.id}|${date}`) || [];
      let dutyHours = 0;
      let convertedDays = 0;
      let dutyCheckedIn = false;
      const dutyNames: string[] = [];
      for (const duty of dayDuties) {
        const shift = shiftById.get(duty.shiftId);
        const hours = shift?.hours ?? (shift ? shiftHours(shift.startTime, shift.endTime) : 0);
        dutyHours += hours || 0;
        dutyNames.push(shift ? `${shift.name} (${shift.startTime}-${shift.endTime})` : duty.shiftId);
        if (shift && String(shift.countsAsAdminDay || "false") === "true") {
          convertedDays += shift.adminDayValue || 0;
        }
        if (dutyLogIndex.has(`${emp.id}|${date}|${duty.shiftId}`)) dutyCheckedIn = true;
        const dutyDayType = (String(duty.dayType || dayType).toUpperCase() as DayType) || dayType;
        if (dutyDayType === "HOLIDAY") totals.dutyHoliday += 1;
        else if (dutyDayType === "WEEKEND") totals.dutyWeekend += 1;
        else totals.dutyWeekday += 1;
      }

      // --- Nghỉ phép -------------------------------------------------------
      const leave = input.leaves.find(
        (l) =>
          l.employeeId === emp.id &&
          String(l.status || "").toUpperCase() === "APPROVED" &&
          l.fromDate <= date &&
          l.toDate >= date
      );
      let leaveDays = 0;
      if (leave) {
        leaveDays = String(leave.session || "FULL").toUpperCase() === "FULL" ? 1 : workHours.halfDayValue;
        const type = leaveTypeByCode.get(leave.leaveType);
        if (type?.group === "ANNUAL") totals.annualLeaveDays += leaveDays;
        else totals.otherLeaveDays += leaveDays;
      }

      // --- Ký hiệu ô -------------------------------------------------------
      const parts: string[] = [];
      if (adminDays > 0) {
        parts.push(adminDays >= workHours.halfDayValue * 2 ? symbols.present : symbols.halfPresent);
      }
      if (leave) {
        const type = leaveTypeByCode.get(leave.leaveType);
        parts.push(type?.symbol || symbols.leave);
      }
      if (dayDuties.length) parts.push(symbols.duty);
      if (!parts.length) {
        if (dayType === "HOLIDAY") parts.push(symbols.holiday);
        else if (dayType === "WEEKEND") parts.push(symbols.weekend);
        else if (missing) parts.push(symbols.missing);
        else parts.push(dateIsFuture(date) ? "" : symbols.absent);
      } else if (missing) {
        parts.push(symbols.missing);
      }
      const symbol = parts.filter(Boolean).join(symbols.separator);

      // --- Dồn vào tổng ----------------------------------------------------
      totals.adminDays += adminDays;
      totals.adminHours += adminHours;
      totals.convertedAdminDays += convertedDays;
      totals.dutyShifts += dayDuties.length;
      totals.dutyHours += dutyHours;
      if (dutyCheckedIn) totals.dutyCheckedIn += 1;
      if (late) totals.lateCount += 1;
      if (earlyLeave) totals.earlyLeaveCount += 1;
      if (missing) totals.missingCount += 1;
      if (dayType === "WEEKDAY" && adminDays === 0 && !leave && !dayDuties.length && !dateIsFuture(date)) {
        totals.absentDays += 1;
      }

      days.push({
        date,
        day: Number(date.slice(8, 10)),
        weekday: weekdayOf(date),
        dayType,
        holidayName: holiday ? holiday.name : null,
        symbol,
        adminDays,
        adminHours,
        firstIn: firstIn ? vnTime(firstIn.punchAt) : null,
        lastOut: lastOut ? vnTime(lastOut.punchAt) : null,
        late,
        earlyLeave,
        missing,
        dutyShifts: dayDuties.length,
        dutyHours: Math.round(dutyHours * 100) / 100,
        dutyNames,
        dutyCheckedIn,
        leaveType: leave ? leave.leaveType : null,
        leaveDays,
        note: "",
      });
    }

    totals.adminDays = Math.round(totals.adminDays * 100) / 100;
    totals.adminHours = Math.round(totals.adminHours * 100) / 100;
    totals.dutyHours = Math.round(totals.dutyHours * 100) / 100;
    totals.convertedAdminDays = Math.round(totals.convertedAdminDays * 100) / 100;

    return {
      employee: {
        id: emp.id,
        code: emp.code,
        fullName: emp.fullName,
        position: emp.position || "",
        departmentId: emp.departmentId || null,
        departmentName: dept ? dept.name : "",
      },
      days,
      totals,
    };
  });

  return {
    period,
    dates: dates.map((date) => {
      const dayType = classifyDay(date, holidayMap, workHours);
      const weekday = weekdayOf(date);
      return {
        date,
        day: Number(date.slice(8, 10)),
        weekday,
        weekdayName: WEEKDAY_SHORT[weekday],
        dayType,
        holidayName: holidayMap.get(date)?.name || null,
      };
    }),
    rows,
    settings,
    locked: input.locked,
  };
}

/** Ngày chưa tới thì để ô trắng, không đánh dấu nghỉ không lý do. */
function dateIsFuture(dateStr: string): boolean {
  return dateStr > vnDate();
}

// ---------------------------------------------------------------------------
//  6. Danh tính và vai trò trong phân hệ
// ---------------------------------------------------------------------------

export type AttendanceRole = "STAFF" | "MANAGER" | "ADMIN";

/** Phạm vi dữ liệu của một vai trò: chính mình, bộ phận của mình, hay toàn đơn vị. */
export type RoleScope = "SELF" | "DEPARTMENT" | "ALL";
export const ROLE_SCOPES: RoleScope[] = ["SELF", "DEPARTMENT", "ALL"];

/**
 * Danh mục quyền chức năng. Mỗi vai trò tuỳ chỉnh là một tập con của danh mục
 * này. Quản lý vai trò KHÔNG nằm trong danh mục: chỉ Quản trị hệ thống mới được
 * tạo/sửa vai trò, nếu không ai giữ quyền đó cũng tự nâng quyền cho mình được.
 */
export const PERMISSIONS = [
  { code: "manage.view", group: "Điều hành", label: "Xem bảng điều hành, danh sách cán bộ, lịch trực và trạng thái kỳ" },
  { code: "approvals.decide", group: "Điều hành", label: "Duyệt yêu cầu điều chỉnh, đổi ca và đơn nghỉ phép" },
  { code: "leave.record", group: "Điều hành", label: "Ghi nhận nghỉ phép thay cán bộ" },
  { code: "employees.manage", group: "Danh mục", label: "Thêm, sửa, xoá hồ sơ cán bộ và bộ phận" },
  { code: "accounts.manage", group: "Danh mục", label: "Quản lý tài khoản đăng nhập (tạo, gán, cấp quyền, đặt lại mật khẩu)" },
  { code: "worktime.manage", group: "Cấu hình", label: "Cấu hình thời gian làm việc, ký hiệu và loại nghỉ" },
  { code: "shifts.manage", group: "Cấu hình", label: "Quản lý danh mục ca trực và ngày nghỉ lễ" },
  { code: "roster.manage", group: "Lịch trực", label: "Lập, sửa, sao chép, nhập lịch trực tháng" },
  { code: "timedata.edit", group: "Dữ liệu công", label: "Sửa, xoá lượt chấm công và giờ trực" },
  { code: "periods.lock", group: "Dữ liệu công", label: "Khoá / mở kỳ bảng công" },
  { code: "audits.view", group: "Giám sát", label: "Xem lịch sử thao tác" },
] as const;

export type Permission = (typeof PERMISSIONS)[number]["code"];
const PERMISSION_CODES = new Set<string>(PERMISSIONS.map((p) => p.code));

/** Ba vai trò hệ thống - cố định trong mã, không sửa/xoá được. */
export const BUILTIN_ROLES: Record<AttendanceRole, { name: string; description: string; scope: RoleScope; permissions: Permission[] }> = {
  STAFF: {
    name: "Cán bộ / nhân viên",
    description: "Tự chấm công, xem lịch trực, bảng công của mình và gửi yêu cầu.",
    scope: "SELF",
    permissions: [],
  },
  MANAGER: {
    name: "Phụ trách khoa / bộ phận",
    description: "Theo dõi và duyệt yêu cầu của cán bộ trong bộ phận mình phụ trách.",
    scope: "DEPARTMENT",
    permissions: ["manage.view", "approvals.decide", "leave.record"],
  },
  ADMIN: {
    name: "Quản trị hệ thống chấm công",
    description: "Toàn quyền trong phân hệ, kể cả tạo và phân vai trò.",
    scope: "ALL",
    permissions: PERMISSIONS.map((p) => p.code),
  },
};

export const isBuiltinRole = (code: string): code is AttendanceRole =>
  Object.prototype.hasOwnProperty.call(BUILTIN_ROLES, code);

/** Chuẩn hoá danh sách quyền đọc từ cơ sở dữ liệu / từ giao diện gửi lên. */
export function parsePermissions(value: unknown): Permission[] {
  let list: unknown = value;
  if (typeof value === "string") {
    try {
      list = JSON.parse(value);
    } catch {
      list = [];
    }
  }
  if (!Array.isArray(list)) return [];
  return [...new Set(list.map((x) => String(x)).filter((x) => PERMISSION_CODES.has(x)))] as Permission[];
}

export const parseScope = (value: unknown): RoleScope => {
  const v = String(value || "").toUpperCase();
  return (ROLE_SCOPES as string[]).includes(v) ? (v as RoleScope) : "SELF";
};

/** Bản chiếu vai trò (hệ thống hoặc tuỳ chỉnh) trả ra giao diện. */
export function publicRole(row: RoleRow, employeeCount = 0) {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    description: row.description || "",
    scope: parseScope(row.scope),
    permissions: parsePermissions(row.permissions),
    displayOrder: row.displayOrder ?? 0,
    status: String(row.status || "ACTIVE").toUpperCase(),
    system: false,
    employeeCount,
  };
}

export function builtinRoleList(counts: Map<string, number> = new Map()) {
  return (Object.keys(BUILTIN_ROLES) as AttendanceRole[]).map((code, i) => ({
    id: code,
    code,
    name: BUILTIN_ROLES[code].name,
    description: BUILTIN_ROLES[code].description,
    scope: BUILTIN_ROLES[code].scope,
    permissions: [...BUILTIN_ROLES[code].permissions],
    displayOrder: -10 + i,
    status: "ACTIVE",
    system: true,
    employeeCount: counts.get(code) || 0,
  }));
}

/** Toàn bộ vai trò: ba vai trò hệ thống trước, rồi vai trò tuỳ chỉnh theo thứ tự hiển thị. */
export async function listRoles(includeInactive = true) {
  const [rows, emps] = await Promise.all([
    db.select().from(attRoles),
    db.select({ role: attEmployees.attendanceRole }).from(attEmployees),
  ]);
  const counts = new Map<string, number>();
  for (const e of emps) {
    const code = String(e.role || "STAFF").toUpperCase();
    counts.set(code, (counts.get(code) || 0) + 1);
  }
  const custom = rows
    .map((r) => publicRole(r, counts.get(r.code) || 0))
    .filter((r) => includeInactive || r.status === "ACTIVE")
    .sort((a, b) => a.displayOrder - b.displayOrder || a.name.localeCompare(b.name, "vi"));
  return [...builtinRoleList(counts), ...custom];
}

export type ActorContext = {
  user: UserRow;
  auth: AuthContext;
  /** Hồ sơ cán bộ gắn với tài khoản. Null với tài khoản quản trị thuần. */
  employee: EmployeeRow | null;
  /**
   * Bậc truy cập dùng để dựng giao diện: ADMIN là Quản trị hệ thống (toàn
   * quyền), MANAGER là bất kỳ vai trò nào có ít nhất một quyền quản lý (kể cả
   * vai trò tuỳ chỉnh), STAFF là cán bộ thường.
   */
  role: AttendanceRole;
  /** Mã vai trò thật được gán (STAFF/MANAGER/ADMIN hoặc mã vai trò tuỳ chỉnh). */
  roleCode: string;
  roleName: string;
  permissions: Set<Permission>;
  scope: RoleScope;
  ip: string;
  /** Thiết bị gọi, lưu kèm lượt chấm công để đối chiếu khi có khiếu nại. */
  userAgent: string;
};

/** Địa chỉ IP người gọi, theo header Netlify đặt ở biên. */
export function clientIp(req: Request): string {
  return (
    req.headers.get("x-nf-client-connection-ip") ||
    (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() ||
    ""
  );
}

/**
 * Xác thực rồi dựng ngữ cảnh người thao tác.
 *
 * Vai trò được đọc lại từ cơ sở dữ liệu ở MỌI lần gọi, không lấy từ phiếu phiên:
 * Quản trị hạ quyền một người phụ trách, hay bớt quyền của một vai trò tuỳ
 * chỉnh, là có hiệu lực ngay lập tức. Tài khoản có vai trò Quản trị viên hệ
 * thống ở cổng thông tin luôn là ADMIN trong phân hệ - nếu không, một cơ sở dữ
 * liệu còn trắng sẽ không có ai đủ quyền tạo hồ sơ cán bộ đầu tiên.
 *
 * Vai trò tuỳ chỉnh đã ngừng dùng hoặc đã bị xoá thì người mang nó chỉ còn
 * quyền của cán bộ thường, không bao giờ rơi lên quyền cao hơn.
 */
export async function resolveActor(req: Request): Promise<ActorContext> {
  const auth = await requireScope(req, "attendance");
  const found = await db.select().from(attEmployees).where(eq(attEmployees.userId, auth.user.id));
  const employee = found.length ? found[0] : null;

  let roleCode = "STAFF";
  if (isAdminRole(auth.user.role)) roleCode = "ADMIN";
  else if (employee) roleCode = String(employee.attendanceRole || "STAFF").toUpperCase();

  let role: AttendanceRole = "STAFF";
  let roleName = BUILTIN_ROLES.STAFF.name;
  let permissions: Permission[] = [];
  let scope: RoleScope = "SELF";

  if (isBuiltinRole(roleCode)) {
    role = roleCode;
    roleName = BUILTIN_ROLES[roleCode].name;
    permissions = BUILTIN_ROLES[roleCode].permissions;
    scope = BUILTIN_ROLES[roleCode].scope;
  } else {
    const rows = await db.select().from(attRoles).where(eq(attRoles.code, roleCode));
    const custom = rows[0];
    if (custom && String(custom.status || "ACTIVE").toUpperCase() === "ACTIVE") {
      roleName = custom.name;
      permissions = parsePermissions(custom.permissions);
      scope = parseScope(custom.scope);
      role = permissions.length ? "MANAGER" : "STAFF";
    } else {
      roleCode = "STAFF";
    }
  }

  if (employee && String(employee.status || "ACTIVE").toUpperCase() !== "ACTIVE" && role === "STAFF") {
    throw new AuthError(403, "EMPLOYEE_INACTIVE", "Hồ sơ cán bộ đã ngừng hoạt động. Liên hệ Quản trị để mở lại.");
  }

  return {
    user: auth.user,
    auth,
    employee,
    role,
    roleCode,
    roleName,
    permissions: new Set(permissions),
    scope,
    ip: clientIp(req),
    userAgent: (req.headers.get("user-agent") || "").slice(0, 250),
  };
}

/** Người thao tác có giữ quyền chức năng này không. Quản trị hệ thống luôn có. */
export function hasPermission(actor: ActorContext, permission: Permission): boolean {
  return actor.role === "ADMIN" || actor.permissions.has(permission);
}

/** Bắt buộc một quyền chức năng cụ thể. */
export function requirePermission(actor: ActorContext, permission: Permission): void {
  if (!hasPermission(actor, permission)) {
    const label = PERMISSIONS.find((p) => p.code === permission)?.label || permission;
    throw new AuthError(403, "FORBIDDEN", `Vai trò của bạn không có quyền: ${label}.`);
  }
}

/** Bắt buộc vai trò Quản trị phân hệ. */
export function requireAdmin(actor: ActorContext): void {
  if (actor.role !== "ADMIN") {
    throw new AuthError(403, "FORBIDDEN", "Chức năng này chỉ dành cho Quản trị hệ thống chấm công.");
  }
}

/** Bắt buộc vai trò có quyền quản lý (Quản trị, Phụ trách hoặc vai trò tuỳ chỉnh có quyền). */
export function requireManager(actor: ActorContext): void {
  if (actor.role === "STAFF") {
    throw new AuthError(403, "FORBIDDEN", "Chức năng này dành cho Phụ trách bộ phận hoặc Quản trị hệ thống.");
  }
}

/** Hồ sơ cán bộ của chính người đang đăng nhập, bắt buộc phải có. */
export function requireOwnEmployee(actor: ActorContext): EmployeeRow {
  if (!actor.employee) {
    throw new AuthError(
      403,
      "NO_EMPLOYEE_PROFILE",
      "Tài khoản chưa được gắn với hồ sơ cán bộ nào. Liên hệ Quản trị để gắn hồ sơ trước khi chấm công."
    );
  }
  return actor.employee;
}

/**
 * Phạm vi cán bộ mà người thao tác được xem/sửa.
 *
 * Theo phạm vi dữ liệu của vai trò. ALL: toàn trạm. DEPARTMENT: bộ phận của
 * mình (cộng thêm những bộ phận mà mình là người phụ trách). SELF: chỉ chính
 * mình. Trả null nghĩa là không giới hạn.
 */
export async function visibleEmployeeIds(actor: ActorContext): Promise<string[] | null> {
  if (actor.role === "ADMIN" || actor.scope === "ALL") return null;
  if (actor.scope === "DEPARTMENT") {
    const deptIds = new Set<string>();
    if (actor.employee?.departmentId) deptIds.add(actor.employee.departmentId);
    if (actor.employee) {
      const headed = await db
        .select()
        .from(attDepartments)
        .where(eq(attDepartments.headEmployeeId, actor.employee.id));
      for (const d of headed) deptIds.add(d.id);
    }
    if (!deptIds.size) return actor.employee ? [actor.employee.id] : [];
    const staff = await db
      .select({ id: attEmployees.id })
      .from(attEmployees)
      .where(inArray(attEmployees.departmentId, [...deptIds]));
    const ids = staff.map((s) => s.id);
    if (actor.employee) ids.push(actor.employee.id);
    return [...new Set(ids)];
  }
  return actor.employee ? [actor.employee.id] : [];
}

// ---------------------------------------------------------------------------
//  7. Khoá kỳ bảng công
// ---------------------------------------------------------------------------

/** Trạng thái của một kỳ. Kỳ chưa có bản ghi thì đang mở. */
export async function periodStatus(period: string): Promise<"OPEN" | "LOCKED"> {
  if (!isValidPeriod(period)) return "OPEN";
  const rows = await db.select().from(attPeriods).where(eq(attPeriods.id, period));
  if (!rows.length) return "OPEN";
  return String(rows[0].status || "OPEN").toUpperCase() === "LOCKED" ? "LOCKED" : "OPEN";
}

/**
 * Chặn mọi thao tác ghi vào một kỳ đã khoá.
 *
 * Gọi ở đầu MỌI đường ghi - kể cả của Quản trị. Một bảng công đã khoá và đã
 * trình lãnh đạo mà vẫn sửa được thì con số trên giấy đã ký không còn nghĩa gì.
 */
export async function assertPeriodOpen(dateOrPeriod: string): Promise<void> {
  const period = dateOrPeriod.length > 7 ? periodOf(dateOrPeriod) : dateOrPeriod;
  if (!isValidPeriod(period)) return;
  if ((await periodStatus(period)) === "LOCKED") {
    throw new AuthError(
      409,
      "PERIOD_LOCKED",
      `Bảng công kỳ ${period} đã được khoá. Quản trị phải mở khoá kỳ trước khi sửa dữ liệu.`
    );
  }
}

// ---------------------------------------------------------------------------
//  8. Lịch sử thao tác và thông báo
// ---------------------------------------------------------------------------

/**
 * Ghi một dòng lịch sử thao tác.
 *
 * Không bao giờ ném lỗi ra ngoài: một sự cố khi ghi nhật ký không được phép làm
 * thất bại thao tác nghiệp vụ mà cán bộ vừa thực hiện. Lỗi đi vào log máy chủ.
 */
export async function writeAudit(
  actor: ActorContext,
  entry: {
    entity: string;
    entityId?: string | null;
    action: string;
    field?: string | null;
    oldValue?: unknown;
    newValue?: unknown;
  }
): Promise<void> {
  const short = (value: unknown): string | null => {
    if (value === undefined || value === null) return null;
    const text = typeof value === "string" ? value : JSON.stringify(value);
    return text.length > 2000 ? `${text.slice(0, 2000)}…` : text;
  };
  try {
    await db.insert(attAudits).values({
      entity: entry.entity,
      entityId: entry.entityId || null,
      action: entry.action,
      field: entry.field || null,
      oldValue: short(entry.oldValue),
      newValue: short(entry.newValue),
      actorId: actor.user.id,
      actorName: actor.employee?.fullName || actor.user.name,
      actorUsername: actor.user.username,
      ip: actor.ip || null,
      ts: Date.now(),
    });
  } catch (err) {
    console.warn("[attendance] Không ghi được lịch sử thao tác:", err);
  }
}

/** Gửi thông báo trong phân hệ. Cũng không bao giờ làm thất bại luồng chính. */
export async function notify(
  employeeIds: string | string[],
  title: string,
  body: string,
  kind = "INFO",
  refId: string | null = null
): Promise<void> {
  const ids = (Array.isArray(employeeIds) ? employeeIds : [employeeIds]).filter(Boolean);
  if (!ids.length) return;
  const ts = Date.now();
  try {
    await db.insert(attNotifications).values(ids.map((employeeId) => ({ employeeId, title, body, kind, refId, ts })));
  } catch (err) {
    console.warn("[attendance] Không gửi được thông báo:", err);
  }
}

// ---------------------------------------------------------------------------
//  9. Tiện ích chung cho các Function
// ---------------------------------------------------------------------------

export const JSON_HEADERS = {
  "Content-Type": "application/json",
  "Cache-Control": "no-store",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { headers: JSON_HEADERS, status });

/** Ép về chuỗi đã cắt khoảng trắng, không bao giờ trả undefined. */
export const str = (value: unknown): string =>
  String(value === undefined || value === null ? "" : value).trim();

/** Ép về số, trả về giá trị dự phòng khi không đọc được. */
export const num = (value: unknown, fallback = 0): number => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

/** Sinh mã định danh cho bản ghi mới. */
export const newId = (prefix: string): string =>
  `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/** Bản chiếu cán bộ trả ra giao diện. */
export function publicEmployee(emp: EmployeeRow, deptName = "", account: UserRow | null = null) {
  return {
    id: emp.id,
    code: emp.code,
    fullName: emp.fullName,
    position: emp.position || "",
    departmentId: emp.departmentId || "",
    departmentName: deptName,
    userId: emp.userId || "",
    username: account ? account.username : "",
    attendanceRole: String(emp.attendanceRole || "STAFF").toUpperCase(),
    phone: emp.phone || "",
    email: emp.email || "",
    startDate: emp.startDate || "",
    status: String(emp.status || "ACTIVE").toUpperCase(),
    note: emp.note || "",
    displayOrder: emp.displayOrder ?? 0,
    hasAccount: Boolean(emp.userId),
    accountStatus: account ? String(account.status || "ACTIVE").toUpperCase() : "",
    accountAccess: account ? String(account.attendanceAccess || "false") : "",
  };
}

/** Bản chiếu ca trực trả ra giao diện. */
export function publicShift(shift: ShiftRow) {
  return {
    id: shift.id,
    code: shift.code,
    name: shift.name,
    startTime: shift.startTime,
    endTime: shift.endTime,
    crossesMidnight: String(shift.crossesMidnight || "false") === "true",
    hours: shift.hours ?? shiftHours(shift.startTime, shift.endTime),
    dayScope: String(shift.dayScope || "ANY").toUpperCase(),
    coefficient: shift.coefficient ?? 1,
    countsAsAdminDay: String(shift.countsAsAdminDay || "false") === "true",
    adminDayValue: shift.adminDayValue ?? 0,
    color: shift.color || "#0284c7",
    note: shift.note || "",
    displayOrder: shift.displayOrder ?? 0,
    status: String(shift.status || "ACTIVE").toUpperCase(),
  };
}

/** Tra cứu tên bộ phận theo id, dùng chung cho mọi bản chiếu. */
export async function departmentNameMap(): Promise<Map<string, string>> {
  const rows = await db.select().from(attDepartments);
  return new Map(rows.map((d) => [d.id, d.name]));
}

/** Tài khoản đăng nhập của một danh sách cán bộ. */
export async function accountsFor(employees: EmployeeRow[]): Promise<Map<string, UserRow>> {
  const ids = employees.map((e) => e.userId).filter((v): v is string => Boolean(v));
  if (!ids.length) return new Map();
  const rows = await db.select().from(users).where(inArray(users.id, ids));
  return new Map(rows.map((u) => [u.id, u]));
}

/** Cán bộ đang hoạt động, đã sắp xếp theo thứ tự hiển thị rồi tới tên. */
export async function activeEmployees(): Promise<EmployeeRow[]> {
  const rows = await db.select().from(attEmployees).where(eq(attEmployees.status, "ACTIVE"));
  return sortEmployees(rows);
}

export function sortEmployees(rows: EmployeeRow[]): EmployeeRow[] {
  return rows.slice().sort((a, b) => {
    const orderDiff = (a.displayOrder ?? 0) - (b.displayOrder ?? 0);
    if (orderDiff !== 0) return orderDiff;
    return a.fullName.localeCompare(b.fullName, "vi");
  });
}

/** Ca trực đang dùng, đã sắp xếp. */
export async function listShifts(includeInactive = false): Promise<ShiftRow[]> {
  const rows = includeInactive
    ? await db.select().from(attShifts)
    : await db.select().from(attShifts).where(eq(attShifts.status, "ACTIVE"));
  return rows.slice().sort((a, b) => (a.displayOrder ?? 0) - (b.displayOrder ?? 0) || a.name.localeCompare(b.name, "vi"));
}

/** Toàn bộ danh mục ngày nghỉ lễ. */
export async function listHolidays(): Promise<HolidayRow[]> {
  return db.select().from(attHolidays);
}

/** Một cán bộ theo id, hoặc null. */
export async function findEmployee(id: string): Promise<EmployeeRow | null> {
  if (!id) return null;
  const rows = await db.select().from(attEmployees).where(eq(attEmployees.id, id));
  return rows.length ? rows[0] : null;
}

/**
 * Cán bộ mà người thao tác được phép tác động lên, hoặc ném lỗi 403.
 *
 * Mọi đường ghi nhận dữ liệu thay người khác đều phải đi qua đây: không có
 * đường nào cho một cán bộ thường sửa bảng công của người khác, kể cả khi gọi
 * thẳng API và tự điền employeeId.
 */
export async function assertCanManage(actor: ActorContext, employeeId: string): Promise<EmployeeRow> {
  const emp = await findEmployee(employeeId);
  if (!emp) throw new AuthError(404, "EMPLOYEE_NOT_FOUND", "Không tìm thấy hồ sơ cán bộ.");
  const scope = await visibleEmployeeIds(actor);
  if (scope && !scope.includes(emp.id)) {
    throw new AuthError(403, "FORBIDDEN", "Cán bộ này không thuộc phạm vi quản lý của bạn.");
  }
  return emp;
}

/** Ngày hôm nay và các mốc của kỳ hiện tại - dùng cho màn hình chấm công. */
export function todayContext() {
  const today = vnDate();
  return { today, now: vnTime(), period: periodOf(today), weekday: weekdayOf(today) };
}

export { AuthError };
