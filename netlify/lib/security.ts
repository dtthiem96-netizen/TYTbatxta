/**
 * Lớp dữ liệu CHỐNG GIAN LẬN: đọc/ghi các bảng an ninh, kho ảnh selfie riêng tư
 * trên Netlify Blobs, và các phép kiểm tra cần cơ sở dữ liệu (ảnh dùng lại, thiết
 * bị dùng chung, chấm dồn dập...). Luật thuần nằm ở netlify/lib/antifraud.ts.
 */
import { getStore } from "@netlify/blobs";
import jpeg from "jpeg-js";
import { db } from "../../db/index.js";
import {
  attAdjustments,
  attAlerts,
  attAttempts,
  attDevices,
  attEmployees,
  attFaceTemplates,
  attNonces,
  attQrTokens,
  attRequests,
  attSettings,
} from "../../db/schema.js";
import { and, desc, eq, gt, gte, isNull, ne, sql } from "drizzle-orm";
import {
  DEFAULT_SECURITY,
  centerSquare,
  contrast,
  cosineSimilarity,
  dHash,
  faceVector,
  hamming,
  hasExif,
  isJpeg,
  normalizeSecurity,
  randomToken,
  reason,
  resizeGray,
  sha256Hex,
  toGray,
  type RiskLevel,
  type RiskReason,
  type SecuritySettings,
} from "./antifraud.js";
import { vnDate, type ActorContext } from "./attendance.js";
import { getGoogleAiClient, resolveGoogleAiConnection, DEFAULT_GEMINI_MODEL } from "./google-ai.js";

export const SECURITY_SETTING_KEY = "security";
/** Kho ảnh selfie. Blobs không có đường công khai: chỉ Function đã kiểm quyền mới đọc được. */
export const SELFIE_STORE = "attendance-selfies";

export type AttemptRow = typeof attAttempts.$inferSelect;
export type DeviceRow = typeof attDevices.$inferSelect;
export type AlertRow = typeof attAlerts.$inferSelect;

// ---------------------------------------------------------------------------
//  Cấu hình
// ---------------------------------------------------------------------------

export async function getSecurity(): Promise<SecuritySettings> {
  try {
    const rows = await db.select().from(attSettings).where(eq(attSettings.id, SECURITY_SETTING_KEY));
    if (!rows.length || !rows[0].value) return normalizeSecurity(DEFAULT_SECURITY);
    return normalizeSecurity(JSON.parse(rows[0].value));
  } catch {
    return normalizeSecurity(DEFAULT_SECURITY);
  }
}

export async function saveSecurity(value: SecuritySettings, actor: ActorContext): Promise<void> {
  const payload = JSON.stringify(value);
  const now = Date.now();
  await db
    .insert(attSettings)
    .values({ id: SECURITY_SETTING_KEY, value: payload, updatedBy: actor.user.id, updatedAt: now })
    .onConflictDoUpdate({ target: attSettings.id, set: { value: payload, updatedBy: actor.user.id, updatedAt: now } });
}

// ---------------------------------------------------------------------------
//  Cảnh báo
// ---------------------------------------------------------------------------

export type AlertInput = {
  level: Exclude<RiskLevel, "GREEN">;
  category: string;
  title: string;
  cause: string;
  employeeId?: string | null;
  userId?: string | null;
  deviceHash?: string | null;
  attemptId?: number | null;
  evidence?: unknown;
  /** Cùng dedupeKey chỉ sinh một cảnh báo. Mặc định: loại + người + ngày. */
  dedupeKey?: string | null;
};

