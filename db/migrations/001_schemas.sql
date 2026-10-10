-- Schemas and the append-only guard (PRD sections 4.3 and 4.4).
-- Run as a superuser. Files in this directory are applied in name order.

CREATE SCHEMA IF NOT EXISTS business;
CREATE SCHEMA IF NOT EXISTS audit;
CREATE SCHEMA IF NOT EXISTS trail;

-- L4: no row in any of the three schemas can be changed or removed.
CREATE OR REPLACE FUNCTION public.reject_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'append-only: % on %.% is not permitted', TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE OR REPLACE FUNCTION public.attach_append_only(target regclass) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = target AND tgname = 'append_only_row') THEN
    RETURN;
  END IF;
  EXECUTE format(
    'CREATE TRIGGER append_only_row BEFORE UPDATE OR DELETE ON %s
       FOR EACH ROW EXECUTE FUNCTION public.reject_mutation()', target);
  EXECUTE format(
    'CREATE TRIGGER append_only_truncate BEFORE TRUNCATE ON %s
       FOR EACH STATEMENT EXECUTE FUNCTION public.reject_mutation()', target);
END;
$$;

-- Any table created later in these schemas receives the guard automatically,
-- so a new audit table cannot be left unprotected by omission.
CREATE OR REPLACE FUNCTION public.guard_new_tables() RETURNS event_trigger
LANGUAGE plpgsql AS $$
DECLARE
  obj record;
BEGIN
  FOR obj IN SELECT * FROM pg_event_trigger_ddl_commands()
             WHERE command_tag = 'CREATE TABLE' AND object_type = 'table'
  LOOP
    IF obj.schema_name IN ('business', 'audit', 'trail') THEN
      PERFORM public.attach_append_only(obj.objid::regclass);
    END IF;
  END LOOP;
END;
$$;

DROP EVENT TRIGGER IF EXISTS guard_new_tables;
CREATE EVENT TRIGGER guard_new_tables ON ddl_command_end
  WHEN TAG IN ('CREATE TABLE')
  EXECUTE FUNCTION public.guard_new_tables();
