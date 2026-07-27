CREATE TABLE "appointments" (
	"id" text PRIMARY KEY,
	"patient_name" text NOT NULL,
	"phone" text NOT NULL,
	"dob" text,
	"gender" text,
	"id_card" text,
	"service" text,
	"appointment_date" text NOT NULL,
	"symptoms" text,
	"is_telehealth" text DEFAULT 'false',
	"status" text DEFAULT 'PENDING',
	"room_id" text,
	"assigned_doctor" text,
	"ts" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "can_receive_video" text DEFAULT 'true';