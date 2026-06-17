from datetime import datetime


def format_brief(ranked: list[dict], total_sources: int) -> list[str]:
    """
    Formats ranked theses into a SINGLE SMS message.
    Verizon's gateway drops multiple emails from the same sender —
    everything must fit in one message.
    """
    today = datetime.now().strftime("%b %d")
    lines = []

    lines.append(f"MARKET LENS {today}")
    lines.append("─" * 22)

    for i, t in enumerate(ranked):
        emoji = t.get("priority_emoji", "🟢")
        ticker = t.get("ticker") or "?"
        score = t.get("final_score", 0)
        verdict = t.get("verdict", "MONITOR")
        horizon = t.get("time_horizon", "?")
        priced_in = "priced in" if t.get("market_priced_in") else "NOT priced in"

        # one catalyst, shortened
        catalysts = t.get("catalysts", [])
        catalyst = catalysts[0][:80] if catalysts else "N/A"

        # one risk, shortened
        risks = t.get("risks", [])
        risk = risks[0][:60] if risks else "N/A"

        lines.append(
            f"{emoji} {ticker} {score}/100 | {verdict} | {horizon}\n"
            f"  {priced_in}\n"
            f"  WHY: {catalyst}\n"
            f"  RISK: {risk}"
        )

    # secondary tickers
    secondary = []
    for t in ranked:
        secondary.extend(t.get("second_order_beneficiaries", []))
    secondary = [s for s in list(dict.fromkeys(secondary)) if s and s != "N/A"][:4]

    lines.append("─" * 22)
    if secondary:
        lines.append(f"Also watch: {', '.join(secondary)}")
    lines.append(f"Sources: {total_sources} | 7AM tomorrow")

    return ["\n".join(lines)]
