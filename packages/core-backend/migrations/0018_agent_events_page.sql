-- A page's calls in the Audit log: an HTML page of the knowledge base that
-- calls the viewer's tools is recorded under its own path (`page_path`), as a
-- third kind of principal beside the connection key and the agent connection,
-- and a call the viewer refused it is recorded as `refused`. Exactly one
-- principal per row still holds, now over the three columns.
ALTER TABLE "agent_events" DROP CONSTRAINT "agent_events_outcome";--> statement-breakpoint
ALTER TABLE "agent_events" DROP CONSTRAINT "agent_events_principal";--> statement-breakpoint
ALTER TABLE "agent_events" ADD COLUMN "page_path" text;--> statement-breakpoint
CREATE INDEX "agent_events_by_page" ON "agent_events" USING btree ("user_id","page_path","at");--> statement-breakpoint
ALTER TABLE "agent_events" ADD CONSTRAINT "agent_events_outcome" CHECK ("agent_events"."outcome" IN ('ok', 'error', 'denied', 'refused'));--> statement-breakpoint
ALTER TABLE "agent_events" ADD CONSTRAINT "agent_events_principal" CHECK (num_nonnulls("agent_events"."key_id", "agent_events"."connection_id", "agent_events"."page_path") = 1);