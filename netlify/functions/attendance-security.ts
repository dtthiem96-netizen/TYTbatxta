/**
 * API "AN TOÀN CHẤM CÔNG" - bảng điều khiển chống gian lận của Quản trị.
 *
 *   GET  /api/attendance/security?view=...
 *        dashboard     chỉ số trong ngày + theo tháng (xanh / vàng / đỏ, cảnh báo, thiết bị...)
 *        alerts        danh sách cảnh báo (lọc theo trạng thái, mức, ngày)
 *        attempts      sổ bằng chứng các lượt chấm (được chấp nhận và bị từ chối)
 *        attempt       chi tiết một lượt: vị trí, khoảng cách, thiết bị, selfie, lý do
 *        selfie        ẢNH selfie (nhị phân) - chỉ xem, mỗi lần xem đều ghi nhật ký
 *        devices       thiết bị chấm công (chờ duyệt / đã duyệt / thu hồi)
 *        self_duty     ca trực tự nhận đang chờ xác nhận
 *        adjustments   lịch sử điều chỉnh (trước / sau, người đề nghị, người duyệt)
 *        sessions      phiên đăng nhập đang mở của phân hệ
 *        settings      cấu hình an ninh (vùng chấm công, QR, selfie, bốn mắt...)
 *        audit_verify  kiểm tra tính toàn vẹn chuỗi băm của nhật ký kiểm toán
 *
 *   POST /api/attendance/security  { action: ... }
 *        alert_update      cập nhật trạng thái xử lý / kết quả của cảnh báo
 *        device_decide     duyệt / từ chối / thu hồi thiết bị
 *        self_duty_decide  xác nhận / không xác nhận ca trực tự nhận
 *        settings_save     lưu cấu hình an ninh
 *        session_revoke    đóng một phiên đăng nhập
 *        template_enroll   lấy ảnh của một lượt đã có làm ảnh mẫu khuôn mặt
 *        qr_next           màn hình QR tại Trạm xin mã (giữ mã cũ nếu chưa tới kỳ đổi / chưa dùng)
 *        purge_selfies     xoá ảnh selfie quá hạn lưu trữ
 *
 * NGUYÊN TẮC: hệ thống chỉ gắn mức XANH / VÀNG / ĐỎ và đưa bằng chứng; kết luận
 * gian lận luôn do con người đưa ra khi xử lý cảnh báo (resolution = VIOLATION).
 * Không ai được xử lý cảnh báo, duyệt thiết bị hay ca trực của chính mình.
 */
import { db } from "../../db/index.js";
import {
  attAdjustments,
  attAlerts,
  attAttempts,
  attDevices,
  attDutyAssignments,
  attDutyLogs,
  attEmployees,
  attFaceTemplates,
  authSessions,
  users,
} from "../../db/schema.js";
import { and, desc, eq, gt, gte, inArray, isNull, lte, sql, type SQL } from "drizzle-orm";
import type { AnyColumn } from "drizzle-orm";
import { authErrorResponse } from "../lib/auth.js";
import {
  AuthError,
  JSON_HEADERS,
  addDays,
  csrfCheck,
  hasPermission,
  isValidDate,
  isValidPeriod,
  json,
  listShifts,
  notify,
  num,
  periodDates,
  periodOf,
  requirePermission,
  resolveActor,
  str,
  visibleEmployeeIds,
  vnDate,
  vnEpoch,
  vnTime,
  writeAudit,
  type ActorContext,
} from "../lib/attendance.js";
import { normalizeSecurity } from "../lib/antifraud.js";
import {
  ALERT_CATEGORIES,
  analyzeSelfie,
  enrollTemplate,
  getSecurity,
  issueQr,
  purgeExpiredSelfies,
  qrStatus,
  readSelfie,
  saveSecurity,
} from "../lib/security.js";
import { revokeSession, uaFamily } from "../lib/sessions.js";

const ALERT_STATUSES = new Set(["OPEN", "REVIEWING", "RESOLVED", "DISMISSED"]);
const RESOLUTIONS = new Set(["VALID", "VIOLATION", "TECHNICAL", "OTHER"]);

const nameOf = (actor: ActorContext) => actor.employee?.fullName || actor.user.name;

/** Điều kiện phạm vi dữ liệu: Phụ trách bộ phận chỉ thấy người trong bộ phận mình. */
async function scopeCond(actor: ActorContext, column: AnyColumn): Promise<SQL | undefined> {
  const ids = await visibleEmployeeIds(actor);
  if (!ids) return undefined;
  if (!ids.length) return sql`false`;
  return inArray(column, ids);
}

async function assertInScope(actor: ActorContext, employeeId: string | null) {
  const ids = await visibleEmployeeIds(actor);
  if (ids && (!employeeId || !ids.includes(employeeId))) {
    throw new AuthError(403, "FORBIDDEN", "Dữ liệu này không thuộc phạm vi quản lý của bạn.");
  }
}

async function nameMap(ids: (string | null | undefined)[]) {
  const list = [...new Set(ids.filter(Boolean) as string[])];
  const map = new Map<string, { name: string; code: string | null }>();
  if (!list.length) return map;
  const rows = await db
    .select({ id: attEmployees.id, name: attEmployees.fullName, code: attEmployees.code })
    .from(attEmployees)
    .where(inArray(attEmployees.id, list));
  for (const r of rows) map.set(r.id, { name: r.name, code: r.code });
  return map;
}

const parseJson = (v: string | null | undefined) => {
  if (!v) return null;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
};

