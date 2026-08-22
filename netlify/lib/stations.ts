/**
 * Thư viện dùng chung cho việc ĐIỀU HƯỚNG CUỘC GỌI THEO ĐIỂM TRẠM.
 *
 * Cả ba nơi đều đọc từ đây để không có hai bản luật khác nhau:
 *   - netlify/functions/station-rooms.ts  (Quản trị cấu hình trạm ↔ phòng Zoom)
 *   - netlify/functions/signal.ts         (định tuyến, đổ chuông, leo thang)
 *   - netlify/functions/notify.ts         (chọn thiết bị nhận thông báo đẩy)
 *
 * Nguyên tắc bảo mật xuyên suốt: liên kết và mật khẩu phòng Zoom KHÔNG bao giờ
 * lọt vào danh sách công khai của người dân, vào nhật ký, hay vào nội dung thông
 * báo đẩy. Chỉ tài khoản Quản trị (khi cấu hình) và người đã giành quyền tiếp
 * nhận cuộc gọi (khi vào phòng) mới đọc được bản đầy đủ.
 */
import { db } from "../../db/index.js";
import { stationRooms, stationRoomAudits } from "../../db/schema.js";
import { asc, eq } from "drizzle-orm";

export type StationRow = typeof stationRooms.$inferSelect;

/** Múi giờ dùng để tính khung giờ trực - trạm ở Lào Cai, không theo giờ máy chủ. */
const TZ = "Asia/Ho_Chi_Minh";

export const RING_TIMEOUT_MIN = 20;
export const RING_TIMEOUT_MAX = 180;
export const RING_TIMEOUT_DEFAULT = 45;

/** Số vòng leo thang trong chính trạm đích trước khi chuyển sang trạm dự phòng. */
export const MAX_PRIORITY_ROUNDS = 3;

// ---------------------------------------------------------------------------
//  Liên kết Zoom
// ---------------------------------------------------------------------------

/** Miền được chấp nhận cho liên kết phòng Zoom. */
function isZoomHost(host: string): boolean {
  const h = host.toLowerCase();
  return h === "zoom.us" || h.endsWith(".zoom.us") || h === "zoomgov.com" || h.endsWith(".zoomgov.com");
}

export type ZoomLinkInfo = {
  ok: boolean;
  error?: string;
  meetingId?: string;
  passcode?: string;
  normalizedUrl?: string;
};

/**
 * Phân tích liên kết "Copy Invite Link" của Zoom.
 *
 * Chấp nhận cả dạng /j/<id> (tham gia thường) lẫn /s/<id> (phòng cá nhân của
 * chủ phòng); tham số pwd nếu có sẽ được tách ra làm mật khẩu gợi ý để Quản trị
 * không phải gõ lại bằng tay.
 */
export function parseZoomLink(raw: string): ZoomLinkInfo {
  const value = String(raw || "").trim();
  if (!value) return { ok: false, error: "Chưa nhập liên kết phòng Zoom." };

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, error: "Liên kết không đúng định dạng. Ví dụ đúng: https://us02web.zoom.us/j/9471234567" };
  }

  if (url.protocol !== "https:") {
    return { ok: false, error: "Liên kết phải bắt đầu bằng https:// để bảo mật cuộc gọi." };
  }
  if (!isZoomHost(url.hostname)) {
    return { ok: false, error: "Liên kết phải thuộc miền zoom.us hoặc miền Zoom của đơn vị." };
  }

  const match = url.pathname.match(/\/(?:j|s|wc\/join)\/(\d{9,12})/);
  if (!match) {
    return { ok: false, error: 'Không đọc được mã phòng trong liên kết. Hãy dùng đường dẫn dạng ".../j/<mã phòng>".' };
  }

  return {
    ok: true,
    meetingId: match[1],
    passcode: url.searchParams.get("pwd") || undefined,
    normalizedUrl: url.toString()
  };
}

/** Mã phòng chỉ gồm chữ số, cho phép người nhập gõ kèm dấu cách. */
export function normalizeMeetingId(raw: string): string {
  return String(raw || "").replace(/[^0-9]/g, "");
}

/** Hiển thị mã phòng theo nhóm 3-4-4 như trong ứng dụng Zoom. */
export function formatMeetingId(raw: string): string {
  const digits = normalizeMeetingId(raw);
  if (digits.length < 9) return digits;
  if (digits.length === 9) return `${digits.slice(0, 3)} ${digits.slice(3, 6)} ${digits.slice(6)}`;
  return `${digits.slice(0, 3)} ${digits.slice(3, 7)} ${digits.slice(7)}`;
}

// ---------------------------------------------------------------------------
//  Khung giờ trực
// ---------------------------------------------------------------------------

type DutyHours = {
  always?: boolean;
  mon_fri?: [string, string];
  mon_sat?: [string, string];
  sat?: [string, string];
  sun?: [string, string];
};

function parseDutyHours(raw: string | null | undefined): DutyHours {
  if (!raw) return { always: true };
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as DutyHours) : { always: true };
  } catch {
    return { always: true };
  }
}

