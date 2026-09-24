-- Đổi tên cơ quan chủ quản in trên bảng chấm công/phiếu PDF trong cấu hình đã lưu.
UPDATE "att_settings"
   SET "value" = replace("value", 'TRUNG TÂM Y TẾ HUYỆN BÁT XÁT - SỞ Y TẾ LÀO CAI', 'UBND XÃ BÁT XÁT')
 WHERE "id" = 'org'
   AND "value" LIKE '%TRUNG TÂM Y TẾ HUYỆN BÁT XÁT - SỞ Y TẾ LÀO CAI%';
