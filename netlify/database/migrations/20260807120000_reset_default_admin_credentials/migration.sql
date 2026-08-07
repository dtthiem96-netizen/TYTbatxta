-- =============================================================================
--  Đặt lại hai tài khoản Quản trị CMS về trạng thái mặc định
-- =============================================================================
--
--  Vì sao cần bản di trú này: bản di trú chỉ chạy MỘT lần trên mỗi nhánh cơ sở
--  dữ liệu. Khi mật khẩu Quản trị bị đổi, bị đặt lại nhầm, tài khoản bị khoá
--  (status = DISABLED), bị thu hồi quyền, hoặc tên đăng nhập bị lưu lệch hoa/
--  thường - hai bản di trú cũ (20260806035628 và 20260807010000) KHÔNG bao giờ
--  chạy lại để sửa. Cách duy nhất an toàn là tiến về phía trước bằng một bản di
--  trú mới: bản này chạy đúng một lần trên MỌI nhánh (xem trước - preview và
--  chính thức - production) ngay ở lần triển khai kế tiếp.
--
--  Bản di trú chỉ tác động đến DỮ LIỆU, không đổi lược đồ bảng - vì vậy ảnh chụp
--  lược đồ (snapshot.json) giữ nguyên so với bản di trú liền trước.
--
--  Hai tài khoản được đặt lại:
--    1. tytbatxat@laocai.gov.vn - Quản trị viên hệ thống (cổng /admin và CMS).
--    2. admin-tytbatxat        - Quản trị viên CMS của Mô-đun Xác thực
--                                (/api/auth/login, /api/cms/*).
--
--  Mật khẩu mặc định được nạp dưới dạng CHUỖI BĂM bcrypt (cost factor = 10).
--  Bảng "users" không bao giờ giữ mật khẩu dạng rõ, kể cả trong tệp này. Chuỗi
--  băm bên dưới giữ nguyên giá trị đã công bố trong README và trong hằng số
--  DEFAULT_ADMIN_PASSWORD_HASH của netlify/lib/auth.ts, nên mật khẩu mặc định
--  sau khi đặt lại vẫn đúng bằng mật khẩu đã ghi trong tài liệu bàn giao.
--  Công cụ sinh lại chuỗi băm: node auth/tools/generate-hash.mjs '<mật khẩu>'.
--
--  Cột must_change_password được bật 'true': cả hai tài khoản đang dùng mật khẩu
--  mặc định nên giao diện sẽ nhắc đổi mật khẩu riêng ngay sau khi đăng nhập.
--  Cờ này chỉ hiện lời nhắc, không chặn đăng nhập.
--
--  Bản sao đọc được để chạy tay trên PostgreSQL khác: db/sql/reset-admin-credentials.sql
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
  );--> statement-breakpoint

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
WHERE lower("username") = 'tytbatxat@laocai.gov.vn';--> statement-breakpoint

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
);--> statement-breakpoint

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
WHERE lower("username") = 'admin-tytbatxat';--> statement-breakpoint

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
