-- =============================================================================
-- TOÀN VẸN DỮ LIỆU CHẤM CÔNG - CHẤM TRỰC (lớp Database)
--
-- Các trigger dưới đây là lớp bảo vệ cuối cùng, độc lập với mã ứng dụng: kể cả
-- khi một API bị lỗi hoặc bị lạm dụng, cơ sở dữ liệu vẫn từ chối
--   * xoá / sửa giá trị gốc của lượt chấm công (att_punches),
--   * xoá / sửa giờ nhận ca, người trực của nhật ký trực (att_duty_logs),
--   * sửa / xoá sổ bằng chứng (att_attempts), bản ghi điều chỉnh
--     (att_adjustments) và nhật ký kiểm toán (att_audits).
-- Nhật ký kiểm toán được nối thành chuỗi băm SHA-256 (seq, prev_hash, hash) và
-- đóng dấu thời gian bằng đồng hồ của máy chủ cơ sở dữ liệu.
-- =============================================================================

-- ---- att_punches: chỉ được chuyển trạng thái một chiều, không được xoá -------
CREATE OR REPLACE FUNCTION att_punches_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'ATT_IMMUTABLE: Không được xoá lượt chấm công gốc (id=%). Hãy tạo đề nghị điều chỉnh.', OLD.id
      USING ERRCODE = 'P0001';
  END IF;

  IF NEW.employee_id IS DISTINCT FROM OLD.employee_id
     OR NEW.work_date IS DISTINCT FROM OLD.work_date
     OR NEW.punch_type IS DISTINCT FROM OLD.punch_type
     OR NEW.punch_at IS DISTINCT FROM OLD.punch_at
     OR NEW.session IS DISTINCT FROM OLD.session
     OR NEW.status IS DISTINCT FROM OLD.status
     OR NEW.minutes_delta IS DISTINCT FROM OLD.minutes_delta
     OR NEW.device IS DISTINCT FROM OLD.device
     OR NEW.ip IS DISTINCT FROM OLD.ip
     OR NEW.user_agent IS DISTINCT FROM OLD.user_agent
     OR NEW.source IS DISTINCT FROM OLD.source
     OR NEW.request_id IS DISTINCT FROM OLD.request_id
     OR NEW.note IS DISTINCT FROM OLD.note
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.dedupe_key IS DISTINCT FROM OLD.dedupe_key
     -- Liên kết bằng chứng chỉ được gắn MỘT LẦN (lượt chấm ghi trước, bằng chứng ghi ngay sau).
     OR (OLD.attempt_id IS NOT NULL AND NEW.attempt_id IS DISTINCT FROM OLD.attempt_id)
     OR (OLD.risk_level IS NOT NULL AND NEW.risk_level IS DISTINCT FROM OLD.risk_level)
  THEN
    RAISE EXCEPTION 'ATT_IMMUTABLE: Không được sửa dữ liệu gốc của lượt chấm công (id=%). Hãy tạo đề nghị điều chỉnh.', OLD.id
      USING ERRCODE = 'P0001';
  END IF;

  -- Trạng thái chỉ đi một chiều: ACTIVE -> SUPERSEDED / VOIDED.
  IF NEW.state IS DISTINCT FROM OLD.state
     AND COALESCE(OLD.state, 'ACTIVE') <> 'ACTIVE' THEN
    RAISE EXCEPTION 'ATT_IMMUTABLE: Lượt chấm công % đã bị thay thế/huỷ hiệu lực, không thể khôi phục trực tiếp.', OLD.id
      USING ERRCODE = 'P0001';
  END IF;
  IF NEW.state IS NOT NULL AND NEW.state NOT IN ('ACTIVE', 'SUPERSEDED', 'VOIDED') THEN
    RAISE EXCEPTION 'ATT_IMMUTABLE: Trạng thái không hợp lệ: %', NEW.state USING ERRCODE = 'P0001';
  END IF;
  IF NEW.state = 'ACTIVE' AND COALESCE(OLD.state, 'ACTIVE') = 'ACTIVE'
     AND NEW.superseded_by IS DISTINCT FROM OLD.superseded_by THEN
    RAISE EXCEPTION 'ATT_IMMUTABLE: Chỉ ghi liên kết thay thế khi chuyển trạng thái.' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS att_punches_guard ON att_punches;
--> statement-breakpoint
CREATE TRIGGER att_punches_guard
  BEFORE UPDATE OR DELETE ON att_punches
  FOR EACH ROW EXECUTE FUNCTION att_punches_guard();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION att_block_truncate() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'ATT_IMMUTABLE: Không được xoá toàn bộ bảng % (TRUNCATE).', TG_TABLE_NAME
    USING ERRCODE = 'P0001';
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS att_punches_no_truncate ON att_punches;
--> statement-breakpoint
CREATE TRIGGER att_punches_no_truncate
  BEFORE TRUNCATE ON att_punches
  FOR EACH STATEMENT EXECUTE FUNCTION att_block_truncate();