/** Thông tin bằng chứng của một lượt - KHÔNG trả vector sinh trắc hay khoá công khai. */
function attemptView(a: typeof attAttempts.$inferSelect, names: Map<string, { name: string; code: string | null }>) {
  return {
    id: a.id,
    employeeId: a.employeeId,
    employeeName: a.employeeId ? names.get(a.employeeId)?.name || "" : "",
    kind: a.kind,
    serverTs: a.serverTs,
    serverTime: vnTime(a.serverTs),
    workDate: a.workDate,
    result: a.result,
    riskLevel: a.riskLevel,
    reasons: parseJson(a.reasons) || [],
    rejectMessage: a.rejectMessage,
    deviceHash: a.deviceHash,
    deviceSignatureOk: a.deviceSignatureOk,
    ip: a.ip,
    browser: uaFamily(a.userAgent),
    lat: a.lat,
    lng: a.lng,
    accuracyM: a.accuracyM,
    distanceM: a.distanceM,
    geofenceOk: a.geofenceOk,
    locationAgeMs: a.locationAgeMs,
    ipGeo: a.ipGeo,
    clockSkewMs: a.clockSkewMs,
    hasSelfie: Boolean(a.selfieKey),
    livenessResult: a.livenessResult,
    faceScore: a.faceScore,
    aiVerdict: parseJson(a.aiVerdict),
    qrUsed: Boolean(a.qrTokenId),
    refType: a.refType,
    refId: a.refId,
  };
}

// ---------------------------------------------------------------------------
//  Bảng điều khiển
// ---------------------------------------------------------------------------

async function handleDashboard(actor: ActorContext, date: string, period: string) {
  requirePermission(actor, "security.view");
  const dayStart = vnEpoch(date, "00:00");
  const dayEnd = vnEpoch(addDays(date, 1), "00:00");
  const dates = periodDates(period);
  const monthStart = vnEpoch(dates[0], "00:00");
  const monthEnd = vnEpoch(addDays(dates[dates.length - 1], 1), "00:00");
  const attemptScope = await scopeCond(actor, attAttempts.employeeId);
  const alertScope = await scopeCond(actor, attAlerts.employeeId);

  const levelCounts = async (from: number, to: number) => {
    const rows = await db
      .select({ level: attAttempts.riskLevel, result: attAttempts.result, n: sql<number>`count(*)::int` })
      .from(attAttempts)
      .where(and(gte(attAttempts.serverTs, from), lte(attAttempts.serverTs, to - 1), attemptScope))
      .groupBy(attAttempts.riskLevel, attAttempts.result);
    const out = { total: 0, green: 0, yellow: 0, red: 0, accepted: 0, rejected: 0 };
    for (const r of rows) {
      out.total += r.n;
      if (r.level === "GREEN") out.green += r.n;
      if (r.level === "YELLOW") out.yellow += r.n;
      if (r.level === "RED") out.red += r.n;
      if (r.result === "ACCEPTED") out.accepted += r.n;
      else out.rejected += r.n;
    }
    return out;
  };

  const alertCounts = async (fromDay: string, toDay: string) => {
    const rows = await db
      .select({ level: attAlerts.level, status: attAlerts.status, n: sql<number>`count(*)::int` })
      .from(attAlerts)
      .where(and(gte(attAlerts.day, fromDay), lte(attAlerts.day, toDay), alertScope))
      .groupBy(attAlerts.level, attAlerts.status);
    const out = { total: 0, yellow: 0, red: 0, open: 0, violations: 0 };
    for (const r of rows) {
      out.total += r.n;
      if (r.level === "YELLOW") out.yellow += r.n;
      if (r.level === "RED") out.red += r.n;
      if (["OPEN", "REVIEWING"].includes(String(r.status || "OPEN"))) out.open += r.n;
    }
    const v = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(attAlerts)
      .where(and(gte(attAlerts.day, fromDay), lte(attAlerts.day, toDay), eq(attAlerts.resolution, "VIOLATION"), alertScope));
    out.violations = v[0]?.n || 0;
    return out;
  };

  const [today, month, alertsToday, alertsMonth] = await Promise.all([
    levelCounts(dayStart, dayEnd),
    levelCounts(monthStart, monthEnd),
    alertCounts(date, date),
    alertCounts(dates[0], dates[dates.length - 1]),
  ]);

  // Chuỗi theo ngày trong tháng (biểu đồ).
  const daily = await db
    .select({
      day: attAttempts.workDate,
      level: attAttempts.riskLevel,
      n: sql<number>`count(*)::int`,
    })
    .from(attAttempts)
    .where(and(gte(attAttempts.serverTs, monthStart), lte(attAttempts.serverTs, monthEnd - 1), attemptScope))
    .groupBy(attAttempts.workDate, attAttempts.riskLevel);
  const series = dates.map((d) => {
    const row = { date: d, green: 0, yellow: 0, red: 0 };
    for (const r of daily.filter((x) => x.day === d)) {
      if (r.level === "GREEN") row.green = r.n;
      if (r.level === "YELLOW") row.yellow = r.n;
      if (r.level === "RED") row.red = r.n;
    }
    return row;
  });

  const byCategory = await db
    .select({ category: attAlerts.category, level: attAlerts.level, n: sql<number>`count(*)::int` })
    .from(attAlerts)
    .where(and(gte(attAlerts.day, dates[0]), lte(attAlerts.day, dates[dates.length - 1]), alertScope))
    .groupBy(attAlerts.category, attAlerts.level)
    .orderBy(desc(sql`count(*)`))
    .limit(20);

  const topPeople = await db
    .select({ employeeId: attAlerts.employeeId, n: sql<number>`count(*)::int` })
    .from(attAlerts)
    .where(and(gte(attAlerts.day, dates[0]), lte(attAlerts.day, dates[dates.length - 1]), sql`${attAlerts.employeeId} is not null`, alertScope))
    .groupBy(attAlerts.employeeId)
    .orderBy(desc(sql`count(*)`))
    .limit(10);
  const names = await nameMap(topPeople.map((t) => t.employeeId));

  const [pendingDevices, pendingSelfDuty, adjustmentsMonth, sharedDevices, activeSessions] = await Promise.all([
    db.select({ n: sql<number>`count(*)::int` }).from(attDevices).where(and(eq(attDevices.status, "PENDING"), await scopeCond(actor, attDevices.employeeId))),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(attDutyLogs)
      .where(and(eq(attDutyLogs.approvalStatus, "PENDING"), sql`coalesce(${attDutyLogs.state}, 'ACTIVE') = 'ACTIVE'`, await scopeCond(actor, attDutyLogs.employeeId))),
    db
      .select({ n: sql<number>`count(*)::int`, self: sql<number>`count(*) filter (where ${attAdjustments.selfApproved} = 'true')::int` })
      .from(attAdjustments)
      .where(and(gte(attAdjustments.createdAt, monthStart), lte(attAdjustments.createdAt, monthEnd - 1), await scopeCond(actor, attAdjustments.employeeId))),
    db
      .select({ hash: attDevices.deviceHash, n: sql<number>`count(distinct ${attDevices.userId})::int` })
      .from(attDevices)
      .groupBy(attDevices.deviceHash)
      .having(sql`count(distinct ${attDevices.userId}) > 1`),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(authSessions)
      .where(and(isNull(authSessions.revokedAt), gt(authSessions.expiresAt, Date.now()))),
  ]);

  const security = await getSecurity();
  return json({
    success: true,
    date,
    period,
    today: { attempts: today, alerts: alertsToday },
    month: {
      attempts: month,
      alerts: alertsMonth,
      adjustments: adjustmentsMonth[0]?.n || 0,
      selfApprovedAdjustments: adjustmentsMonth[0]?.self || 0,
    },
    pending: {
      devices: pendingDevices[0]?.n || 0,
      selfDuty: pendingSelfDuty[0]?.n || 0,
    },
    sharedDevices: sharedDevices.length,
    activeSessions: activeSessions[0]?.n || 0,
    series,
    byCategory: byCategory.map((c) => ({ ...c, label: ALERT_CATEGORIES[c.category] || c.category })),
    topPeople: topPeople.map((t) => ({ employeeId: t.employeeId, name: names.get(String(t.employeeId))?.name || "", count: t.n })),
    posture: {
      geofenceConfigured: security.geofence.enabled && security.geofence.lat !== null && security.geofence.lng !== null,
      requireDevice: security.requireDevice,
      selfieMode: security.selfieMode,
      qrMode: security.qrMode,
      fourEyes: security.fourEyes,
      singleSession: security.singleSession,
    },
    categories: ALERT_CATEGORIES,
  });
}