/** Sinh cảnh báo. Không bao giờ ném lỗi ra ngoài. */
export async function raiseAlert(a: AlertInput): Promise<void> {
  const day = vnDate();
  const dedupeKey =
    a.dedupeKey === null ? null : a.dedupeKey || `${a.category}|${a.employeeId || a.userId || a.deviceHash || "-"}|${day}`;
  try {
    await db
      .insert(attAlerts)
      .values({
        level: a.level,
        category: a.category,
        employeeId: a.employeeId || null,
        userId: a.userId || null,
        deviceHash: a.deviceHash || null,
        attemptId: a.attemptId || null,
        title: a.title.slice(0, 200),
        cause: a.cause.slice(0, 1000),
        evidence: a.evidence === undefined ? null : JSON.stringify(a.evidence).slice(0, 8000),
        day,
        createdAt: Date.now(),
        status: "OPEN",
        dedupeKey,
      })
      .onConflictDoNothing();
  } catch (err) {
    console.warn("[security] Không ghi được cảnh báo:", err);
  }
}

/** Nhãn tiếng Việt của từng loại cảnh báo (dùng cho bảng điều khiển). */
export const ALERT_CATEGORIES: Record<string, string> = {
  OUTSIDE_GEOFENCE: "Ngoài vùng chấm công",
  GEOFENCE_EDGE: "Ở rìa vùng chấm công",
  GEOFENCE_NOT_CONFIGURED: "Chưa cấu hình vùng chấm công",
  LOW_ACCURACY: "Định vị kém chính xác",
  NO_LOCATION: "Không có vị trí",
  MOCK_ACCURACY: "Nghi vị trí giả",
  MOCK_ROUNDED: "Nghi vị trí giả",
  MOCK_IDENTICAL: "Nghi vị trí giả",
  GPS_JUMP: "Vị trí nhảy bất thường",
  STALE_LOCATION: "Vị trí cũ",
  FUTURE_LOCATION: "Vị trí bị chỉnh",
  CLOCK_SKEW: "Đồng hồ thiết bị bị chỉnh",
  IP_COUNTRY_MISMATCH: "IP bất thường",
  AUTOMATION: "Trình duyệt tự động hoá",
  MOVING_FAST: "Đang di chuyển nhanh",
  DEVICE_UNREGISTERED: "Thiết bị lạ",
  DEVICE_PENDING: "Thiết bị chờ duyệt",
  DEVICE_REVOKED: "Thiết bị bị thu hồi",
  DEVICE_SIGNATURE: "Chữ ký thiết bị sai",
  SHARED_DEVICE: "Một thiết bị nhiều tài khoản",
  MANY_DEVICES: "Một tài khoản nhiều thiết bị",
  SELFIE_MISSING: "Thiếu ảnh selfie",
  SELFIE_INVALID: "Ảnh selfie không hợp lệ",
  SELFIE_REUSED: "Dùng lại ảnh cũ",
  SELFIE_NEAR_DUPLICATE: "Ảnh gần trùng ảnh cũ",
  SELFIE_EXIF: "Ảnh có sẵn (không chụp trực tiếp)",
  SELFIE_DARK: "Ảnh tối / che camera",
  LIVENESS_STATIC: "Nghi dùng ảnh tĩnh",
  LIVENESS_FAIL: "Không đạt kiểm tra người thật",
  FACE_MISMATCH: "Khuôn mặt khác ảnh mẫu",
  FACE_NO_TEMPLATE: "Chưa có ảnh mẫu",
  QR_MISSING: "Thiếu mã QR",
  QR_INVALID: "Mã QR sai / hết hạn / đã dùng",
  NONCE_INVALID: "Thử thách hết hạn / dùng lại",
  DUPLICATE: "Chấm trùng",
  NO_OPEN_IN: "Chấm ra không có chấm vào",
  OUTSIDE_SHIFT: "Ngoài giờ / ngoài ca",
  NO_ROSTER: "Không có lịch trực",
  SELF_DUTY_PENDING: "Ca tự nhận chờ duyệt",
  REPEATED_ATTEMPTS: "Chấm lặp nhiều lần",
  EXCESSIVE_ADJUSTMENTS: "Điều chỉnh quá nhiều",
  ADMIN_ADJUSTMENT: "Quản trị điều chỉnh dữ liệu",
  CONCURRENT_LOGIN: "Đăng nhập đồng thời",
  SESSION_HIJACK: "Phiên bất thường",
  OFFLINE_SYNC: "Chấm ngoại tuyến đồng bộ lại",
  RATE_LIMIT: "Gọi API dồn dập",
  LOGIN_BRUTEFORCE: "Dò mật khẩu",
  EARLY_CHECKOUT: "Kết ca trực sớm",
  DEVICE_REGISTER: "Đăng ký thiết bị",
  SELF_APPROVAL: "Tự duyệt dữ liệu của mình",
};

