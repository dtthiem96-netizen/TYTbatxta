CREATE TABLE "att_duty_group_members" (
	"id" text PRIMARY KEY,
	"group_id" text NOT NULL,
	"employee_id" text NOT NULL,
	"status" text DEFAULT 'APPROVED',
	"approved_by" text,
	"approved_by_name" text,
	"approved_at" bigint,
	"created_at" bigint
);
--> statement-breakpoint
CREATE TABLE "att_duty_groups" (
	"id" text PRIMARY KEY,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"station_code" text NOT NULL,
	"note" text,
	"status" text DEFAULT 'ACTIVE',
	"created_at" bigint,
	"updated_at" bigint
);
--> statement-breakpoint
CREATE TABLE "att_duty_rules" (
	"id" text PRIMARY KEY,
	"name" text NOT NULL,
	"station_code" text NOT NULL,
	"department_id" text,
	"workplace_id" text,
	"duty_group_id" text,
	"shift_id" text NOT NULL,
	"weekday_headcount" text NOT NULL,
	"holiday_headcount" integer,
	"effective_from" text NOT NULL,
	"effective_to" text,
	"eligible_employee_ids" text DEFAULT '[]',
	"allow_cross_station" text DEFAULT 'false',
	"max_per_month" integer,
	"max_weekend_holiday_per_month" integer,
	"priority" integer DEFAULT 0,
	"status" text DEFAULT 'ACTIVE',
	"note" text,
	"created_by" text,
	"created_at" bigint,
	"updated_at" bigint
);
--> statement-breakpoint
CREATE TABLE "att_employee_postings" (
	"id" text PRIMARY KEY,
	"employee_id" text NOT NULL,
	"station_code" text,
	"department_id" text,
	"workplace_id" text,
	"effective_from" text NOT NULL,
	"reason" text,
	"created_by" text,
	"created_by_name" text,
	"created_at" bigint
);
--> statement-breakpoint
CREATE TABLE "att_secondments" (
	"id" text PRIMARY KEY,
	"employee_id" text NOT NULL,
	"station_code" text NOT NULL,
	"workplace_id" text,
	"valid_from" text NOT NULL,
	"valid_to" text NOT NULL,
	"decision_ref" text,
	"reason" text,
	"status" text DEFAULT 'PENDING',
	"requested_by" text,
	"requested_by_name" text,
	"approved_by" text,
	"approved_by_name" text,
	"approved_at" bigint,
	"created_at" bigint,
	"updated_at" bigint
);
--> statement-breakpoint
CREATE TABLE "att_workplaces" (
	"id" text PRIMARY KEY,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"station_code" text NOT NULL,
	"department_id" text,
	"note" text,
	"display_order" integer DEFAULT 0,
	"status" text DEFAULT 'ACTIVE',
	"created_at" bigint,
	"updated_at" bigint
);
--> statement-breakpoint
ALTER TABLE "att_duty_assignments" ADD COLUMN "station_code" text;--> statement-breakpoint
ALTER TABLE "att_duty_assignments" ADD COLUMN "department_id" text;--> statement-breakpoint
ALTER TABLE "att_duty_assignments" ADD COLUMN "workplace_id" text;--> statement-breakpoint
ALTER TABLE "att_duty_assignments" ADD COLUMN "rule_id" text;--> statement-breakpoint
ALTER TABLE "att_employees" ADD COLUMN "station_code" text;--> statement-breakpoint
ALTER TABLE "att_employees" ADD COLUMN "workplace_id" text;--> statement-breakpoint
ALTER TABLE "att_employees" ADD COLUMN "duty_status" text DEFAULT 'ACTIVE';--> statement-breakpoint
ALTER TABLE "att_employees" ADD COLUMN "allowed_shift_ids" text DEFAULT '[]';--> statement-breakpoint
ALTER TABLE "att_employees" ADD COLUMN "duty_rule" text;--> statement-breakpoint
CREATE INDEX "att_duty_station_date_idx" ON "att_duty_assignments" ("station_code","duty_date");--> statement-breakpoint
CREATE UNIQUE INDEX "att_duty_group_members_uidx" ON "att_duty_group_members" ("group_id","employee_id");--> statement-breakpoint
CREATE INDEX "att_duty_group_members_employee_idx" ON "att_duty_group_members" ("employee_id");--> statement-breakpoint
CREATE UNIQUE INDEX "att_duty_groups_code_uidx" ON "att_duty_groups" ("code");--> statement-breakpoint
CREATE INDEX "att_duty_rules_station_idx" ON "att_duty_rules" ("station_code","shift_id");--> statement-breakpoint
CREATE UNIQUE INDEX "att_employee_postings_uidx" ON "att_employee_postings" ("employee_id","effective_from");--> statement-breakpoint
CREATE INDEX "att_employees_station_idx" ON "att_employees" ("station_code");--> statement-breakpoint
CREATE INDEX "att_secondments_employee_idx" ON "att_secondments" ("employee_id","valid_from");--> statement-breakpoint
CREATE UNIQUE INDEX "att_workplaces_code_uidx" ON "att_workplaces" ("code");--> statement-breakpoint
CREATE INDEX "att_workplaces_station_idx" ON "att_workplaces" ("station_code");--> statement-breakpoint
ALTER TABLE "att_duty_assignments" ADD CONSTRAINT "att_duty_assignments_hvdKSKRnSRcl_fkey" FOREIGN KEY ("station_code") REFERENCES "station_rooms"("station_code");--> statement-breakpoint
ALTER TABLE "att_duty_assignments" ADD CONSTRAINT "att_duty_assignments_department_id_att_departments_id_fkey" FOREIGN KEY ("department_id") REFERENCES "att_departments"("id");--> statement-breakpoint
ALTER TABLE "att_duty_assignments" ADD CONSTRAINT "att_duty_assignments_workplace_id_att_workplaces_id_fkey" FOREIGN KEY ("workplace_id") REFERENCES "att_workplaces"("id");--> statement-breakpoint
ALTER TABLE "att_duty_assignments" ADD CONSTRAINT "att_duty_assignments_rule_id_att_duty_rules_id_fkey" FOREIGN KEY ("rule_id") REFERENCES "att_duty_rules"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "att_duty_group_members" ADD CONSTRAINT "att_duty_group_members_group_id_att_duty_groups_id_fkey" FOREIGN KEY ("group_id") REFERENCES "att_duty_groups"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "att_duty_group_members" ADD CONSTRAINT "att_duty_group_members_employee_id_att_employees_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "att_employees"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "att_duty_groups" ADD CONSTRAINT "att_duty_groups_station_code_station_rooms_station_code_fkey" FOREIGN KEY ("station_code") REFERENCES "station_rooms"("station_code");--> statement-breakpoint
ALTER TABLE "att_duty_rules" ADD CONSTRAINT "att_duty_rules_station_code_station_rooms_station_code_fkey" FOREIGN KEY ("station_code") REFERENCES "station_rooms"("station_code");--> statement-breakpoint
ALTER TABLE "att_duty_rules" ADD CONSTRAINT "att_duty_rules_department_id_att_departments_id_fkey" FOREIGN KEY ("department_id") REFERENCES "att_departments"("id");--> statement-breakpoint
ALTER TABLE "att_duty_rules" ADD CONSTRAINT "att_duty_rules_workplace_id_att_workplaces_id_fkey" FOREIGN KEY ("workplace_id") REFERENCES "att_workplaces"("id");--> statement-breakpoint
ALTER TABLE "att_duty_rules" ADD CONSTRAINT "att_duty_rules_duty_group_id_att_duty_groups_id_fkey" FOREIGN KEY ("duty_group_id") REFERENCES "att_duty_groups"("id");--> statement-breakpoint
ALTER TABLE "att_duty_rules" ADD CONSTRAINT "att_duty_rules_shift_id_att_shifts_id_fkey" FOREIGN KEY ("shift_id") REFERENCES "att_shifts"("id");--> statement-breakpoint
ALTER TABLE "att_employee_postings" ADD CONSTRAINT "att_employee_postings_employee_id_att_employees_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "att_employees"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "att_employee_postings" ADD CONSTRAINT "att_employee_postings_ik0sS6mdL0Yy_fkey" FOREIGN KEY ("station_code") REFERENCES "station_rooms"("station_code");--> statement-breakpoint
ALTER TABLE "att_employee_postings" ADD CONSTRAINT "att_employee_postings_department_id_att_departments_id_fkey" FOREIGN KEY ("department_id") REFERENCES "att_departments"("id");--> statement-breakpoint
ALTER TABLE "att_employee_postings" ADD CONSTRAINT "att_employee_postings_workplace_id_att_workplaces_id_fkey" FOREIGN KEY ("workplace_id") REFERENCES "att_workplaces"("id");--> statement-breakpoint
-- Hồ sơ cán bộ trỏ tới bộ phận đã không còn thì khoá ngoại mới không tạo được.
-- Bỏ liên kết hỏng (không có bộ phận nào để trỏ tới) thay vì để migration thất bại.
UPDATE "att_employees" SET "department_id" = NULL
 WHERE "department_id" IS NOT NULL
   AND "department_id" NOT IN (SELECT "id" FROM "att_departments");--> statement-breakpoint
