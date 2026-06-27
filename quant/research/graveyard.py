"""
graveyard.py — Strategy Graveyard helper (Module 13).

Search/append rejected strategies in GRAVEYARD.md. Check before researching anything new.
  python graveyard.py search <keyword>
  python graveyard.py add        (interactive append)
"""
from __future__ import annotations
import sys, os, datetime as dt

HERE = os.path.dirname(os.path.abspath(__file__))
GRAVE = os.path.join(HERE, "GRAVEYARD.md")


def search(keyword: str):
    text = open(GRAVE).read()
    blocks = text.split("\n## ")
    hits = [b for b in blocks if keyword.lower() in b.lower()]
    if not hits:
        print(f"No graveyard entry matching '{keyword}'. (Safe to research.)")
        return
    print(f"⚠ Found {len(hits)} graveyard match(es) for '{keyword}':\n")
    for h in hits:
        print("## " + h.split("\n\n")[0] + "\n")


def add(name: str, reason: str, evidence: str = ""):
    entry = (f"\n## {name}\n- **Status:** REJECTED\n- **Date:** {dt.date.today()}\n"
             f"- **Why rejected:** {reason}\n")
    if evidence:
        entry += f"- **Evidence:** {evidence}\n"
    with open(GRAVE, "a") as f:
        f.write(entry)
    print(f"Added '{name}' to the graveyard.")


if __name__ == "__main__":
    if len(sys.argv) >= 3 and sys.argv[1] == "search":
        search(" ".join(sys.argv[2:]))
    elif len(sys.argv) >= 4 and sys.argv[1] == "add":
        add(sys.argv[2], sys.argv[3], sys.argv[4] if len(sys.argv) > 4 else "")
    else:
        print(__doc__)
