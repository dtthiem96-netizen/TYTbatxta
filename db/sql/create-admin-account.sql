-- =============================================================================
--  Trạm Y tế Bát Xát - CMS
--  Script khởi tạo tài khoản Quản trị viên
-- =============================================================================
--
--  Tài khoản   : admin-tytbatxat
--  Vai trò     : admin
--  Mật khẩu    : nạp dưới dạng CHUỖI BĂM bcrypt, cost factor = 10.
--                Cơ sở dữ liệu không bao giờ giữ mật khẩu dạng rõ, kể cả trong
--                tệp script này. Chuỗi băm bên dưới được sinh bằng:
--                    node auth/tools/generate-hash.mjs 'Admin123@'
--                và đối chiếu lại được bằng bcrypt.compare().
--
--  Cách chạy:
--    - Trên Netlify Database: script đã được đóng gói thành bản di trú
--      netlify/database/migrations/20260807010000_add_cms_admin_account và tự
--      chạy khi triển khai. KHÔNG cần chạy tay.
--    - Trên PostgreSQL khác: psql "$DATABASE_URL" -f db/sql/create-admin-account.sql
--
--  Script viết theo kiểu UPSERT nên chạy lại nhiều lần vẫn an toàn. Lưu ý: chạy
--  lại sẽ ĐẶT LẠI mật khẩu về giá trị khởi tạo. Sau khi bàn giao hệ thống, Quản
--  trị phải đổi mật khẩu và không chạy lại tệp này nữa.
-- =============================================================================

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
  -- bcrypt('Admin123@', 10)
  '$2b$10$1323U8CdUjVB7/v72SnQC.1yuch8Nvrp.9NQ9Wgw0vq17WkN3gYLC',
  'tytbatxat@laocai.gov.vn',
  'TYT-BATXAT-01',
  'true',   -- được vào Module Bảng điều khiển điểm trạm
  'true',   -- được nhận cuộc gọi video khám từ xa
  'ACTIVE',
  'false',
  (EXTRACT(EPOCH FROM now()) * 1000)::bigint,
  (EXTRACT(EPOCH FROM now()) * 1000)::bigint
)
-- Cột "username" có ràng buộc UNIQUE, nên nếu tài khoản đã tồn tại thì cập nhật
-- lại thay vì báo lỗi trùng khoá.
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
