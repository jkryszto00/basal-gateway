CREATE TABLE "organization_quotas" (
	"organization_id" text PRIMARY KEY NOT NULL,
	"monthly_requests" integer,
	"monthly_tokens" bigint,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "monthly_requests" integer;--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "monthly_tokens" bigint;--> statement-breakpoint
ALTER TABLE "organization_quotas" ADD CONSTRAINT "organization_quotas_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;