// ---------------------------------------------------------------------------
//  Sổ bằng chứng
// ---------------------------------------------------------------------------

export type AttemptInput = Omit<typeof attAttempts.$inferInsert, "id" | "createdAt" | "reasons"> & {
  reasons: RiskReason[];
};

/**
 * Ghi một lượt thử vào sổ bằng chứng. Lỗi ở đây LÀM THẤT BẠI lượt chấm: không
 * có bằng chứng thì không có lượt chấm.
 */
export async function recordAttempt(a: AttemptInput): Promise<number> {
  const rows = await db
    .insert(attAttempts)
    .values({ ...a, reasons: JSON.stringify(a.reasons), createdAt: Date.now() })
    .returning({ id: attAttempts.id });
  return rows[0].id;
}

/**
 * Sinh cảnh báo cho một lượt thử có mức YELLOW/RED: một cảnh báo cho lý do
 * nặng nhất (theo người + loại + ngày, nên chấm lại nhiều lần không làm ngập
 * danh sách cảnh báo).
 */
export async function alertForAttempt(p: {
  attemptId: number;
  level: RiskLevel;
  reasons: RiskReason[];
  employeeId: string | null;
  userId: string;
  deviceHash?: string | null;
  kindLabel: string;
  evidence: Record<string, unknown>;
}): Promise<void> {
  if (p.level === "GREEN") return;
  const worst = p.reasons.filter((r) => r.level === p.level);
  if (!worst.length) return;
  const primary = worst[0];
  await raiseAlert({
    level: p.level,
    category: primary.code,
    employeeId: p.employeeId,
    userId: p.userId,
    deviceHash: p.deviceHash || null,
    attemptId: p.attemptId,
    title: `${p.kindLabel}: ${ALERT_CATEGORIES[primary.code] || primary.code}`,
    cause: worst.map((r) => r.message).join(" "),
    evidence: { attemptId: p.attemptId, reasons: p.reasons, ...p.evidence },
  });
}

// ---------------------------------------------------------------------------
//  Thử thách dùng một lần (nonce)
// ---------------------------------------------------------------------------

export async function issueNonce(actor: ActorContext, purpose: string, ttlSec: number, challenge: string | null) {
  const now = Date.now();
  const id = randomToken(24);
  await db.insert(attNonces).values({
    id,
    userId: actor.user.id,
    employeeId: actor.employee?.id || null,
    purpose,
    challenge,
    issuedAt: now,
    expiresAt: now + ttlSec * 1000,
    ip: actor.ip || null,
  });
  // Dọn thử thách quá hạn từ lâu (bảng này không phải sổ bằng chứng).
  db.delete(attNonces)
    .where(sql`${attNonces.expiresAt} < ${now - 24 * 3600 * 1000}`)
    .catch(() => undefined);
  return { id, expiresAt: now + ttlSec * 1000 };
}

/**
 * Tiêu thụ nonce NGUYÊN TỬ: một câu UPDATE ... WHERE used_at IS NULL AND chưa
 * hết hạn ... RETURNING. Hai yêu cầu cùng dùng một nonce thì chỉ một bên thắng.
 */
export async function consumeNonce(id: string, userId: string, purpose: string) {
  if (!id) return null;
  const now = Date.now();
  const rows = await db
    .update(attNonces)
    .set({ usedAt: now })
    .where(
      and(
        eq(attNonces.id, id),
        eq(attNonces.userId, userId),
        eq(attNonces.purpose, purpose),
        isNull(attNonces.usedAt),
        gt(attNonces.expiresAt, now)
      )
    )
    .returning();
  return rows[0] || null;
}