// ---------------------------------------------------------------------------
//  Cảnh báo
// ---------------------------------------------------------------------------

async function handleAlerts(actor: ActorContext, url: URL) {
  requirePermission(actor, "security.view");
  const status = str(url.searchParams.get("status")).toUpperCase();
  const level = str(url.searchParams.get("level")).toUpperCase();
  const from = str(url.searchParams.get("from"));
  const to = str(url.searchParams.get("to"));
  const employeeId = str(url.searchParams.get("employeeId"));
  const conds: (SQL | undefined)[] = [await scopeCond(actor, attAlerts.employeeId)];
  if (status === "ACTIVE") conds.push(sql`coalesce(${attAlerts.status}, 'OPEN') in ('OPEN', 'REVIEWING')`);
  else if (ALERT_STATUSES.has(status)) conds.push(eq(attAlerts.status, status));
  if (level === "YELLOW" || level === "RED") conds.push(eq(attAlerts.level, level));
  if (isValidDate(from)) conds.push(gte(attAlerts.day, from));
  if (isValidDate(to)) conds.push(lte(attAlerts.day, to));
  if (employeeId) conds.push(eq(attAlerts.employeeId, employeeId));
  const rows = await db
    .select()
    .from(attAlerts)
    .where(and(...conds))
    .orderBy(desc(attAlerts.createdAt))
    .limit(Math.min(500, num(url.searchParams.get("limit"), 200)));
  const names = await nameMap(rows.map((r) => r.employeeId));
  return json({
    success: true,
    alerts: rows.map((r) => ({
      id: r.id,
      level: r.level,
      category: r.category,
      categoryLabel: ALERT_CATEGORIES[r.category] || r.category,
      employeeId: r.employeeId,
      employeeName: r.employeeId ? names.get(r.employeeId)?.name || "" : "",
      deviceHash: r.deviceHash,
      attemptId: r.attemptId,
      title: r.title,
      cause: r.cause,
      evidence: parseJson(r.evidence),
      day: r.day,
      createdAt: r.createdAt,
      time: vnTime(r.createdAt),
      status: r.status || "OPEN",
      handledByName: r.handledByName,
      handledAt: r.handledAt,
      resolution: r.resolution,
      resolutionNote: r.resolutionNote,
    })),
  });
}

async function updateAlert(actor: ActorContext, body: Record<string, unknown>) {
  requirePermission(actor, "security.review");
  const id = num(body.id, 0);
  const found = await db.select().from(attAlerts).where(eq(attAlerts.id, id));
  if (!found.length) return json({ success: false, error: "Không tìm thấy cảnh báo." }, 404);
  const alert = found[0];
  await assertInScope(actor, alert.employeeId);
  if (alert.employeeId && actor.employee?.id === alert.employeeId) {
    return json({ success: false, error: "Không được tự xử lý cảnh báo liên quan đến chính mình." }, 403);
  }
  const status = str(body.status).toUpperCase();
  if (!ALERT_STATUSES.has(status)) return json({ success: false, error: "Trạng thái xử lý không hợp lệ." }, 400);
  const resolution = str(body.resolution).toUpperCase();
  const note = str(body.note).slice(0, 1000);
  const closing = status === "RESOLVED" || status === "DISMISSED";
  if (closing && !RESOLUTIONS.has(resolution)) {
    return json({ success: false, error: "Hãy chọn kết quả xử lý (hợp lệ / vi phạm / lỗi kỹ thuật / khác)." }, 400);
  }
  if (closing && note.length < 5) return json({ success: false, error: "Hãy ghi rõ nhận xét khi đóng cảnh báo (tối thiểu 5 ký tự)." }, 400);
  // Kết luận "vi phạm" chỉ do con người đưa ra, và phải có nhận xét cụ thể.
  if (resolution === "VIOLATION" && note.length < 15) {
    return json({ success: false, error: "Kết luận vi phạm cần nhận xét cụ thể (tối thiểu 15 ký tự) dựa trên bằng chứng đã xem." }, 400);
  }
  const now = Date.now();
  const next = {
    status,
    handledBy: actor.user.id,
    handledByName: nameOf(actor),
    handledAt: now,
    resolution: closing ? resolution : alert.resolution,
    resolutionNote: note || alert.resolutionNote,
  };
  await db.update(attAlerts).set(next).where(eq(attAlerts.id, id));
  await writeAudit(actor, {
    entity: "alert",
    entityId: String(id),
    action: closing ? "ALERT_CLOSE" : "ALERT_UPDATE",
    oldValue: { status: alert.status, resolution: alert.resolution },
    newValue: { status, resolution: next.resolution },
    reason: note || null,
  });
  return json({ success: true, message: "Đã cập nhật cảnh báo." });
}

