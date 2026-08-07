-- =============================================================================
--  Trạm Y tế Bát Xát - CMS
--  Script ĐẶT LẠI hai tài khoản Quản trị về mật khẩu mặc định
-- =============================================================================
--
--  Đây là bản sao đọc được (chạy tay được) của bản di trú
--  netlify/database/migrations/20260807120000_reset_default_admin_credentials.
--
--  Cách chạy:
--    - Trên Netlify Database: KHÔNG cần chạy tay. Bản di trú tự chạy đúng một
--      lần trên mỗi nhánh cơ sở dữ liệu ở lần triển khai kế tiếp.
--    - Trên PostgreSQL khác: psql "$DATABASE_URL" -f db/sql/reset-admin-credentials.sql
--
--  Script viết theo kiểu UPSERT nên chạy lại nhiều lần vẫn an toàn. Lưu ý: mỗi
--  lần chạy đều ĐẶT LẠI mật khẩu của hai tài khoản Quản trị về giá trị mặc
--  định - chỉ dùng khi thật sự mất quyền truy cập CMS.
-- =============================================================================

-- 1) Chuẩn hoá tên đăng nhập của hai tài khoản Quản trị về dạng đã cắt khoảng
--    trắng và viết thường.
--
--    Tuyến đăng nhập tra cứu tài khoản bằng phép so khớp chính xác, nên một dấu
--    cách thừa hoặc một chữ hoa lọt vào bản ghi là đủ để "sai mật khẩu" dù mật
--    khẩu hoàn toàn đúng. Điều kiện NOT EXISTS bảo đảm không vi phạm ràng buộc
--    UNIQUE khi trong bảng đã có sẵn một bản ghi mang đúng tên viết thường.
UPDATE "users" AS u SET
  "username"   = lower(btrim(u."username")),
  "updated_at" = (EXTRACT(EPOCH FROM now()) * 1000)::bigint
WHERE lower(btrim(u."username")) IN ('tytbatxat@laocai.gov.vn', 'admin-tytbatxat')
  AND u."username" <> lower(btrim(u."username"))
  AND NOT EXISTS (
    SELECT 1 FROM "users" AS x
    WHERE x."username" = lower(btrim(u."username")) AND x."id" <> u."id"
  );

-- 2) Tài khoản Quản trị viên hệ thống đã có trong bảng: nạp lại mật khẩu mặc
--    định, trả lại đủ quyền Quản trị + quyền vào Bảng điều khiển điểm trạm, mở
--    khoá nếu trước đó bị đặt DISABLED.
UPDATE "users" SET
  "password_hash"        = '$2b$10$sU8HOOtV7CpoeNOjpUtEuODFWYMoFGuurqXf0/Lf2oCXuAuks1UVG',
  "role"                 = 'Quản trị viên (Admin)',
  "station_access"       = 'true',
  "can_receive_video"    = 'true',
  "status"               = 'ACTIVE',
  "must_change_password" = 'true',
  "email"                = COALESCE(NULLIF("email", ''), 'tytbatxat@laocai.gov.vn'),
  "station_code"         = COALESCE(NULLIF("station_code", ''), 'TYT-BATXAT-01'),
  "updated_at"           = (EXTRACT(EPOCH FROM now()) * 1000)::bigint
WHERE lower("username") = 'tytbatxat@laocai.gov.vn';

-- 3) Nhánh cơ sở dữ liệu còn trống hoặc tài khoản đã bị xoá: tạo lại.
--    'U1' là mã của Quản trị trong bộ dữ liệu gieo hạt của netlify/functions/cms.ts;
--    nếu mã đó đã thuộc về một tài khoản khác thì dùng mã dự phòng để không đụng
--    khoá chính.
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
  'true',
  (EXTRACT(EPOCH FROM now()) * 1000)::bigint,
  (EXTRACT(EPOCH FROM now()) * 1000)::bigint
WHERE NOT EXISTS (
  SELECT 1 FROM "users" WHERE lower("username") = 'tytbatxat@laocai.gov.vn'
);

-- 4) Tài khoản Quản trị CMS của Mô-đun Xác thực: đặt lại y hệt cách trên.
UPDATE "users" SET
  "password_hash"        = '$2b$10$1323U8CdUjVB7/v72SnQC.1yuch8Nvrp.9NQ9Wgw0vq17WkN3gYLC',
  "role"                 = 'admin',
  "station_access"       = 'true',
  "can_receive_video"    = 'true',
  "status"               = 'ACTIVE',
  "must_change_password" = 'true',
  "email"                = COALESCE(NULLIF("email", ''), 'tytbatxat@laocai.gov.vn'),
  "station_code"         = COALESCE(NULLIF("station_code", ''), 'TYT-BATXAT-01'),
  "updated_at"           = (EXTRACT(EPOCH FROM now()) * 1000)::bigint
WHERE lower("username") = 'admin-tytbatxat';

INSERT INTO "users" (
  "id", "username", "name", "role", "can_receive_video", "station_access",
  "password_hash", "email", "station_code", "status", "must_change_password",
  "created_at", "updated_at"
)
SELECT
  CASE WHEN EXISTS (SELECT 1 FROM "users" WHERE "id" = 'U-ADMIN-CMS-TYTBATXAT')
       THEN 'U-ADMIN-CMS-TYTBATXAT-2' ELSE 'U-ADMIN-CMS-TYTBATXAT' END,
  'admin-tytbatxat',
  'Quản trị viên CMS Trạm Y tế Bát Xát',
  'admin',
  'true',
  'true',
  '$2b$10$1323U8CdUjVB7/v72SnQC.1yuch8Nvrp.9NQ9Wgw0vq17WkN3gYLC',
  'tytbatxat@laocai.gov.vn',
  'TYT-BATXAT-01',
  'ACTIVE',
  'true',
  (EXTRACT(EPOCH FROM now()) * 1000)::bigint,
  (EXTRACT(EPOCH FROM now()) * 1000)::bigint
WHERE NOT EXISTS (
  SELECT 1 FROM "users" WHERE lower("username") = 'admin-tytbatxat'
);