// ---------------------------------------------------------------------------
//  QR động
// ---------------------------------------------------------------------------

const QR_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

export function qrPayload(code: string) {
  return `TYTBX-CC:${code}`;
}

/** Tách mã từ nội dung QR quét được hoặc từ mã gõ tay. */
export function parseQrInput(value: unknown): string {
  const s = String(value || "").trim().toUpperCase();
  const m = /^TYTBX-CC:([A-Z0-9]{8,32})$/.exec(s);
  if (m) return m[1];
  return /^[A-Z0-9]{8,32}$/.test(s) ? s : "";
}

/** Phát mã QR mới cho màn hình tại Trạm. Máy chủ chỉ giữ dấu băm của mã. */
export async function issueQr(actor: ActorContext, ttlSec: number) {
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  let code = "";
  for (const b of bytes) code += QR_ALPHABET[b % QR_ALPHABET.length];
  const now = Date.now();
  const id = `qr-${now.toString(36)}-${randomToken(4)}`;
  await db.insert(attQrTokens).values({
    id,
    codeHash: await sha256Hex(`qr|${code}`),
    issuedBy: actor.user.id,
    issuedAt: now,
    expiresAt: now + ttlSec * 1000,
  });
  db.delete(attQrTokens)
    .where(sql`${attQrTokens.expiresAt} < ${now - 7 * 24 * 3600 * 1000}`)
    .catch(() => undefined);
  return { id, code, payload: qrPayload(code), issuedAt: now, expiresAt: now + ttlSec * 1000 };
}

/** Tiêu thụ mã QR nguyên tử. Trả null nếu sai, hết hạn hoặc đã dùng. */
export async function consumeQr(code: string, employeeId: string) {
  if (!code) return null;
  const now = Date.now();
  const rows = await db
    .update(attQrTokens)
    .set({ usedAt: now, usedByEmployeeId: employeeId })
    .where(
      and(eq(attQrTokens.codeHash, await sha256Hex(`qr|${code}`)), isNull(attQrTokens.usedAt), gt(attQrTokens.expiresAt, now))
    )
    .returning();
  return rows[0] || null;
}

export async function qrStatus(id: string) {
  const rows = await db.select().from(attQrTokens).where(eq(attQrTokens.id, id));
  return rows[0] || null;
}

// ---------------------------------------------------------------------------
//  Ảnh selfie
// ---------------------------------------------------------------------------

export const MAX_SELFIE_BYTES = 700 * 1024;

export type SelfieAnalysis = {
  bytes: Uint8Array;
  sha256: string;
  dhash: string;
  vector: number[];
  contrast: number;
  exif: boolean;
  width: number;
  height: number;
};

/** Giải mã chuỗi base64 (có thể kèm tiền tố data:image/jpeg;base64,). */
export function decodeImageBase64(input: unknown): Uint8Array | null {
  const s = String(input || "");
  if (!s) return null;
  const b64 = s.includes(",") ? s.slice(s.indexOf(",") + 1) : s;
  if (b64.length > MAX_SELFIE_BYTES * 1.4) return null;
  try {
    return new Uint8Array(Buffer.from(b64, "base64"));
  } catch {
    return null;
  }
}

/**
 * Phân tích ảnh selfie Ở MÁY CHỦ: tự giải mã JPEG, tự tính dấu băm và vector.
 * Không nhận bất kỳ "kết quả nhận diện" nào từ trình duyệt.
 */
