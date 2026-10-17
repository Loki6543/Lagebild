# Zobiris Lagebild v3.1: formula, replay and base plan

Extracted from the Formula and Plan tabs of the Lagebild app (`app/index.html`), as published on 2026-10-17. Research only: not personal financial advice, and nothing here places trades.

## The formula, version 3.1

    
Version 3 answers the October 16 formula review and a weekly replay of the engine from February 2021 to October 2026. Version 3.1 adds the operating rules of the October 16 technical whitepaper: a record and a quality state for every input, and a run that fails closed. After the sleeve projection only the ballast step can raise a holding (VOO and gold, up to their sleeve ceilings); every later step lowers holdings or moves money to cash. The final weights are checked against every limit on each refresh, and a failed check blocks the run.

#### 1 · Signal
```
S = ½·T + ½·M
  (both in volatility units)
Trend
  T = clamp(ln(P ÷ A) ÷ (σe·√H))
  stocks, gold: A = 200-day average,
  H = 63/252
  crypto: A = 70 three-day bars
  (210 days), H = 90/365
Momentum
  M = clamp(ln(P 21 days ago ÷
  P 126 days ago) ÷ (σe·√h))
  h = 105/252 stocks,
  105/365 crypto
σe = max(63-day vol,
  ½ × default vol)
```

#### 2 · Macro
```
stocks = 0.3·(−Δ10y 3m ÷ 0.5)
  + 0.3·level + 0.15·Fed + 0.25·semis
gold = 0.55·(−Δ real yield 3m ÷ 0.5)
  + 0.3·Fed − 0.15·semis
  real yield: 10-year TIPS
  (FRED DFII10), fallback 10y − CPI
crypto = 0.6·RSPS regime + 0.4·leverage
  leverage: open interest 30d
  minus market cap 30d
Fed = clamp(−E[Δrate] ÷ 0.25),
  next FOMC only (CME FedWatch)
Missing parts count as 0; nothing
is reweighted.
```

#### 3 · Tilt
```
z = 0.8·S + 0.2·macro
  (z = 0 when the signal is missing)
p = base · e^(0.2·z),
  scaled to 100
```

#### 4 · Smoothing
```
p = ½·p + ½·p of the run
  3 to 21 days old, before any limit
```

#### 5 · Sleeves
```
exact projection:
stocks 51–61, gold 19–29, crypto 15–20
```

#### 6 · Limits
```
one upper bound per holding,
the tightest wins
BTC ≤ 10 → excess to ballast
NVDA look-through ≤ 10: move
  (L − 10) ÷ 0.92 of NVDA into VOO
ballast VOO 60 / gold 40, only up to
  the sleeve ceilings, rest to cash
BTC month-end close below
  its 10-month average
  → alts 0, BTC ≤ ½·min(p, 10),
  proceeds to cash
switches: alt trend gate (alt ≤ ½·p),
  trend-distance gate
```

#### 7 · Crypto risk
```
share ≤ 60% (50% in a correlation
  spike), base and EWMA models
a* = min(1, positive root of
  (1−q)A·a² + (1−2q)B·a − qC)
A = kᵀΣk, B = kᵀΣn, C = nᵀΣn
crypto × a*, rest to cash
```

#### 8 · Volatility
```
s = min(1, 24% ÷ σ(w))
every holding × s, rest to cash
```

#### 9 · Switch
```
drawdown overlay:
  m = 1 if D ≤ 10%, else
  max(0.5, 1 − ½·(D − 10%) ÷ 20%)
```

#### 10 · Check
```
every limit verified on the final
weights
```

#### 11 · Actions
```
against marked holdings, else the
  last run: Add or Trim beyond
  max(1.5 pts, 20% of position);
  forced trims are never held back
```

#### 12 · Status
```
valid: every input observed,
  every check passes
degraded: an optional input is
  missing, delayed or a proxy; it
  counts as 0 or is labeled, and the
  targets stay actionable
invalid: a price series, the BTC
  month-end closes, the risk model or
  a final check is missing or fails
  → no actionable targets; the last
  valid run stays visible as history
```

