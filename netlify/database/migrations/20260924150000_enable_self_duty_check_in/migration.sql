-- Chuyển sang chấm trực tự động bởi người trực: tắt yêu cầu phải được phân lịch trước.
UPDATE "att_settings"
   SET "value" = replace("value", '"requireDutyAssignment":true', '"requireDutyAssignment":false')
 WHERE "id" = 'work_hours'
   AND "value" LIKE '%"requireDutyAssignment":true%';
