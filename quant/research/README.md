# NexusTrader Research OS

A research platform for discovering, validating, and documenting trading strategies —
**built around the live bots, never touching them.** Production code (`live_runner.py`,
`meanrev_runner.py`, `allocator.py`, `dynamic_budget.py`, `equity_protector.py`,
`health_check.py`, `strategies/`) is untouched by anything in this folder.

## Philosophy
Robustness over Sharpe · evidence over intuition · long samples · economic rationale ·
out-of-sample over in-sample. A high-Sharpe strategy that fails the robustness gates is
REJECTED, not deployed.

## Modules built (the high-leverage core — 80% of the value)
| # | Module | File | What it does |
|---|---|---|---|
| 1 | Research Manager | `research_manager.py` | Scaffolds documented experiment folders, orchestrates validation |
| 5 | Auto-Validation | `lib/validate.py` | One call → full perf + robustness report + recommendation |
| 4 | Similarity Engine | `lib/similarity.py` | Flags redundancy vs live bots / past experiments (return correlation) |
| 9 | Parameter Stability | `lib/stability.py` | Sweeps params, rewards plateaus, warns on overfit spikes |
| 13 | Strategy Graveyard | `GRAVEYARD.md` + `graveyard.py` | Permanent record of rejected ideas — check before researching |

Deferred (build when needed): Portfolio Lab (M6), Regime Framework (M7), Failure Analysis
(M8), Monte Carlo (M10), Data Auditor (M11), Live-vs-Backtest Drift (M12 — needs months of
live data), Capacity (M14 — needs ADV data), Research Dashboard (M15).

## The workflow
```
1. Check the graveyard:   python graveyard.py search <keyword>
2. Write a hypothesis:    python research_manager.py new <slug>
                          (fill in experiments/<id>_<slug>/hypothesis.md)
3. Implement + validate:  use run_experiment() (see example below)
4. Read the auto-report:  experiments/<id>_<slug>/report.md
5. If rejected:           add it to the graveyard
```

## Example: validate a candidate end-to-end
```python
import sys; sys.path.insert(0, "research")
from data import get_universe, ALL_SYMBOLS, CRYPTO_UNIVERSE
from engine import build_price_panel
import research_manager as rm
from research.lib.similarity import live_bot_returns
import my_strategy  # your candidate, exposes strategy(panel, **kw) -> weights

panel = build_price_panel(get_universe(...)).ffill()
existing = live_bot_returns(etf_panel, stock_panel)   # redundancy check vs live bots

path = rm.new_experiment("my_idea")
rm.run_experiment(
    path, my_strategy.strategy, panel,
    existing_returns=existing,
    stability_param=("some_param", [1,2,3,4,5], dict(other=...)),  # optional sweep
    name="my idea",
    some_param=3, other=...,
)
# -> experiments/<id>_my_idea/{report.md, results.json}
```

## Recommendation tiers
`REJECT` · `NEEDS_MORE_RESEARCH` · `INTERESTING` · `PAPER_TRADE` · `PRODUCTION_CANDIDATE`
(robustness gates dominate — see `lib/validate.py::_recommend`).
