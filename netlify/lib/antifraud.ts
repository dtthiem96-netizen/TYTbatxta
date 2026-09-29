/**
 * Lõi luật CHỐNG GIAN LẬN chấm công - chấm trực.
 *
 * Tệp này cố ý KHÔNG import cơ sở dữ liệu hay bất kỳ mô-đun nào khác: toàn bộ
 * là hàm thuần (đầu vào → đầu ra), nhờ vậy bộ kiểm thử tools/anti-fraud-tests.mjs
 * chạy thẳng được bằng Node mà không cần máy chủ, và mỗi luật chỉ tồn tại ở một
 * nơi. Các Function (attendance.ts, attendance-security.ts) gọi vào đây, còn
 * phần đọc/ghi dữ liệu nằm ở netlify/lib/security.ts.
 *
 * NGUYÊN TẮC PHÂN LOẠI (yêu cầu 13):
 *   GREEN  - hợp lệ: mọi lớp kiểm tra đều đạt.
 *   YELLOW - cần xem xét: có dấu hiệu bất thường nhưng KHÔNG đủ để kết luận.
 *            Lượt chấm vẫn được ghi, kèm cảnh báo cho người có thẩm quyền.
 *   RED    - từ chối kỹ thuật: vi phạm một điều kiện cứng (ngoài vùng, thiết bị
 *            chưa duyệt, chữ ký sai, QR hết hạn, ảnh dùng lại...). Lượt chấm
 *            KHÔNG được ghi, nhưng lượt thử vẫn nằm trong sổ bằng chứng.
 * Kết quả của AI (so khớp khuôn mặt, kiểm tra động tác) chỉ có thể nâng lên
 * YELLOW, không bao giờ tự nó đẩy lên RED: hệ thống không kết luận gian lận chỉ
 * dựa vào AI.
 */

export type RiskLevel = "GREEN" | "YELLOW" | "RED";

export type RiskReason = {
  code: string;
  level: RiskLevel;
  message: string;
};

const LEVEL_ORDER: Record<RiskLevel, number> = { GREEN: 0, YELLOW: 1, RED: 2 };

/** Mức cao nhất trong danh sách lý do. Không có lý do nào thì GREEN. */
export function combineLevel(reasons: RiskReason[]): RiskLevel {
  let level: RiskLevel = "GREEN";
  for (const r of reasons) if (LEVEL_ORDER[r.level] > LEVEL_ORDER[level]) level = r.level;
  return level;
}

export const reason = (code: string, level: RiskLevel, message: string): RiskReason => ({ code, level, message });

// ---------------------------------------------------------------------------
//  1. Cấu hình an ninh (att_settings, khoá "security")
// ---------------------------------------------------------------------------

export type QrMode = "OFF" | "OPTIONAL" | "REQUIRED";
export type SelfieMode = "OFF" | "OPTIONAL" | "REQUIRED";

export type SecuritySettings = {
  /** Toạ độ Trạm và bán kính cho phép chấm (mét). */
  geofence: { enabled: boolean; lat: number | null; lng: number | null; radiusM: number; maxAccuracyM: number };
  /** Bắt buộc thiết bị đã được Quản trị duyệt. */
  requireDevice: boolean;
  selfieMode: SelfieMode;
  qrMode: QrMode;
  /** Chu kỳ đổi mã QR và thời gian sống của mỗi mã (giây). */
  qrRotateSec: number;
  qrTtlSec: number;
  /** Thời hạn sống của thử thách chấm công (giây). */
  challengeTtlSec: number;
  /** Tốc độ di chuyển tối đa hợp lý giữa hai lượt chấm (km/h). */
  maxSpeedKmh: number;
  /** Ngưỡng tương đồng khuôn mặt (0..1). Dưới ngưỡng → YELLOW. */
  faceMatchThreshold: number;
  /** Dùng AI (Gemini) để đối chiếu selfie với ảnh tham chiếu và động tác liveness. */
  aiFaceCheck: boolean;
  /** Giữ ảnh selfie bao lâu (ngày) trước khi tự xoá. */
  selfieRetentionDays: number;
  /** Nguyên tắc bốn mắt: điều chỉnh do Quản trị lập phải do người khác duyệt. */
  fourEyes: boolean;
  /** Mỗi tài khoản chỉ một phiên đăng nhập; đăng nhập mới đẩy phiên cũ ra. */
  singleSession: boolean;
  /** Lệch đồng hồ thiết bị tối đa trước khi gắn cờ (giây). */
  maxClockSkewSec: number;
  /** Số lượt đề nghị điều chỉnh trong tháng vượt ngưỡng thì cảnh báo. */
  maxAdjustmentsPerMonth: number;
};

