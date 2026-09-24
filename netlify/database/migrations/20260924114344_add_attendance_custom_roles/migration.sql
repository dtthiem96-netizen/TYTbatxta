CREATE TABLE "att_roles" (
	"id" text PRIMARY KEY,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"scope" text DEFAULT 'SELF',
	"permissions" text DEFAULT '[]',
	"display_order" integer DEFAULT 0,
	"status" text DEFAULT 'ACTIVE',
	"created_by" text,
	"created_at" bigint,
	"updated_at" bigint
);
--> statement-breakpoint
CREATE UNIQUE INDEX "att_roles_code_uidx" ON "att_roles" ("code");