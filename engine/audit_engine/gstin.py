"""GSTIN and PAN structure checks (CGST Rules, rule 10; D-08 and section 11.3)."""

from __future__ import annotations

import re

_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"
_PAN_RE = re.compile(r"^[A-Z]{5}[0-9]{4}[A-Z]$")
_GSTIN_RE = re.compile(r"^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$")

VALID_STATE_CODES = {f"{i:02d}" for i in range(1, 39)} | {"97", "99"}


def checksum_char(first14: str) -> str:
    total = 0
    for i, ch in enumerate(first14):
        value = _CHARS.index(ch)
        product = value * (2 if i % 2 else 1)
        total += product // 36 + product % 36
    return _CHARS[(36 - total % 36) % 36]


def normalise(gstin: str | None) -> str | None:
    if gstin is None:
        return None
    g = str(gstin).strip().upper().replace(" ", "")
    return g or None


def structure_errors(gstin: str | None) -> list[str]:
    """Return a list of problems with the GSTIN. Empty means valid."""
    g = normalise(gstin)
    if not g:
        return ["missing"]
    if len(g) != 15:
        return [f"length {len(g)}, expected 15"]
    errors = []
    if not _GSTIN_RE.match(g):
        errors.append("pattern does not match state code, PAN, entity number, Z, checksum")
    if g[:2] not in VALID_STATE_CODES:
        errors.append(f"state code {g[:2]} is not valid")
    if all(c in _CHARS for c in g[:14]) and checksum_char(g[:14]) != g[14]:
        errors.append(f"checksum {g[14]} does not match computed {checksum_char(g[:14])}")
    return errors


def is_valid(gstin: str | None) -> bool:
    return not structure_errors(gstin)


def pan_of(gstin: str | None) -> str | None:
    """PAN is characters 3 to 12 of the GSTIN (section 11.3)."""
    g = normalise(gstin)
    if not g or len(g) < 12:
        return None
    pan = g[2:12]
    return pan if _PAN_RE.match(pan) else None


def state_of(gstin: str | None) -> str | None:
    g = normalise(gstin)
    if not g or len(g) < 2 or not g[:2].isdigit():
        return None
    return g[:2]


def is_valid_pan(pan: str | None) -> bool:
    return bool(pan) and bool(_PAN_RE.match(str(pan).strip().upper()))


def make_gstin(state_code: str, pan: str, entity_no: str = "1") -> str:
    """Build a structurally valid GSTIN. Used by the data generator and tests."""
    first14 = f"{state_code}{pan}{entity_no}Z"
    return first14 + checksum_char(first14)