#### Risk model
```
Σ = D·R·D
D = long-window volatility
  (252 days stocks, 300 days crypto)
R = (1−δ)·R_EWMA(λ 0.94) + δ·r̄
  δ: Ledoit–Wolf intensity toward
  the average correlation, kept in
  [0.25, 0.75]; repaired to the
  nearest valid correlation matrix
EWMA model: second check for the
  crypto risk cap
shown only: 63-day sample,
  stress at ρ = 0.8
```

    
### What the review changed

    
      - **Adopted as correctness fixes:** final limits enforced once and checked (the old order let ballast transfers and smoothing break earlier caps); the NVDA transfer divided by 0.92; Fed odds from the next meeting only; smoothing moved before the limits; gates turned into upper bounds so halvings never multiply; the crypto risk repair replaced by the review's closed form, verified on 10,000 random cases with zero failures.

      - **Adopted as better estimates:** trend and momentum in volatility units with log returns, so a 10% gap means more for gold than for SOL; long-window volatilities with shrunk, valid correlations; the trend-distance gate measured against a fully observed 210-day average instead of an EMA that still carried 5% weight on its first bar; a market real yield from TIPS instead of 10y minus CPI.

      - **Adopted from your own Zobiris rules:** Hyperliquid positioning and Fear & Greed are shown but carry no weight, because the Zobiris roadmap gives positioning shadow status with no trading authority.

      - **Not adopted:** the review's claim that crypto momentum lacked history (the engine uses 3-day bars covering 300 days, and already annualizes crypto on 365 days); its open-interest objection (CoinMarketCap reports a true 30-day change, now netted against the market-cap change); enforcing the 24% ceiling under a 0.8 stress correlation, which would hold about 18% cash permanently and break your fully invested mandate, so stress volatility is shown instead.

      - **Macro kept at 0.2, not 0:** the replay could not measure any effect either way (certainty-equivalent 19.9% without macro, 20.2% at 0.2 and 0.4), so macro keeps half its old authority as context rather than full control.

    

    
### What the technical whitepaper changed, v3.1

    
The October 16 technical whitepaper documented this engine and audited it against public endpoints and independent calculations. Version 3.1 adopts its operating rules.

    
      - **Fail closed:** if a price series, the BTC month-end closes, the risk model or a final check is missing or fails, the run gives no actionable targets. The last valid run stays visible, labeled as history, and the blocked refresh is kept in the run log.

      - **Every input carries a record:** source, units, observation date, retrieval time and a quality state, which is observed, delayed, missing, inconsistent or proxy. The Data quality card shows them on every run.

      - **Gaps stay visible:** a missing optional input still counts as 0 and nothing is reweighted, but the run is marked degraded. The 10y minus CPI fallback for the TIPS yield and the Fed funds fallback for FedWatch are labeled proxies, because they measure something different.

      - **Implausible values are excluded:** a 30-day open interest or market cap change beyond ±150% sets the leverage term to 0 instead of moving the crypto score.

      - **Wording corrected:** the ballast step can raise VOO and gold after the sleeve projection, so the final check, not the order of the steps, is what guarantees the limits. The EWMA model is a second check for the crypto risk cap, not a display-only model.

    
    
### Corrections the audit confirmed

    
      - Volatility here is the annualized standard deviation of log returns. ATR is a range statistic and is never used as volatility.

      - The shrinkage is the Ledoit–Wolf intensity toward the average correlation, applied to EWMA correlations. scikit-learn's LedoitWolf shrinks toward a scaled identity instead, so the two are different estimators.

      - The crypto cap has one exact answer: when crypto and non-crypto risk are both positive, the quadratic is negative at zero, so it has exactly one positive root. An independent rerun on 10,000 random portfolios under two covariance models found no case above the cap; the largest excess was 4.4 × 10⁻¹⁶.

      - CPCV and the Deflated Sharpe Ratio need the full return series of every trial, not the summary table, so neither is claimed. Derivatives, funding carry and meta-labeling stay separate research with no trading authority.

    

    
### Replay, February 2021 to October 2026

    
Weekly decisions at Friday's close using only data observable then, executed at the next session's close, 0.10% cost per ETF trade and 0.50% per crypto trade, cash earning the 3-month T-bill. Gold uses GLD before IAUM existed.

    
| Rule set | CAGR | Vol | Max DD | CE | Turnover |
|---|---|---|---|---|---|
| Base plan | 28.3% | 20.3% | 38.6% | 17.6% | 63% |
| Base + BTC gate | 31.2% | 18.7% | 28.7% | 20.5% | 75% |
| v3 default | 30.6% | 18.3% | 29.2% | 20.2% | 92% |
| v3 + drawdown | 30.0% | 17.0% | 23.9% | 20.2% | 132% |
| v2, Oct 16 | 28.7% | 17.1% | 24.5% | 19.1% | 108% |

Rows: the plain base plan rebalanced on bands; the same plus the monthly BTC gate; this app’s default; the default plus the drawdown overlay; version 2 as published. CE is the certainty-equivalent return. Volatility and turnover columns appear on wider screens.

    
      - The monthly BTC gate does almost all the protective work: it cut the 2022 drawdown from 38.6% to 28.7%. The cut held with a 12-month average, but an 8-month average whipsawed and lost 2 points of certainty-equivalent return, so 10 months stays. Trend tilts added about 1.5 points of certainty-equivalent return; the volatility ceiling and crypto risk cap cost about 0.7 points as insurance.

      - No rule set clears the review's promotion bar: every 95% bootstrap interval for the gain over the plain base plan includes zero. 5.7 years and one bear market cannot prove an edge.

      - The absolute returns are flattered by hindsight: the twelve holdings were chosen in 2026, knowing NVIDIA, semiconductors, BTC and SOL did well. Read the table for differences between rule sets, not as a forecast.

      - CE is the certainty-equivalent return: annual excess return minus 1.5 times its variance. 28 configurations were tried; all are kept in the research log.

    

    
