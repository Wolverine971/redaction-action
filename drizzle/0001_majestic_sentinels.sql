CREATE TABLE "audit_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"batch_id" uuid NOT NULL,
	"actor" text NOT NULL,
	"action" text NOT NULL,
	"entity_id" uuid,
	"mention_id" uuid,
	"summary" text NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'processing' NOT NULL,
	"stage" text DEFAULT 'Queued' NOT NULL,
	"error" text,
	"warning" text,
	"model" text,
	"usage" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "blocks" (
	"id" text PRIMARY KEY NOT NULL,
	"document_id" uuid NOT NULL,
	"page_number" integer NOT NULL,
	"position" integer NOT NULL,
	"text" text NOT NULL,
	"boxes" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"batch_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"filename" text NOT NULL,
	"page_count" integer DEFAULT 0 NOT NULL,
	"bytes" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "entities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"batch_id" uuid NOT NULL,
	"type" text NOT NULL,
	"label" text NOT NULL,
	"aliases" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"role" text,
	"ai_suggestion" text NOT NULL,
	"ai_confidence" real DEFAULT 0.5 NOT NULL,
	"ai_rationale" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_by" text DEFAULT 'ai' NOT NULL,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mentions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"batch_id" uuid NOT NULL,
	"entity_id" uuid,
	"document_id" uuid NOT NULL,
	"block_id" text NOT NULL,
	"page_number" integer NOT NULL,
	"start" integer NOT NULL,
	"end" integer NOT NULL,
	"text" text NOT NULL,
	"rects" jsonb NOT NULL,
	"source" text NOT NULL,
	"confidence" real DEFAULT 0.5 NOT NULL,
	"ai_decision" text DEFAULT 'inherit' NOT NULL,
	"ai_reason" text,
	"ambiguous" boolean DEFAULT false NOT NULL,
	"candidate_entity_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"ai_guess_confidence" real,
	"ai_guess_rationale" text,
	"assignment_confirmed" boolean DEFAULT false NOT NULL,
	"override" text,
	"decided_by" text,
	"decided_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "pages" (
	"document_id" uuid NOT NULL,
	"page_number" integer NOT NULL,
	"width" real NOT NULL,
	"height" real NOT NULL,
	CONSTRAINT "pages_document_id_page_number_pk" PRIMARY KEY("document_id","page_number")
);
--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_batch_id_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."batches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blocks" ADD CONSTRAINT "blocks_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_batch_id_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."batches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entities" ADD CONSTRAINT "entities_batch_id_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."batches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mentions" ADD CONSTRAINT "mentions_batch_id_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."batches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mentions" ADD CONSTRAINT "mentions_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mentions" ADD CONSTRAINT "mentions_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mentions" ADD CONSTRAINT "mentions_block_id_blocks_id_fk" FOREIGN KEY ("block_id") REFERENCES "public"."blocks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pages" ADD CONSTRAINT "pages_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_batch_idx" ON "audit_events" USING btree ("batch_id","created_at");--> statement-breakpoint
CREATE INDEX "blocks_document_idx" ON "blocks" USING btree ("document_id","page_number");--> statement-breakpoint
CREATE INDEX "documents_batch_idx" ON "documents" USING btree ("batch_id");--> statement-breakpoint
CREATE INDEX "entities_batch_idx" ON "entities" USING btree ("batch_id");--> statement-breakpoint
CREATE INDEX "mentions_batch_idx" ON "mentions" USING btree ("batch_id");--> statement-breakpoint
CREATE INDEX "mentions_entity_idx" ON "mentions" USING btree ("entity_id");--> statement-breakpoint
CREATE INDEX "mentions_document_idx" ON "mentions" USING btree ("document_id","page_number");