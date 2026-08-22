CREATE TABLE "push_subscriptions" (
	"id" text PRIMARY KEY,
	"user_id" text NOT NULL,
	"station_code" text,
	"endpoint" text NOT NULL,
	"keys_json" text,
	"user_agent" text,
	"created_at" bigint,
	"last_used_at" bigint
);
--> statement-breakpoint
CREATE TABLE "station_receivers" (
	"id" text PRIMARY KEY,
	"station_code" text NOT NULL,
	"user_id" text NOT NULL,
	"personal_zoom_url" text,
	"personal_meeting_id" text,
	"priority" integer DEFAULT 1,
	"notify_channels" text DEFAULT 'POPUP,SOUND,PUSH',
	"is_active" text DEFAULT 'true',
	"created_at" bigint,
	"updated_at" bigint
);
--> statement-breakpoint
CREATE TABLE "station_room_audits" (
	"id" serial PRIMARY KEY,
	"station_code" text NOT NULL,
	"actor_name" text,
	"actor_username" text,
	"action" text NOT NULL,
	"field" text,
	"old_value" text,
	"new_value" text,
	"ts" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "station_rooms" (
	"station_code" text PRIMARY KEY,
	"station_name" text NOT NULL,
	"note" text,
	"zoom_join_url" text,
	"zoom_meeting_id" text,
	"zoom_passcode" text,
	"zoom_host_email" text,
	"fallback_station_code" text,
	"ring_timeout_sec" integer DEFAULT 45,
	"duty_hours" text,
	"off_hours_mode" text DEFAULT 'SHOW',
	"status" text DEFAULT 'ACTIVE',
	"display_order" integer DEFAULT 0,
	"updated_by" text,
	"updated_at" bigint
);
--> statement-breakpoint
ALTER TABLE "telehealth_peers" ADD COLUMN "station_code" text;--> statement-breakpoint
ALTER TABLE "telehealth_peers" ADD COLUMN "user_id" text;--> statement-breakpoint
ALTER TABLE "telehealth_rooms" ADD COLUMN "station_code" text;--> statement-breakpoint
ALTER TABLE "telehealth_rooms" ADD COLUMN "routing_state" text DEFAULT 'WAITING';--> statement-breakpoint
ALTER TABLE "telehealth_rooms" ADD COLUMN "ringing_station" text;--> statement-breakpoint
ALTER TABLE "telehealth_rooms" ADD COLUMN "ringing_since" bigint;--> statement-breakpoint
ALTER TABLE "telehealth_rooms" ADD COLUMN "escalation_round" integer DEFAULT 0;--> statement-breakpoint
ALTER TABLE "telehealth_rooms" ADD COLUMN "accepted_by" text;--> statement-breakpoint
ALTER TABLE "telehealth_rooms" ADD COLUMN "accepted_name" text;--> statement-breakpoint
ALTER TABLE "telehealth_rooms" ADD COLUMN "accepted_at" bigint;--> statement-breakpoint
ALTER TABLE "telehealth_rooms" ADD COLUMN "zoom_join_url" text;--> statement-breakpoint
ALTER TABLE "telehealth_rooms" ADD COLUMN "zoom_meeting_id" text;--> statement-breakpoint
ALTER TABLE "telehealth_rooms" ADD COLUMN "zoom_passcode" text;--> statement-breakpoint
CREATE INDEX "push_subscriptions_user_idx" ON "push_subscriptions" ("user_id");--> statement-breakpoint
CREATE INDEX "station_receivers_station_idx" ON "station_receivers" ("station_code");--> statement-breakpoint
CREATE INDEX "station_receivers_user_idx" ON "station_receivers" ("user_id");--> statement-breakpoint
CREATE INDEX "station_room_audits_station_ts_idx" ON "station_room_audits" ("station_code","ts");--> statement-breakpoint
CREATE INDEX "station_rooms_status_idx" ON "station_rooms" ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "station_receivers_station_user_uidx" ON "station_receivers" ("station_code","user_id");--> statement-breakpoint
INSERT INTO "station_rooms" ("station_code","station_name","note","ring_timeout_sec","off_hours_mode","duty_hours","status","display_order","fallback_station_code","updated_by","updated_at") VALUES
  ('TYT-BATXAT-01','Trạm Y tế Bát Xát (Trung tâm)','Trực 24/7 - Phòng khám đa khoa',45,'SHOW','{"always":true}','ACTIVE',1,NULL,'migration',1787000000000),
  ('TYT-BATXAT-BQ-02','Điểm phòng khám Bản Qua','Khám thường - giờ hành chính',45,'SHOW','{"mon_sat":["07:30","17:00"]}','ACTIVE',2,'TYT-BATXAT-01','migration',1787000000000),
  ('TYT-BATXAT-BV-03','Điểm phòng khám Bản Vược','Khám thường - giờ hành chính',45,'SHOW','{"mon_sat":["07:30","17:00"]}','ACTIVE',3,'TYT-BATXAT-01','migration',1787000000000),
  ('TYT-BATXAT-QK-04','Điểm phòng khám Quang Kim','Khám thường - giờ hành chính',45,'SHOW','{"mon_sat":["07:30","17:00"]}','ACTIVE',4,'TYT-BATXAT-01','migration',1787000000000),
  ('TYT-BATXAT-PN-05','Điểm phòng khám Phìn Ngan','Khám thường - giờ hành chính',45,'SHOW','{"mon_sat":["07:30","17:00"]}','ACTIVE',5,'TYT-BATXAT-01','migration',1787000000000)
ON CONFLICT ("station_code") DO NOTHING;--> statement-breakpoint
INSERT INTO "station_receivers" ("id","station_code","user_id","priority","notify_channels","is_active","created_at","updated_at")
SELECT 'SR-' || "id", "station_code", "id", 1, 'POPUP,SOUND,PUSH', 'true', 1787000000000, 1787000000000
  FROM "users"
 WHERE "station_code" IS NOT NULL
   AND "station_code" <> ''
   AND coalesce("can_receive_video",'true') <> 'false'
   AND upper(coalesce("status",'ACTIVE')) = 'ACTIVE'
   AND EXISTS (SELECT 1 FROM "station_rooms" sr WHERE sr."station_code" = "users"."station_code")
ON CONFLICT DO NOTHING;--> statement-breakpoint
UPDATE "telehealth_rooms" SET "routing_state" = 'ENDED' WHERE "routing_state" IS NULL;
