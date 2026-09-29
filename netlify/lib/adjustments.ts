/**
 * ĐIỀU CHỈNH DỮ LIỆU CÔNG - không bao giờ sửa hay xoá bản gốc (yêu cầu 10, 16).
 *
 * Mọi thay đổi lượt chấm công / nhật ký trực đều đi qua đây:
 *   - CREATE  : chèn bản ghi mới (source ADMIN / REQUEST), bản gốc không có.
 *   - REPLACE : chèn bản ghi mới, rồi chuyển bản gốc sang SUPERSEDED và trỏ
 *               superseded_by tới bản mới.
 *   - VOID    : chuyển bản gốc sang VOIDED (huỷ hiệu lực), không chèn gì.
 * Mỗi lần điều chỉnh sinh một dòng att_adjustments (chỉ ghi thêm) lưu người đề
 * nghị, lý do, người duyệt, thời điểm, giá trị trước và sau; cộng thêm một dòng
 * nhật ký kiểm toán có chuỗi băm. Trigger CSDL bảo đảm bản gốc không bị sửa.
 */
import { db } from "../../db/index.js";
import { attDutyLogs, attPunches } from "../../db/schema.js";
import { and, eq, sql } from "drizzle-orm";
import { newId, vnTime, writeAudit, type ActorContext } from "./attendance.js";
import { recordAdjustment } from "./security.js";

export type PunchRow = typeof attPunches.$inferSelect;
export type DutyLogRow = typeof attDutyLogs.$inferSelect;

export type Approval = {
  reason: string;
  requestId?: string | null;
  requestedBy: string;
  requestedByName: string;
  requestedAt: number;
  approver: ActorContext;
  selfApproved: boolean;
};

const approverName = (a: ActorContext) => a.employee?.fullName || a.user.name;

export class AdjustmentConflict extends Error {}

const punchView = (p: Partial<PunchRow> | null) =>
  p
    ? {
        id: p.id ?? null,
        workDate: p.workDate,
        punchType: p.punchType,
        time: p.punchAt ? vnTime(p.punchAt) : null,
        session: p.session,
        status: p.status,
        source: p.source,
        state: p.state || "ACTIVE",
        note: p.note || null,
        attemptId: p.attemptId ?? null,
        riskLevel: p.riskLevel ?? null,
      }
    : null;

const logView = (l: Partial<DutyLogRow> | null) =>
  l
    ? {
        id: l.id ?? null,
        assignmentId: l.assignmentId,
        dutyDate: l.dutyDate,
        shiftId: l.shiftId,
        checkIn: l.checkInAt ? vnTime(l.checkInAt) : null,
        checkOut: l.checkOutAt ? vnTime(l.checkOutAt) : null,
        hours: l.hours ?? null,
        source: l.source,
        state: l.state || "ACTIVE",
        approvalStatus: l.approvalStatus || "APPROVED",
      }
    : null;

/**
 * Áp một điều chỉnh lên lượt chấm công.
 * original: bản đang ACTIVE cần thay / huỷ (null khi CREATE).
 * values:   giá trị lượt chấm mới (null khi VOID).
 */
export async function applyPunchChange(p: {
  operation: "CREATE" | "REPLACE" | "VOID";
  employeeId: string;
  workDate: string;
  original: PunchRow | null;
  values: Omit<typeof attPunches.$inferInsert, "employeeId" | "workDate" | "adjustmentId" | "dedupeKey" | "createdAt" | "createdBy"> | null;
  approval: Approval;
}): Promise<{ adjustmentId: string; newId: number | null }> {
  const adjustmentId = newId("adj");
  const now = Date.now();
  let createdId: number | null = null;

  if (p.operation !== "VOID") {
    if (!p.values) throw new Error("Thiếu giá trị lượt chấm mới.");
    const rows = await db
      .insert(attPunches)
      .values({
        ...p.values,
        employeeId: p.employeeId,
        workDate: p.workDate,
        adjustmentId,
        requestId: p.approval.requestId || p.values.requestId || null,
        createdBy: p.approval.approver.user.id,
        createdAt: now,
        dedupeKey: `adj:${adjustmentId}`,
      })
      .returning({ id: attPunches.id });
    createdId = rows[0].id;
  }

  if (p.original) {
    const moved = await db
      .update(attPunches)
      .set({ state: p.operation === "VOID" ? "VOIDED" : "SUPERSEDED", supersededBy: createdId })
      .where(and(eq(attPunches.id, p.original.id), sql`coalesce(${attPunches.state}, 'ACTIVE') = 'ACTIVE'`))
      .returning({ id: attPunches.id });
    if (!moved.length) {
      // Bản gốc vừa bị người khác thay/huỷ: huỷ luôn bản mới để không có hai bản ACTIVE.
      if (createdId) await db.update(attPunches).set({ state: "VOIDED" }).where(eq(attPunches.id, createdId));
      throw new AdjustmentConflict("Lượt chấm công gốc đã được điều chỉnh bởi thao tác khác. Vui lòng tải lại.");
    }
  }

  const after = p.values ? punchView({ ...p.values, id: createdId ?? undefined, workDate: p.workDate }) : null;
  await recordAdjustment({
    id: adjustmentId,
    targetType: "PUNCH",
    operation: p.operation,
    originalId: p.original?.id ?? null,
    newRecordId: createdId,
    employeeId: p.employeeId,
    workDate: p.workDate,
    requestId: p.approval.requestId || null,
    beforeData: JSON.stringify(punchView(p.original)),
    afterData: JSON.stringify(after),
    reason: p.approval.reason,
    requestedBy: p.approval.requestedBy,
    requestedByName: p.approval.requestedByName,
    requestedAt: p.approval.requestedAt,
    approvedBy: p.approval.approver.user.id,
    approvedByName: approverName(p.approval.approver),
    approvedAt: now,
    selfApproved: p.approval.selfApproved ? "true" : "false",
  });
  await writeAudit(p.approval.approver, {
    entity: "punch",
    entityId: String(p.original?.id ?? createdId ?? ""),
    action: `ADJUST_${p.operation}`,
    oldValue: punchView(p.original),
    newValue: { ...after, adjustmentId },
    reason: p.approval.reason,
    approverId: p.approval.approver.user.id,
    approverName: approverName(p.approval.approver),
  });
  return { adjustmentId, newId: createdId };
}