--> statement-breakpoint

-- ---- att_duty_logs: giờ kết ca ghi một lần, không sửa người/ca/giờ nhận ca ---
CREATE OR REPLACE FUNCTION att_duty_logs_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'ATT_IMMUTABLE: Không được xoá nhật ký trực gốc (id=%). Hãy tạo đề nghị điều chỉnh.', OLD.id
      USING ERRCODE = 'P0001';
  END IF;

  IF NEW.assignment_id IS DISTINCT FROM OLD.assignment_id
     OR NEW.employee_id IS DISTINCT FROM OLD.employee_id
     OR NEW.duty_date IS DISTINCT FROM OLD.duty_date
     OR NEW.shift_id IS DISTINCT FROM OLD.shift_id
     OR NEW.check_in_at IS DISTINCT FROM OLD.check_in_at
     OR NEW.source IS DISTINCT FROM OLD.source
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.dedupe_key IS DISTINCT FROM OLD.dedupe_key
     OR (OLD.check_in_attempt_id IS NOT NULL AND NEW.check_in_attempt_id IS DISTINCT FROM OLD.check_in_attempt_id)
  THEN
    RAISE EXCEPTION 'ATT_IMMUTABLE: Không được sửa người trực, suất trực hay giờ nhận ca của nhật ký trực (id=%). Hãy tạo đề nghị điều chỉnh.', OLD.id
      USING ERRCODE = 'P0001';
  END IF;

  -- Giờ kết ca chỉ được ghi MỘT LẦN (từ trống sang có giá trị).
  IF OLD.check_out_at IS NOT NULL AND NEW.check_out_at IS DISTINCT FROM OLD.check_out_at THEN
    RAISE EXCEPTION 'ATT_IMMUTABLE: Giờ kết ca của nhật ký trực % đã được ghi, không thể sửa trực tiếp.', OLD.id
      USING ERRCODE = 'P0001';
  END IF;
  IF OLD.check_out_attempt_id IS NOT NULL AND NEW.check_out_attempt_id IS DISTINCT FROM OLD.check_out_attempt_id THEN
    RAISE EXCEPTION 'ATT_IMMUTABLE: Không được sửa bằng chứng kết ca.' USING ERRCODE = 'P0001';
  END IF;
  -- Số giờ trực chỉ được tính lại cùng lúc với việc ghi giờ kết ca.
  IF OLD.check_out_at IS NOT NULL AND NEW.hours IS DISTINCT FROM OLD.hours THEN
    RAISE EXCEPTION 'ATT_IMMUTABLE: Không được sửa số giờ trực đã chốt.' USING ERRCODE = 'P0001';
  END IF;

  IF NEW.state IS DISTINCT FROM OLD.state
     AND COALESCE(OLD.state, 'ACTIVE') <> 'ACTIVE' THEN
    RAISE EXCEPTION 'ATT_IMMUTABLE: Nhật ký trực % đã bị thay thế/huỷ hiệu lực.', OLD.id USING ERRCODE = 'P0001';
  END IF;
  IF NEW.state IS NOT NULL AND NEW.state NOT IN ('ACTIVE', 'SUPERSEDED', 'VOIDED') THEN
    RAISE EXCEPTION 'ATT_IMMUTABLE: Trạng thái không hợp lệ: %', NEW.state USING ERRCODE = 'P0001';
  END IF;

  -- Kết quả duyệt ca tự nhận chỉ được quyết định một lần.
  IF COALESCE(OLD.approval_status, 'APPROVED') IN ('APPROVED', 'REJECTED')
     AND NEW.approval_status IS DISTINCT FROM OLD.approval_status THEN
    RAISE EXCEPTION 'ATT_IMMUTABLE: Nhật ký trực % đã có kết quả duyệt.', OLD.id USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS att_duty_logs_guard ON att_duty_logs;
--> statement-breakpoint
CREATE TRIGGER att_duty_logs_guard
  BEFORE UPDATE OR DELETE ON att_duty_logs
  FOR EACH ROW EXECUTE FUNCTION att_duty_logs_guard();
--> statement-breakpoint
DROP TRIGGER IF EXISTS att_duty_logs_no_truncate ON att_duty_logs;
--> statement-breakpoint
CREATE TRIGGER att_duty_logs_no_truncate
  BEFORE TRUNCATE ON att_duty_logs
  FOR EACH STATEMENT EXECUTE FUNCTION att_block_truncate();