export async function analyzeSelfie(bytes: Uint8Array | null): Promise<SelfieAnalysis | { error: RiskReason }> {
  if (!bytes || !bytes.length) return { error: reason("SELFIE_MISSING", "RED", "Chưa có ảnh selfie chụp trực tiếp.") };
  if (bytes.length > MAX_SELFIE_BYTES || !isJpeg(bytes)) {
    return { error: reason("SELFIE_INVALID", "RED", "Ảnh selfie không đúng định dạng JPEG hoặc quá lớn.") };
  }
  let decoded: { width: number; height: number; data: Uint8Array };
  try {
    decoded = jpeg.decode(bytes, { useTArray: true, formatAsRGBA: true, maxResolutionInMP: 4, maxMemoryUsageInMB: 96 });
  } catch {
    return { error: reason("SELFIE_INVALID", "RED", "Không đọc được ảnh selfie.") };
  }
  if (decoded.width < 160 || decoded.height < 160) {
    return { error: reason("SELFIE_INVALID", "RED", "Ảnh selfie quá nhỏ.") };
  }
  const gray = toGray(decoded.width, decoded.height, decoded.data);
  const face = resizeGray(gray, 64, 64, centerSquare(gray));
  return {
    bytes,
    sha256: await sha256Hex(bytes),
    dhash: dHash(face),
    vector: faceVector(gray),
    contrast: Math.round(contrast(face) * 10) / 10,
    exif: hasExif(bytes),
    width: decoded.width,
    height: decoded.height,
  };
}

function selfieStore() {
  return getStore({ name: SELFIE_STORE, consistency: "strong" });
}

export async function storeSelfie(key: string, bytes: Uint8Array, metadata: Record<string, string | number>) {
  await selfieStore().set(key, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, {
    metadata,
  });
}

export async function readSelfie(key: string): Promise<ArrayBuffer | null> {
  try {
    return (await selfieStore().get(key, { type: "arrayBuffer" })) as ArrayBuffer | null;
  } catch {
    return null;
  }
}

/** Xoá ảnh quá hạn lưu trữ (tối thiểu hoá dữ liệu). Trả về số ảnh đã xoá. */
export async function purgeExpiredSelfies(retentionDays: number): Promise<number> {
  const store = selfieStore();
  const cutoff = Date.now() - retentionDays * 24 * 3600 * 1000;
  let removed = 0;
  const { blobs } = await store.list({ prefix: "att/" });
  for (const b of blobs) {
    // Khoá có dạng att/<yyyy-mm-dd>/...; ảnh tham chiếu (ref/) không bị xoá tự động.
    const day = b.key.split("/")[1] || "";
    const ts = Date.parse(`${day}T00:00:00+07:00`);
    if (Number.isFinite(ts) && ts < cutoff) {
      await store.delete(b.key);
      removed++;
    }
  }
  return removed;
}

/**
 * Các kiểm tra ảnh cần lịch sử: ảnh trùng tuyệt đối với bất kỳ lượt nào trước
 * đó (dùng lại ảnh cũ → RED), ảnh gần trùng ảnh của chính người đó (→ YELLOW),
 * hai khung hình (bình thường / làm động tác) gần như y hệt (ảnh tĩnh → YELLOW).
 */
