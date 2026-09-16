ALTER TABLE "change_requests" ADD COLUMN "apply_failure_reason" text;--> statement-breakpoint
ALTER TABLE "change_requests" ADD COLUMN "apply_failure_conflicts" boolean;--> statement-breakpoint
ALTER TABLE "change_requests" ADD COLUMN "apply_failed_at" timestamp;--> statement-breakpoint
ALTER TABLE "change_requests" ADD COLUMN "apply_failed_by_name" text;