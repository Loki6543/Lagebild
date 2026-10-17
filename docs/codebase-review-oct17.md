# Review of the "production-grade codebase" critique (lagebild.pdf)

Reviewed 2026-10-17 against this repository. The PDF is a six-page AI-written review of the replay code
(`build_panel.py`, `run_replay.js`, `stats.py`, `analyze.py`). Its praise is accurate. Most of its weaknesses are
wrong for this code, and its sample code does not run. One idea was worth adding.

## Claims checked

| PDF claim | Finding |
|---|---|
| Point-in-time data: CPI known on the 15th of the next month, NSA series not revised | **Correct** (`build_panel.py:114`). |
| DSR, PBO and the stationary bootstrap; 22 correlated trials | **Correct.** |
| `stats.py` imports scipy but requirements list only numpy and scipy | **Self-contradictory, not a problem.** Both are pinned. Pinning exact versions is deliberate, for reproducibility. |
| Running from another directory will crash | **Wrong.** Every script resolves paths from `os.path.abspath(__file__)` or `__dirname`. |
| The engine is a global `ZE`, so the replay "breaks silently" | **Wrong.** The replay loads it with `require('./engine/lagebild-engine.js')`, the same module the tests import. A renamed export throws at once, and `tests/test_engine_coverage.js` checks the exports. |
| No error handling for a missing or malformed `panel.json` | **True, but harmless.** Node stops with ENOENT or a SyntaxError that names the file. Failing loudly is the right behaviour for a batch job. |
| Switch to ES modules | **Not useful.** The engine is one file shared with the browser app, and CommonJS works in every Node version. It is churn with no gain. |
| Move the configurations to JSON | **Already half done.** `run_replay.js` writes `results/configs.json`, which `analyze.py` reads. Keeping the definitions in code keeps each option next to the engine call that uses it. |
| The IAUM backfill from GLD is a noisy heuristic; use NAV ratios | **Minor.** `splice_iaum` chains GLD's daily returns back from IAUM's first price. Both hold physical gold, so the only drift is the fee difference (about 0.31 percentage points a year). |
| A fixed bootstrap block of 8 weeks | **Fair, but low value.** The Politis–White automatic block length would be a refinement. With every interval already including zero, it would not change any conclusion. |
| Effective trials may be optimistic in crashes | **A reasonable question, now measured.** See below. The PDF's own code for it is wrong: `effective_trials` returns `(n_eff, rho)`, so `rho, _ = effective_trials(...)` reads N_eff as rho. It also *assumes* rho = 1 when it has too few weeks. |
| "Static split", so add walk-forward optimisation | **Wrong premise and wrong direction.** `analyze.py` already reports a walk-forward check. The engine's parameters are frozen by design. Tuning them on rolling windows would add the search the overfitting checks exist to catch. |
| CE penalty λ × (number of tuned parameters) | **Not adopted.** λ would be arbitrary. The deflated Sharpe ratio and PBO already charge for the search, using the actual number of trials. |
| A "random walk" baseline to separate alpha from beta | **Already covered.** Every result is measured against the base plan. That is the beta baseline that matters here, and the paired bootstrap tests that difference. |
| pandas, plotly, rich, pyproject.toml | **Not adopted.** That adds three heavy dependencies to draw charts. If charts are wanted, a small dependency-free HTML page built from the run files would do. |
| Docker, automated data download | **Optional.** The raw provider files are not in git because of their licence terms. A fetch script would need the user's own API keys and must keep the `MANIFEST.json` hashes. |
| The PDF's sample code | **Broken.** It has a Vega-Lite error pasted in as the "strategies.json", mis-indented Python, and an `analyze.py` plot that reads keys `summary.json` does not have (`runs`, `weekly`). |

## What was added

`stats.trial_correlation_by_regime(M, proxy)`, which `analyze.py` calls.
- It splits the replay weeks into the worst 10% of base-plan weeks and the rest.
- It reports the average correlation between configurations, and the effective number of trials, separately for each group.
- It returns `None` rather than a guess when a group has fewer than 10 weeks.

The next replay run adds one line to `results/REPORT.md` under "Overfitting checks". That line answers the useful part of the PDF's question: whether the overlays still behave differently in the weeks they exist for. A test with synthetic data checks that crash convergence is detected.

The existing numbers in `results/` are unchanged, because the per-run files are not in git. The line appears once `run_replay.js` and `analyze.py` are run again.