export async function selfieHistoryChecks(
  employeeId: string,
  primary: SelfieAnalysis,
  action: SelfieAnalysis | null,
  challengeCode: string | null
): Promise<RiskReason[]> {
  const out: RiskReason[] = [];
  if (primary.exif) out.push(reason("SELFIE_EXIF", "YELLOW", "Ảnh mang dữ liệu EXIF của máy ảnh - không giống ảnh chụp trực tiếp trong ứng dụng."));
  if (primary.contrast < 8) out.push(reason("SELFIE_DARK", "YELLOW", "Ảnh selfie gần như một màu (tối/che camera)."));

  const reused = await db
    .select({ id: attAttempts.id })
    .from(attAttempts)
    .where(eq(attAttempts.selfieSha256, primary.sha256))
    .limit(1);
  if (reused.length) {
    out.push(reason("SELFIE_REUSED", "RED", `Ảnh selfie trùng tuyệt đối với ảnh đã dùng ở lượt #${reused[0].id} - không phải ảnh chụp mới.`));
  }

  const recent = await db
    .select({ id: attAttempts.id, dhash: attAttempts.selfieDhash })
    .from(attAttempts)
    .where(and(eq(attAttempts.employeeId, employeeId), sql`${attAttempts.selfieDhash} is not null`))
    .orderBy(desc(attAttempts.serverTs))
    .limit(60);
  const near = recent.find((r) => r.dhash && hamming(r.dhash, primary.dhash) <= 2);
  if (near && !reused.length) {
    out.push(reason("SELFIE_NEAR_DUPLICATE", "YELLOW", `Ảnh selfie gần như trùng ảnh ở lượt #${near.id}.`));
  }

  if (challengeCode && action) {
    if (action.sha256 === primary.sha256 || hamming(action.dhash, primary.dhash) <= 1) {
      out.push(reason("LIVENESS_STATIC", "YELLOW", "Hai khung hình (bình thường và khi làm động tác) gần như giống hệt - nghi dùng ảnh tĩnh."));
    }
  } else if (challengeCode && !action) {
    out.push(reason("LIVENESS_FAIL", "YELLOW", "Thiếu khung hình làm động tác kiểm tra người thật."));
  }
  return out;
}

/** So vector ảnh với mẫu đã đăng ký. Không có mẫu → null. */
export async function compareWithTemplate(employeeId: string, vector: number[]) {
  const rows = await db.select().from(attFaceTemplates).where(eq(attFaceTemplates.employeeId, employeeId));
  const tpl = rows[0];
  if (!tpl || String(tpl.status || "ACTIVE") !== "ACTIVE") return null;
  try {
    const ref = JSON.parse(tpl.vector) as number[];
    return { score: Math.round(cosineSimilarity(ref, vector) * 1000) / 1000, referenceKey: tpl.referenceKey };
  } catch {
    return null;
  }
}

/** Lưu (thay) mẫu khuôn mặt của cán bộ từ ảnh của một lượt thử đã có. */
export async function enrollTemplate(p: {
  employeeId: string;
  vector: number[];
  dhash: string;
  referenceKey: string | null;
  sourceAttemptId: number | null;
  actor: ActorContext;
}) {
  const values = {
    employeeId: p.employeeId,
    vector: JSON.stringify(p.vector),
    dhash: p.dhash,
    referenceKey: p.referenceKey,
    sourceAttemptId: p.sourceAttemptId,
    enrolledBy: p.actor.user.id,
    enrolledByName: p.actor.employee?.fullName || p.actor.user.name,
    enrolledAt: Date.now(),
    status: "ACTIVE",
  };
  await db.insert(attFaceTemplates).values(values).onConflictDoUpdate({ target: attFaceTemplates.employeeId, set: values });
}

/**
 * Hỏi Gemini (qua Netlify AI Gateway) hai câu: ảnh chụp có cùng người với ảnh
 * mẫu không, và khung hình thứ hai có đúng động tác được yêu cầu không.
 *
 * Kết quả CHỈ LÀ THAM KHẢO: không đạt → YELLOW để người thật xem ảnh; lỗi/hết
 * giờ → bỏ qua (không bao giờ chặn chấm công vì AI không trả lời).
 */
