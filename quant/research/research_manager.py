"""
research_manager.py — Research Manager (Module 1) + auto-validation reports (Module 5).

The orchestrator. Creates a numbered, self-documenting experiment folder, runs a
candidate strategy through the standardized validation + similarity + stability
checks, and auto-writes a report.md + results.json. No experiment goes undocumented.

Workflow (matches the spec):
  1. new_experiment(slug)            -> scaffolds the folder + hypothesis.md template
  2. run_experiment(slug, strategy_fn, panel, ...) -> validates, compares, documents

Touches NO production code. Everything lives under research/experiments/.
"""

from __future__ import annotations
import sys, os, json, datetime as dt, re

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from lib.validate import validate_strategy
from lib.similarity import compare
from lib.stability import analyze as stability_analyze

EXP_DIR = os.path.join(HERE, "experiments")
os.makedirs(EXP_DIR, exist_ok=True)


def _next_id() -> str:
    year = dt.date.today().year
    existing = [d for d in os.listdir(EXP_DIR) if re.match(rf"{year}_\d+", d)]
    nums = [int(d.split("_")[1]) for d in existing] or [0]
    return f"{year}_{max(nums)+1:03d}"


def new_experiment(slug: str) -> str:
    """Scaffold a new experiment folder. Returns its path."""
    eid = _next_id()
    name = f"{eid}_{slug}"
    path = os.path.join(EXP_DIR, name)
    os.makedirs(os.path.join(path, "charts"), exist_ok=True)
    with open(os.path.join(path, "hypothesis.md"), "w") as f:
        f.write(HYPOTHESIS_TEMPLATE.format(id=eid, slug=slug, date=dt.date.today()))
    print(f"Created experiment: {name}\n  -> {path}/hypothesis.md")
    return path


def run_experiment(exp_path: str, strategy_fn, price_panel, existing_returns: dict | None = None,
                   stability_param: tuple | None = None, name: str = "strategy", **strat_kwargs) -> dict:
    """Validate a candidate + (optionally) similarity + stability; write report.

    existing_returns:  {name: return_series} to check redundancy against (live bots etc.)
    stability_param:   (param_name, [values], fixed_kwargs) to sweep, or None to skip.
    """
    weights = strategy_fn(price_panel, **strat_kwargs)
    val = validate_strategy(weights, price_panel, name=name)
    cand_returns = val.pop("returns")

    sim = compare(cand_returns, existing_returns) if existing_returns else None

    stab = None
    if stability_param:
        pname, values, fixed = stability_param
        stab = stability_analyze(strategy_fn, price_panel, pname, values, **fixed)

    results = dict(
        name=name, params=strat_kwargs,
        validation=val, similarity=sim, stability=stab,
        timestamp=dt.datetime.now().isoformat(),
    )
    with open(os.path.join(exp_path, "results.json"), "w") as f:
        json.dump(results, f, indent=2, default=str)
    _write_report(exp_path, results)
    print(f"\n  Recommendation: {val['recommendation']}")
    print(f"  -> {exp_path}/report.md")
    return results


def _write_report(path: str, r: dict):
    v = r["validation"]; perf = v["performance"]; rob = v["robustness"]
    lines = [
        f"# Validation Report — {r['name']}",
        f"_Generated {r['timestamp'][:19]}_\n",
        f"## VERDICT: **{v['recommendation']}**",
        f"> {v['reasoning']}\n",
        "## Performance",
        f"| metric | value |",
        f"|---|---|",
        f"| CAGR | {perf.get('cagr',0)*100:+.2f}% |",
        f"| Sharpe | {perf.get('sharpe',0)} |",
        f"| Sortino | {perf.get('sortino',0)} |",
        f"| Calmar | {perf.get('calmar',0)} |",
        f"| Max Drawdown | {perf.get('max_drawdown',0)*100:.1f}% |",
        f"| Win Rate | {perf.get('win_rate',0)*100:.0f}% |",
        f"| Profit Factor | {perf.get('profit_factor',0)} |",
        f"| Volatility | {perf.get('volatility',0)*100:.1f}% |\n",
        "## Robustness",
        f"- **2x-cost Sharpe:** {rob['sharpe_2x_cost']} (must survive)",
        f"- **Eras positive:** {rob['eras_positive']}",
        f"- **First/second half Sharpe:** {rob['first_half_sharpe']} / {rob['second_half_sharpe']}",
        f"- **Deflated Sharpe prob:** {rob['dsr_full']} (want > 0.90)\n",
    ]
    if r.get("similarity"):
        s = r["similarity"]
        lines += ["## Similarity / Redundancy",
                  f"- **Verdict:** {s['verdict']}",
                  f"- **Correlations:** {s['correlations']}",
                  f"- {s['recommendation']}\n"]
    if r.get("stability"):
        st = r["stability"]["stability"]
        lines += ["## Parameter Stability",
                  f"- **Verdict:** {st['verdict']}",
                  f"- Stability score: {st['score']} | positive across {st['positive_fraction']*100:.0f}% of range\n"]
    lines += ["## Era detail", "| period | sharpe | cagr | maxdd |", "|---|---|---|---|"]
    for e in v.get("era_detail", []):
        lines.append(f"| {e['period']} | {e['sharpe']} | {e['cagr']*100:+.1f}% | {e['maxdd']*100:.1f}% |")
    with open(os.path.join(path, "report.md"), "w") as f:
        f.write("\n".join(lines))


HYPOTHESIS_TEMPLATE = """# Experiment {id} — {slug}
_Created {date}_

## Hypothesis
<one-sentence claim: what edge, on what, why it should exist>

## Economic rationale
<WHY does this edge exist? structural flow / behavioral bias / risk premium?
 An edge with no economic cause is probably data-mined noise.>

## Expected behavior
- Holding period:
- Turnover:
- Expected capacity:
- Direction (long/short/both):

## Required data
<what data; do we have it free, or does it need a paid feed?>

## Assumptions
<what must be true for this to work>

## Likely failure modes
<how could this be a mirage? overfit / decayed / survivorship / look-ahead?>

## Status
- [ ] hypothesis approved
- [ ] implemented
- [ ] validated
- [ ] decision recorded
"""


if __name__ == "__main__":
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("command", choices=["new"])
    ap.add_argument("slug")
    args = ap.parse_args()
    if args.command == "new":
        new_experiment(args.slug)