function minutesOf(hhmm: string): number {
  const [h, m] = String(hhmm || "0:0").split(":").map((n) => Number(n) || 0);
  return h * 60 + m;
}

/** Giờ - phút - thứ tại Lào Cai, không phụ thuộc múi giờ của máy chủ Netlify. */
function localParts(now: number): { minutes: number; weekday: number } {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
    hour12: false
  });
  const parts = fmt.formatToParts(new Date(now));
  const get = (type: string) => parts.find((p) => p.type === type)?.value || "";
  const hour = Number(get("hour")) || 0;
  const minute = Number(get("minute")) || 0;
  const map: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return { minutes: hour * 60 + minute, weekday: map[get("weekday")] ?? 1 };
}

/** Trạm có đang trong khung giờ trực đã cấu hình hay không. */
export function isWithinDutyHours(station: Pick<StationRow, "dutyHours">, now: number): boolean {
  const duty = parseDutyHours(station.dutyHours);
  if (duty.always) return true;

  const { minutes, weekday } = localParts(now);
  const inRange = (range?: [string, string]) =>
    Array.isArray(range) && minutes >= minutesOf(range[0]) && minutes <= minutesOf(range[1]);

  if (weekday === 0) return inRange(duty.sun);
  if (weekday === 6) return inRange(duty.sat) || inRange(duty.mon_sat);
  return inRange(duty.mon_fri) || inRange(duty.mon_sat);
}

// ---------------------------------------------------------------------------
//  Đọc cấu hình trạm
// ---------------------------------------------------------------------------

export async function listStations(): Promise<StationRow[]> {
  return db.select().from(stationRooms).orderBy(asc(stationRooms.displayOrder), asc(stationRooms.stationCode));
}

export async function getStation(code: string): Promise<StationRow | null> {
  if (!code) return null;
  const rows = await db.select().from(stationRooms).where(eq(stationRooms.stationCode, code));
  return rows[0] || null;
}

export async function stationMap(): Promise<Map<string, StationRow>> {
  const rows = await listStations();
  return new Map(rows.map((r) => [r.stationCode, r]));
}

/*
 * Bản đệm ngắn hạn của danh mục trạm.
 *
 * Một lượt long-poll hàng đợi quét lại cơ sở dữ liệu vài chục lần trong bảy
 * giây, mà hồ sơ trạm thì hầu như không đổi giữa các lần quét đó. Giữ lại kết
 * quả trong vài giây cắt gần hết số truy vấn thừa. Đây thuần tuý là bộ đệm:
 * nguồn sự thật vẫn là bảng station_rooms, và mọi thay đổi của Quản trị viên
 * chậm nhất STATION_CACHE_MS là có hiệu lực trên toàn hệ thống.
 */
const STATION_CACHE_MS = 5_000;
let stationCache: { at: number; map: Map<string, StationRow> } | null = null;

export async function stationMapCached(now: number): Promise<Map<string, StationRow>> {
  if (stationCache && now - stationCache.at < STATION_CACHE_MS) return stationCache.map;
  const map = await stationMap();
  stationCache = { at: now, map };
  return map;
}

/** Thời gian đổ chuông đã kẹp trong khoảng cho phép. */
export function ringTimeoutSec(station: StationRow | null | undefined): number {
  const raw = Number(station?.ringTimeoutSec ?? RING_TIMEOUT_DEFAULT);
  if (!Number.isFinite(raw)) return RING_TIMEOUT_DEFAULT;
  return Math.min(RING_TIMEOUT_MAX, Math.max(RING_TIMEOUT_MIN, Math.round(raw)));
}

/** Bản chiếu công khai: KHÔNG kèm liên kết, mã phòng hay mật khẩu Zoom. */
export function publicStation(row: StationRow, now: number, dutyCount: number) {
  const onDutyHours = isWithinDutyHours(row, now);
  return {
    code: row.stationCode,
    name: row.stationName,
    note: row.note || "",
    status: String(row.status || "ACTIVE").toUpperCase(),
    hasZoom: Boolean(row.zoomJoinUrl),
    onDutyHours,
    offHoursMode: String(row.offHoursMode || "SHOW").toUpperCase(),
    dutyCount,
    fallbackStationCode: row.fallbackStationCode || "",
    ringTimeoutSec: ringTimeoutSec(row)
  };
}

/** Bản chiếu cho Quản trị: có liên kết và mã phòng, mật khẩu chỉ báo CÓ hay KHÔNG. */
export function adminStation(row: StationRow) {
  return {
    code: row.stationCode,
    name: row.stationName,
    note: row.note || "",
    zoomJoinUrl: row.zoomJoinUrl || "",
    zoomMeetingId: row.zoomMeetingId || "",
    zoomMeetingIdPretty: formatMeetingId(row.zoomMeetingId || ""),
    hasPasscode: Boolean(row.zoomPasscode),
    zoomHostEmail: row.zoomHostEmail || "",
    fallbackStationCode: row.fallbackStationCode || "",
    ringTimeoutSec: ringTimeoutSec(row),
    dutyHours: row.dutyHours || '{"always":true}',
    offHoursMode: String(row.offHoursMode || "SHOW").toUpperCase(),
    status: String(row.status || "ACTIVE").toUpperCase(),
    displayOrder: Number(row.displayOrder || 0),
    updatedBy: row.updatedBy || "",
    updatedAt: row.updatedAt || null
  };
}