export async function aiFaceCheck(p: {
  reference: Uint8Array | null;
  neutral: Uint8Array;
  action: Uint8Array | null;
  challengeLabel: string | null;
}): Promise<{ sameperson: string; liveness: string; note: string } | null> {
  try {
    const conn = resolveGoogleAiConnection();
    if (!conn.configured) return null;
    const ai = getGoogleAiClient(conn);
    const parts: any[] = [];
    const b64 = (u: Uint8Array) => Buffer.from(u).toString("base64");
    if (p.reference) {
      parts.push("ẢNH MẪU (đăng ký):");
      parts.push({ inlineData: { mimeType: "image/jpeg", data: b64(p.reference) } });
    }
    parts.push("ẢNH 1 (chụp lúc chấm, mặt bình thường):");
    parts.push({ inlineData: { mimeType: "image/jpeg", data: b64(p.neutral) } });
    if (p.action) {
      parts.push(`ẢNH 2 (chụp lúc chấm, được yêu cầu: ${p.challengeLabel || "làm động tác"}):`);
      parts.push({ inlineData: { mimeType: "image/jpeg", data: b64(p.action) } });
    }
    parts.push(
      'Trả JSON: {"sameperson":"YES|NO|UNSURE","liveness":"PASS|FAIL|UNSURE","note":"<tối đa 30 từ tiếng Việt>"}. ' +
        "sameperson: ẢNH 1 có cùng một người với ẢNH MẪU không (UNSURE nếu không có ảnh mẫu). " +
        "liveness: ẢNH 1 và ẢNH 2 có phải chụp trực tiếp một người thật (không phải chụp lại màn hình/ảnh in) và ẢNH 2 có làm đúng động tác không."
    );
    const call = ai.models.generateContent({
      model: conn.model || DEFAULT_GEMINI_MODEL,
      contents: [{ role: "user", parts: parts.map((x) => (typeof x === "string" ? { text: x } : x)) }],
      config: {
        systemInstruction:
          "Bạn là công cụ hỗ trợ kiểm tra ảnh chấm công. Chỉ mô tả điều quan sát được, không kết luận gian lận. Trả đúng JSON.",
        responseMimeType: "application/json",
      },
    });
    const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), 9000));
    const res = (await Promise.race([call, timeout])) as { text?: string } | null;
    if (!res || !res.text) return null;
    const parsed = JSON.parse(res.text) as Record<string, unknown>;
    const pick = (v: unknown, allowed: string[]) => {
      const s = String(v || "").toUpperCase();
      return allowed.includes(s) ? s : "UNSURE";
    };
    return {
      sameperson: pick(parsed.sameperson, ["YES", "NO", "UNSURE"]),
      liveness: pick(parsed.liveness, ["PASS", "FAIL", "UNSURE"]),
      note: String(parsed.note || "").slice(0, 300),
    };
  } catch (err) {
    console.warn("[security] AI kiểm tra ảnh không khả dụng:", err instanceof Error ? err.message : err);
    return null;
  }
}

// ---------------------------------------------------------------------------
//  Thiết bị
// ---------------------------------------------------------------------------

export async function findDevice(userId: string, deviceHash: string): Promise<DeviceRow | null> {
  if (!deviceHash) return null;
  const rows = await db
    .select()
    .from(attDevices)
    .where(and(eq(attDevices.userId, userId), eq(attDevices.deviceHash, deviceHash)));
  return rows[0] || null;
}

/** Các tài khoản KHÁC đang dùng cùng thiết bị (theo dấu vân tay khoá). */
export async function otherAccountsOnDevice(userId: string, deviceHash: string) {
  return db
    .select()
    .from(attDevices)
    .where(and(eq(attDevices.deviceHash, deviceHash), ne(attDevices.userId, userId), ne(attDevices.status, "REJECTED")));
}

// ---------------------------------------------------------------------------
//  Phát hiện bất thường theo lịch sử (sau mỗi lượt thử)
// ---------------------------------------------------------------------------