// ---------------------------------------------------------------------------
//  Sổ bằng chứng
// ---------------------------------------------------------------------------

async function handleAttempts(actor: ActorContext, url: URL) {
  requirePermission(actor, "security.view");
  const date = str(url.searchParams.get("date"));
  const employeeId = str(url.searchParams.get("employeeId"));
  const result = str(url.searchParams.get("result")).toUpperCase();
  const level = str(url.searchParams.get("level")).toUpperCase();
  const conds: (SQL | undefined)[] = [await scopeCond(actor, attAttempts.employeeId)];
  if (isValidDate(date)) {
    conds.push(gte(attAttempts.serverTs, vnEpoch(date, "00:00")));
    conds.push(lte(attAttempts.serverTs, vnEpoch(addDays(date, 1), "00:00") - 1));
  }
  if (employeeId) conds.push(eq(attAttempts.employeeId, employeeId));
  if (result === "ACCEPTED" || result === "REJECTED") conds.push(eq(attAttempts.result, result));
  if (["GREEN", "YELLOW", "RED"].includes(level)) conds.push(eq(attAttempts.riskLevel, level));
  const rows = await db
    .select()
    .from(attAttempts)
    .where(and(...conds))
    .orderBy(desc(attAttempts.serverTs))
    .limit(Math.min(500, num(url.searchParams.get("limit"), 200)));
  const names = await nameMap(rows.map((r) => r.employeeId));
  return json({ success: true, attempts: rows.map((r) => attemptView(r, names)) });
}

async function handleAttempt(actor: ActorContext, id: number) {
  requirePermission(actor, "security.view");
  const rows = await db.select().from(attAttempts).where(eq(attAttempts.id, id));
  if (!rows.length) return json({ success: false, error: "Không tìm thấy lượt chấm." }, 404);
  const a = rows[0];
  await assertInScope(actor, a.employeeId);
  const names = await nameMap([a.employeeId]);
  const alerts = await db.select().from(attAlerts).where(eq(attAlerts.attemptId, id));
  const device = a.deviceHash
    ? (await db.select().from(attDevices).where(and(eq(attDevices.deviceHash, a.deviceHash), eq(attDevices.userId, a.userId))))[0] || null
    : null;
  const security = await getSecurity();
  return json({
    success: true,
    attempt: attemptView(a, names),
    geofence: { lat: security.geofence.lat, lng: security.geofence.lng, radiusM: security.geofence.radiusM },
    device: device ? { id: device.id, label: device.label, platform: device.platform, status: device.status } : null,
    alerts: alerts.map((r) => ({ id: r.id, level: r.level, title: r.title, status: r.status, resolution: r.resolution })),
    canViewSelfie: Boolean(a.selfieKey) && hasPermission(actor, "security.review"),
  });
}

/** Trả ảnh selfie dạng nhị phân. Chỉ xem - không có thao tác sửa/xoá ảnh. */
async function handleSelfie(actor: ActorContext, id: number, frame: string) {
  requirePermission(actor, "security.review");
  const rows = await db.select().from(attAttempts).where(eq(attAttempts.id, id));
  if (!rows.length || !rows[0].selfieKey) return json({ success: false, error: "Lượt chấm không có ảnh." }, 404);
  const a = rows[0];
  await assertInScope(actor, a.employeeId);
  const key = frame === "action" ? `${String(a.selfieKey).replace(/\.jpg$/, "")}-action.jpg` : String(a.selfieKey);
  const data = await readSelfie(key);
  if (!data) return json({ success: false, error: "Ảnh đã hết hạn lưu trữ hoặc không còn." }, 404);
  await writeAudit(actor, {
    entity: "selfie",
    entityId: String(id),
    action: "SELFIE_VIEW",
    newValue: { attemptId: id, frame: frame === "action" ? "action" : "neutral", employeeId: a.employeeId },
  });
  return new Response(data, {
    status: 200,
    headers: {
      "Content-Type": "image/jpeg",
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Disposition": "inline",
      "Referrer-Policy": "no-referrer",
    },
  });
}

// ---------------------------------------------------------------------------
//  Thiết bị
// ---------------------------------------------------------------------------

async function handleDevices(actor: ActorContext, status: string) {
  requirePermission(actor, "security.view");
  const conds: (SQL | undefined)[] = [await scopeCond(actor, attDevices.employeeId)];
  if (["PENDING", "APPROVED", "REJECTED", "REVOKED"].includes(status)) conds.push(eq(attDevices.status, status));
  const rows = await db.select().from(attDevices).where(and(...conds)).orderBy(desc(attDevices.createdAt)).limit(500);
  const names = await nameMap(rows.map((r) => r.employeeId));
  const hashes = [...new Set(rows.map((r) => r.deviceHash))];
  const shared = hashes.length
    ? await db
        .select({ hash: attDevices.deviceHash, n: sql<number>`count(distinct ${attDevices.userId})::int` })
        .from(attDevices)
        .where(inArray(attDevices.deviceHash, hashes))
        .groupBy(attDevices.deviceHash)
    : [];
  const sharedMap = new Map(shared.map((s) => [s.hash, s.n]));
  const templates = await db
    .select({ employeeId: attFaceTemplates.employeeId, status: attFaceTemplates.status })
    .from(attFaceTemplates);
  const tplSet = new Set(templates.filter((t) => String(t.status || "ACTIVE") === "ACTIVE").map((t) => t.employeeId));
  return json({
    success: true,
    devices: rows.map((d) => ({
      id: d.id,
      employeeId: d.employeeId,
      employeeName: d.employeeId ? names.get(d.employeeId)?.name || "" : "",
      deviceHash: d.deviceHash,
      label: d.label,
      platform: d.platform,
      browser: uaFamily(d.userAgent),
      status: d.status,
      requestReason: d.requestReason,
      registrationAttemptId: d.registrationAttemptId,
      firstIp: d.firstIp,
      lastIp: d.lastIp,
      createdAt: d.createdAt,
      lastSeenAt: d.lastSeenAt,
      decidedByName: d.decidedByName,
      decidedAt: d.decidedAt,
      decisionNote: d.decisionNote,
      accountsOnDevice: sharedMap.get(d.deviceHash) || 1,
      hasFaceTemplate: d.employeeId ? tplSet.has(d.employeeId) : false,
    })),
  });
}

