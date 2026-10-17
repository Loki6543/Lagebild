# Review of the v3 audit against the code

Reviewed 2026-10-17. Inputs: `audit-memo.md`, `FIXES.md`, `v3-improved-whitepaper.md` and
`test_engine_coverage.js`. Like v2, the audit was written without this repository. It cites files that
are not here (`tests/test_replay.js`, `tests/test_analysis.py`, `EVALUATION.md`), and the "before" code it
quotes is not the engine's code. This document records what holds, what was overstated and what was added.

Research only. Nothing here carries trading authority.

## 1. The two "HIGH" bugs

| Audit claim | What the code does | Outcome |
|---|---|---|
| **Bug 23.** Smoothing accepts a prior run from 0 to 21 days old; the spec says 3 to 21. | The engine line (`engine/lagebild-engine.js:749`, copied at `app/index.html:1261`) checked only `age <= 21`. But the app already selects the prior with `age >= 3 && age <= 21` (`app/index.html`, prior-run lookup). The replay's prior is the previous weekly run, about 7 days old. No caller could pass a 0 to 2 day prior. | **No behaviour change.** The guard `age >= 3 &&` is now in both copies as defence in depth, and test 7 checks it. |
| **Bug 24.** `run_replay.js` starts at `indexOf(DECISIONS[0]) + 1`, so the first Friday is "silently dropped". | Deliberate. The base plan is seeded at the first execution day and the loop runs from there. The first 7 weeks are blocked because SOL has too little history, so evaluating the first Friday would trade nothing either way. | **Not changed.** Dropping the `+1` alters seeding, and confirming that requires a full replay rerun from the raw panel, which is not in git. Test 10 now pins the current start and points here. |

## 2. Valid points carried forward

| Issue | Status |
|---|---|
| `pbo_cscv` silently returned 1.0 when there were too few rows per block. | **Fixed.** It now raises `ValueError` when there are fewer than 2 trials, n_blocks is odd or below 2, or there are fewer than 2 rows per block. `tests/test_stats.py::test_pbo_refuses_too_few_rows` covers it. The published run (about 300 weeks × 22 trials, 16 blocks) is unaffected. |
| `monthEndCloses` excludes the current month, even on its last day. | Correct by design: the BTC gate uses completed months only. Test 5 documents it. |
| A constant price series gives NaN in the EWMA and correlation. | Open. Real prices are never constant, but the engine should fail closed on a non-finite risk matrix rather than rely on that. |
| The data-freshness check (`lastCloseMs`) treats US holidays as stale days. | Open. It produces a false warning, not a wrong target. |
| Initial costs and the first holding interval are left out of weekly excess returns. | Open. This is a one-row bias, inside the noise. |
| Crypto valuation timing in the replay (24/7 marks against equity closes). | Open. Weekly marks mix crypto at the UTC daily close with equity closes. |

## 3. Errors in the v3 whitepaper (not committed)

The v3 whitepaper repeats several v2 errors that `docs/whitepaper-v2-review.md` already corrected, and adds some new ones.

- **Drawdown overlay.** It still says "CPPI multiplier 5". The slope is 2.5 (m = 1 − 0.5·(D − 0.10)/0.20).
- **Hurst, Ooi and Pedersen.** It still cites the *Journal of Financial Economics* and 58 markets. The paper is in the *Journal of Portfolio Management* and covers 67 markets.
- **Golden Butterfly.** It is still attributed to Rick Ferri. It is Tyler's at Portfolio Charts.
- **UI tabs.** It lists tabs the app does not have. The tabs are Lagebild, Holdings, History, Formula and Plan.
- **`monthlyGate` and FedWatch.** It says `monthlyGate` depends on FedWatch odds. The gate uses only BTC month-end closes. FedWatch is a live-only macro input, and the engine uses a Fed-funds proxy without it.
- **Holding table.** It still says the v1 holding table is empty. The engine specifies every weight.
- **Test totals.** "25/25 tests passing" counts test files this repository does not have.

The whitepaper itself is not committed, for the same reason the v2 one was not: its errors would mislead a later reader.

## 4. What was added

- `tests/test_engine_coverage.js`: the audit's 10 node tests. Tests 1 to 6, 8 and 9 are unchanged. Test 7 checks the smoothing guard. Test 10 pins the replay start, as described in section 1.
- The `age >= 3` smoothing guard, applied identically to the engine and the app copy.
- The `pbo_cscv` input guard and its test.
- This review.

Checks run: `node --test tests/test_engine_coverage.js` 10/10, `python3 -m pytest -q tests` 8/8,
`verification/engine_crypto_cap_check.js` and `verification/crypto_cap_proof.py` 0 failures each.
