-- Khởi tạo tài khoản Quản trị viên CMS: admin-tytbatxat
--
-- Bản di trú này chỉ tác động đến DỮ LIỆU, không đổi lược đồ bảng - vì vậy ảnh
-- chụp lược đồ (snapshot.json) giữ nguyên so với bản di trú liền trước.
--
-- Mật khẩu khởi tạo được nạp dưới dạng chuỗi băm bcrypt ($2b$, cost factor 10).
-- Bảng "users" không bao giờ giữ mật khẩu dạng rõ. Bản sao đọc được của lệnh
-- này nằm ở db/sql/create-admin-account.sql; công cụ sinh lại chuỗi băm là
-- auth/tools/generate-hash.mjs.
--
-- Đổi mật khẩu qua CMS (Quản trị hệ thống → Phân quyền hệ thống) hoặc qua
-- /api/station-auth action=change_password sẽ ghi đè giá trị này. Bản di trú
-- không chạy lại nên sẽ không khôi phục lại mật khẩu khởi tạo.

INSERT INTO "users" (
  "id",
  "username",
  "name",
  "role",
  "password_hash",
  "email",
  "station_code",
  "station_access",
  "can_receive_video",
  "status",
  "must_change_password",
  "created_at",
  "updated_at"
)
VALUES (
  'U-ADMIN-CMS-TYTBATXAT',
  'admin-tytbatxat',
  'Quản trị viên CMS Trạm Y tế Bát Xát',
  'admin',
  '$2b$10$1323U8CdUjVB7/v72SnQC.1yuch8Nvrp.9NQ9Wgw0vq17WkN3gYLC',
  'tytbatxat@laocai.gov.vn',
  'TYT-BATXAT-01',
  'true',
  'true',
  'ACTIVE',
  'false',
  (EXTRACT(EPOCH FROM now()) * 1000)::bigint,
  (EXTRACT(EPOCH FROM now()) * 1000)::bigint
)
-- Cột "username" có ràng buộc UNIQUE: nếu tài khoản đã tồn tại thì cập nhật lại
-- thay vì làm hỏng cả bản di trú vì lỗi trùng khoá.
ON CONFLICT ("username") DO UPDATE SET
  "name"                 = EXCLUDED."name",
  "role"                 = EXCLUDED."role",
  "password_hash"        = EXCLUDED."password_hash",
  "email"                = COALESCE(NULLIF("users"."email", ''), EXCLUDED."email"),
  "station_code"         = COALESCE(NULLIF("users"."station_code", ''), EXCLUDED."station_code"),
  "station_access"       = 'true',
  "can_receive_video"    = 'true',
  "status"               = 'ACTIVE',
  "must_change_password" = 'false',
  "updated_at"           = (EXTRACT(EPOCH FROM now()) * 1000)::bigint;
