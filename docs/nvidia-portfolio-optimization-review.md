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
2. **A minimum-CVaR challenger in the replay. Proposed, not built.** Within the same sleeve bands and caps, solve for the
   weights with the lowest CVaR (CPU, `scipy.optimize.linprog`) and add it as one more replay configuration. It would test
   whether an optimiser beats the fixed base plan out of sample. Adding it adds a trial, which raises the deflated-Sharpe
   bar for every configuration, so it is worth doing once, not as a parameter sweep.
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
- The CVaR column appears in `results/REPORT.md` after the next `run_replay.js` and `analyze.py` run. The per-run files
  are not in git.
