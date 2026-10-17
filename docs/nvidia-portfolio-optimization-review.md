# NVIDIA portfolio-optimization blueprint: what Lagebild can use

Reviewed 2026-10-17. The repository is
[NVIDIA-AI-Blueprints/portfolio-optimization](https://github.com/NVIDIA-AI-Blueprints/portfolio-optimization), Apache-2.0,
commit `093a8bd` (14 Sep 2026). It is a mean-CVaR and mean-variance optimiser that runs on NVIDIA's GPU solvers (cuOpt and
cuML), with scenario generation, a backtester and rebalancing rules. Research only: nothing here changes the engine's
targets or carries trading authority.

## The two systems solve different problems

| | NVIDIA blueprint | Lagebild |
|---|---|---|
| How weights are set | An optimiser picks weights that maximise return minus risk over sampled scenarios. | Fixed base weights, tilted by trend and macro signals, then capped. |
| Risk measure | CVaR (expected shortfall) at 95%, or variance. | EWMA and shrunk covariance; a 24% volatility cap; a crypto risk-share cap. |
| Groups | `group_constraints` with weight bounds. | Sleeve bands (stocks 51–61%, gold 19–29%, crypto 15–20%). |
| Rebalancing | Re-optimise on a loss, on drift from the optimum, or on drawdown. | Action band per asset (1.5 percentage points or 20%), weekly decisions, drawdown overlay. |
| Overfitting control | None found: no deflated Sharpe, PBO or bootstrap intervals. | DSR, PBO (CSCV), paired stationary bootstrap, walk-forward check. |
| Scale | Built for thousands of assets and scenarios on H100 GPUs. | 12 assets, about 300 weekly decisions. |

A GPU solver brings nothing at Lagebild's size: a 12-asset CVaR linear programme with a few thousand scenarios solves in
milliseconds on a CPU.

## Worth taking

1. **CVaR as a tail-risk measure. Added.** Volatility treats a −8% week and a +8% week alike, and crypto's losses have fat
   tails. `stats.cvar` computes historical 95% expected shortfall: the average of the worst 5% of weeks, using the
   Rockafellar–Uryasev fractional tail. `analyze.py` reports it per configuration in a new "Weekly CVaR 95%" column.
   It is a diagnostic only and changes no target. Tests check it against a hand-computed tail and the normal-distribution
   value (2.063σ).
