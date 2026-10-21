CREATE TABLE "att_roster_snapshots" (
	"id" text PRIMARY KEY,
	"period" text NOT NULL,
	"reason" text NOT NULL,
	"row_count" integer NOT NULL,
	"rows" text NOT NULL,
	"restored_at" bigint,
	"restored_by" text,
	"created_by" text,
	"created_by_name" text,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX "att_roster_snapshots_period_idx" ON "att_roster_snapshots" ("period","created_at");