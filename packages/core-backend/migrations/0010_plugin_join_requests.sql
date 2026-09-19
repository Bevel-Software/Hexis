CREATE TABLE "plugin_join_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"requester_email" text NOT NULL,
	"requester_name" text NOT NULL,
	"plugin_key" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"failure_reason" text,
	"change_request_number" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "plugin_join_requests_status" CHECK ("plugin_join_requests"."status" IN ('pending', 'opened', 'failed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "plugin_join_requests_requester_plugin_unq" ON "plugin_join_requests" USING btree ("requester_email","plugin_key");--> statement-breakpoint
CREATE INDEX "plugin_join_requests_by_status" ON "plugin_join_requests" USING btree ("status");