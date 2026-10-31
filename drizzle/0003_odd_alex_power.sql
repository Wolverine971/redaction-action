ALTER TABLE "audit_events" ADD COLUMN "entity_label" text;--> statement-breakpoint
ALTER TABLE "audit_events" ADD COLUMN "entity_type" text;--> statement-breakpoint
ALTER TABLE "audit_events" ADD COLUMN "mention_text" text;--> statement-breakpoint
ALTER TABLE "audit_events" ADD COLUMN "document_id" uuid;--> statement-breakpoint
ALTER TABLE "audit_events" ADD COLUMN "page_number" integer;--> statement-breakpoint
ALTER TABLE "audit_events" ADD COLUMN "from_state" text;--> statement-breakpoint
ALTER TABLE "audit_events" ADD COLUMN "to_state" text;--> statement-breakpoint
ALTER TABLE "mentions" ADD COLUMN "assigned_by" text;--> statement-breakpoint
ALTER TABLE "mentions" ADD COLUMN "assigned_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "audit_entity_idx" ON "audit_events" USING btree ("entity_id");