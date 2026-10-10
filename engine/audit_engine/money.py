"""Money helpers. All amounts are integers in paise (LG-3)."""

from __future__ import annotations


def div_round(numerator: int, denominator: int) -> int:
    """Integer division rounded half away from zero."""
    if denominator == 0:
        raise ZeroDivisionError("denominator is zero")
    sign = -1 if (numerator < 0) ^ (denominator < 0) else 1
    q, r = divmod(abs(numerator), abs(denominator))
    if 2 * r >= abs(denominator):
        q += 1
    return sign * q


def apply_bp(amount: int, bp: int) -> int:
    """Amount multiplied by basis points, rounded to the paisa."""
    return div_round(amount * bp, 10000)


def rupees(paise: int) -> str:
    """Format paise as Indian rupees with lakh grouping, for example 12,34,567.89."""
    sign = "-" if paise < 0 else ""
    p = abs(int(paise))
    whole, frac = divmod(p, 100)
    s = str(whole)
    if len(s) > 3:
        head, tail = s[:-3], s[-3:]
        groups = []
        while len(head) > 2:
            groups.insert(0, head[-2:])
            head = head[:-2]
        if head:
            groups.insert(0, head)
        s = ",".join(groups) + "," + tail
    return f"{sign}{s}.{frac:02d}"


def to_paise(value: object) -> int | None:
    """Parse a register cell into paise. Returns None when it is not a number.

    Accepts integers, floats and strings with commas, a currency prefix or
    parentheses for negatives. Used only for parsed values stored beside the
    raw cell (RI-4), never in place of it.
    """
    if value is None:
        return None
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value * 100
    if isinstance(value, float):
        return int(round(value * 100))
    s = str(value).strip()
    if not s:
        return None
    neg = False
    if s.startswith("(") and s.endswith(")"):
        neg, s = True, s[1:-1]
    for token in ("Rs.", "Rs", "INR", "₹", ",", " "):
        s = s.replace(token, "")
    if s.startswith("-"):
        neg, s = (not neg), s[1:]
    if not s:
        return None
    try:
        if "." in s:
            whole, frac = s.split(".", 1)
            if not whole:
                whole = "0"
            if not (whole.isdigit() and frac.isdigit()):
                return None
            frac3 = (frac + "000")[:3]
            paise = int(whole) * 100 + int(frac3[:2])
            if int(frac3[2]) >= 5:
                paise += 1
        else:
            if not s.isdigit():
                return None
            paise = int(s) * 100
    except ValueError:
        return None
    return -paise if neg else paise