export async function detectPatternAnomalies(p: {
  employeeId: string;
  userId: string;
  deviceHash: string | null;
  attemptId: number;
}): Promise<void> {
  try {
    const now = Date.now();
    // Chấm lặp nhiều lần trong 10 phút.
    const burst = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(attAttempts)
      .where(and(eq(attAttempts.employeeId, p.employeeId), gte(attAttempts.serverTs, now - 10 * 60000)));
    if ((burst[0]?.n || 0) >= 6) {
      await raiseAlert({
        level: "YELLOW",
        category: "REPEATED_ATTEMPTS",
        employeeId: p.employeeId,
        userId: p.userId,
        attemptId: p.attemptId,
        title: "Chấm lặp nhiều lần",
        cause: `${burst[0].n} lượt chấm/thử trong 10 phút.`,
        evidence: { count: burst[0].n, windowMin: 10 },
      });
    }
    // Một tài khoản dùng nhiều thiết bị trong 30 ngày.
    const devices = await db
      .select({ n: sql<number>`count(distinct ${attAttempts.deviceHash})::int` })
      .from(attAttempts)
      .where(
        and(
          eq(attAttempts.employeeId, p.employeeId),
          gte(attAttempts.serverTs, now - 30 * 24 * 3600 * 1000),
          sql`${attAttempts.deviceHash} is not null`
        )
      );
    if ((devices[0]?.n || 0) >= 3) {
      await raiseAlert({
        level: "YELLOW",
        category: "MANY_DEVICES",
        employeeId: p.employeeId,
        userId: p.userId,
        title: "Một tài khoản chấm từ nhiều thiết bị",
        cause: `${devices[0].n} thiết bị khác nhau trong 30 ngày.`,
        evidence: { devices: devices[0].n },
        dedupeKey: `MANY_DEVICES|${p.employeeId}|${vnDate().slice(0, 7)}`,
      });
    }
    // Một thiết bị dùng cho nhiều tài khoản.
    if (p.deviceHash) {
      const shared = await db
        .select({ n: sql<number>`count(distinct ${attAttempts.userId})::int` })
        .from(attAttempts)
        .where(and(eq(attAttempts.deviceHash, p.deviceHash), gte(attAttempts.serverTs, now - 30 * 24 * 3600 * 1000)));
      if ((shared[0]?.n || 0) >= 2) {
        await raiseAlert({
          level: "RED",
          category: "SHARED_DEVICE",
          employeeId: p.employeeId,
          userId: p.userId,
          deviceHash: p.deviceHash,
          title: "Một thiết bị chấm cho nhiều tài khoản",
          cause: `Thiết bị đã được dùng để chấm cho ${shared[0].n} tài khoản trong 30 ngày (nghi chấm hộ).`,
          evidence: { deviceHash: p.deviceHash, accounts: shared[0].n },
          dedupeKey: `SHARED_DEVICE|${p.deviceHash}|${vnDate()}`,
        });
      }
    }
  } catch (err) {
    console.warn("[security] Không phân tích được mẫu bất thường:", err);
  }
}

/** Cảnh báo khi một cán bộ gửi quá nhiều đề nghị điều chỉnh trong tháng. */
export async function checkAdjustmentVolume(employeeId: string, userId: string, max: number) {
  try {
    const month = vnDate().slice(0, 7);
    const rows = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(attRequests)
      .where(and(eq(attRequests.employeeId, employeeId), sql`${attRequests.targetDate} like ${month + "%"}`));
    const n = rows[0]?.n || 0;
    if (n > max) {
      await raiseAlert({
        level: "YELLOW",
        category: "EXCESSIVE_ADJUSTMENTS",
        employeeId,
        userId,
        title: "Đề nghị điều chỉnh vượt ngưỡng",
        cause: `${n} đề nghị điều chỉnh/đổi ca trong tháng ${month} (ngưỡng ${max}).`,
        evidence: { month, count: n, threshold: max },
        dedupeKey: `EXCESSIVE_ADJUSTMENTS|${employeeId}|${month}`,
      });
    }
  } catch (err) {
    console.warn("[security] Không đếm được đề nghị điều chỉnh:", err);
  }
}

// ---------------------------------------------------------------------------
//  Bản ghi điều chỉnh
// ---------------------------------------------------------------------------

export async function recordAdjustment(a: Omit<typeof attAdjustments.$inferInsert, "createdAt">) {
  await db.insert(attAdjustments).values({ ...a, createdAt: Date.now() });
}

export async function employeeName(employeeId: string | null | undefined): Promise<string> {
  if (!employeeId) return "";
  const rows = await db.select({ n: attEmployees.fullName }).from(attEmployees).where(eq(attEmployees.id, employeeId));
  return rows[0]?.n || "";
}
