# Zobiris Lagebild replay, 2021-02-08 to 2026-10-09

Generated 2026-10-17 by `analyze.py` from the shipped engine (Zobiris Lagebild v3.1). 296 weekly decisions, 22 configurations, every one kept.

## All configurations

| Configuration | CAGR | Vol | Max DD | CE | Sharpe | Turnover | CE gain vs base (95% CI) | DSR |
|---|---:|---:|---:|---:|---:|---:|---|---:|
| v3 without either risk cap | 31.6% | 18.3% | 29.1% | 20.4% | 1.39 | 28% | +2.7 (-1.4 to +7.5) | 1.00 |
| Base + BTC gate (10 months) | 31.6% | 18.3% | 30.0% | 20.4% | 1.39 | 29% | +2.7 (-1.1 to +7.2) | 1.00 |
| v3 without volatility ceiling | 31.0% | 17.8% | 28.3% | 20.1% | 1.40 | 29% | +2.5 (-1.8 to +7.3) | 1.00 |
| Base + BTC gate (12 months) | 30.4% | 18.0% | 30.0% | 19.5% | 1.36 | 29% | +1.9 (-2.2 to +6.4) | 1.00 |
| v3, tilt strength 0.4 | 29.8% | 17.4% | 28.4% | 19.3% | 1.37 | 38% | +1.7 (-2.8 to +6.6) | 1.00 |
| v3 default | 29.6% | 17.4% | 28.1% | 19.2% | 1.36 | 34% | +1.5 (-2.9 to +6.4) | 1.00 |
| v3 without smoothing | 29.6% | 17.4% | 27.9% | 19.1% | 1.36 | 33% | +1.5 (-3.0 to +6.5) | 1.00 |
| v3 without crypto risk cap | 29.7% | 17.7% | 28.8% | 19.1% | 1.35 | 35% | +1.5 (-2.9 to +6.4) | 1.00 |
| v3, macro at 0.4 | 29.4% | 17.4% | 28.1% | 19.0% | 1.35 | 34% | +1.3 (-3.1 to +6.3) | 1.00 |
| v3 + alt trend gate | 29.4% | 17.5% | 28.5% | 19.0% | 1.35 | 37% | +1.3 (-3.1 to +6.3) | 1.00 |
| v3 without macro | 29.5% | 17.7% | 28.3% | 18.9% | 1.34 | 35% | +1.3 (-3.1 to +6.2) | 1.00 |
| Base + gate + risk caps, no tilts | 29.3% | 17.5% | 28.6% | 18.9% | 1.34 | 35% | +1.2 (-3.1 to +6.1) | 1.00 |
| v3, gate 12 months | 29.0% | 17.2% | 28.1% | 18.8% | 1.35 | 30% | +1.1 (-3.5 to +6.2) | 1.00 |
| v3, tilt strength 0.6 | 29.1% | 17.6% | 28.9% | 18.7% | 1.33 | 43% | +1.1 (-3.3 to +6.0) | 1.00 |
| v3 + drawdown overlay | 28.3% | 16.0% | 22.9% | 18.6% | 1.41 | 42% | +1.0 (-4.9 to +7.7) | 1.00 |
| v3 + trend-distance gate | 28.7% | 17.2% | 28.2% | 18.5% | 1.33 | 36% | +0.9 (-3.7 to +6.0) | 1.00 |
| v3 + all three switches | 27.9% | 16.0% | 23.2% | 18.3% | 1.39 | 49% | +0.7 (-5.3 to +7.3) | 1.00 |
| Base plan, band rebalance | 29.1% | 20.3% | 37.4% | 17.6% | 1.17 | 27% |  | 0.99 |
| Tilts only, no gate or caps | 28.6% | 19.6% | 37.2% | 17.6% | 1.19 | 25% | -0.1 (-1.4 to +1.3) | 0.99 |
| v3 without BTC gate | 27.2% | 18.2% | 32.2% | 17.0% | 1.21 | 33% | -0.6 (-3.2 to +2.1) | 0.99 |
| Base + BTC gate (8 months) | 24.9% | 18.2% | 30.2% | 15.2% | 1.11 | 37% | -2.5 (-9.5 to +3.9) | 0.99 |
| v3, gate 8 months | 24.1% | 17.3% | 28.4% | 14.8% | 1.12 | 41% | -2.8 (-10.1 to +4.0) | 0.99 |