/** Lấy ảnh của một lượt làm mẫu khuôn mặt: vector tính lại ở máy chủ từ ảnh gốc. */
async function enrollFromAttempt(actor: ActorContext, attemptId: number, employeeId: string) {
  const rows = await db.select().from(attAttempts).where(eq(attAttempts.id, attemptId));
  const a = rows[0];
  if (!a || !a.selfieKey || a.employeeId !== employeeId) return { ok: false, error: "Lượt này không có ảnh của cán bộ." };
  const data = await readSelfie(a.selfieKey);
  if (!data) return { ok: false, error: "Ảnh không còn trong kho lưu trữ." };
  const analysis = await analyzeSelfie(new Uint8Array(data));
  if ("error" in analysis) return { ok: false, error: analysis.error.message };
  await enrollTemplate({
    employeeId,
    vector: analysis.vector,
    dhash: analysis.dhash,
    referenceKey: a.selfieKey,
    sourceAttemptId: a.id,
    actor,
  });
  await writeAudit(actor, {
    entity: "face_template",
    entityId: employeeId,
    action: "TEMPLATE_ENROLL",
    newValue: { sourceAttemptId: a.id },
  });
  return { ok: true, error: "" };
}

async function decideDevice(actor: ActorContext, body: Record<string, unknown>) {
  requirePermission(actor, "security.review");
  const id = str(body.id);
  const decision = str(body.decision).toUpperCase();
  const note = str(body.note).slice(0, 500);
  if (!["APPROVE", "REJECT", "REVOKE"].includes(decision)) return json({ success: false, error: "Quyết định không hợp lệ." }, 400);
  const found = await db.select().from(attDevices).where(eq(attDevices.id, id));
  if (!found.length) return json({ success: false, error: "Không tìm thấy thiết bị." }, 404);
  const device = found[0];
  await assertInScope(actor, device.employeeId);
  if (device.userId === actor.user.id || (device.employeeId && device.employeeId === actor.employee?.id)) {
    return json({ success: false, error: "Không được tự duyệt thiết bị của chính mình." }, 403);
  }
  const current = String(device.status || "PENDING").toUpperCase();
  const allowed: Record<string, string[]> = { APPROVE: ["PENDING"], REJECT: ["PENDING"], REVOKE: ["APPROVED", "PENDING"] };
  if (!allowed[decision].includes(current)) {
    return json({ success: false, error: `Thiết bị đang ở trạng thái ${current}, không thể thực hiện thao tác này.` }, 409);
  }
  if (decision !== "APPROVE" && note.length < 5) return json({ success: false, error: "Hãy ghi lý do (tối thiểu 5 ký tự)." }, 400);
  const next = decision === "APPROVE" ? "APPROVED" : decision === "REJECT" ? "REJECTED" : "REVOKED";
  const now = Date.now();
  const updated = await db
    .update(attDevices)
    .set({ status: next, decidedBy: actor.user.id, decidedByName: nameOf(actor), decidedAt: now, decisionNote: note || null })
    .where(and(eq(attDevices.id, id), eq(attDevices.status, current)))
    .returning({ id: attDevices.id });
  if (!updated.length) return json({ success: false, error: "Thiết bị vừa được người khác xử lý." }, 409);

  let templateMessage = "";
  if (next === "APPROVED" && device.employeeId && device.registrationAttemptId) {
    const existing = await db.select().from(attFaceTemplates).where(eq(attFaceTemplates.employeeId, device.employeeId));
    const hasActive = existing.some((t) => String(t.status || "ACTIVE") === "ACTIVE");
    if (!hasActive || body.replaceTemplate === true) {
      const r = await enrollFromAttempt(actor, device.registrationAttemptId, device.employeeId);
      templateMessage = r.ok ? " Đã lưu ảnh mẫu khuôn mặt từ ảnh đăng ký." : ` Chưa lưu được ảnh mẫu: ${r.error}`;
    }
  }
  await writeAudit(actor, {
    entity: "device",
    entityId: id,
    action: `DEVICE_${next}`,
    oldValue: { status: current },
    newValue: { status: next, employeeId: device.employeeId, deviceHash: device.deviceHash },
    reason: note || null,
    approverId: actor.user.id,
    approverName: nameOf(actor),
  });
  if (device.employeeId) {
    const label = next === "APPROVED" ? "đã được duyệt" : next === "REJECTED" ? "không được duyệt" : "đã bị thu hồi";
    await notify(device.employeeId, "Thiết bị chấm công", `Thiết bị ${device.label || ""} ${label}.${note ? ` Ghi chú: ${note}` : ""}`, "DEVICE", id);
  }
  // Đóng cảnh báo "thiết bị chờ duyệt" tương ứng.
  await db
    .update(attAlerts)
    .set({ status: "RESOLVED", resolution: "OTHER", resolutionNote: `Thiết bị ${next}`, handledBy: actor.user.id, handledByName: nameOf(actor), handledAt: now })
    .where(and(eq(attAlerts.dedupeKey, `DEVICE_PENDING|${id}`), sql`coalesce(${attAlerts.status}, 'OPEN') in ('OPEN', 'REVIEWING')`));
  return json({ success: true, message: `Thiết bị ${next === "APPROVED" ? "đã được duyệt" : next === "REJECTED" ? "đã bị từ chối" : "đã bị thu hồi"}.${templateMessage}` });
}

