CREATE TABLE "telehealth_peers" (
	"id" text PRIMARY KEY,
	"room_id" text NOT NULL,
	"role" text NOT NULL,
	"name" text NOT NULL,
	"last_seen" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "telehealth_rooms" (
	"id" text PRIMARY KEY,
	"patient_name" text,
	"symptoms" text,
	"vitals" text,
	"notes" text,
	"status" text DEFAULT 'WAITING',
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "telehealth_signals" (
	"seq" serial PRIMARY KEY,
	"room_id" text NOT NULL,
	"from_peer" text NOT NULL,
	"to_peer" text,
	"type" text NOT NULL,
	"payload" text,
	"ts" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX "telehealth_peers_room_idx" ON "telehealth_peers" ("room_id");--> statement-breakpoint
CREATE INDEX "telehealth_signals_room_seq_idx" ON "telehealth_signals" ("room_id","seq");