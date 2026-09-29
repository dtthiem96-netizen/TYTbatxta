CREATE TABLE "att_adjustments" (
	"id" text PRIMARY KEY,
	"target_type" text NOT NULL,
	"operation" text NOT NULL,
	"original_id" integer,
	"new_record_id" integer,
	"employee_id" text NOT NULL,
	"work_date" text,
	"request_id" text,
	"before_data" text,
	"after_data" text,
	"reason" text NOT NULL,
	"requested_by" text,
	"requested_by_name" text,
	"requested_at" bigint,
	"approved_by" text,
	"approved_by_name" text,
	"approved_at" bigint,
	"self_approved" text DEFAULT 'false',
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "att_alerts" (
	"id" serial PRIMARY KEY,
	"level" text NOT NULL,
	"category" text NOT NULL,
	"employee_id" text,
	"user_id" text,
	"device_hash" text,
	"attempt_id" integer,
	"title" text NOT NULL,
	"cause" text,
	"evidence" text,
	"day" text NOT NULL,
	"created_at" bigint NOT NULL,
	"status" text DEFAULT 'OPEN',
	"handled_by" text,
	"handled_by_name" text,
	"handled_at" bigint,
	"resolution" text,
	"resolution_note" text,
	"dedupe_key" text
);
--> statement-breakpoint
CREATE TABLE "att_attempts" (
	"id" serial PRIMARY KEY,
	"user_id" text NOT NULL,
	"employee_id" text,
	"kind" text NOT NULL,
	"server_ts" bigint NOT NULL,
	"work_date" text,
	"result" text NOT NULL,
	"risk_level" text NOT NULL,
	"reasons" text,
	"reject_message" text,
	"device_id" text,
	"device_hash" text,
	"device_signature_ok" text,
	"session_id" text,
	"ip" text,
	"user_agent" text,
	"lat" real,
	"lng" real,
	"accuracy_m" real,
	"distance_m" real,
	"geofence_ok" text,
	"location_age_ms" integer,
	"ip_geo" text,
	"client_ts" bigint,
	"clock_skew_ms" integer,
	"selfie_key" text,
	"selfie_sha256" text,
	"selfie_dhash" text,
	"liveness_result" text,
	"face_score" real,
	"ai_verdict" text,
	"qr_token_id" text,
	"nonce_id" text,
	"ref_type" text,
	"ref_id" text,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "att_devices" (
	"id" text PRIMARY KEY,
	"user_id" text NOT NULL,
	"employee_id" text,
	"device_hash" text NOT NULL,
	"public_key" text NOT NULL,
	"label" text,
	"platform" text,
	"user_agent" text,
	"status" text DEFAULT 'PENDING',
	"request_reason" text,
	"registration_attempt_id" integer,
	"first_ip" text,
	"last_ip" text,
	"created_at" bigint,
	"last_seen_at" bigint,
	"decided_by" text,
	"decided_by_name" text,
	"decided_at" bigint,
	"decision_note" text
);
--> statement-breakpoint
CREATE TABLE "att_face_templates" (
	"employee_id" text PRIMARY KEY,
	"vector" text NOT NULL,
	"dhash" text,
	"reference_key" text,
	"source_attempt_id" integer,
	"enrolled_by" text,
	"enrolled_by_name" text,
	"enrolled_at" bigint,
	"status" text DEFAULT 'ACTIVE'
);
--> statement-breakpoint
CREATE TABLE "att_nonces" (
	"id" text PRIMARY KEY,
	"user_id" text NOT NULL,
	"employee_id" text,
	"purpose" text NOT NULL,
	"challenge" text,
	"issued_at" bigint NOT NULL,
	"expires_at" bigint NOT NULL,
	"used_at" bigint,
	"ip" text
);
--> statement-breakpoint
CREATE TABLE "att_qr_tokens" (
	"id" text PRIMARY KEY,
	"code_hash" text NOT NULL,
	"issued_by" text,
	"issued_at" bigint NOT NULL,
	"expires_at" bigint NOT NULL,
	"used_at" bigint,
	"used_by_employee_id" text
);
--> statement-breakpoint
CREATE TABLE "auth_rate_limits" (
	"key" text PRIMARY KEY,
	"window_start" bigint NOT NULL,
	"count" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_sessions" (
	"id" text PRIMARY KEY,
	"user_id" text NOT NULL,
	"ip" text,
	"user_agent" text,
	"device_hash" text,
	"last_ip" text,
	"ip_changes" integer DEFAULT 0,
	"created_at" bigint NOT NULL,
	"last_seen_at" bigint,
	"expires_at" bigint NOT NULL,
	"revoked_at" bigint,
	"revoked_reason" text
);
--> statement-breakpoint
ALTER TABLE "att_audits" ADD COLUMN "user_agent" text;--> statement-breakpoint
ALTER TABLE "att_audits" ADD COLUMN "device_id" text;--> statement-breakpoint
ALTER TABLE "att_audits" ADD COLUMN "reason" text;--> statement-breakpoint
ALTER TABLE "att_audits" ADD COLUMN "approver_id" text;--> statement-breakpoint
ALTER TABLE "att_audits" ADD COLUMN "approver_name" text;--> statement-breakpoint
ALTER TABLE "att_audits" ADD COLUMN "seq" bigint;--> statement-breakpoint
ALTER TABLE "att_audits" ADD COLUMN "prev_hash" text;--> statement-breakpoint
ALTER TABLE "att_audits" ADD COLUMN "hash" text;--> statement-breakpoint
ALTER TABLE "att_duty_logs" ADD COLUMN "state" text DEFAULT 'ACTIVE';--> statement-breakpoint
ALTER TABLE "att_duty_logs" ADD COLUMN "superseded_by" integer;--> statement-breakpoint
ALTER TABLE "att_duty_logs" ADD COLUMN "adjustment_id" text;--> statement-breakpoint
ALTER TABLE "att_duty_logs" ADD COLUMN "check_in_attempt_id" integer;--> statement-breakpoint
ALTER TABLE "att_duty_logs" ADD COLUMN "check_out_attempt_id" integer;--> statement-breakpoint
ALTER TABLE "att_duty_logs" ADD COLUMN "risk_level" text;--> statement-breakpoint
ALTER TABLE "att_duty_logs" ADD COLUMN "approval_status" text DEFAULT 'APPROVED';--> statement-breakpoint
ALTER TABLE "att_duty_logs" ADD COLUMN "approved_by" text;--> statement-breakpoint
ALTER TABLE "att_duty_logs" ADD COLUMN "approved_by_name" text;--> statement-breakpoint
ALTER TABLE "att_duty_logs" ADD COLUMN "approved_at" bigint;--> statement-breakpoint
ALTER TABLE "att_duty_logs" ADD COLUMN "dedupe_key" text;--> statement-breakpoint
ALTER TABLE "att_punches" ADD COLUMN "state" text DEFAULT 'ACTIVE';--> statement-breakpoint
ALTER TABLE "att_punches" ADD COLUMN "superseded_by" integer;--> statement-breakpoint
ALTER TABLE "att_punches" ADD COLUMN "adjustment_id" text;--> statement-breakpoint
ALTER TABLE "att_punches" ADD COLUMN "attempt_id" integer;--> statement-breakpoint
ALTER TABLE "att_punches" ADD COLUMN "risk_level" text;--> statement-breakpoint
ALTER TABLE "att_punches" ADD COLUMN "dedupe_key" text;--> statement-breakpoint
CREATE INDEX "att_adjustments_employee_idx" ON "att_adjustments" ("employee_id","work_date");--> statement-breakpoint
CREATE INDEX "att_adjustments_created_idx" ON "att_adjustments" ("created_at");--> statement-breakpoint
CREATE INDEX "att_alerts_day_idx" ON "att_alerts" ("day");--> statement-breakpoint
CREATE INDEX "att_alerts_status_idx" ON "att_alerts" ("status");--> statement-breakpoint
CREATE INDEX "att_alerts_employee_idx" ON "att_alerts" ("employee_id");--> statement-breakpoint
CREATE UNIQUE INDEX "att_alerts_dedupe_uidx" ON "att_alerts" ("dedupe_key");--> statement-breakpoint
CREATE INDEX "att_attempts_employee_ts_idx" ON "att_attempts" ("employee_id","server_ts");--> statement-breakpoint
CREATE INDEX "att_attempts_ts_idx" ON "att_attempts" ("server_ts");--> statement-breakpoint
CREATE INDEX "att_attempts_device_idx" ON "att_attempts" ("device_hash");--> statement-breakpoint
CREATE INDEX "att_attempts_sha_idx" ON "att_attempts" ("selfie_sha256");--> statement-breakpoint
CREATE INDEX "att_audits_seq_idx" ON "att_audits" ("seq");--> statement-breakpoint
CREATE UNIQUE INDEX "att_devices_user_hash_uidx" ON "att_devices" ("user_id","device_hash");--> statement-breakpoint
CREATE INDEX "att_devices_hash_idx" ON "att_devices" ("device_hash");--> statement-breakpoint
CREATE INDEX "att_devices_status_idx" ON "att_devices" ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "att_duty_logs_dedupe_uidx" ON "att_duty_logs" ("dedupe_key");--> statement-breakpoint
CREATE INDEX "att_nonces_expires_idx" ON "att_nonces" ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "att_punches_dedupe_uidx" ON "att_punches" ("dedupe_key");--> statement-breakpoint
CREATE UNIQUE INDEX "att_qr_tokens_code_uidx" ON "att_qr_tokens" ("code_hash");--> statement-breakpoint
CREATE INDEX "att_qr_tokens_expires_idx" ON "att_qr_tokens" ("expires_at");--> statement-breakpoint
CREATE INDEX "auth_sessions_user_idx" ON "auth_sessions" ("user_id","created_at");