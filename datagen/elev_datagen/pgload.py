"""Development helper: copy a fixture into Postgres tables shaped like contracts/events/read-model.md.

Used to test the engine's Postgres path before the ledger core exists. The real
business schema, roles and triggers are owned by db/ (Person A).
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

DDL = """
CREATE SCHEMA IF NOT EXISTS business;
CREATE TABLE IF NOT EXISTS business.events (
  seq bigint PRIMARY KEY, event_type text NOT NULL, entity_id text NOT NULL, aggregate_id text NOT NULL,
  aggregate_version integer NOT NULL, sale_id text, payload jsonb NOT NULL, business_date date NOT NULL,
  recorded_at timestamptz NOT NULL, identity_user text NOT NULL, identity_role text NOT NULL,
  idempotency_key text NOT NULL, prev_hash char(64) NOT NULL, hash char(64) NOT NULL);
CREATE TABLE IF NOT EXISTS business.postings (
  seq bigint NOT NULL, line_no integer NOT NULL, entity_id text NOT NULL, account text NOT NULL,
  debit bigint NOT NULL, credit bigint NOT NULL, sale_id text, source_event_type text NOT NULL,
  business_date date NOT NULL, PRIMARY KEY (seq, line_no));
"""


def load(fixture_dir: str, url: str) -> int:
    import psycopg

    d = Path(fixture_dir)
    with psycopg.connect(url) as conn, conn.cursor() as cur:
        cur.execute(DDL)
        cur.execute("TRUNCATE business.events, business.postings")
        with cur.copy("COPY business.events FROM STDIN") as cp:
            for line in (d / "events.jsonl").open(encoding="utf-8"):
                e = json.loads(line)
                cp.write_row([e["seq"], e["event_type"], e["entity_id"], e["aggregate_id"], e["aggregate_version"],
                              e["sale_id"], json.dumps(e["payload"], ensure_ascii=False), e["business_date"],
                              e["recorded_at"], e["identity"]["user"], e["identity"]["role"], e["idempotency_key"],
                              e["prev_hash"], e["hash"]])
        n = 0
        with cur.copy("COPY business.postings FROM STDIN") as cp:
            for line in (d / "postings.jsonl").open(encoding="utf-8"):
                p = json.loads(line)
                cp.write_row([p["seq"], p["line_no"], p["entity_id"], p["account"], p["debit"], p["credit"],
                              p["sale_id"], p["source_event_type"], p["business_date"]])
                n += 1
    return n


if __name__ == "__main__":
    print(load(sys.argv[1], sys.argv[2]))
