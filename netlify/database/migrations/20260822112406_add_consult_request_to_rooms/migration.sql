/* MỜI BÁC SĨ TUYẾN TRÊN VÀO CÙNG PHÒNG KHÁM

   Trước đây một cuộc gọi chỉ có đúng một "người tiếp nhận": ai bấm trước thì
   chiếm, người bấm sau bị từ chối. Vì vậy khi cán bộ điểm trạm đã nhận cuộc gọi
   thì Module Bác sĩ tuyến trên ở chân trang không còn lối nào vào phòng đó nữa.

   Ba cột dưới đây ghi lại lời mời hội chẩn của điểm trạm ngay trong hồ sơ phòng,
   nên bác sĩ mở Module sau đó vài phút vẫn thấy lời mời còn treo. Lời mời được
   xoá trắng khi có bác sĩ tuyến trên thực sự vào phòng. */

ALTER TABLE "telehealth_rooms" ADD COLUMN "consult_requested_at" bigint;--> statement-breakpoint
ALTER TABLE "telehealth_rooms" ADD COLUMN "consult_requested_by" text;--> statement-breakpoint
ALTER TABLE "telehealth_rooms" ADD COLUMN "consult_note" text;
