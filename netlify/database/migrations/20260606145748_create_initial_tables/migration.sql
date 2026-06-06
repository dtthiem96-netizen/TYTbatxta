CREATE TABLE "documents" (
	"id" text PRIMARY KEY,
	"title" text NOT NULL,
	"type" text NOT NULL,
	"url" text NOT NULL,
	"date" text NOT NULL,
	"ts" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "news" (
	"id" text PRIMARY KEY,
	"title" text NOT NULL,
	"description" text,
	"date" text NOT NULL,
	"ts" bigint NOT NULL,
	"icon" text,
	"color" text
);
--> statement-breakpoint
CREATE TABLE "services" (
	"id" text PRIMARY KEY,
	"name" text NOT NULL,
	"person" text NOT NULL,
	"zalo" text NOT NULL,
	"ts" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY,
	"username" text NOT NULL UNIQUE,
	"name" text NOT NULL,
	"role" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vaccines" (
	"id" text PRIMARY KEY,
	"date" text NOT NULL,
	"time" text NOT NULL,
	"target" text NOT NULL,
	"ts" bigint NOT NULL
);