--> statement-breakpoint

-- ---- Sổ chỉ ghi thêm: att_attempts, att_adjustments, att_audits --------------
CREATE OR REPLACE FUNCTION att_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'ATT_IMMUTABLE: Bảng % chỉ cho phép ghi thêm, không được sửa hay xoá.', TG_TABLE_NAME
    USING ERRCODE = 'P0001';
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS att_attempts_append_only ON att_attempts;
--> statement-breakpoint
CREATE TRIGGER att_attempts_append_only
  BEFORE UPDATE OR DELETE ON att_attempts
  FOR EACH ROW EXECUTE FUNCTION att_append_only();
--> statement-breakpoint
DROP TRIGGER IF EXISTS att_attempts_no_truncate ON att_attempts;
--> statement-breakpoint
CREATE TRIGGER att_attempts_no_truncate
  BEFORE TRUNCATE ON att_attempts
  FOR EACH STATEMENT EXECUTE FUNCTION att_block_truncate();
--> statement-breakpoint
DROP TRIGGER IF EXISTS att_adjustments_append_only ON att_adjustments;
--> statement-breakpoint
CREATE TRIGGER att_adjustments_append_only
  BEFORE UPDATE OR DELETE ON att_adjustments
  FOR EACH ROW EXECUTE FUNCTION att_append_only();
--> statement-breakpoint
DROP TRIGGER IF EXISTS att_adjustments_no_truncate ON att_adjustments;
--> statement-breakpoint
CREATE TRIGGER att_adjustments_no_truncate
  BEFORE TRUNCATE ON att_adjustments
  FOR EACH STATEMENT EXECUTE FUNCTION att_block_truncate();
--> statement-breakpoint
DROP TRIGGER IF EXISTS att_audits_append_only ON att_audits;
--> statement-breakpoint
CREATE TRIGGER att_audits_append_only
  BEFORE UPDATE OR DELETE ON att_audits
  FOR EACH ROW EXECUTE FUNCTION att_append_only();
--> statement-breakpoint
DROP TRIGGER IF EXISTS att_audits_no_truncate ON att_audits;
--> statement-breakpoint
CREATE TRIGGER att_audits_no_truncate
  BEFORE TRUNCATE ON att_audits
  FOR EACH STATEMENT EXECUTE FUNCTION att_block_truncate();
--> statement-breakpoint

-- ---- Chuỗi băm của nhật ký kiểm toán ----------------------------------------
-- Khoá tư vấn (advisory lock) theo giao dịch tuần tự hoá việc nối chuỗi, để hai
-- dòng ghi đồng thời không cùng trỏ vào một prev_hash.
CREATE OR REPLACE FUNCTION att_audits_chain() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  last_seq bigint;
  last_hash text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('att_audits_chain'));
  SELECT seq, hash INTO last_seq, last_hash
    FROM att_audits WHERE seq IS NOT NULL ORDER BY seq DESC LIMIT 1;

  NEW.ts := (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint;
  NEW.seq := COALESCE(last_seq, 0) + 1;
  NEW.prev_hash := COALESCE(last_hash, 'GENESIS');
  NEW.hash := encode(sha256(convert_to(concat_ws('|',
      NEW.prev_hash, NEW.seq::text, NEW.ts::text, NEW.entity, COALESCE(NEW.entity_id, ''),
      NEW.action, COALESCE(NEW.field, ''), COALESCE(NEW.old_value, ''), COALESCE(NEW.new_value, ''),
      COALESCE(NEW.actor_id, ''), COALESCE(NEW.ip, ''), COALESCE(NEW.device_id, ''),
      COALESCE(NEW.reason, ''), COALESCE(NEW.approver_id, '')), 'UTF8')), 'hex');
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS att_audits_chain ON att_audits;
--> statement-breakpoint
CREATE TRIGGER att_audits_chain
  BEFORE INSERT ON att_audits
  FOR EACH ROW EXECUTE FUNCTION att_audits_chain();
--> statement-breakpoint

-- ---- Ràng buộc bổ sung ------------------------------------------------------
ALTER TABLE att_attempts ADD CONSTRAINT att_attempts_risk_chk
  CHECK (risk_level IN ('GREEN', 'YELLOW', 'RED'));
--> statement-breakpoint
ALTER TABLE att_attempts ADD CONSTRAINT att_attempts_result_chk
  CHECK (result IN ('ACCEPTED', 'REJECTED'));
--> statement-breakpoint
ALTER TABLE att_alerts ADD CONSTRAINT att_alerts_level_chk
  CHECK (level IN ('YELLOW', 'RED'));