async function templateEnroll(actor: ActorContext, body: Record<string, unknown>) {
  requirePermission(actor, "security.review");
  const attemptId = num(body.attemptId, 0);
  const rows = await db.select().from(attAttempts).where(eq(attAttempts.id, attemptId));
  if (!rows.length || !rows[0].employeeId) return json({ success: false, error: "Không tìm thấy lượt chấm." }, 404);
  const employeeId = rows[0].employeeId;
  await assertInScope(actor, employeeId);
  if (employeeId === actor.employee?.id) return json({ success: false, error: "Không được tự đặt ảnh mẫu cho chính mình." }, 403);
  const r = await enrollFromAttempt(actor, attemptId, employeeId);
  if (!r.ok) return json({ success: false, error: r.error }, 400);
  return json({ success: true, message: "Đã cập nhật ảnh mẫu khuôn mặt." });
}

// ---------------------------------------------------------------------------
//  Ca trực tự nhận chờ xác nhận
// ---------------------------------------------------------------------------

async function handleSelfDuty(actor: ActorContext) {
  requirePermission(actor, "security.view");
  const rows = await db
    .select()
    .from(attDutyLogs)
    .where(
      and(
        eq(attDutyLogs.approvalStatus, "PENDING"),
        sql`coalesce(${attDutyLogs.state}, 'ACTIVE') = 'ACTIVE'`,
        await scopeCond(actor, attDutyLogs.employeeId)
      )
    )
    .orderBy(desc(attDutyLogs.createdAt))
    .limit(300);
  const names = await nameMap(rows.map((r) => r.employeeId));
  const shifts = await listShifts(true);
  return json({
    success: true,
    items: rows.map((l) => {
      const shift = shifts.find((s) => s.id === l.shiftId);
      return {
        id: l.id,
        assignmentId: l.assignmentId,
        employeeId: l.employeeId,
        employeeName: names.get(l.employeeId)?.name || "",
        dutyDate: l.dutyDate,
        shiftName: shift?.name || l.shiftId,
        shiftTime: shift ? `${shift.startTime} - ${shift.endTime}` : "",
        checkIn: l.checkInAt ? vnTime(l.checkInAt) : null,
        checkOut: l.checkOutAt ? vnTime(l.checkOutAt) : null,
        riskLevel: l.riskLevel,
        checkInAttemptId: l.checkInAttemptId,
        checkOutAttemptId: l.checkOutAttemptId,
        note: l.note,
      };
    }),
  });
}

async function decideSelfDuty(actor: ActorContext, body: Record<string, unknown>) {
  requirePermission(actor, "security.review");
  const id = num(body.id, 0);
  const approve = str(body.decision).toUpperCase() !== "REJECT";
  const note = str(body.note).slice(0, 500);
  const rows = await db.select().from(attDutyLogs).where(eq(attDutyLogs.id, id));
  if (!rows.length) return json({ success: false, error: "Không tìm thấy nhật ký trực." }, 404);
  const log = rows[0];
  await assertInScope(actor, log.employeeId);
  if (log.employeeId === actor.employee?.id) return json({ success: false, error: "Không được tự xác nhận ca trực của chính mình." }, 403);
  if (!approve && note.length < 5) return json({ success: false, error: "Hãy ghi lý do không xác nhận (tối thiểu 5 ký tự)." }, 400);
  const now = Date.now();
  const updated = await db
    .update(attDutyLogs)
    .set({
      approvalStatus: approve ? "APPROVED" : "REJECTED",
      approvedBy: actor.user.id,
      approvedByName: nameOf(actor),
      approvedAt: now,
      updatedAt: now,
    })
    .where(and(eq(attDutyLogs.id, id), eq(attDutyLogs.approvalStatus, "PENDING"), sql`coalesce(${attDutyLogs.state}, 'ACTIVE') = 'ACTIVE'`))
    .returning({ id: attDutyLogs.id });
  if (!updated.length) return json({ success: false, error: "Ca trực này đã được xử lý." }, 409);
  await writeAudit(actor, {
    entity: "duty_log",
    entityId: String(id),
    action: approve ? "SELF_DUTY_APPROVE" : "SELF_DUTY_REJECT",
    oldValue: { approvalStatus: "PENDING" },
    newValue: { approvalStatus: approve ? "APPROVED" : "REJECTED", assignmentId: log.assignmentId, dutyDate: log.dutyDate },
    reason: note || null,
    approverId: actor.user.id,
    approverName: nameOf(actor),
  });
  await db
    .update(attAlerts)
    .set({
      status: "RESOLVED",
      resolution: approve ? "VALID" : "OTHER",
      resolutionNote: note || (approve ? "Đã xác nhận ca trực" : "Không xác nhận ca trực"),
      handledBy: actor.user.id,
      handledByName: nameOf(actor),
      handledAt: now,
    })
    .where(and(eq(attAlerts.dedupeKey, `SELF_DUTY_PENDING|${log.assignmentId}`), sql`coalesce(${attAlerts.status}, 'OPEN') in ('OPEN', 'REVIEWING')`));
  await notify(
    log.employeeId,
    approve ? "Ca trực tự nhận được xác nhận" : "Ca trực tự nhận không được xác nhận",
    `Ca trực ngày ${log.dutyDate} ${approve ? "đã được xác nhận và được tính giờ trực" : "không được xác nhận"}.${note ? ` Ghi chú: ${note}` : ""}`,
    "DUTY",
    log.assignmentId
  );
  if (!approve) {
    // Suất trực do cán bộ tự tạo giữ nguyên để đối chiếu; ghi chú kết quả lên suất trực.
    await db
      .update(attDutyAssignments)
      .set({ note: `Tự chấm trực - KHÔNG được xác nhận: ${note}`.slice(0, 500), updatedAt: now })
      .where(eq(attDutyAssignments.id, log.assignmentId));
  }
  return json({ success: true, message: approve ? "Đã xác nhận ca trực." : "Đã không xác nhận ca trực." });
}

// ---------------------------------------------------------------------------
//  Lịch sử điều chỉnh, phiên đăng nhập, cấu hình, toàn vẹn nhật ký
// ---------------------------------------------------------------------------

