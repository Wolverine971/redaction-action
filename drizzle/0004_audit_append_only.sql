-- Fill the new structured columns on log rows written before they existed.
UPDATE "audit_events" a
SET "entity_label" = e."label", "entity_type" = e."type"
FROM "entities" e
WHERE a."entity_id" = e."id" AND a."entity_label" IS NULL;--> statement-breakpoint

UPDATE "audit_events" a
SET "mention_text" = m."text", "document_id" = m."document_id", "page_number" = m."page_number"
FROM "mentions" m
WHERE a."mention_id" = m."id" AND a."mention_text" IS NULL;--> statement-breakpoint

UPDATE "audit_events"
SET
  "from_state" = CASE
    WHEN "details"->>'from' IN ('pending', 'flagged') THEN 'flagged'
    WHEN "details"->>'from' IN ('redact', 'redacted') THEN 'redacted'
    WHEN "details"->>'from' IN ('keep', 'kept') THEN 'kept'
    WHEN "action" LIKE 'mention.%' THEN 'follows'
  END,
  "to_state" = CASE
    WHEN "details"->>'to' IN ('pending', 'flagged') THEN 'flagged'
    WHEN "details"->>'to' IN ('redact', 'redacted') THEN 'redacted'
    WHEN "details"->>'to' IN ('keep', 'kept') THEN 'kept'
    WHEN "action" LIKE 'mention.%' THEN 'follows'
  END
WHERE ("action" ~ '^entity\.(redact|redacted|keep|kept)$' OR ("action" = 'entity.flagged' AND "actor" <> 'system') OR "action" ~ '^mention\.(redact|keep|clear)$')
  AND "to_state" IS NULL;--> statement-breakpoint

UPDATE "audit_events" SET "to_state" = 'flagged' WHERE "action" = 'entity.flagged' AND "actor" = 'system' AND "to_state" IS NULL;--> statement-breakpoint

-- "decided_by" on a mention used to mean whoever touched it last. Without an exception, that was the
-- person who confirmed or added it, so it moves to "assigned_by".
UPDATE "mentions"
SET "assigned_by" = "decided_by", "assigned_at" = "decided_at", "decided_by" = NULL, "decided_at" = NULL
WHERE "override" IS NULL AND "decided_by" IS NOT NULL;--> statement-breakpoint

-- The audit log is append-only. Rows can be removed only by deleting their whole batch.
CREATE OR REPLACE FUNCTION audit_events_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM batches WHERE id = OLD.batch_id) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'The audit log is append-only: entries cannot be changed or deleted (% on audit_events)', TG_OP;
END;
$$;--> statement-breakpoint

CREATE TRIGGER audit_events_append_only
BEFORE UPDATE OR DELETE ON "audit_events"
FOR EACH ROW EXECUTE FUNCTION audit_events_append_only();--> statement-breakpoint

CREATE OR REPLACE FUNCTION audit_events_no_truncate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'The audit log is append-only: TRUNCATE is not allowed on audit_events';
END;
$$;--> statement-breakpoint

CREATE TRIGGER audit_events_no_truncate
BEFORE TRUNCATE ON "audit_events"
FOR EACH STATEMENT EXECUTE FUNCTION audit_events_no_truncate();
