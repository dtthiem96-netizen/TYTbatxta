/* GỠ BỎ CHIA PHÒNG ZOOM & RÀNG BUỘC MỖI TÀI KHOẢN CÁN BỘ VÀO ĐÚNG MỘT ĐIỂM TRẠM

   Cuộc gọi khám từ xa chạy hoàn toàn trên phòng WebRTC sẵn có của từng điểm
   trạm ("room-<slug mã trạm>"), đúng phòng mà người dân vào khi chọn điểm trạm
   đó. Vì vậy toàn bộ cột Zoom do CMS Quản trị cấp phát trở thành thừa và được
   gỡ bỏ.

   Đồng thời mỗi tài khoản cán bộ chỉ còn được gắn vào MỘT điểm trạm duy nhất:
   station_receivers.user_id trở thành khoá duy nhất, và users.station_code
   được đồng bộ theo đúng hàng trực còn lại. */

-- 1) Tài khoản đã nằm trong danh sách trực nhưng hồ sơ chưa ghi điểm trạm:
--    lấy trạm của hàng trực tốt nhất (đang bật, ưu tiên cao nhất, tạo sớm nhất).
UPDATE "users" u
   SET "station_code" = pick."station_code"
  FROM (
    SELECT DISTINCT ON (r."user_id") r."user_id", r."station_code"
      FROM "station_receivers" r
     ORDER BY r."user_id",
              (coalesce(r."is_active", 'true') = 'true') DESC,
              coalesce(r."priority", 99) ASC,
              coalesce(r."created_at", 0) ASC,
              r."id" ASC
  ) pick
 WHERE u."id" = pick."user_id"
   AND coalesce(u."station_code", '') = '';
--> statement-breakpoint

-- 2) Một tài khoản đang trực ở nhiều trạm: chỉ giữ lại hàng khớp với điểm trạm
--    ghi trong hồ sơ tài khoản, nếu không có thì giữ hàng trực tốt nhất.
DELETE FROM "station_receivers" r
 USING (
   SELECT r2."id",
          row_number() OVER (
            PARTITION BY r2."user_id"
            ORDER BY (r2."station_code" = coalesce(u."station_code", '')) DESC,
                     (coalesce(r2."is_active", 'true') = 'true') DESC,
                     coalesce(r2."priority", 99) ASC,
                     coalesce(r2."created_at", 0) ASC,
                     r2."id" ASC
          ) AS rn
     FROM "station_receivers" r2
     LEFT JOIN "users" u ON u."id" = r2."user_id"
 ) ranked
 WHERE r."id" = ranked."id"
   AND ranked."rn" > 1;
--> statement-breakpoint

-- 3) Hồ sơ tài khoản luôn trỏ về đúng điểm trạm của hàng trực còn lại.
UPDATE "users" u
   SET "station_code" = r."station_code"
  FROM "station_receivers" r
 WHERE r."user_id" = u."id"
   AND coalesce(u."station_code", '') <> r."station_code";
--> statement-breakpoint

-- 4) Khoá duy nhất theo tài khoản thay cho khoá duy nhất theo cặp (trạm, tài khoản):
--    máy chủ không thể ghi thêm một điểm trạm thứ hai cho cùng một cán bộ.
DROP INDEX IF EXISTS "station_receivers_station_user_uidx";--> statement-breakpoint
DROP INDEX IF EXISTS "station_receivers_user_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "station_receivers_user_uidx" ON "station_receivers" ("user_id");--> statement-breakpoint

-- 5) Gỡ toàn bộ cột Zoom.
ALTER TABLE "station_receivers" DROP COLUMN IF EXISTS "personal_zoom_url";--> statement-breakpoint
ALTER TABLE "station_receivers" DROP COLUMN IF EXISTS "personal_meeting_id";--> statement-breakpoint
ALTER TABLE "station_rooms" DROP COLUMN IF EXISTS "zoom_join_url";--> statement-breakpoint
ALTER TABLE "station_rooms" DROP COLUMN IF EXISTS "zoom_meeting_id";--> statement-breakpoint
ALTER TABLE "station_rooms" DROP COLUMN IF EXISTS "zoom_passcode";--> statement-breakpoint
ALTER TABLE "station_rooms" DROP COLUMN IF EXISTS "zoom_host_email";--> statement-breakpoint
ALTER TABLE "telehealth_rooms" DROP COLUMN IF EXISTS "zoom_join_url";--> statement-breakpoint
ALTER TABLE "telehealth_rooms" DROP COLUMN IF EXISTS "zoom_meeting_id";--> statement-breakpoint
ALTER TABLE "telehealth_rooms" DROP COLUMN IF EXISTS "zoom_passcode";
