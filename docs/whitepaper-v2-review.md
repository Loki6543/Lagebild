# Review of the v2 whitepaper and research memo against the code

Reviewed 2026-10-17. Inputs: the "Improved technical whitepaper" (v2, 17 October 2026), its research memo and
`proof.py`. Both were written without access to this repository: they describe the engine from the October 16
whitepaper and list many values as "not specified" or "REQUIRED". Most of those values are in
`engine/lagebild-engine.js` (v3.1, the engine the app ships) or in the replay code here. This document records
what the code actually does, what remains open, and where v2 is wrong, so v2's placeholders are not adopted by
mistake.

Research only. Nothing here changes the engine or carries trading authority.

## 1. Verified

| Claim | Check | Result |
|---|---|---|
| The crypto risk-cap root keeps the crypto share of variance at or below the cap | `verification/crypto_cap_proof.py` (v2's proof, a Python re-implementation) | 10,000 portfolios, 20,000 model checks, 0 failures, max excess 4.4 × 10⁻¹⁶ |
| The same holds for the engine the app ships, not just a re-implementation | `verification/engine_crypto_cap_check.js` (new: same test through the engine's own `cryptoScale`, `portRisk`, `cryptoShareOf`) | 10,000 portfolios, 20,000 model checks, 0 failures, 0 weights raised, max excess 5.6 × 10⁻¹⁶ |
| Shrinkage is Ledoit and Wolf's constant-correlation ("Honey", 2004) target, not scikit-learn's scaled identity | `ledoitWolf()` computes the Honey intensity toward the mean pairwise correlation, clamped to [0.25, 0.75], then repairs to a valid correlation matrix (`psdCorr`) | v2's correction is right, and the code and `docs/lagebild-v3.1.md` already say so |
| The EWMA model is binding for the crypto cap, not display-only | `enforce()` takes the minimum `cryptoScale` over the base and EWMA models; `verify()` checks both | v2 is right; v3.1 already resolved the wording |
| ATR is not volatility | The engine uses the annualised standard deviation of log returns everywhere and never ATR | Agrees with v2 |

The engine's root is also more robust than the proof's. It returns 1 when crypto is already within the cap.
It uses the rationalised form `2qC / (√disc + L)` when `L ≥ 0`, which avoids cancellation, and it returns 0
when non-crypto risk is zero instead of raising an error.

## 2. Items v2 marks "not specified" that the code specifies

| v2 item | What the code does |
|---|---|
| Base weights; v2 proposes an equal ETH/SOL/LINK split | All twelve are fixed: VOO 26, SMH 12, NVDA 5, MSFT 4, TSM 4, XLE 5, IAUM 16, GDX 8, BTC 10, ETH 3, SOL 5, LINK 2. **Do not adopt the equal split.** |
| Clamp endpoints; v2 proposes ±3σ | Trend T and momentum M are clamped to [−1, 1]. The tilt multiplier `exp(0.2·z)` is also clamped to [0.6, 1.5], a step v2's formula omits. **Do not adopt ±3σ.** |
| Default volatilities; v2 proposes "63-day realised" | A fixed table used as a floor (σe = max(63-day vol, ½ × default)) and as the fallback: VOO 16%, SMH 32%, NVDA 45%, MSFT 25%, TSM 35%, XLE 25%, IAUM 16%, GDX 35%, BTC 50%, ETH 70%, SOL 85%, LINK 85%. |
| Macro "level" | From the 10-year yield y: −1 if y ≥ 5%, −0.5 if ≥ 4.5%, 0 if ≥ 4%, +0.5 below 4%. |
| Macro "semis" | z-score of the SMH/VOO price ratio over its last 50 observations, divided by 1.5 and clamped to [−1, 1]. Not the Philadelphia Semiconductor Index. |
| Fed term without FedWatch | −1, 0 or +1 from the six-month change in Fed funds (±0.10 point band), labelled as a proxy. |
| Smoothing prior run | The app takes the most recent valid (not blocked) run aged 3 to 21 days. With none, there is no smoothing. Smoothing is also skipped when the BTC gate or trend-distance level flipped since that run, which neither whitepaper mentions. |
| Correlation-spike trigger; v2 proposes crypto pairs above 0.85 | The average EWMA correlation of the risk set (VOO, SMH, NVDA, TSM, BTC, ETH, SOL) exceeds its 63-day sample average by more than 0.15 **and** is above 0.4. The cap then tightens from 0.60 to 0.50. **Do not adopt v2's placeholder.** |
| Trend-distance thresholds | z = ln(P / 210-day average) ÷ (30-day daily vol × √30), S = Φ(z). Clear when S ≥ 0.5 (z ≥ 0). Trim when 0.2 ≤ S < 0.5: alts scaled by 0.5 + 0.5·(S − 0.2)/0.3. Cut when S < 0.2 (z below about −0.84): alts exit and BTC is halved. Off by default. |
| Drawdown overlay | m = 1 up to a 10% drawdown, then 1 − 0.5·(D − 0.10)/0.20, with a floor of 0.5 at 30%. The slope is 2.5, not the "CPPI multiplier 5" v2 states. |

## 3. Replay questions v2 raises, answered by this repository's replay

| v2 question | Answer (see `README.md`, `stats.py`, `analyze.py`) |
|---|---|
| Bootstrap method | Paired stationary bootstrap (Politis and Romano 1994), mean block 8 weeks, 5,000 draws, percentile interval. |
| Turnover convention | One-way, per year. |
| DSR and PBO inputs | Computed from the full weekly return series of all 22 configurations. No trial is dropped, and the trials correlate at 0.98. |
| Kraken 720-bar ceiling | Does not apply: crypto history comes from Twelve Data daily series. It matters only for anyone rebuilding the replay from Kraken's public endpoint. |
| ALFRED vintages | Treasury and TIPS yields count from the day after observation, and market yields are not revised. CPI is the non-seasonally-adjusted index, which is never revised. Fed funds is known on the first of the next month. |
| "One bear market" | The window contains the 2022 equity bear (S&P 500 about −25% peak to trough, January to October 2022) and the 2022 crypto winter (BTC about −77%). v2 is right that "one bear market" undersells it. The memo's "19.4%, just missed" is the calendar-year 2022 loss, not the peak-to-trough fall. |

**A discrepancy to resolve.** The replay table in `docs/lagebild-v3.1.md` (from the app) is not the table this
repository reproduces in `results/REPORT.md`:
- **v3 default:** the app reports a CAGR of 30.6% and turnover of 92%. Here, the CAGR is 29.6% and one-way turnover is 34%.
- **Base + BTC gate:** this replay matches v3 default or beats it.

The app's table came from an earlier run with an unstated turnover convention. `results/REPORT.md` is the
reproducible one, so treat it as authoritative and update the app's Formula tab to match it.

## 4. Still open

1. **Fund look-through coefficients.** NVIDIA at 8% of VOO and 20% of SMH are assumptions, not verified holdings, and they drift.
2. **Ballast split.** 60% VOO / 40% gold is a stated choice that the replay never tested against alternatives. It is a cheap challenger to add to `run_replay.js`.
3. **Live-only inputs.** The crypto regime, open interest, FedWatch odds, Fear and Greed, and positioning have no free history, so the replay counts them as 0. The macro effect the replay measures is therefore only the yields-and-Fed part.
4. **Actions with real holdings.** First-run, zero-position and outside-cash conventions are in the app (`markHoldings`) but not written up.
5. **Prospective record.** Every interval for the gain over the base plan still includes zero. Only a frozen rule set run forward can change that.

## 5. Errors in v2 and the memo

The literature appendix was partly written from memory; the memo says so itself in F.2. These are the
corrections I could make with confidence. Every other citation in v2 should be checked against the source
before it is reused.

- **Hurst, Ooi and Pedersen (2017),** "A Century of Evidence on Trend-Following Investing", appeared in the *Journal of Portfolio Management* 44(1), not the *Journal of Financial Economics*. The DOI and volume v2 gives do not belong to it. Its evidence is 67 markets from 1880; v2 says 58.
- **Jegadeesh and Titman (1993)** appeared in the *Journal of Finance* 48(1). v2's inline note says JFE and gives a JFE DOI; its own reference list has it right.
- **Golden Butterfly** is from Tyler at Portfolio Charts, not Rick Ferri. The **Permanent Portfolio** is Harry Browne's and has no connection to Caxton Associates.
- **Drawdown overlay.** The slope is 2.5, not 5. The overlay is a drawdown-triggered scale-down, not a cushion rule, so "CPPI-like in spirit" is the most the comparison supports.
- **The v1 claim that the holding table is empty** is true of the PDF v1 reviewed, not of the engine (section 2).

The rest of v2's literature framing is reasonable context and changes nothing in the engine:
- the tilt is a heuristic, not Black-Litterman;
- the base plan is a strategic anchor, not risk parity;
- the BTC gate is a standard time-series trend rule;
- 22 correlated trials are a small sample.

## 6. What was added to the repository

- `verification/crypto_cap_proof.py`: v2's proof, unchanged. Run it with `python3 verification/crypto_cap_proof.py` (needs numpy).
- `verification/engine_crypto_cap_check.js`: the same proof run against the shipped engine. Run it with `node verification/engine_crypto_cap_check.js`.
- This review. The v2 whitepaper and memo themselves are not committed, because their placeholders (equal crypto split, ±3σ clamps, a crypto-only spike rule) contradict the engine and would mislead a later reader.
