// audit helper
module.exports.recordAudit = async function (db, actorUserId, action, targetType, targetId, metadata) {
  try {
    await db.AuditLog.create({
      actor_user_id: actorUserId,
      action,
      target_type: targetType,
      target_id: targetId,
      metadata
    });
  } catch (err) {
    console.error('Failed to record audit', err);
  }
};
