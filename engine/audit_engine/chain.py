"""Hash chain and Merkle reference implementation (PRD section 8.3, contracts/events)."""

from __future__ import annotations

import hashlib
import json
from typing import Iterable, Mapping

GENESIS = "0" * 64
ENVELOPE_FIELDS = (
    "seq", "event_type", "entity_id", "aggregate_id", "aggregate_version", "sale_id", "payload",
    "business_date", "recorded_at", "identity", "idempotency_key", "prev_hash",
)


def canonical_json(value: object) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False)


def sha256_hex(data: bytes | str) -> str:
    if isinstance(data, str):
        data = data.encode("utf-8")
    return hashlib.sha256(data).hexdigest()


def hashed_content(event: Mapping) -> dict:
    return {k: event.get(k) for k in ENVELOPE_FIELDS}


def event_hash(event: Mapping) -> str:
    content = hashed_content(event)
    return sha256_hex(content["prev_hash"] + canonical_json(content))


def verify_chain(events: Iterable[Mapping], expected_first_prev: str = GENESIS) -> dict:
    """Recompute a chain. Events must be in seq order starting at the first seq given.

    Returns ok, first_bad_seq, head_seq, head_hash and the reason for the first break.
    """
    prev = expected_first_prev
    expected_seq = None
    head_seq, head_hash = 0, GENESIS
    for ev in events:
        seq = ev["seq"]
        if expected_seq is not None and seq != expected_seq:
            return {"ok": False, "first_bad_seq": expected_seq, "head_seq": head_seq, "head_hash": head_hash,
                    "reason": f"sequence gap: expected {expected_seq}, found {seq}"}
        if ev["prev_hash"] != prev:
            return {"ok": False, "first_bad_seq": seq, "head_seq": head_seq, "head_hash": head_hash,
                    "reason": "prev_hash does not equal the hash of the previous event"}
        computed = event_hash(ev)
        if computed != ev["hash"]:
            return {"ok": False, "first_bad_seq": seq, "head_seq": head_seq, "head_hash": head_hash,
                    "reason": "stored hash does not equal the recomputed hash"}
        prev = computed
        head_seq, head_hash = seq, computed
        expected_seq = seq + 1
    return {"ok": True, "first_bad_seq": None, "head_seq": head_seq, "head_hash": head_hash, "reason": None}


def merkle_root(leaf_hashes: list[str]) -> str:
    """Binary Merkle root over hex leaf hashes. An odd node is promoted unchanged."""
    if not leaf_hashes:
        return GENESIS
    level = [bytes.fromhex(h) for h in leaf_hashes]
    while len(level) > 1:
        nxt = []
        for i in range(0, len(level), 2):
            if i + 1 < len(level):
                nxt.append(hashlib.sha256(level[i] + level[i + 1]).digest())
            else:
                nxt.append(level[i])
        level = nxt
    return level[0].hex()
