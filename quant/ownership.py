"""
ownership.py — Shared position ownership ledger (collision safety for bots on the
same stock universe).

THE HAZARD (Part 3 of LOWVOL_BOT_SPEC.md; the June 9 ORB/swing collision class):
mean-rev AND low-vol both trade STOCK_UNIVERSE. Both infer "my positions" from the
Alpaca account by symbol membership. If low-vol holds KO and mean-rev later signals
KO, mean-rev would count low-vol's KO shares as its own and, on exit, liquidate the
FULL position via the close endpoint — selling low-vol's shares out from under it.

THE FIX: a tiny explicit ledger recording which bot owns which shares. Each bot,
after its fills, writes its own section. Each bot reads the ledger to (a) count only
its OWN shares as "current" and (b) avoid touching the other bot's shares.

File: quant/ownership.json — {"lowvol": {"KO": qty, ...}, "meanrev": {"AAPL": qty}}
Written ATOMICALLY (temp file + os.replace) so a crash mid-write can't corrupt it.
Defensive by design: if the ledger is missing/unreadable, callers fall back to the
old symbol-membership behavior (no worse than before this file existed).
"""

from __future__ import annotations
import os, json, tempfile

LEDGER = os.path.join(os.path.dirname(os.path.abspath(__file__)), "ownership.json")


def load() -> dict:
    """Return the full ledger {'lowvol': {...}, 'meanrev': {...}}. Never raises."""
    try:
        with open(LEDGER) as f:
            d = json.load(f)
        return {"lowvol": d.get("lowvol", {}), "meanrev": d.get("meanrev", {})}
    except Exception:
        return {"lowvol": {}, "meanrev": {}}


def owned_by(bot: str) -> dict:
    """{symbol: qty} the given bot ('lowvol'|'meanrev') currently owns per the ledger."""
    return load().get(bot, {})


def owned_symbols(bot: str) -> set:
    """Set of symbols the given bot owns (qty > 0)."""
    return {s for s, q in owned_by(bot).items() if abs(float(q)) > 1e-9}


def other_symbols(bot: str) -> set:
    """Symbols owned by the OTHER stock bot — the ones `bot` must NOT touch."""
    other = "meanrev" if bot == "lowvol" else "lowvol"
    return owned_symbols(other)


def write_section(bot: str, holdings: dict) -> None:
    """Atomically replace `bot`'s section with {symbol: qty} (qty>0 only), leaving
    the other bot's section untouched. Call after fills settle."""
    d = load()
    d[bot] = {s: round(float(q), 6) for s, q in holdings.items() if abs(float(q)) > 1e-9}
    _atomic_write(d)


def _atomic_write(d: dict) -> None:
    dirn = os.path.dirname(LEDGER)
    fd, tmp = tempfile.mkstemp(dir=dirn, prefix=".ownership.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(d, f, indent=2)
        os.replace(tmp, LEDGER)   # atomic on POSIX
    except Exception:
        try: os.unlink(tmp)
        except Exception: pass
        raise
