-- Ban Giám đốc Trạm Y tế Bát Xát theo Quyết định số 13/QĐ-TYT ngày 01/6/2026
-- (Phụ lục I - Cơ cấu tổ chức Trạm Y tế Bát Xát).
--
-- Trang Giới thiệu tự đưa các liên hệ trong bảng contacts có chức danh chứa
-- "Giám đốc" vào mục Ban lãnh đạo. Số điện thoại dùng số chính thức của Trạm,
-- không công khai số cá nhân. Sửa hoặc xoá về sau trong Quản trị CMS → Danh bạ;
-- bản di trú không chạy lại nên không ghi đè chỉnh sửa trong CMS.
--
-- Tên 3 khoa, phòng cũng được cập nhật theo đúng Phụ lục I.
--
-- Bản di trú này chỉ tác động đến DỮ LIỆU, không đổi lược đồ bảng.

INSERT INTO "contacts" ("id", "name", "role", "phone", "ts") VALUES
  ('C-BGD-01', 'Vũ Văn Dương', 'Phó Giám đốc phụ trách - Phụ trách chung; trực tiếp phụ trách Phòng Hành chính, Tài chính, Nhân sự, Dược, Thiết bị y tế, Cận lâm sàng', '02143909011', 1795996800001),
  ('C-BGD-02', 'BS. Trần Văn Đoan', 'Phó Giám đốc - Trực tiếp phụ trách Khoa Khám bệnh, chữa bệnh, Dân số, Trẻ em, Bảo trợ xã hội', '02143909011', 1795996800002),
  ('C-BGD-03', 'Vũ Thị Hồng Nhung', 'Phó Giám đốc - Trực tiếp phụ trách Khoa Phòng bệnh, An toàn thực phẩm', '02143909011', 1795996800003)
ON CONFLICT ("id") DO NOTHING;
--> statement-breakpoint
INSERT INTO "site_configs" ("id", "value") VALUES
  ('dept-khambenh-title', 'Khoa Khám bệnh, chữa bệnh, Dân số, Trẻ em, Bảo trợ xã hội'),
  ('dept-hanhchinh-title', 'Phòng Hành chính, Tài chính, Nhân sự, Dược, Thiết bị y tế, Cận lâm sàng'),
  ('dept-phongbenh-title', 'Khoa Phòng bệnh, An toàn thực phẩm')
ON CONFLICT ("id") DO UPDATE SET "value" = EXCLUDED."value";
