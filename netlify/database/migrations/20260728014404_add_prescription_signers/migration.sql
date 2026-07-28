CREATE TABLE "prescription_signers" (
	"id" text PRIMARY KEY,
	"name" text NOT NULL,
	"title" text DEFAULT 'Bác sỹ' NOT NULL,
	"license" text,
	"workplace" text,
	"signature" text,
	"is_default" text DEFAULT 'false',
	"ts" bigint NOT NULL
);
