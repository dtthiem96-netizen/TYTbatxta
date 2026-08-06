-- Thiết lập tài khoản Quản trị viên (Admin) mặc định của hệ thống.
--
-- Tài khoản: tytbatxat@laocai.gov.vn
-- Mật khẩu mặc định được nạp dưới dạng chuỗi băm bcrypt ($2b$, 10 vòng) - cơ sở
-- dữ liệu KHÔNG bao giờ giữ mật khẩu dạng rõ. Đổi mật khẩu trong CMS (Quản trị
-- hệ thống → Phân quyền hệ thống) hoặc qua /api/station-auth action=change_password
-- sẽ ghi đè giá trị này; bản di trú không chạy lại nên không khôi phục lại nó.
--
-- Bản di trú này chỉ tác động đến DỮ LIỆU, không đổi lược đồ bảng.

-- 1) Tài khoản đã có sẵn trong bảng (được cms.ts gieo hạt lúc khởi tạo site):
--    nạp mật khẩu mặc định, bảo đảm đủ quyền Quản trị + quyền vào Bảng điều
--    khiển điểm trạm, và mở khoá nếu trước đó bị đặt DISABLED.
UPDATE "users" SET
  "password_hash" = '$2b$10$sU8HOOtV7CpoeNOjpUtEuODFWYMoFGuurqXf0/Lf2oCXuAuks1UVG',
  "role" = 'Quản trị viên (Admin)',
  "station_access" = 'true',
  "can_receive_video" = 'true',
  "status" = 'ACTIVE',
  "must_change_password" = 'false',
  "email" = COALESCE(NULLIF("email", ''), 'tytbatxat@laocai.gov.vn'),
  "station_code" = COALESCE(NULLIF("station_code", ''), 'TYT-BATXAT-01'),
  "updated_at" = (EXTRACT(EPOCH FROM now()) * 1000)::bigint
WHERE lower("username") = 'tytbatxat@laocai.gov.vn';--> statement-breakpoint

-- 2) Cơ sở dữ liệu còn trống hoặc tài khoản đã bị xoá: tạo mới.
--    Mã 'U1' là mã của Quản trị trong bộ dữ liệu gieo hạt; nếu mã đó đã thuộc về
--    một tài khoản khác thì dùng mã dự phòng để không đụng khoá chính.
INSERT INTO "users" (
  "id", "username", "name", "role", "can_receive_video", "station_access",
  "password_hash", "email", "station_code", "status", "must_change_password",
  "created_at", "updated_at"
)
SELECT
  CASE WHEN EXISTS (SELECT 1 FROM "users" WHERE "id" = 'U1') THEN 'U-ADMIN-TYTBATXAT' ELSE 'U1' END,
  'tytbatxat@laocai.gov.vn',
  'Quản trị viên hệ thống (Trạm trưởng)',
  'Quản trị viên (Admin)',
  'true',
  'true',
  '$2b$10$sU8HOOtV7CpoeNOjpUtEuODFWYMoFGuurqXf0/Lf2oCXuAuks1UVG',
  'tytbatxat@laocai.gov.vn',
  'TYT-BATXAT-01',
  'ACTIVE',
  'false',
  (EXTRACT(EPOCH FROM now()) * 1000)::bigint,
  (EXTRACT(EPOCH FROM now()) * 1000)::bigint
WHERE NOT EXISTS (
  SELECT 1 FROM "users" WHERE lower("username") = 'tytbatxat@laocai.gov.vn'
);
