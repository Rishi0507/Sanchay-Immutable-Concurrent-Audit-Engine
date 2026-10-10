-- Service roles (PRD section 4.4). Passwords here are development defaults.
-- Change them with ALTER ROLE and the matching service environment variables
-- before any shared deployment.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ledger_rw') THEN
    CREATE ROLE ledger_rw LOGIN PASSWORD 'ledger_rw';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'engine_audit') THEN
    CREATE ROLE engine_audit LOGIN PASSWORD 'engine_audit';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mcp_read') THEN
    CREATE ROLE mcp_read LOGIN PASSWORD 'mcp_read';
  END IF;
END;
$$;

REVOKE ALL ON SCHEMA business, audit, trail FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA business, audit, trail FROM PUBLIC;

-- Ledger core: the only writer of business and trail.
GRANT USAGE ON SCHEMA business, trail TO ledger_rw;
GRANT SELECT, INSERT ON ALL TABLES IN SCHEMA business, trail TO ledger_rw;

-- Audit engine: reads business and trail, writes audit. It holds no
-- privilege that can write to business (L3).
GRANT USAGE ON SCHEMA business, audit, trail TO engine_audit;
GRANT SELECT ON ALL TABLES IN SCHEMA business, trail TO engine_audit;
GRANT SELECT, INSERT ON ALL TABLES IN SCHEMA audit TO engine_audit;
GRANT CREATE ON SCHEMA audit TO engine_audit;

-- MCP server: read only everywhere.
GRANT USAGE ON SCHEMA business, audit, trail TO mcp_read;
GRANT SELECT ON ALL TABLES IN SCHEMA business, audit, trail TO mcp_read;

-- Tables the engine creates later in audit stay readable by the MCP server.
ALTER DEFAULT PRIVILEGES FOR ROLE engine_audit IN SCHEMA audit
  GRANT SELECT ON TABLES TO mcp_read;