ALTER TABLE "att_employees" ADD CONSTRAINT "att_employees_department_id_att_departments_id_fkey" FOREIGN KEY ("department_id") REFERENCES "att_departments"("id");--> statement-breakpoint
ALTER TABLE "att_employees" ADD CONSTRAINT "att_employees_station_code_station_rooms_station_code_fkey" FOREIGN KEY ("station_code") REFERENCES "station_rooms"("station_code");--> statement-breakpoint
ALTER TABLE "att_employees" ADD CONSTRAINT "att_employees_workplace_id_att_workplaces_id_fkey" FOREIGN KEY ("workplace_id") REFERENCES "att_workplaces"("id");--> statement-breakpoint
ALTER TABLE "att_secondments" ADD CONSTRAINT "att_secondments_employee_id_att_employees_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "att_employees"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "att_secondments" ADD CONSTRAINT "att_secondments_station_code_station_rooms_station_code_fkey" FOREIGN KEY ("station_code") REFERENCES "station_rooms"("station_code");--> statement-breakpoint
ALTER TABLE "att_secondments" ADD CONSTRAINT "att_secondments_workplace_id_att_workplaces_id_fkey" FOREIGN KEY ("workplace_id") REFERENCES "att_workplaces"("id");--> statement-breakpoint
ALTER TABLE "att_workplaces" ADD CONSTRAINT "att_workplaces_station_code_station_rooms_station_code_fkey" FOREIGN KEY ("station_code") REFERENCES "station_rooms"("station_code");--> statement-breakpoint
ALTER TABLE "att_workplaces" ADD CONSTRAINT "att_workplaces_department_id_att_departments_id_fkey" FOREIGN KEY ("department_id") REFERENCES "att_departments"("id");