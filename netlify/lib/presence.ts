/**
 * XÁC MINH HIỆN DIỆN - chuỗi kiểm tra chung cho mọi lượt chấm công / chấm trực.
 *
 * Máy chủ tự kiểm lại MỌI điều kiện, không tin bất kỳ kết luận nào từ trình
 * duyệt (yêu cầu 1):
 *   1. Thử thách dùng một lần (nonce) còn hạn và đúng người → chống phát lại.
 *   2. Thiết bị đã đăng ký, đã được duyệt, và KÝ ĐƯỢC thử thách bằng khoá riêng
 *      không xuất được → chống dùng máy khác / gọi API trực tiếp.
 *   3. Vị trí GPS lấy MỘT LẦN lúc chấm: máy chủ tự tính khoảng cách tới Trạm,
 *      đối chiếu sai số, lịch sử di chuyển, IP, đồng hồ → chống ngoài vùng /
 *      vị trí giả.
 *   4. Ảnh selfie chụp trực tiếp (2 khung hình, khung 2 làm động tác ngẫu nhiên)
 *      → máy chủ giải mã, băm, so với ảnh cũ, so vector với mẫu, hỏi AI tham
 *      khảo → chống chấm hộ / dùng ảnh có sẵn.
 *   5. Mã QR động tại Trạm (nếu bật) còn hạn và chưa dùng.
 * Kết quả là danh sách lý do + mức GREEN/YELLOW/RED; nghiệp vụ (trùng lượt,
 * đúng ca, đúng lịch trực) được Function cộng thêm trước khi quyết định.
 */
import { db } from "../../db/index.js";
import { attAttempts, attDevices } from "../../db/schema.js";
import { and, desc, eq, sql } from "drizzle-orm";
import {
  LIVENESS_CHALLENGES,
  checkGeofence,
  combineLevel,
  gpsSignals,
  parseLocation,
  reason,
  signingPayload,
  verifyDeviceSignature,
  type Location,
  type RiskLevel,
  type RiskReason,
  type SecuritySettings,
} from "./antifraud.js";
import { vnDate, str, type ActorContext } from "./attendance.js";
import {
  aiFaceCheck,
  alertForAttempt,
  analyzeSelfie,
  compareWithTemplate,
  consumeNonce,
  consumeQr,
  decodeImageBase64,
  detectPatternAnomalies,
  findDevice,
  parseQrInput,
  readSelfie,
  recordAttempt,
  selfieHistoryChecks,
  storeSelfie,
  type DeviceRow,
  type SelfieAnalysis,
} from "./security.js";

export type PresenceKind = "PUNCH_IN" | "PUNCH_OUT" | "DUTY_IN" | "DUTY_OUT";

export const KIND_LABELS: Record<string, string> = {
  PUNCH_IN: "Chấm vào",
  PUNCH_OUT: "Chấm ra",
  DUTY_IN: "Nhận ca trực",
  DUTY_OUT: "Kết ca trực",
  DEVICE_REGISTER: "Đăng ký thiết bị",
};

export type PresenceResult = {
  serverTs: number;
  reasons: RiskReason[];
  location: Location | null;
  distanceM: number | null;
  geofenceOk: boolean | null;
  device: DeviceRow | null;
  deviceHash: string | null;
  signatureOk: boolean;
  selfie: SelfieAnalysis | null;
  selfieKey: string | null;
  faceScore: number | null;
  livenessResult: string | null;
  aiVerdict: string | null;
  qrTokenId: string | null;
  nonceId: string | null;
  clientTs: number | null;
  ipGeo: string | null;
};

/** Mã quốc gia theo IP từ header x-nf-geo (base64 JSON) của Netlify. */
export function ipCountryOf(req: Request): string | null {
  const raw = req.headers.get("x-nf-geo");
  if (!raw) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64").toString("utf8"));
    return parsed?.country?.code || null;
  } catch {
    return null;
  }
}

/**
 * Chạy toàn bộ lớp xác minh hiện diện. KHÔNG ghi sổ bằng chứng - việc đó do
 * finalizeAttempt() làm sau khi Function cộng thêm lý do nghiệp vụ.
 */
