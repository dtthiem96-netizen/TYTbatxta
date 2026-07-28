CREATE TABLE "examination_reports" (
	"report_code" text PRIMARY KEY,
	"room_id" text NOT NULL,
	"station_code" text,
	"operator_name" text,
	"patient_name" text,
	"patient_age" integer,
	"patient_gender" text,
	"vitals_json" text,
	"clinical_notes" text,
	"diagnosis" text,
	"icd10" text,
	"treatment_plan" text,
	"prescription" text,
	"doctor_notes" text,
	"status" text DEFAULT 'COMPLETED',
	"ts" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "station_vitals" (
	"id" serial PRIMARY KEY,
	"room_id" text NOT NULL,
	"station_code" text,
	"operator_name" text,
	"patient_name" text,
	"patient_age" integer,
	"patient_gender" text,
	"bp_sys" integer,
	"bp_dia" integer,
	"heart_rate" integer,
	"spo2" real,
	"temperature" real,
	"weight" real,
	"symptoms" text,
	"status" text DEFAULT 'NORMAL',
	"ts" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX "examination_reports_room_idx" ON "examination_reports" ("room_id");--> statement-breakpoint
CREATE INDEX "station_vitals_room_ts_idx" ON "station_vitals" ("room_id","ts");