CREATE TABLE "call_logs" (
	"id" text PRIMARY KEY,
	"room_id" text NOT NULL,
	"appointment_id" text,
	"patient_name" text,
	"patient_id" text,
	"station_code" text,
	"station_name" text,
	"operator_name" text,
	"operator_username" text,
	"operator_role" text,
	"call_date" text,
	"call_time" text,
	"started_at" bigint,
	"ended_at" bigint,
	"duration_sec" integer DEFAULT 0,
	"diagnosis" text,
	"treatment_plan" text,
	"prescription" text,
	"doctor_advice" text,
	"signer_name" text,
	"vitals_json" text,
	"chat_transcript" text,
	"chat_count" integer DEFAULT 0,
	"status" text DEFAULT 'IN_CALL',
	"ts" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX "call_logs_ts_idx" ON "call_logs" ("ts");--> statement-breakpoint
CREATE INDEX "call_logs_room_idx" ON "call_logs" ("room_id");