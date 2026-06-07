CREATE TABLE "contacts" (
	"id" text PRIMARY KEY,
	"name" text NOT NULL,
	"role" text NOT NULL,
	"phone" text NOT NULL,
	"ts" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "news" ADD COLUMN "image" text;