/** Áp một điều chỉnh lên nhật ký trực - cùng nguyên tắc với lượt chấm công. */
export async function applyDutyLogChange(p: {
  operation: "CREATE" | "REPLACE" | "VOID";
  original: DutyLogRow | null;
  values: Omit<typeof attDutyLogs.$inferInsert, "adjustmentId" | "dedupeKey" | "createdAt" | "createdBy" | "updatedAt"> | null;
  employeeId: string;
  dutyDate: string;
  approval: Approval;
}): Promise<{ adjustmentId: string; newId: number | null }> {
  const adjustmentId = newId("adj");
  const now = Date.now();
  let createdId: number | null = null;

  if (p.operation !== "VOID") {
    if (!p.values) throw new Error("Thiếu giá trị nhật ký trực mới.");
    const rows = await db
      .insert(attDutyLogs)
      .values({
        ...p.values,
        adjustmentId,
        createdBy: p.approval.approver.user.id,
        createdAt: now,
        updatedAt: now,
        // Khoá chống trùng riêng cho bản điều chỉnh (bản gốc giữ khoá = mã suất trực).
        dedupeKey: `adj:${adjustmentId}`,
      })
      .returning({ id: attDutyLogs.id });
    createdId = rows[0].id;
  }

  if (p.original) {
    const moved = await db
      .update(attDutyLogs)
      .set({ state: p.operation === "VOID" ? "VOIDED" : "SUPERSEDED", supersededBy: createdId, updatedAt: now })
      .where(and(eq(attDutyLogs.id, p.original.id), sql`coalesce(${attDutyLogs.state}, 'ACTIVE') = 'ACTIVE'`))
      .returning({ id: attDutyLogs.id });
    if (!moved.length) {
      if (createdId) await db.update(attDutyLogs).set({ state: "VOIDED" }).where(eq(attDutyLogs.id, createdId));
      throw new AdjustmentConflict("Nhật ký trực gốc đã được điều chỉnh bởi thao tác khác. Vui lòng tải lại.");
    }
  }

  const after = p.values ? logView({ ...p.values, id: createdId ?? undefined }) : null;
  await recordAdjustment({
    id: adjustmentId,
    targetType: "DUTY_LOG",
    operation: p.operation,
    originalId: p.original?.id ?? null,
    newRecordId: createdId,
    employeeId: p.employeeId,
    workDate: p.dutyDate,
    requestId: p.approval.requestId || null,
    beforeData: JSON.stringify(logView(p.original)),
    afterData: JSON.stringify(after),
    reason: p.approval.reason,
    requestedBy: p.approval.requestedBy,
    requestedByName: p.approval.requestedByName,
    requestedAt: p.approval.requestedAt,
    approvedBy: p.approval.approver.user.id,
    approvedByName: approverName(p.approval.approver),
    approvedAt: now,
    selfApproved: p.approval.selfApproved ? "true" : "false",
  });
  await writeAudit(p.approval.approver, {
    entity: "duty_log",
    entityId: String(p.original?.id ?? createdId ?? ""),
    action: `ADJUST_${p.operation}`,
    oldValue: logView(p.original),
    newValue: { ...after, adjustmentId },
    reason: p.approval.reason,
    approverId: p.approval.approver.user.id,
    approverName: approverName(p.approval.approver),
  });
  return { adjustmentId, newId: createdId };
}