### Where the data comes from

    
      - **Twelve Data:** 260 days of daily closes for VOO, SMH, NVDA, MSFT, TSM, XLE, IAUM and GDX.

      - **CoinDesk:** 100 daily and 100 three-day composite closes for BTC, ETH, SOL and LINK. **Crypto.com** is the fallback.

      - **Alpha Vantage:** weekly 10-year Treasury yield, monthly CPI and Fed funds, and BTC month-end closes for the gate, cached 12 hours.

      - **Firecrawl:** CME FedWatch odds for the next Fed decision, and FRED's 10-year TIPS yield (DFII10), cached 12 hours.

      - **TEXT TO QUANT:** the RSPS crypto regime. **CoinMarketCap:** open interest, market cap, Fear & Greed and ETF assets. **Coinversa Pulse:** Hyperliquid positioning, shown only.

    
    
### Free-data path

    
The audit found that the core math needs no paid service: trend, momentum, covariance, the crypto cap and the equal-risk portfolios are computed here from price histories. What is free, and what is not:

    
| Input | Route | Status |
|---|---|---|
| ETF daily closes | Twelve Data Basic: 8 credits a minute, 800 a day; one refresh uses 8 | free |
| Crypto daily and 3-day closes | CoinDesk with Crypto.com as fallback; Kraken's public OHLC (720 daily bars) also works | free |
| BTC month-end closes | Alpha Vantage free tier, cached 12 hours | free |
| 10-year yield, CPI, Fed funds | Alpha Vantage or FRED | free |
| Real yield (TIPS) | FRED DFII10; a replay needs ALFRED vintages, not today's revised values | free |
| Fed odds | FedWatch page read by Firecrawl; the official FedWatch API is paid (about $25 a month end-of-day when checked) | conditional |
| Crypto regime | TEXT TO QUANT RSPS is proprietary, with no verified free contract | conditional |
| 30-day open interest | CoinMarketCap gives a 30-day change without an observation time; Hyperliquid's public endpoint covers one venue, today only | conditional |
| A proven return edge | No data source supplies one; it needs frozen rules and a forward shadow record | unproven |

    
Free means no new paid data subscription for personal research. It does not cover commercial display or redistribution, which Twelve Data's usage policy restricts.

    
### What it cannot do

    
      - It reacts to the market; it does not predict it. Trend rules lag turning points by design.

      - It does not know your tax lots. In a taxable account, every Trim can realize gains the replay does not charge for.

      - Fund look-through coefficients (NVIDIA at 8% of VOO and 20% of SMH) are assumptions, not verified holdings.

      - Crypto closes at 00:00 UTC, four hours after the US stock close, so daily correlations carry a small timing mismatch.

## Base plan: medium plus

    
The anchor the engine tilts from, set Oct 16, 2026 and revised the same day: crypto lowered to 20% with BTC at 10% and more SOL than ETH. Fully invested, because bonds and interest-earning accounts are held elsewhere.

    
_(Base plan table: VOO 26, SMH 12, NVDA 5, MSFT 4, TSM 4, XLE 5 · IAUM 16, GDX 8 · BTC 10, ETH 3, SOL 5, LINK 2; sleeves stocks 56, gold 24, crypto 20.)_

    
### Standing rules

    
      - **Bewegungskrieg:** stage new money. Core stocks at once, crypto and SMH in two tranches, gold over three months or more.

      - **Hinhaltender Widerstand:** the monthly BTC gate, applied at each month-end close. It is the one rule the replay clearly supports.

      - **Elastische Verteidigung:** act on Add or Trim signals only; ignore Hold noise.

      - **Probe ledger:** new coins only from the CoinMarketCap top 500, at most 2% each, logged with a thesis and an exit.

    
    
### Known weaknesses

    
      - Rebalanced without any gate, the plan fell 38.6% from November 2021 to October 2022 and stayed under water for 731 days. With the monthly gate the fall was 28.7%.

      - Crypto is 20% of the money but 28% to 50% of the plan's risk, depending on the year: 28% in mid October 2026, 50% in June 2022. Its volatility has cooled, with SOL at about 59% a year and BTC at 41% over the last 300 days, while gold miners have run near 52%.

    
    
This app is research built from public data and your Zobiris framework. It is not personal financial advice and it does not place trades.