async function handleAdjustments(actor: ActorContext, url: URL) {
  requirePermission(actor, "security.view");
  const period = str(url.searchParams.get("period"));
  const employeeId = str(url.searchParams.get("employeeId"));
  const conds: (SQL | undefined)[] = [await scopeCond(actor, attAdjustments.employeeId)];
  if (isValidPeriod(period)) {
    const dates = periodDates(period);
    conds.push(gte(attAdjustments.workDate, dates[0]));
    conds.push(lte(attAdjustments.workDate, dates[dates.length - 1]));
  }
  if (employeeId) conds.push(eq(attAdjustments.employeeId, employeeId));
  const rows = await db.select().from(attAdjustments).where(and(...conds)).orderBy(desc(attAdjustments.createdAt)).limit(500);
  const names = await nameMap(rows.map((r) => r.employeeId));
  return json({
    success: true,
    adjustments: rows.map((r) => ({
      ...r,
      employeeName: names.get(r.employeeId)?.name || "",
      beforeData: parseJson(r.beforeData),
      afterData: parseJson(r.afterData),
      selfApproved: r.selfApproved === "true",
    })),
  });
}

async function handleSessions(actor: ActorContext) {
  requirePermission(actor, "security.review");
  const rows = await db
    .select({
      id: authSessions.id,
      userId: authSessions.userId,
      ip: authSessions.ip,
      lastIp: authSessions.lastIp,
      ipChanges: authSessions.ipChanges,
      userAgent: authSessions.userAgent,
      createdAt: authSessions.createdAt,
      lastSeenAt: authSessions.lastSeenAt,
      expiresAt: authSessions.expiresAt,
      username: users.username,
      name: users.name,
    })
    .from(authSessions)
    .leftJoin(users, eq(users.id, authSessions.userId))
    .where(and(isNull(authSessions.revokedAt), gt(authSessions.expiresAt, Date.now())))
    .orderBy(desc(authSessions.lastSeenAt))
    .limit(300);
  const scope = await visibleEmployeeIds(actor);
  let allowedUsers: Set<string> | null = null;
  if (scope) {
    const emps = scope.length
      ? await db.select({ userId: attEmployees.userId }).from(attEmployees).where(inArray(attEmployees.id, scope))
      : [];
    allowedUsers = new Set(emps.map((e) => String(e.userId || "")));
  }
  return json({
    success: true,
    sessions: rows
      .filter((r) => !allowedUsers || allowedUsers.has(r.userId))
      .map((r) => ({
        id: r.id,
        userId: r.userId,
        username: r.username,
        name: r.name,
        ip: r.ip,
        lastIp: r.lastIp,
        ipChanges: r.ipChanges,
        browser: uaFamily(r.userAgent),
        createdAt: r.createdAt,
        lastSeenAt: r.lastSeenAt,
        expiresAt: r.expiresAt,
        current: r.id === actor.sessionId,
      })),
  });
}

async function revokeUserSession(actor: ActorContext, body: Record<string, unknown>) {
  requirePermission(actor, "security.review");
  const id = str(body.id);
  const rows = await db.select().from(authSessions).where(eq(authSessions.id, id));
  if (!rows.length) return json({ success: false, error: "Không tìm thấy phiên." }, 404);
  const scope = await visibleEmployeeIds(actor);
  if (scope) {
    const emp = await db.select({ id: attEmployees.id }).from(attEmployees).where(eq(attEmployees.userId, rows[0].userId));
    if (!emp.length || !scope.includes(emp[0].id)) throw new AuthError(403, "FORBIDDEN", "Phiên này không thuộc phạm vi quản lý của bạn.");
  }
  await revokeSession(id, "ADMIN_REVOKE");
  await writeAudit(actor, {
    entity: "session",
    entityId: id,
    action: "SESSION_REVOKE",
    newValue: { userId: rows[0].userId },
    reason: str(body.reason).slice(0, 500) || null,
  });
  return json({ success: true, message: "Đã đóng phiên đăng nhập." });
}

async function handleSettingsView(actor: ActorContext) {
  requirePermission(actor, "security.view");
  return json({ success: true, settings: await getSecurity(), canConfigure: hasPermission(actor, "security.configure") });
}

async function saveSettingsAction(actor: ActorContext, body: Record<string, unknown>) {
  requirePermission(actor, "security.configure");
  const before = await getSecurity();
  const next = normalizeSecurity(body.settings);
  const reasonText = str(body.reason).slice(0, 500);
  // Hạ mức bảo vệ (tắt thiết bị / selfie / bốn mắt / vùng chấm công) phải nêu lý do.
  const weakened =
    (before.requireDevice && !next.requireDevice) ||
    (before.selfieMode === "REQUIRED" && next.selfieMode !== "REQUIRED") ||
    (before.fourEyes && !next.fourEyes) ||
    (before.geofence.enabled && !next.geofence.enabled) ||
    (before.qrMode === "REQUIRED" && next.qrMode !== "REQUIRED");
  if (weakened && reasonText.length < 10) {
    return json({ success: false, error: "Thay đổi này làm giảm mức bảo vệ. Hãy nêu lý do cụ thể (tối thiểu 10 ký tự)." }, 400);
  }
  await saveSecurity(next, actor);
  await writeAudit(actor, {
    entity: "settings",
    entityId: "security",
    action: "SECURITY_SAVE",
    oldValue: before,
    newValue: next,
    reason: reasonText || null,
  });
  if (weakened) {
    const { raiseAlert } = await import("../lib/security.js");
    await raiseAlert({
      level: "YELLOW",
      category: "ADMIN_ADJUSTMENT",
      userId: actor.user.id,
      title: "Giảm mức bảo vệ chấm công",
      cause: `${nameOf(actor)} đã nới lỏng cấu hình an ninh. Lý do: ${reasonText}`,
      evidence: { before, after: next },
      dedupeKey: `SECURITY_WEAKEN|${Date.now()}`,
    });
  }
  return json({ success: true, message: "Đã lưu cấu hình an ninh.", settings: next });
}

