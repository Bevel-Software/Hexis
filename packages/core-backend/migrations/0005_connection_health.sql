CREATE TABLE "connection_health" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"manual_name" text NOT NULL,
	"status" text NOT NULL,
	"error" text,
	"checked_at" timestamp DEFAULT now() NOT NULL,
	"probe_started_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "connection_health_status" CHECK ("connection_health"."status" IN ('ok', 'failed', 'unverifiable'))
);
--> statement-breakpoint
ALTER TABLE "connection_health" ADD CONSTRAINT "connection_health_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "connection_health_by_manual" ON "connection_health" USING btree ("manual_name");--> statement-breakpoint
CREATE UNIQUE INDEX "connection_health_user_manual_unq" ON "connection_health" USING btree ("user_id","manual_name");