CE is the certainty-equivalent return: annual mean excess return over T-bills minus 1.5 times its annual variance. Turnover is one-way. DSR is the probability that the true Sharpe ratio beats what the best of 22 unskilled configurations would show by luck; 0.95 or higher would count as significant. Against zero it is close to 1 for every row, because every configuration earned a high Sharpe ratio in a strong market; it says the period was good, not that any rule worked. The active test below is the one that matters.

## Does anything beat the plain base plan?

| Configuration | Active PSR | Active DSR | CE gain vs base + gate (95% CI) |
|---|---:|---:|---|
| Base + BTC gate (8 months) | 0.08 | 0.01 | -5.2 (-11.4 to -0.9) |
| Base + BTC gate (12 months) | 0.59 | 0.18 | -0.9 (-1.9 to +0.1) |
| Base + gate + risk caps, no tilts | 0.44 | 0.10 | -1.5 (-3.5 to +0.1) |
| v3 default | 0.48 | 0.11 | -1.2 (-3.1 to +0.6) |
| v3 + drawdown overlay | 0.33 | 0.06 | -1.8 (-5.0 to +1.6) |
| v3 + alt trend gate | 0.45 | 0.10 | -1.4 (-3.4 to +0.5) |
| v3 + trend-distance gate | 0.37 | 0.07 | -1.9 (-4.0 to +0.2) |
| v3 + all three switches | 0.30 | 0.05 | -2.1 (-5.5 to +1.4) |
| v3 without macro | 0.47 | 0.11 | -1.4 (-3.3 to +0.3) |
| v3, macro at 0.4 | 0.45 | 0.10 | -1.4 (-3.3 to +0.4) |
| v3, tilt strength 0.4 | 0.51 | 0.13 | -1.1 (-3.0 to +0.8) |
| v3, tilt strength 0.6 | 0.43 | 0.09 | -1.6 (-3.6 to +0.3) |
| v3 without smoothing | 0.48 | 0.11 | -1.3 (-3.1 to +0.5) |
| v3 without volatility ceiling | 0.66 | 0.23 | -0.3 (-1.9 to +1.2) |
| v3 without crypto risk cap | 0.50 | 0.12 | -1.3 (-2.7 to +0.2) |
| v3 without either risk cap | 0.75 | 0.32 | +0.0 (-1.0 to +1.0) |
| v3 without BTC gate | 0.11 | 0.01 | -3.4 (-6.6 to -0.4) |
| v3, gate 8 months | 0.06 | 0.00 | -5.6 (-11.8 to -0.9) |
| v3, gate 12 months | 0.40 | 0.08 | -1.6 (-3.5 to +0.2) |
| Tilts only, no gate or caps | 0.24 | 0.03 | -2.8 (-7.2 to +1.0) |

Base + BTC gate (10 months) itself: active PSR 0.77, active DSR 0.33. It is the reference in the last column.

Active returns are each configuration minus the base plan, week by week. PSR asks whether that active Sharpe ratio is above zero; DSR also charges for the 21 configurations tried.

## Overfitting checks

- Probability of backtest overfitting (CSCV, 16 blocks, 12,870 splits): **57%**. Above 50% means the in-sample winner usually lands in the bottom half out of sample.
- The configurations move together (average weekly correlation 0.98), so the 22 trials count as about 1.4 independent ones.
- Walk forward: the best configuration before 2023-12-08 was **Base + BTC gate (10 months)**; after that date it ranked 5 of 22.

## Calendar years

| Configuration | 2021 | 2022 | 2023 | 2024 | 2025 | 2026 |
|---|---:|---:|---:|---:|---:|---:|
| Base plan, band rebalance | 52% | -29% | 65% | 48% | 34% | 21% |
| Base + BTC gate (10 months) | 52% | -17% | 60% | 46% | 34% | 21% |
| v3 default | 46% | -17% | 53% | 46% | 33% | 20% |
| v3 + drawdown overlay | 46% | -15% | 47% | 46% | 29% | 19% |
| v3 without either risk cap | 51% | -17% | 58% | 47% | 35% | 21% |
| v3 without BTC gate | 46% | -26% | 57% | 46% | 32% | 20% |

2021 starts on 2021-02-08; 2026 ends on 2026-10-09.