/** Tính lại chuỗi băm của nhật ký kiểm toán ngay trong CSDL, báo dòng đầu tiên bị lệch. */
async function handleAuditVerify(actor: ActorContext) {
  requirePermission(actor, "audits.view");
  const result = await db.execute(sql`
    with chain as (
      select seq, hash, prev_hash,
        lag(hash) over (order by seq) as expected_prev,
        encode(sha256(convert_to(concat_ws('|',
          prev_hash, seq::text, ts::text, entity, coalesce(entity_id, ''),
          action, coalesce(field, ''), coalesce(old_value, ''), coalesce(new_value, ''),
          coalesce(actor_id, ''), coalesce(ip, ''), coalesce(device_id, ''),
          coalesce(reason, ''), coalesce(approver_id, '')), 'UTF8')), 'hex') as recomputed,
        lag(seq) over (order by seq) as prev_seq
      from att_audits where seq is not null
    )
    select
      (select count(*)::int from chain) as total,
      (select min(seq) from chain where hash <> recomputed
          or prev_hash <> coalesce(expected_prev, 'GENESIS')
          or (prev_seq is not null and seq <> prev_seq + 1)
          or (prev_seq is null and seq <> 1)) as first_broken,
      (select count(*)::int from att_audits where seq is null) as legacy
  `);
  const row = ((result as unknown as { rows?: Record<string, unknown>[] }).rows || (result as unknown as Record<string, unknown>[]))[0] || {};
  const firstBroken = row.first_broken === null || row.first_broken === undefined ? null : Number(row.first_broken);
  await writeAudit(actor, { entity: "audit", entityId: "chain", action: "AUDIT_VERIFY", newValue: { ok: firstBroken === null } });
  return json({
    success: true,
    ok: firstBroken === null,
    total: Number(row.total || 0),
    legacyRows: Number(row.legacy || 0),
    firstBrokenSeq: firstBroken,
    message:
      firstBroken === null
        ? "Chuỗi băm nhật ký kiểm toán toàn vẹn."
        : `Phát hiện chuỗi băm bị đứt từ dòng số ${firstBroken}: nhật ký có thể đã bị can thiệp ngoài hệ thống.`,
  });
}

/** Màn hình QR tại Trạm: giữ mã hiện tại tới kỳ đổi, đổi ngay khi mã vừa được dùng. */
async function qrNext(actor: ActorContext, body: Record<string, unknown>) {
  requirePermission(actor, "kiosk.qr");
  const security = await getSecurity();
  if (security.qrMode === "OFF") return json({ success: false, error: "Chế độ QR đang tắt trong cấu hình an ninh." }, 409);
  const currentId = str(body.currentId);
  const now = Date.now();
  if (currentId) {
    const current = await qrStatus(currentId);
    if (current && !current.usedAt && current.expiresAt > now + 5000 && now - current.issuedAt < security.qrRotateSec * 1000) {
      return json({ success: true, same: true, id: current.id, expiresAt: current.expiresAt, rotateAt: current.issuedAt + security.qrRotateSec * 1000 });
    }
  }
  const qr = await issueQr(actor, security.qrTtlSec);
  return json({
    success: true,
    same: false,
    id: qr.id,
    code: qr.code,
    payload: qr.payload,
    expiresAt: qr.expiresAt,
    rotateAt: qr.issuedAt + security.qrRotateSec * 1000,
    serverTime: now,
  });
}

async function purgeSelfies(actor: ActorContext) {
  requirePermission(actor, "security.configure");
  const security = await getSecurity();
  const removed = await purgeExpiredSelfies(security.selfieRetentionDays);
  await writeAudit(actor, { entity: "selfie", entityId: "purge", action: "SELFIE_PURGE", newValue: { removed, retentionDays: security.selfieRetentionDays } });
  return json({ success: true, message: `Đã xoá ${removed} ảnh quá hạn lưu trữ ${security.selfieRetentionDays} ngày.` });
}

// ---------------------------------------------------------------------------

export default async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: JSON_HEADERS, status: 204 });
  try {
    const actor = await resolveActor(req);
    const url = new URL(req.url);
    if (req.method === "GET") {
      const view = str(url.searchParams.get("view")) || "dashboard";
      switch (view) {
        case "dashboard": {
          const date = str(url.searchParams.get("date"));
          const period = str(url.searchParams.get("period"));
          const day = isValidDate(date) ? date : vnDate();
          return await handleDashboard(actor, day, isValidPeriod(period) ? period : periodOf(day));
        }
        case "alerts":
          return await handleAlerts(actor, url);
        case "attempts":
          return await handleAttempts(actor, url);
        case "attempt":
          return await handleAttempt(actor, num(url.searchParams.get("id"), 0));
        case "selfie":
          return await handleSelfie(actor, num(url.searchParams.get("id"), 0), str(url.searchParams.get("frame")));
        case "devices":
          return await handleDevices(actor, str(url.searchParams.get("status")).toUpperCase());
        case "self_duty":
          return await handleSelfDuty(actor);
        case "adjustments":
          return await handleAdjustments(actor, url);
        case "sessions":
          return await handleSessions(actor);
        case "settings":
          return await handleSettingsView(actor);
        case "audit_verify":
          return await handleAuditVerify(actor);
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
      case "alert_update":
        return await updateAlert(actor, body);
      case "device_decide":
        return await decideDevice(actor, body);
      case "self_duty_decide":
        return await decideSelfDuty(actor, body);
      case "settings_save":
        return await saveSettingsAction(actor, body);
      case "session_revoke":
        return await revokeUserSession(actor, body);
      case "template_enroll":
        return await templateEnroll(actor, body);
      case "qr_next":
        return await qrNext(actor, body);
      case "purge_selfies":
        return await purgeSelfies(actor);
      default:
        return json({ success: false, error: "Hành động không hợp lệ." }, 400);
    }
  } catch (err: unknown) {
    const authResponse = authErrorResponse(err, JSON_HEADERS);
    if (authResponse) return authResponse;
    if (err instanceof AuthError) return json({ success: false, code: err.code, error: err.message }, err.status);
    console.error("attendance-security error", err);
    return json({ success: false, error: "Hệ thống an toàn chấm công đang gián đoạn. Vui lòng thử lại." }, 500);
  }
};

export const config = {
  path: "/api/attendance/security",
};