// ---------------------------------------------------------------------------
//  Leo thang
// ---------------------------------------------------------------------------

export type RingPlan = {
  /** Trạm đang được đổ chuông ở thời điểm hiện tại (gốc hoặc dự phòng). */
  stationCode: string;
  /** Vòng leo thang: 0,1,2… trong trạm gốc; -1 nghĩa là đã sang trạm dự phòng. */
  round: number;
  /** Mức ưu tiên cao nhất được phép nhận chuông lúc này (1 = chỉ trực chính). */
  maxPriority: number;
  /** Số giây còn lại trước bước leo thang kế tiếp. */
  remainingSec: number;
  escalated: boolean;
  /** Đã hết mọi vòng ở cả trạm gốc lẫn trạm dự phòng. */
  exhausted: boolean;
};

/**
 * Tính xem một cuộc gọi đang phải đổ chuông ở đâu, cho ai.
 *
 * Cách tính hoàn toàn dựa trên `ringingSince` nên không cần tiến trình nền: mọi
 * lượt quét hàng đợi tự suy ra trạng thái leo thang từ thời gian đã trôi qua.
 * Mốc thời gian là nguồn sự thật, việc ghi `routing_state` chỉ để tra cứu lại.
 */
export function ringPlan(
  originStationCode: string,
  ringingSince: number | null | undefined,
  stations: Map<string, StationRow>,
  now: number
): RingPlan {
  const origin = stations.get(originStationCode) || null;
  const timeout = ringTimeoutSec(origin);
  const elapsed = Math.max(0, Math.floor((now - Number(ringingSince || now)) / 1000));
  const round = Math.floor(elapsed / timeout);
  const fallbackCode = origin?.fallbackStationCode || "";
  const nextStepAt = (round + 1) * timeout;

  // Ba vòng đầu vẫn ở trạm gốc, mỗi vòng mở rộng thêm một mức ưu tiên.
  if (round < MAX_PRIORITY_ROUNDS) {
    return {
      stationCode: originStationCode,
      round,
      maxPriority: round + 1,
      remainingSec: Math.max(0, nextStepAt - elapsed),
      escalated: round > 0,
      exhausted: false
    };
  }

  // Hết vòng ở trạm gốc: chuyển sang trạm dự phòng nếu có cấu hình.
  if (fallbackCode && stations.has(fallbackCode)) {
    const fallbackTimeout = ringTimeoutSec(stations.get(fallbackCode));
    const sinceFallback = elapsed - MAX_PRIORITY_ROUNDS * timeout;
    const fallbackRound = Math.floor(sinceFallback / fallbackTimeout);
    if (fallbackRound < MAX_PRIORITY_ROUNDS) {
      return {
        stationCode: fallbackCode,
        round: -1,
        maxPriority: fallbackRound + 1,
        remainingSec: Math.max(0, (fallbackRound + 1) * fallbackTimeout - sinceFallback),
        escalated: true,
        exhausted: false
      };
    }
  }

  return {
    stationCode: fallbackCode && stations.has(fallbackCode) ? fallbackCode : originStationCode,
    round: -1,
    maxPriority: 99,
    remainingSec: 0,
    escalated: true,
    exhausted: true
  };
}

/** Đọc ngược mã trạm từ quy ước roomId cũ (room-<slug>-<thời điểm>). */
export function stationFromRoomId(roomId: string, codes: Iterable<string>): string {
  const id = String(roomId || "").toLowerCase();
  let best = "";
  for (const code of codes) {
    const slug = String(code).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    if (!slug) continue;
    if (id === `room-${slug}` || id.startsWith(`room-${slug}-`)) {
      if (slug.length > best.length) best = code;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
//  Nhật ký thay đổi cấu hình
// ---------------------------------------------------------------------------

/** Các trường không được ghi giá trị thật vào nhật ký. */
const MASKED_FIELDS = new Set(["zoomPasscode", "zoom_passcode"]);

export async function writeAudit(entries: Array<{
  stationCode: string;
  actorName?: string | null;
  actorUsername?: string | null;
  action: string;
  field?: string | null;
  oldValue?: unknown;
  newValue?: unknown;
}>, now: number) {
  if (!entries.length) return;
  const mask = (field: string | null | undefined, value: unknown) => {
    if (value === undefined || value === null || value === "") return null;
    if (field && MASKED_FIELDS.has(field)) return "••••";
    return String(value).slice(0, 400);
  };
  await db.insert(stationRoomAudits).values(
    entries.map((e) => ({
      stationCode: e.stationCode,
      actorName: e.actorName || null,
      actorUsername: e.actorUsername || null,
      action: e.action,
      field: e.field || null,
      oldValue: mask(e.field, e.oldValue),
      newValue: mask(e.field, e.newValue),
      ts: now
    }))
  );
}