export async function verifyPresence(
  req: Request,
  actor: ActorContext,
  body: Record<string, unknown>,
  kind: PresenceKind,
  security: SecuritySettings
): Promise<PresenceResult> {
  const serverTs = Date.now();
  const reasons: RiskReason[] = [];
  const employeeId = actor.employee?.id || "";
  const clientTsRaw = Number(body.clientTs);
  const clientTs = Number.isFinite(clientTsRaw) && clientTsRaw > 0 ? Math.round(clientTsRaw) : null;

  // 1. Thử thách một lần.
  const nonceId = str(body.nonce).slice(0, 80);
  const nonce = await consumeNonce(nonceId, actor.user.id, "PRESENCE");
  if (!nonce) {
    reasons.push(
      reason("NONCE_INVALID", "RED", "Phiên xác minh đã hết hạn hoặc đã được dùng. Vui lòng bấm chấm lại để lấy phiên mới.")
    );
  }
  const challengeCode = nonce?.challenge || null;

  // 2. Vị trí + selfie (cần cho chữ ký) được đọc trước.
  const location = parseLocation(body.location);
  const neutralBytes = decodeImageBase64(body.selfie);
  const actionBytes = decodeImageBase64(body.selfieAction);

  let selfie: SelfieAnalysis | null = null;
  let action: SelfieAnalysis | null = null;
  if (security.selfieMode !== "OFF") {
    if (!neutralBytes) {
      reasons.push(
        security.selfieMode === "REQUIRED"
          ? reason("SELFIE_MISSING", "RED", "Chưa có ảnh selfie chụp trực tiếp từ camera.")
          : reason("SELFIE_MISSING", "YELLOW", "Lượt chấm không kèm ảnh selfie.")
      );
    } else {
      const analyzed = await analyzeSelfie(neutralBytes);
      if ("error" in analyzed) reasons.push(analyzed.error);
      else selfie = analyzed;
      if (actionBytes) {
        const a2 = await analyzeSelfie(actionBytes);
        if (!("error" in a2)) action = a2;
      }
    }
  }

  // 3. Thiết bị và chữ ký.
  const deviceHash = str(body.deviceHash).toLowerCase().slice(0, 64) || null;
  let device: DeviceRow | null = null;
  let signatureOk = false;
  if (deviceHash) device = await findDevice(actor.user.id, deviceHash);
  if (device && nonce) {
    const payload = signingPayload({
      nonce: nonce.id,
      action: kind,
      type: str(body.type) || null,
      lat: location?.lat ?? null,
      lng: location?.lng ?? null,
      selfieSha256: selfie?.sha256 || null,
    });
    signatureOk = await verifyDeviceSignature(device.publicKey, payload, str(body.signature));
  }
  const deviceLevel: RiskLevel = security.requireDevice ? "RED" : "YELLOW";
  if (!device) {
    reasons.push(
      reason(
        "DEVICE_UNREGISTERED",
        deviceLevel,
        "Thiết bị này chưa được đăng ký cho tài khoản. Hãy đăng ký thiết bị và chờ Quản trị duyệt."
      )
    );
  } else {
    const status = String(device.status || "PENDING").toUpperCase();
    if (status === "PENDING") {
      reasons.push(reason("DEVICE_PENDING", deviceLevel, "Thiết bị đang chờ Quản trị duyệt, chưa dùng để chấm được."));
    } else if (status !== "APPROVED") {
      reasons.push(reason("DEVICE_REVOKED", "RED", "Thiết bị đã bị từ chối hoặc thu hồi quyền chấm công."));
    }
    if (nonce && !signatureOk) {
      reasons.push(
        reason("DEVICE_SIGNATURE", "RED", "Chữ ký thiết bị không hợp lệ - dữ liệu gửi lên đã bị sửa hoặc không xuất phát từ thiết bị đã đăng ký.")
      );
    }
    if (status === "APPROVED" && signatureOk) {
      db.update(attDevices)
        .set({ lastSeenAt: serverTs, lastIp: actor.ip || null })
        .where(eq(attDevices.id, device.id))
        .catch(() => undefined);
    }
  }

  // 4. Vị trí: vùng chấm công + dấu hiệu giả lập.
  const geo = checkGeofence(security, location);
  reasons.push(...geo.reasons);
  const previous = employeeId
    ? await db
        .select({ lat: attAttempts.lat, lng: attAttempts.lng, ts: attAttempts.serverTs })
        .from(attAttempts)
        .where(and(eq(attAttempts.employeeId, employeeId), sql`${attAttempts.lat} is not null`))
        .orderBy(desc(attAttempts.serverTs))
        .limit(5)
    : [];
  const ipGeo = ipCountryOf(req);
  reasons.push(
    ...gpsSignals(location, {
      serverTs,
      clientTs,
      previous: previous[0] && previous[0].lat !== null ? { lat: previous[0].lat!, lng: previous[0].lng!, ts: previous[0].ts } : null,
      recentCoords: previous.filter((p) => p.lat !== null).map((p) => ({ lat: p.lat!, lng: p.lng! })),
      ipCountry: ipGeo,
      clientFlags: body.clientFlags && typeof body.clientFlags === "object" ? (body.clientFlags as Record<string, unknown>) : null,
      maxSpeedKmh: security.maxSpeedKmh,
      maxClockSkewSec: security.maxClockSkewSec,
    })
  );

  // 5. Ảnh: lịch sử, mẫu khuôn mặt, AI tham khảo.
  let selfieKey: string | null = null;
  let faceScore: number | null = null;
  let livenessResult: string | null = null;
  let aiVerdict: string | null = null;
  if (selfie && employeeId) {
    reasons.push(...(await selfieHistoryChecks(employeeId, selfie, action, challengeCode)));
    const tpl = await compareWithTemplate(employeeId, selfie.vector);
    if (!tpl) {
      reasons.push(reason("FACE_NO_TEMPLATE", "YELLOW", "Chưa có ảnh mẫu khuôn mặt để đối chiếu (được tạo khi Quản trị duyệt thiết bị)."));
    } else {
      faceScore = tpl.score;
      if (tpl.score < security.faceMatchThreshold) {
        reasons.push(
          reason("FACE_MISMATCH", "YELLOW", `Độ tương đồng với ảnh mẫu ${(tpl.score * 100).toFixed(0)}% dưới ngưỡng ${(security.faceMatchThreshold * 100).toFixed(0)}%.`)
        );
      }
    }
    if (security.aiFaceCheck) {
      const reference = tpl?.referenceKey ? await readSelfie(tpl.referenceKey) : null;
      const label = LIVENESS_CHALLENGES.find((c) => c.code === challengeCode)?.label || null;
      const ai = await aiFaceCheck({
        reference: reference ? new Uint8Array(reference) : null,
        neutral: selfie.bytes,
        action: action?.bytes || null,
        challengeLabel: label,
      });
      if (ai) {
        aiVerdict = JSON.stringify(ai);
        livenessResult = ai.liveness;
        // AI chỉ nâng lên VÀNG, không bao giờ tự kết luận ĐỎ (yêu cầu 13).
        if (ai.sameperson === "NO") reasons.push(reason("FACE_MISMATCH", "YELLOW", `AI tham khảo: có thể không cùng người với ảnh mẫu. ${ai.note}`));
        if (ai.liveness === "FAIL") reasons.push(reason("LIVENESS_FAIL", "YELLOW", `AI tham khảo: nghi không phải chụp trực tiếp / sai động tác. ${ai.note}`));
      }
    }
    if (!livenessResult) livenessResult = action ? "FRAMES_DIFFER" : "NOT_CHECKED";
    // Chỉ lưu ảnh khi lượt thử có ý nghĩa (qua được nonce): tránh bị gửi ảnh rác làm đầy kho.
    if (nonce) {
      selfieKey = `att/${vnDate(serverTs)}/${employeeId}/${serverTs}-${selfie.sha256.slice(0, 12)}.jpg`;
      await storeSelfie(selfieKey, selfie.bytes, { employeeId, kind, ts: serverTs, frame: "neutral" });
      if (action) await storeSelfie(`${selfieKey.replace(/\.jpg$/, "")}-action.jpg`, action.bytes, { employeeId, kind, ts: serverTs, frame: "action" });
    }
  }

  // 6. QR động.
  let qrTokenId: string | null = null;
  const qrCode = parseQrInput(body.qr);
  if (security.qrMode !== "OFF") {
    if (qrCode) {
      const qr = await consumeQr(qrCode, employeeId);
      if (qr) qrTokenId = qr.id;
      else reasons.push(reason("QR_INVALID", "RED", "Mã QR không đúng, đã hết hạn hoặc đã được dùng. Hãy quét mã mới trên màn hình tại Trạm."));
    } else if (security.qrMode === "REQUIRED") {
      reasons.push(reason("QR_MISSING", "RED", "Trạm yêu cầu quét mã QR động hiển thị tại Trạm."));
    }
  }

  return {
    serverTs,
    reasons,
    location,
    distanceM: geo.distanceM,
    geofenceOk: geo.inside,
    device,
    deviceHash,
    signatureOk,
    selfie,
    selfieKey,
    faceScore,
    livenessResult,
    aiVerdict,
    qrTokenId,
    nonceId: nonce?.id || null,
    clientTs,
    ipGeo,
  };
}