2. **A minimum-CVaR challenger in the replay. Built, awaiting the next replay run with the raw panel.** Within the plan's
   limits it solves for the weights with the lowest CVaR and runs as one more replay configuration, `min_cvar` ("Minimum
   CVaR within the plan limits"). It tests whether an optimiser beats the fixed base plan out of sample. No result exists
   yet: the replay needs `data/panel/panel.json`, which is built from raw downloads that are not in git, so the per-run
   file and the report row appear only after the next `run_replay.js` and `analyze.py` run.
   - **Solver.** `lib/min_cvar.js` is a dense two-phase simplex in plain Node, with no dependencies. It solves the
     Rockafellar–Uryasev linear programme (minimise ζ + Σuₜ / ((1 − α)T), with uₜ ≥ −(rₜ·w) − ζ and uₜ ≥ 0), and it
     returns a status instead of throwing: `infeasible`, `unbounded` or `iteration_limit` (plus `invalid_input` and
     `numerical_error` as guards). Dantzig pricing switches to Bland's rule after a run of degenerate pivots, so it cannot
     cycle. A 252-day, 12-asset problem solves in roughly 10 to 70 milliseconds. The tests compare its objective with
     `scipy.optimize.linprog(method='highs')` on 36 seeded problems with 60 to 260 days of fat-tailed returns, and on 60
     degenerate generic programmes; they require 1e-7 relative agreement.
   - **Inputs.** At each decision date, the trailing 252 aligned daily simple returns of the 12 assets, built from what
     the engine sees: equities through the decision day, crypto through the day before. The tests change all later data
     and check that the target does not move.
   - **Constraints (the plan's limits only).** Long only, fully invested, sleeve bands (stocks 51–61%, gold 19–29%,
     crypto 15–20%), BTC at most 10%, and NVDA + 0.08 VOO + 0.20 SMH at most 10%, all read from the engine's constants.
     The 24% volatility ceiling and the crypto risk-share cap are not imposed, and there is no BTC gate and no tilt.
   - **Execution.** The target goes through the same action band as the engine: an asset trades only when
     |target − current| > max(1.5 points, 20% of current). Trades then execute at the next session's close with the same
     costs and cash rule as every other configuration. A fully invested target executed through a band can leave cash idle
     until positions leave their band; read the run's cash and turnover with that in mind.
   - **Fail closed.** If the solver returns anything but `optimal`, or fewer than 253 aligned closes exist, the week holds:
     no trades, counted in `blockedWeeks` and in the run's `minCvar.byStatus`. SOL's history starts on 2020-08-11, so the
     first solve cannot come before about August 2021; the earlier weeks hold the seeded base plan.
   - **Audit trail.** `results/runs/min_cvar.json` also stores each decision's target, current weights, trades and CVaR.
   - **One trial.** The challenger raises the count from 22 to 23 configurations. The deflated Sharpe ratio charges for
     the best result expected from unskilled trials, and that bar rises with the number of trials, so adding the challenger
     raises the bar for every configuration. That is why it is added once, with the level (95%) and window (252 days)
     fixed in advance, and not as a parameter sweep.
   - **What to expect.** A linear-programme optimum sits at a vertex of the limits, so the targets will be concentrated at
     the bounds. It uses no expected-return estimate, which is what makes mean-CVaR fragile (see "Not worth taking"), but
     the tail of one year of history is still a noisy input. The report should be read for out-of-sample tail loss and
     turnover, not for the in-sample CVaR the optimiser minimised.
   - **Overrides for tests.** `LAGEBILD_PANEL` sets the panel file and `LAGEBILD_RESULTS` the results directory. Both
     default to the old paths, and the tests check that the earlier configurations' output is byte-identical to the
     previous script's.
3. **CVaR in the app's risk panel. Proposed, not built.** This would show the current target's historical 95% weekly CVaR
   next to its volatility. It touches the engine and the app copy together, so it belongs in its own change, with the
   engine-and-app equality check.

## Not worth taking

- **The optimiser as the allocation rule.** Mean-CVaR weights are very sensitive to estimated returns. Lagebild's fixed
  anchor exists to avoid that estimation error, and the replay already finds no reliable gain from signals.
- **Loss-triggered re-optimisation** (`_check_pct_change`). It re-optimises after cumulative losses pass a threshold. That
  sells after declines, and Lagebild's drawdown overlay already handles drawdowns, with a floor.
- **Scenario generation by KDE** (`backtest.py:225`). It uses one fixed bandwidth (0.005, half a percent a day) for every
  asset. That is about half of gold's daily volatility and a sixth of Bitcoin's, so it blurs the assets very unequally. The stationary bootstrap in `stats.py` keeps the real joint and serial
  structure without that choice.
- **cuOpt, cuML, CUDA 13 and the pydantic parameter classes.** They are heavy dependencies for no gain at this scale. The
  coverage tests already pin `PARAMS`.

## Issues seen in the blueprint (for context, not ported)

- **Drift check** (`rebalance.py:545–549`): the drifted weights are computed as w × P(start) / P(end), and they are not
  renormalised to sum to 1. Drifted weights should be proportional to w × P(end) / P(start), then normalised. As written,
  the drift trigger measures the wrong direction and scale.
- **Transaction costs default to 0** (`transaction_cost_factor: float = 0`). Lagebild's replay always charges costs.
- **Results are reported without any multiple-testing correction,** even though rebalancing thresholds and risk aversion
  are meant to be tuned.

## Checks

- `python3 -m pytest -q tests`: 10 passed, including the new CVaR test.
- `node --test tests/test_engine_coverage.js`: 10/10.
- `node --test tests/test_min_cvar.js`: 13/13. Hand cases with known answers, the simplex edge cases (Beale's cycling
  example, infeasible, unbounded), and the HiGHS comparison. The comparison is skipped with a message if python3 cannot
  import scipy.
- `node --test tests/test_replay_min_cvar.js`: 10/10 on a synthetic panel in a temporary directory: limits at every
  decision, the action band, hold-and-count on solver failure, no lookahead, and byte-identical output for the
  earlier configurations.
- The CVaR column and the `min_cvar` row appear in `results/REPORT.md` after the next `run_replay.js` and `analyze.py`
  run. The per-run files are not in git.
