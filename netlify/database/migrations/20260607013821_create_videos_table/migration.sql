CREATE TABLE "videos" (
	"id" text PRIMARY KEY,
	"title" text NOT NULL,
	"description" text,
	"url" text NOT NULL,
	"date" text NOT NULL,
	"ts" bigint NOT NULL,
	"is_collapsed" text DEFAULT 'false'
);