/**
 * Ghi lượt thử vào sổ bằng chứng, sinh cảnh báo, chạy phát hiện bất thường.
 * Trả về id lượt thử và mức rủi ro cuối cùng.
 */
export async function finalizeAttempt(p: {
  actor: ActorContext;
  kind: PresenceKind;
  presence: PresenceResult;
  extraReasons: RiskReason[];
  accepted: boolean;
  rejectMessage?: string | null;
  workDate: string;
  refType?: string | null;
  refId?: string | null;
}): Promise<{ attemptId: number; level: RiskLevel; reasons: RiskReason[] }> {
  const reasons = [...p.presence.reasons, ...p.extraReasons];
  const level = combineLevel(reasons);
  const pr = p.presence;
  const attemptId = await recordAttempt({
    userId: p.actor.user.id,
    employeeId: p.actor.employee?.id || null,
    kind: p.kind,
    serverTs: pr.serverTs,
    workDate: p.workDate,
    result: p.accepted ? "ACCEPTED" : "REJECTED",
    riskLevel: level,
    reasons,
    rejectMessage: p.rejectMessage || null,
    deviceId: pr.device?.id || null,
    deviceHash: pr.deviceHash,
    deviceSignatureOk: pr.signatureOk ? "true" : "false",
    sessionId: p.actor.sessionId,
    ip: p.actor.ip || null,
    userAgent: p.actor.userAgent || null,
    lat: pr.location?.lat ?? null,
    lng: pr.location?.lng ?? null,
    accuracyM: pr.location?.accuracy ?? null,
    distanceM: pr.distanceM,
    geofenceOk: pr.geofenceOk === null ? null : String(pr.geofenceOk),
    locationAgeMs:
      pr.location?.positionTs && pr.clientTs ? Math.max(-2147483647, Math.min(2147483647, pr.clientTs - pr.location.positionTs)) : null,
    ipGeo: pr.ipGeo,
    clientTs: pr.clientTs,
    clockSkewMs: pr.clientTs ? Math.max(-2147483647, Math.min(2147483647, pr.clientTs - pr.serverTs)) : null,
    selfieKey: pr.selfieKey,
    selfieSha256: pr.selfie?.sha256 || null,
    selfieDhash: pr.selfie?.dhash || null,
    livenessResult: pr.livenessResult,
    faceScore: pr.faceScore,
    aiVerdict: pr.aiVerdict,
    qrTokenId: pr.qrTokenId,
    nonceId: pr.nonceId,
    refType: p.refType || null,
    refId: p.refId || null,
  });
  await alertForAttempt({
    attemptId,
    level,
    reasons,
    employeeId: p.actor.employee?.id || null,
    userId: p.actor.user.id,
    deviceHash: pr.deviceHash,
    kindLabel: KIND_LABELS[p.kind] || p.kind,
    evidence: {
      result: p.accepted ? "ACCEPTED" : "REJECTED",
      distanceM: pr.distanceM,
      accuracyM: pr.location?.accuracy ?? null,
      ip: p.actor.ip,
      faceScore: pr.faceScore,
    },
  });
  if (p.actor.employee) {
    await detectPatternAnomalies({ employeeId: p.actor.employee.id, userId: p.actor.user.id, deviceHash: pr.deviceHash, attemptId });
  }
  return { attemptId, level, reasons };
}

/** Rút gọn lý do để trả ra giao diện. */
export const publicReasons = (reasons: RiskReason[]) => reasons.map((r) => ({ code: r.code, level: r.level, message: r.message }));

/** Lỗi vi phạm ràng buộc duy nhất của Postgres (23505). */
export function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string }; message?: string };
  return e?.code === "23505" || e?.cause?.code === "23505" || /duplicate key|unique constraint/i.test(String(e?.message || ""));
}

/** Lỗi do trigger bất biến của cơ sở dữ liệu chặn. */
export function isImmutableViolation(err: unknown): boolean {
  const e = err as { message?: string; cause?: { message?: string } };
  return /ATT_IMMUTABLE/.test(String(e?.message || "")) || /ATT_IMMUTABLE/.test(String(e?.cause?.message || ""));
}
