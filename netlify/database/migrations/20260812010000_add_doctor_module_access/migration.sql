ALTER TABLE "users" ADD COLUMN "doctor_access" text DEFAULT 'false';--> statement-breakpoint
ALTER TABLE "telehealth_rooms" ADD COLUMN "patient_id" text;--> statement-breakpoint
UPDATE "users"
   SET "doctor_access" = 'true'
 WHERE ("role" ILIKE '%bác s%'
     OR "role" ILIKE '%bac s%'
     OR "role" ILIKE '%doctor%'
     OR "role" ILIKE '%tuyến trên%'
     OR "role" ILIKE '%tuyen tren%'
     OR "role" ILIKE '%admin%'
     OR "role" ILIKE '%quản trị%'
     OR "role" ILIKE '%quan tri%');--> statement-breakpoint
INSERT INTO "users" (
  "id", "username", "name", "role",
  "can_receive_video", "station_access", "doctor_access",
  "password_hash", "email", "station_code", "status", "must_change_password",
  "created_at", "updated_at"
) VALUES (
  'U-DOCTOR-TUYENTREN-01',
  'bstuyentren@laocai.gov.vn',
  'BS. CKI Tuyến trên (Hội chẩn từ xa)',
  'Bác sĩ tuyến trên (Superior Doctor)',
  'true', 'false', 'true',
  NULL,
  'bstuyentren@laocai.gov.vn',
  'TYT-BATXAT-01',
  'ACTIVE',
  'true',
  1786000000000, 1786000000000
) ON CONFLICT ("username") DO UPDATE SET
  "doctor_access" = 'true',
  "status" = 'ACTIVE',
  "updated_at" = 1786000000000;