export const DEFAULT_SECURITY: SecuritySettings = {
  geofence: { enabled: true, lat: null, lng: null, radiusM: 150, maxAccuracyM: 100 },
  requireDevice: true,
  selfieMode: "REQUIRED",
  qrMode: "OPTIONAL",
  qrRotateSec: 30,
  qrTtlSec: 60,
  challengeTtlSec: 120,
  maxSpeedKmh: 120,
  faceMatchThreshold: 0.6,
  aiFaceCheck: true,
  selfieRetentionDays: 180,
  fourEyes: true,
  singleSession: true,
  maxClockSkewSec: 300,
  maxAdjustmentsPerMonth: 4,
};

const clamp = (n: unknown, min: number, max: number, fallback: number): number => {
  const v = Number(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.min(max, Math.max(min, v));
};
const coord = (n: unknown, limit: number): number | null => {
  if (n === null || n === undefined || n === "") return null;
  const v = Number(n);
  return Number.isFinite(v) && Math.abs(v) <= limit ? v : null;
};
const bool = (v: unknown, fallback: boolean): boolean =>
  v === undefined || v === null ? fallback : v === true || v === "true" || v === 1 || v === "1";
const mode = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T => {
  const s = String(v || "").toUpperCase() as T;
  return allowed.includes(s) ? s : fallback;
};

/** Chuẩn hoá cấu hình đọc từ cơ sở dữ liệu / gửi lên từ giao diện. Không bao giờ ném lỗi. */
export function normalizeSecurity(input: unknown): SecuritySettings {
  const raw = (input && typeof input === "object" ? input : {}) as Record<string, any>;
  const g = (raw.geofence && typeof raw.geofence === "object" ? raw.geofence : {}) as Record<string, unknown>;
  const d = DEFAULT_SECURITY;
  return {
    geofence: {
      enabled: bool(g.enabled, d.geofence.enabled),
      lat: coord(g.lat, 90),
      lng: coord(g.lng, 180),
      radiusM: clamp(g.radiusM, 20, 5000, d.geofence.radiusM),
      maxAccuracyM: clamp(g.maxAccuracyM, 10, 1000, d.geofence.maxAccuracyM),
    },
    requireDevice: bool(raw.requireDevice, d.requireDevice),
    selfieMode: mode(raw.selfieMode, ["OFF", "OPTIONAL", "REQUIRED"] as const, d.selfieMode),
    qrMode: mode(raw.qrMode, ["OFF", "OPTIONAL", "REQUIRED"] as const, d.qrMode),
    qrRotateSec: clamp(raw.qrRotateSec, 10, 300, d.qrRotateSec),
    qrTtlSec: clamp(raw.qrTtlSec, 15, 600, d.qrTtlSec),
    challengeTtlSec: clamp(raw.challengeTtlSec, 30, 600, d.challengeTtlSec),
    maxSpeedKmh: clamp(raw.maxSpeedKmh, 10, 1000, d.maxSpeedKmh),
    faceMatchThreshold: clamp(raw.faceMatchThreshold, 0, 1, d.faceMatchThreshold),
    aiFaceCheck: bool(raw.aiFaceCheck, d.aiFaceCheck),
    selfieRetentionDays: clamp(raw.selfieRetentionDays, 7, 3650, d.selfieRetentionDays),
    fourEyes: bool(raw.fourEyes, d.fourEyes),
    singleSession: bool(raw.singleSession, d.singleSession),
    maxClockSkewSec: clamp(raw.maxClockSkewSec, 30, 86400, d.maxClockSkewSec),
    maxAdjustmentsPerMonth: clamp(raw.maxAdjustmentsPerMonth, 1, 100, d.maxAdjustmentsPerMonth),
  };
}

// ---------------------------------------------------------------------------
//  2. Vị trí: vùng chấm công (geofence) và dấu hiệu giả lập GPS
// ---------------------------------------------------------------------------

/** Khoảng cách mặt đất giữa hai toạ độ (mét), công thức haversine. */
export function haversineM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371008.8;
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLng = (lng2 - lng1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

export type Location = {
  lat: number;
  lng: number;
  accuracy: number;
  /** Thời điểm thiết bị đo vị trí (Position.timestamp), theo đồng hồ thiết bị. */
  positionTs?: number | null;
  altitude?: number | null;
  speed?: number | null;
};

/** Đọc và kiểm tra toạ độ gửi lên. Trả null nếu không hợp lệ. */
export function parseLocation(input: unknown): Location | null {
  if (!input || typeof input !== "object") return null;
  const o = input as Record<string, unknown>;
  const lat = Number(o.lat);
  const lng = Number(o.lng);
  const accuracy = Number(o.accuracy);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  if (!Number.isFinite(accuracy) || accuracy < 0 || accuracy > 100000) return null;
  const optional = (v: unknown) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
  return {
    lat,
    lng,
    accuracy,
    positionTs: optional(o.positionTs),
    altitude: optional(o.altitude),
    speed: optional(o.speed),
  };
}

export type GeofenceResult = {
  configured: boolean;
  distanceM: number | null;
  inside: boolean | null;
  reasons: RiskReason[];
};

/**
 * Máy chủ tự tính khoảng cách tới Trạm - không bao giờ nhận "khoảng cách" hay
 * "trong vùng" từ trình duyệt.
 *
 * Quy tắc: ngoài bán kính (sau khi trừ bớt sai số, tối đa bằng chính bán kính)
 * → RED. Sai số GPS quá lớn → RED, vì với sai số 800 m thì không thể khẳng định
 * người chấm đang ở Trạm. Trạm CHƯA cấu hình toạ độ → YELLOW (vẫn ghi nhận,
 * nhưng cảnh báo Quản trị phải cấu hình), để triển khai không làm tê liệt việc
 * chấm công của cả trạm.
 */
export function checkGeofence(settings: SecuritySettings, loc: Location | null): GeofenceResult {
  const g = settings.geofence;
  if (!g.enabled) {
    return { configured: false, distanceM: null, inside: null, reasons: [] };
  }
  if (!loc) {
    return {
      configured: g.lat !== null && g.lng !== null,
      distanceM: null,
      inside: false,
      reasons: [reason("NO_LOCATION", "RED", "Không lấy được vị trí GPS. Hãy bật định vị và cho phép trình duyệt truy cập vị trí.")],
    };
  }
  if (g.lat === null || g.lng === null) {
    return {
      configured: false,
      distanceM: null,
      inside: null,
      reasons: [reason("GEOFENCE_NOT_CONFIGURED", "YELLOW", "Trạm chưa cấu hình toạ độ chấm công - vị trí được lưu để đối chiếu sau.")],
    };
  }
  const distanceM = Math.round(haversineM(g.lat, g.lng, loc.lat, loc.lng));
  const reasons: RiskReason[] = [];
  if (loc.accuracy > g.maxAccuracyM) {
    reasons.push(
      reason(
        "LOW_ACCURACY",
        "RED",
        `Sai số định vị ${Math.round(loc.accuracy)} m vượt mức cho phép ${g.maxAccuracyM} m. Hãy ra chỗ thoáng và thử lại.`
      )
    );
  }
  // Cho phép bù phần sai số, nhưng không bao giờ quá gấp đôi bán kính.
  const tolerance = Math.min(loc.accuracy, g.radiusM);
  const inside = distanceM - tolerance <= g.radiusM;
  if (!inside) {
    reasons.push(reason("OUTSIDE_GEOFENCE", "RED", `Vị trí cách Trạm ${distanceM} m, ngoài bán kính cho phép ${g.radiusM} m.`));
  } else if (distanceM > g.radiusM) {
    reasons.push(reason("GEOFENCE_EDGE", "YELLOW", `Vị trí ở rìa vùng chấm công (${distanceM} m, bán kính ${g.radiusM} m).`));
  }
  return { configured: true, distanceM, inside, reasons };
}

export type GpsContext = {
  serverTs: number;
  clientTs?: number | null;
  /** Lượt chấm có toạ độ gần nhất trước đó của cùng cán bộ. */
  previous?: { lat: number; lng: number; ts: number } | null;
  /** Các lượt chấm gần đây (của cùng cán bộ) để phát hiện toạ độ lặp y hệt. */
  recentCoords?: { lat: number; lng: number }[];
  /** Mã quốc gia theo IP (header x-nf-geo của Netlify), nếu có. */
  ipCountry?: string | null;
  /** Tín hiệu do trình duyệt tự báo (webdriver, ...) - chỉ để tham khảo, không tin. */
  clientFlags?: Record<string, unknown> | null;
  maxSpeedKmh: number;
  maxClockSkewSec: number;
};

/** Số chữ số thập phân thực có của một toạ độ. */
export function decimals(n: number): number {
  const s = String(n);
  if (s.includes("e-")) return Number(s.split("e-")[1]) || 0;
  const i = s.indexOf(".");
  return i < 0 ? 0 : s.length - i - 1;
}

/**
 * Dấu hiệu vị trí giả (mock location / fake GPS).
 *
 * Trình duyệt không cho biết trực tiếp "đây là vị trí giả", nên máy chủ ghép
 * nhiều tín hiệu gián tiếp. Mỗi tín hiệu riêng lẻ có thể do lỗi thiết bị, vì
 * vậy phần lớn chỉ là YELLOW; riêng "dịch chuyển bất khả thi" và "vị trí quốc
 * gia khác" là mâu thuẫn vật lý nên được coi là RED.
 */
export function gpsSignals(loc: Location | null, ctx: GpsContext): RiskReason[] {
  const out: RiskReason[] = [];
  if (!loc) return out;

  // Ứng dụng giả lập vị trí thường trả sai số tròn trĩnh rất nhỏ (0, 1, 3, 5 m)
  // - thiết bị thật trong nhà gần như không bao giờ đạt dưới 3 m.
  if (loc.accuracy <= 1) {
    out.push(reason("MOCK_ACCURACY", "YELLOW", `Sai số định vị ${loc.accuracy} m bất thường (quá hoàn hảo) - dấu hiệu vị trí giả lập.`));
  }
  // Toạ độ bị làm tròn (≤ 4 chữ số thập phân ~ 11 m) - thường là nhập tay.
  if (decimals(loc.lat) <= 4 && decimals(loc.lng) <= 4) {
    out.push(reason("MOCK_ROUNDED", "YELLOW", "Toạ độ bị làm tròn bất thường - dấu hiệu vị trí nhập tay/giả lập."));
  }
  // Trùng khít tuyệt đối với một lượt chấm trước: GPS thật luôn dao động.
  if ((ctx.recentCoords || []).some((c) => c.lat === loc.lat && c.lng === loc.lng)) {
    out.push(reason("MOCK_IDENTICAL", "YELLOW", "Toạ độ trùng khít tuyệt đối với lượt chấm trước - GPS thật luôn dao động."));
  }
  // Vị trí cũ (đo từ lâu rồi gửi lại) hoặc đo "ở tương lai".
  if (loc.positionTs && ctx.clientTs) {
    const age = ctx.clientTs - loc.positionTs;
    if (age > 2 * 60 * 1000) {
      out.push(reason("STALE_LOCATION", "YELLOW", `Vị trí được đo cách thời điểm chấm ${Math.round(age / 1000)} giây.`));
    } else if (age < -60 * 1000) {
      out.push(reason("FUTURE_LOCATION", "YELLOW", "Thời điểm đo vị trí nằm sau thời điểm chấm - dữ liệu vị trí bị chỉnh sửa."));
    }
  }
  // Đồng hồ thiết bị lệch so với máy chủ: dấu hiệu chỉnh giờ máy để chấm "đúng giờ".
  if (ctx.clientTs) {
    const skew = Math.abs(ctx.clientTs - ctx.serverTs);
    if (skew > ctx.maxClockSkewSec * 1000) {
      out.push(
        reason(
          "CLOCK_SKEW",
          "YELLOW",
          `Đồng hồ thiết bị lệch ${Math.round(skew / 60000)} phút so với máy chủ. Giờ chấm luôn lấy theo máy chủ.`
        )
      );
    }
  }
  // Dịch chuyển bất khả thi (GPS nhảy) giữa hai lượt chấm liên tiếp.
  if (ctx.previous && ctx.previous.ts < ctx.serverTs) {
    const km = haversineM(ctx.previous.lat, ctx.previous.lng, loc.lat, loc.lng) / 1000;
    const hours = (ctx.serverTs - ctx.previous.ts) / 3600000;
    const speed = km / Math.max(hours, 1 / 60);
    if (km > 1 && speed > ctx.maxSpeedKmh) {
      out.push(
        reason(
          "GPS_JUMP",
          "RED",
          `Vị trí nhảy ${km.toFixed(1)} km trong ${Math.max(1, Math.round(hours * 60))} phút (~${Math.round(speed)} km/h) - không thể di chuyển thật.`
        )
      );
    }
  }
  // IP ở nước ngoài trong khi GPS báo đang ở Bát Xát.
  if (ctx.ipCountry && ctx.ipCountry.toUpperCase() !== "VN") {
    out.push(reason("IP_COUNTRY_MISMATCH", "YELLOW", `Địa chỉ mạng thuộc quốc gia ${ctx.ipCountry.toUpperCase()} trong khi GPS báo tại Trạm (VPN/proxy?).`));
  }
  const flags = ctx.clientFlags || {};
  if (flags.webdriver === true) {
    out.push(reason("AUTOMATION", "RED", "Trình duyệt đang bị điều khiển tự động (webdriver)."));
  }
  if (loc.speed !== null && loc.speed !== undefined && loc.speed > 50) {
    out.push(reason("MOVING_FAST", "YELLOW", `Thiết bị báo đang di chuyển ${Math.round(loc.speed * 3.6)} km/h khi chấm.`));
  }
  return out;
}

// ---------------------------------------------------------------------------
//  3. Ca trực qua đêm
// ---------------------------------------------------------------------------

/** Mốc epoch của giờ Việt Nam (UTC+7 cố định). Nhân bản vnEpoch để giữ tệp thuần. */
export function vnEpochPure(dateStr: string, timeStr: string): number {
  const [y, m, d] = dateStr.split("-").map(Number);
  const [h, mi] = timeStr.split(":").map(Number);
  return Date.UTC(y, m - 1, d, h, mi, 0, 0) - 7 * 3600 * 1000;
}

export function addDaysPure(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
}

const minutesOf = (hhmm: string): number => {
  const [h, m] = String(hhmm || "0:0").split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
};

/** Ca có vắt qua nửa đêm không (vd 17:00 → 07:00, hay ca 24 giờ 07:00 → 07:00). */
export function crossesMidnight(start: string, end: string): boolean {
  return minutesOf(end) <= minutesOf(start);
}

/**
 * Khung thời gian tuyệt đối của một ca trực gắn với ngày trực.
 *
 * Ca 17:00-07:00 của ngày 12 kéo dài từ 17:00 ngày 12 đến 07:00 ngày 13; lượt
 * kết ca lúc 06:50 sáng ngày 13 vẫn thuộc NGÀY TRỰC 12. Nhận ca được phép sớm
 * earlyMin phút và muộn tới lateMin phút (mặc định: tới giữa ca).
 */
export function dutyWindow(dutyDate: string, start: string, end: string) {
  const startAt = vnEpochPure(dutyDate, start);
  const endDate = crossesMidnight(start, end) ? addDaysPure(dutyDate, 1) : dutyDate;
  const endAt = vnEpochPure(endDate, end);
  return { startAt, endAt, endDate, overnight: endDate !== dutyDate };
}

/**
 * Lượt NHẬN ca có nằm trong khung cho phép không.
 * Sớm tối đa earlyMin phút trước giờ bắt đầu, muộn tối đa tới nửa thời lượng ca.
 */
export function checkInAllowed(now: number, dutyDate: string, start: string, end: string, earlyMin = 60) {
  const w = dutyWindow(dutyDate, start, end);
  const openAt = w.startAt - earlyMin * 60000;
  const closeAt = w.startAt + Math.max(60 * 60000, (w.endAt - w.startAt) / 2);
  return { ok: now >= openAt && now <= closeAt, openAt, closeAt, window: w };
}

/**
 * Lượt KẾT ca: chỉ sau khi đã nhận ca, và không muộn hơn giờ kết thúc quá
 * graceMin phút (quá mức đó phải đi luồng điều chỉnh có duyệt).
 */
export function checkOutAllowed(now: number, dutyDate: string, start: string, end: string, graceMin = 240) {
  const w = dutyWindow(dutyDate, start, end);
  return { ok: now <= w.endAt + graceMin * 60000, early: now < w.endAt - 30 * 60000, window: w };
}

// ---------------------------------------------------------------------------
//  4. Ảnh selfie: dấu vân tay ảnh và vector đặc trưng
// ---------------------------------------------------------------------------

/** Ảnh xám đã thu nhỏ. */
export type Gray = { width: number; height: number; data: Float64Array };

/** Đổi dữ liệu RGBA thành ảnh xám (luma BT.601). */
export function toGray(width: number, height: number, rgba: ArrayLike<number>): Gray {
  const data = new Float64Array(width * height);
  for (let i = 0, p = 0; i < data.length; i++, p += 4) {
    data[i] = 0.299 * rgba[p] + 0.587 * rgba[p + 1] + 0.114 * rgba[p + 2];
  }
  return { width, height, data };
}

/** Thu nhỏ bằng trung bình vùng (box filter) về w×h, trên một khung cắt tuỳ chọn. */
export function resizeGray(
  img: Gray,
  w: number,
  h: number,
  crop: { x: number; y: number; width: number; height: number } = { x: 0, y: 0, width: img.width, height: img.height }
): Gray {
  const out = new Float64Array(w * h);
  for (let ty = 0; ty < h; ty++) {
    const y0 = crop.y + Math.floor((ty * crop.height) / h);
    const y1 = Math.max(y0 + 1, crop.y + Math.floor(((ty + 1) * crop.height) / h));
    for (let tx = 0; tx < w; tx++) {
      const x0 = crop.x + Math.floor((tx * crop.width) / w);
      const x1 = Math.max(x0 + 1, crop.x + Math.floor(((tx + 1) * crop.width) / w));
      let sum = 0;
      let n = 0;
      for (let y = y0; y < y1 && y < img.height; y++) {
        for (let x = x0; x < x1 && x < img.width; x++) {
          sum += img.data[y * img.width + x];
          n++;
        }
      }
      out[ty * w + tx] = n ? sum / n : 0;
    }
  }
  return { width: w, height: h, data: out };
}

/** Khung vuông ở giữa ảnh (vùng khuôn mặt trong khung ngắm selfie), cạnh = ratio × cạnh ngắn. */
export function centerSquare(img: { width: number; height: number }, ratio = 0.7) {
  const side = Math.max(1, Math.floor(Math.min(img.width, img.height) * ratio));
  return { x: Math.floor((img.width - side) / 2), y: Math.floor((img.height - side) / 2), width: side, height: side };
}

/**
 * dHash 64 bit (chuỗi hex 16 ký tự): so từng điểm ảnh với điểm bên phải trên
 * lưới 9×8. Hai ảnh gần như giống nhau (cùng một tấm chụp, nén lại, đổi cỡ) có
 * khoảng cách Hamming nhỏ - dùng để bắt "chụp lại ảnh cũ / ảnh có sẵn".
 */
export function dHash(img: Gray): string {
  const small = resizeGray(img, 9, 8);
  let hex = "";
  for (let y = 0; y < 8; y++) {
    let byte = 0;
    for (let x = 0; x < 8; x++) {
      byte = (byte << 1) | (small.data[y * 9 + x] > small.data[y * 9 + x + 1] ? 1 : 0);
    }
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}

/** Khoảng cách Hamming giữa hai dHash hex. */
export function hamming(a: string, b: string): number {
  if (!a || !b || a.length !== b.length) return 64;
  let d = 0;
  for (let i = 0; i < a.length; i += 2) {
    let x = parseInt(a.slice(i, i + 2), 16) ^ parseInt(b.slice(i, i + 2), 16);
    while (x) {
      d += x & 1;
      x >>= 1;
    }
  }
  return d;
}

/** Độ tương phản (độ lệch chuẩn) - ảnh gần như một màu là ảnh bịt camera / màn hình đen. */
export function contrast(img: Gray): number {
  let sum = 0;
  for (const v of img.data) sum += v;
  const mean = sum / img.data.length;
  let sq = 0;
  for (const v of img.data) sq += (v - mean) ** 2;
  return Math.sqrt(sq / img.data.length);
}

/**
 * Vector đặc trưng khuôn mặt (sinh trắc học mức cơ bản).
 *
 * Vùng giữa khung ngắm → 32×32 xám → cân bằng (trừ trung bình, chia chuẩn) →
 * 1024 số. So sánh bằng cosine. Đây KHÔNG phải nhận dạng khuôn mặt chính xác:
 * nó phát hiện được việc thay người rõ rệt hoặc đưa ảnh khác vào khung, và
 * luôn chỉ cho ra YELLOW - người có thẩm quyền xem ảnh mới kết luận.
 */
export function faceVector(img: Gray): number[] {
  const small = resizeGray(img, 32, 32, centerSquare(img));
  let mean = 0;
  for (const v of small.data) mean += v;
  mean /= small.data.length;
  let norm = 0;
  const out = new Array<number>(small.data.length);
  for (let i = 0; i < small.data.length; i++) {
    out[i] = small.data[i] - mean;
    norm += out[i] * out[i];
  }
  norm = Math.sqrt(norm) || 1;
  return out.map((v) => Math.round((v / norm) * 10000) / 10000);
}

/** Độ tương đồng cosine, quy về 0..1. */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (!a.length || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (!na || !nb) return 0;
  return Math.max(0, Math.min(1, (dot / Math.sqrt(na * nb) + 1) / 2));
}

/** Kiểm tra định dạng JPEG (FF D8 FF) - chặn gửi tệp tuỳ ý thay ảnh. */
export function isJpeg(bytes: Uint8Array): boolean {
  return bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

/**
 * Ảnh "chụp trực tiếp" từ camera trong trình duyệt được vẽ lại qua canvas nên
 * KHÔNG có EXIF. Ảnh lấy từ thư viện / chụp bằng ứng dụng camera thường mang
 * khối APP1 "Exif" (hãng máy, ngày chụp). Có EXIF → dấu hiệu ảnh có sẵn.
 */
export function hasExif(bytes: Uint8Array): boolean {
  const limit = Math.min(bytes.length - 10, 65536);
  for (let i = 2; i < limit; i++) {
    if (bytes[i] === 0xff && bytes[i + 1] === 0xe1) {
      const tag = String.fromCharCode(bytes[i + 4], bytes[i + 5], bytes[i + 6], bytes[i + 7]);
      if (tag === "Exif") return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
//  5. Thử thách liveness và tiện ích mã hoá
// ---------------------------------------------------------------------------

export const LIVENESS_CHALLENGES = [
  { code: "TURN_LEFT", label: "Quay mặt sang TRÁI" },
  { code: "TURN_RIGHT", label: "Quay mặt sang PHẢI" },
  { code: "SMILE", label: "MỈM CƯỜI" },
  { code: "LOOK_UP", label: "NGẨNG ĐẦU lên" },
  { code: "OPEN_MOUTH", label: "HÁ MIỆNG" },
] as const;

export function pickChallenge(random: number = Math.random()) {
  return LIVENESS_CHALLENGES[Math.floor(random * LIVENESS_CHALLENGES.length) % LIVENESS_CHALLENGES.length];
}

export function base64UrlToBytes(input: string): Uint8Array {
  const clean = String(input || "").replace(/-/g, "+").replace(/_/g, "/");
  const padded = clean.padEnd(Math.ceil(clean.length / 4) * 4, "=");
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToHex(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (const b of arr) s += b.toString(16).padStart(2, "0");
  return s;
}

export async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  return bytesToHex(await crypto.subtle.digest("SHA-256", bytes as BufferSource));
}

/** Chuỗi ngẫu nhiên an toàn mật mã (base64url). */
export function randomToken(bytes = 24): string {
  const arr = crypto.getRandomValues(new Uint8Array(bytes));
  let bin = "";
  for (const b of arr) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Chuỗi được thiết bị ký cho mỗi lượt chấm. Gắn chặt nonce một lần của máy
 * chủ với loại thao tác và toạ độ: kẻ nghe lén không dùng lại chữ ký cho lượt
 * khác, cũng không sửa toạ độ sau khi đã ký.
 */
export function signingPayload(p: {
  nonce: string;
  action: string;
  type?: string | null;
  lat?: number | null;
  lng?: number | null;
  selfieSha256?: string | null;
}): string {
  return [p.nonce, p.action, p.type || "", p.lat ?? "", p.lng ?? "", p.selfieSha256 || ""].join("|");
}

/**
 * Kiểm tra chữ ký ECDSA P-256 / SHA-256 (định dạng IEEE P1363 mà WebCrypto
 * trình duyệt tạo ra) bằng khoá công khai JWK của thiết bị.
 */
export async function verifyDeviceSignature(publicJwk: string, payload: string, signatureB64u: string): Promise<boolean> {
  try {
    const jwk = JSON.parse(publicJwk);
    if (!jwk || jwk.kty !== "EC" || jwk.crv !== "P-256" || jwk.d) return false;
    const key = await crypto.subtle.importKey(
      "jwk",
      { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y, ext: true },
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"]
    );
    return await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      base64UrlToBytes(signatureB64u) as BufferSource,
      new TextEncoder().encode(payload)
    );
  } catch {
    return false;
  }
}

/** Dấu vân tay của khoá công khai thiết bị (sha256 của x|y). */
export async function deviceHashOf(publicJwk: string): Promise<string | null> {
  try {
    const jwk = JSON.parse(publicJwk);
    if (!jwk || jwk.kty !== "EC" || jwk.crv !== "P-256" || !jwk.x || !jwk.y || jwk.d) return null;
    return await sha256Hex(`${jwk.x}|${jwk.y}`);
  } catch {
    return null;
  }
}
