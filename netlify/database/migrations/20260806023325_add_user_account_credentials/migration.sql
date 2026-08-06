ALTER TABLE "users" ADD COLUMN "password_hash" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "email" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "phone" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "station_code" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "status" text DEFAULT 'ACTIVE';--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "must_change_password" text DEFAULT 'false';--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "created_at" bigint;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "updated_at" bigint;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "last_login_at" bigint;--> statement-breakpoint
CREATE INDEX "users_station_code_idx" ON "users" ("station_code");--> statement-breakpoint
UPDATE "users" SET "status" = 'ACTIVE' WHERE "status" IS NULL;--> statement-breakpoint
UPDATE "users" SET "must_change_password" = 'false' WHERE "must_change_password" IS NULL;--> statement-breakpoint
UPDATE "users" SET "email" = "username" WHERE "email" IS NULL AND "username" LIKE '%@%';--> statement-breakpoint
UPDATE "users" SET "station_code" = 'TYT-BATXAT-01' WHERE "station_code" IS NULL;
