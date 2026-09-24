CREATE TABLE "att_audits" (
	"id" serial PRIMARY KEY,
	"entity" text NOT NULL,
	"entity_id" text,
	"action" text NOT NULL,
	"field" text,
	"old_value" text,
	"new_value" text,
	"actor_id" text,
	"actor_name" text,
	"actor_username" text,
	"ip" text,
	"ts" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "att_departments" (
	"id" text PRIMARY KEY,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"head_employee_id" text,
	"note" text,
	"display_order" integer DEFAULT 0,
	"status" text DEFAULT 'ACTIVE',
	"created_at" bigint,
	"updated_at" bigint
);
--> statement-breakpoint
CREATE TABLE "att_duty_assignments" (
	"id" text PRIMARY KEY,
	"duty_date" text NOT NULL,
	"shift_id" text NOT NULL,
	"employee_id" text NOT NULL,
	"day_type" text DEFAULT 'WEEKDAY',
	"status" text DEFAULT 'PLANNED',
	"swapped_from_employee_id" text,
	"note" text,
	"created_by" text,
	"created_at" bigint,
	"updated_at" bigint
);
--> statement-breakpoint
CREATE TABLE "att_duty_logs" (
	"id" serial PRIMARY KEY,
	"assignment_id" text NOT NULL,
	"employee_id" text NOT NULL,
	"duty_date" text NOT NULL,
	"shift_id" text NOT NULL,
	"check_in_at" bigint,
	"check_out_at" bigint,
	"hours" real,
	"device" text,
	"ip" text,
	"status" text DEFAULT 'OPEN',
	"source" text DEFAULT 'SELF',
	"note" text,
	"created_by" text,
	"created_at" bigint,
	"updated_at" bigint
);
--> statement-breakpoint
CREATE TABLE "att_employees" (
	"id" text PRIMARY KEY,
	"code" text NOT NULL,
	"full_name" text NOT NULL,
	"position" text,
	"department_id" text,
	"user_id" text,
	"attendance_role" text DEFAULT 'STAFF',
	"phone" text,
	"email" text,
	"start_date" text,
	"status" text DEFAULT 'ACTIVE',
	"note" text,
	"display_order" integer DEFAULT 0,
	"created_at" bigint,
	"updated_at" bigint
);
--> statement-breakpoint
CREATE TABLE "att_holidays" (
	"id" text PRIMARY KEY,
	"name" text NOT NULL,
	"start_date" text NOT NULL,
	"end_date" text NOT NULL,
	"day_type" text DEFAULT 'HOLIDAY',
	"note" text,
	"created_by" text,
	"created_at" bigint,
	"updated_at" bigint
);
--> statement-breakpoint
CREATE TABLE "att_leaves" (
	"id" text PRIMARY KEY,
	"employee_id" text NOT NULL,
	"leave_type" text NOT NULL,
	"from_date" text NOT NULL,
	"to_date" text NOT NULL,
	"days" real,
	"session" text DEFAULT 'FULL',
	"reason" text,
	"attachment" text,
	"status" text DEFAULT 'PENDING',
	"decided_by" text,
	"decided_by_name" text,
	"decided_at" bigint,
	"decision_note" text,
	"created_by" text,
	"created_at" bigint,
	"updated_at" bigint
);
--> statement-breakpoint
CREATE TABLE "att_notifications" (
	"id" serial PRIMARY KEY,
	"employee_id" text NOT NULL,
	"title" text NOT NULL,
	"body" text,
	"kind" text DEFAULT 'INFO',
	"ref_id" text,
	"read_at" bigint,
	"ts" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "att_periods" (
	"id" text PRIMARY KEY,
	"status" text DEFAULT 'OPEN',
	"locked_by" text,
	"locked_by_name" text,
	"locked_at" bigint,
	"note" text,
	"updated_at" bigint
);
--> statement-breakpoint
CREATE TABLE "att_punches" (
	"id" serial PRIMARY KEY,
	"employee_id" text NOT NULL,
	"work_date" text NOT NULL,
	"punch_type" text NOT NULL,
	"punch_at" bigint NOT NULL,
	"session" text,
	"status" text,
	"minutes_delta" integer DEFAULT 0,
	"device" text,
	"ip" text,
	"user_agent" text,
	"source" text DEFAULT 'SELF',
	"request_id" text,
	"note" text,
	"created_by" text,
	"created_at" bigint
);
--> statement-breakpoint
CREATE TABLE "att_requests" (
	"id" text PRIMARY KEY,
	"kind" text NOT NULL,
	"employee_id" text NOT NULL,
	"target_date" text,
	"payload" text,
	"reason" text,
	"status" text DEFAULT 'PENDING',
	"decided_by" text,
	"decided_by_name" text,
	"decided_at" bigint,
	"decision_note" text,
	"created_at" bigint,
	"updated_at" bigint
);
--> statement-breakpoint
CREATE TABLE "att_settings" (
	"id" text PRIMARY KEY,
	"value" text NOT NULL,
	"updated_by" text,
	"updated_at" bigint
);
--> statement-breakpoint
CREATE TABLE "att_shifts" (
	"id" text PRIMARY KEY,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"start_time" text NOT NULL,
	"end_time" text NOT NULL,
	"crosses_midnight" text DEFAULT 'false',
	"hours" real,
	"day_scope" text DEFAULT 'ANY',
	"coefficient" real DEFAULT 1,
	"counts_as_admin_day" text DEFAULT 'false',
	"admin_day_value" real DEFAULT 0,
	"color" text,
	"note" text,
	"display_order" integer DEFAULT 0,
	"status" text DEFAULT 'ACTIVE',
	"created_at" bigint,
	"updated_at" bigint
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "attendance_access" text DEFAULT 'false';--> statement-breakpoint
CREATE INDEX "att_audits_entity_ts_idx" ON "att_audits" ("entity","ts");--> statement-breakpoint
CREATE INDEX "att_audits_ts_idx" ON "att_audits" ("ts");--> statement-breakpoint
CREATE UNIQUE INDEX "att_departments_code_uidx" ON "att_departments" ("code");--> statement-breakpoint
CREATE UNIQUE INDEX "att_duty_unique_idx" ON "att_duty_assignments" ("duty_date","shift_id","employee_id");--> statement-breakpoint
CREATE INDEX "att_duty_date_idx" ON "att_duty_assignments" ("duty_date");--> statement-breakpoint
CREATE INDEX "att_duty_employee_idx" ON "att_duty_assignments" ("employee_id");--> statement-breakpoint
CREATE INDEX "att_duty_logs_employee_date_idx" ON "att_duty_logs" ("employee_id","duty_date");--> statement-breakpoint
CREATE INDEX "att_duty_logs_assignment_idx" ON "att_duty_logs" ("assignment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "att_employees_code_uidx" ON "att_employees" ("code");--> statement-breakpoint
CREATE UNIQUE INDEX "att_employees_user_uidx" ON "att_employees" ("user_id");--> statement-breakpoint
CREATE INDEX "att_employees_department_idx" ON "att_employees" ("department_id");--> statement-breakpoint
CREATE INDEX "att_holidays_range_idx" ON "att_holidays" ("start_date","end_date");--> statement-breakpoint
CREATE INDEX "att_leaves_employee_idx" ON "att_leaves" ("employee_id");--> statement-breakpoint
CREATE INDEX "att_leaves_range_idx" ON "att_leaves" ("from_date","to_date");--> statement-breakpoint
CREATE INDEX "att_leaves_status_idx" ON "att_leaves" ("status");--> statement-breakpoint
CREATE INDEX "att_notifications_employee_ts_idx" ON "att_notifications" ("employee_id","ts");--> statement-breakpoint
CREATE INDEX "att_punches_employee_date_idx" ON "att_punches" ("employee_id","work_date");--> statement-breakpoint
CREATE INDEX "att_punches_date_idx" ON "att_punches" ("work_date");--> statement-breakpoint
CREATE INDEX "att_requests_status_idx" ON "att_requests" ("status");--> statement-breakpoint
CREATE INDEX "att_requests_employee_idx" ON "att_requests" ("employee_id");--> statement-breakpoint
CREATE UNIQUE INDEX "att_shifts_code_uidx" ON "att_shifts" ("code");