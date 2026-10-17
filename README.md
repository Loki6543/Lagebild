# Zobiris Lagebild replay

A weekly replay of the Lagebild allocation engine from February 2021 to October 2026, with the
overfitting tests the October 16 technical whitepaper asked for. It runs the engine the app ships
(`engine/lagebild-engine.js`, copied verbatim from the published artifact), so a result here is a
result for the real app.

Results: [`results/REPORT.md`](results/REPORT.md). Research only: it reads no exchange credentials and has no trading authority. The numbers behind the report are in `results/summary.json`; each configuration's weekly returns are
written to `results/runs/` when you run the replay (kept out of git for size).

## Run it

```bash
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/python build_panel.py      # raw downloads -> data/panel/panel.json
node run_replay.js                   # all configurations -> results/runs/*.json   (about 1 minute)
.venv/bin/python analyze.py          # statistics -> results/summary.json, results/REPORT.md   (about 1 minute)
.venv/bin/python tests/test_stats.py # checks of the statistics code
```

`node run_replay.js v3 base` reruns only the named configurations.

## What it does

**No lookahead.** Each Friday the engine sees ETF closes through Friday, crypto daily bars through
Thursday (Friday's 00:00 UTC bar closes four hours after the US close), and macro values whose
publication date is on or before Friday. Decisions are executed at the next session's close.

**Point-in-time macro.** Treasury and TIPS yields count from the day after observation. Fed funds is
the monthly average of the daily rate, known on the first of the next month. CPI is the
not-seasonally-adjusted index (CPIAUCNS), which is never revised, known on the 15th of the next
month, so its values are the ones published at the time without needing ALFRED vintages.

**Trading.** The engine is given the replay's current holdings. An Add or Trim moves that holding to
its target; Hold leaves it alone; a blocked run (fail closed) trades nothing. Additions never borrow:
if the trims and cash cannot fund them, they are scaled down. Costs are 0.10% of traded value for
ETFs and stocks and 0.50% for crypto. Cash earns the 3-month T-bill (DTB3).

**Every trial counts.** All configurations in `run_replay.js` are kept and enter the overfitting tests.
Add a configuration there and rerun; never delete one that has been run.

## Data

Downloaded on 2026-10-17 through the session's connectors. The raw files stay out of git because
of provider terms; `data/MANIFEST.json` lists their SHA-256 hashes.

| Series | Source | Notes |
|---|---|---|
| 8 ETFs and stocks, daily | Twelve Data `get_time_series` | split-adjusted closes, Jan 2020 to Oct 15 2026 |
| IAUM before 2021-07-01 | GLD from Twelve Data | IAUM did not exist; GLD's daily returns stand in |
| BTC, ETH, SOL, LINK, daily | Twelve Data | SOL starts 2020-08-11 |
| Dividends | Alpha Vantage `DIVIDENDS` | XLE before Dec 2025 and SMH before May 2023 halved for their splits; NVDA left out |
| DGS10, DFII10, DFF, DTB3, CPIAUCNS | FRED CSV through Firecrawl | |

## Known limits

- Inputs the app reads live have no free history and count as 0 here, as the app's missing-data rule
  says: the TEXT TO QUANT crypto regime, CoinMarketCap open interest, CME FedWatch odds (the Fed term
  falls back to the six-month Fed funds change), Fear and Greed and Hyperliquid positioning.
- The first 7 weeks are blocked because SOL has too little history for a trend signal, so every
  configuration holds the base plan until late March 2021.
- The twelve holdings were chosen in 2026 with hindsight. Compare configurations with each other;
  the absolute returns are not a forecast.
- One market history: the configurations correlate at 0.98 week to week, so 22 trials are worth about
  1.4 independent ones.

## App and written method

- `app/index.html`: the Lagebild app (v3.1) as published on claude.ai. It reads market data through claude.ai connectors (`window.claude`), so it runs as a claude.ai artifact, not as a standalone page.
- `docs/lagebild-v3.1.md`: the app's Formula and Plan tabs as Markdown: the 12-step formula, the risk model, what the review and technical whitepaper changed, the 2021–2026 replay table, data sources, the free-data path, and the base plan and standing rules.

## Verification and review

- `verification/crypto_cap_proof.py`: the whitepaper's proof that the crypto risk-cap root never leaves crypto above its share of risk (10,000 random portfolios, two covariance models each).
- `verification/engine_crypto_cap_check.js`: the same test run against the shipped engine's own functions. Both report 0 failures.
- `docs/whitepaper-v2-review.md`: the v2 whitepaper and research memo checked against this code. It lists what the engine already specifies, what is still open, and where v2 is wrong. Read it before adopting any v2 placeholder.
