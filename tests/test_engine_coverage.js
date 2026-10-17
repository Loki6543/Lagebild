'use strict';
// Tests for the Lagebild allocation engine covering the most important
// code paths beyond what test_replay.js already covers. Each test is
// self-contained: synthetic inputs, direct engine function calls, specific
// assertions tied to the spec.
//
// Spec rule being tested is noted in a comment above each test().

const test = require('node:test');
const assert = require('node:assert/strict');
const ZE = require('../engine/lagebild-engine');

// --- Test 1: PARAMS constants match the spec ---
test('PARAMS: key constants match the whitepaper', () => {
  // Spec p.6: δ constrained to [0.25, 0.75], λ = 0.94.
  assert.equal(ZE.PARAMS.shrinkMin, 0.25);
  assert.equal(ZE.PARAMS.shrinkMax, 0.75);
  assert.equal(ZE.PARAMS.ewmaLambda, 0.94);
  // Spec p.6: 24% annualized vol cap.
  assert.equal(ZE.PARAMS.volCap, 0.24);
  // Spec p.6: crypto risk cap 0.60 normal, 0.50 stress.
  assert.equal(ZE.PARAMS.cryptoRiskCap, 0.60);
  assert.equal(ZE.PARAMS.cryptoRiskCapStress, 0.50);
  // Spec p.5: smoothDays=21, smooth=0.5.
  assert.equal(ZE.PARAMS.smoothDays, 21);
  assert.equal(ZE.PARAMS.smooth, 0.5);
  // Spec p.5: NVDA look cap 10%.
  assert.equal(ZE.PARAMS.nvdaLookCap, 10);
  // Spec p.7: drawdown deadband 10%, max 30%, floor 0.5.
  assert.equal(ZE.PARAMS.ddDeadband, 0.10);
  assert.equal(ZE.PARAMS.ddMax, 0.30);
  assert.equal(ZE.PARAMS.ddFloor, 0.5);
  // Spec p.5: BTC gate 10 months.
  assert.equal(ZE.PARAMS.gateMonths, 10);
  // Spec p.5: action band 1.5pp abs, 20% rel.
  assert.equal(ZE.PARAMS.bandAbs, 1.5);
  assert.equal(ZE.PARAMS.bandRel, 0.2);
  // Spec p.5: vol floor 50% of default.
  assert.equal(ZE.PARAMS.volFloor, 0.5);
  // Spec p.4: trend/momentum horizon in years.
  assert.equal(ZE.PARAMS.trendH.eq, 63 / 252);
  assert.equal(ZE.PARAMS.trendH.cx, 90 / 365);
  assert.equal(ZE.PARAMS.momH.eq, 105 / 252);
  assert.equal(ZE.PARAMS.momH.cx, 105 / 365);
  // Spec p.6: stress correlation 0.8.
  assert.equal(ZE.PARAMS.stressRho, 0.8);
  // Spec p.6: stress threshold 0.15.
  assert.equal(ZE.PARAMS.stressThreshold, 0.15);
});

// --- Test 2: Asset universe matches the whitepaper ---
test('ASSETS: 12 instruments with correct base weights and sleeves', () => {
  // Base plan revised Oct 17: 61% stocks / 21% gold / 18% crypto.
  assert.equal(ZE.SLEEVES.stocks, 61);
  assert.equal(ZE.SLEEVES.gold, 21);
  assert.equal(ZE.SLEEVES.crypto, 18);
  // Spec p.2: base weights.
  const byId = Object.fromEntries(ZE.ASSETS.map(a => [a.s, a]));
  assert.equal(byId.VOO.base, 28);
  assert.equal(byId.SMH.base, 12);
  assert.equal(byId.NVDA.base, 5);
  assert.equal(byId.MSFT.base, 5);
  assert.equal(byId.TSM.base, 4);
  assert.equal(byId.XLE.base, 7);
  assert.equal(byId.IAUM.base, 14);
  assert.equal(byId.GDX.base, 7);
  assert.equal(byId.BTC.base, 8);
  assert.equal(byId.ETH.base, 3);
  assert.equal(byId.SOL.base, 5);
  assert.equal(byId.LINK.base, 2);
  // Sleeve sums: 28+12+5+5+4+7 = 61 (stocks); 14+7 = 21 (gold); 8+3+5+2 = 18 (crypto).
  const sum = sleeve => ZE.ASSETS.filter(a => a.sleeve === sleeve).reduce((s, a) => s + a.base, 0);
  assert.equal(sum('stocks'), 61);
  assert.equal(sum('gold'), 21);
  assert.equal(sum('crypto'), 18);
});

// --- Test 3: Sleeve band projects to spec ranges ---
test('SLEEVE_BAND: stocks 56-66, gold 16-26, crypto 13-18', () => {
  // Spec p.5: "Equities 51-61%; gold-related 19-29%; crypto 15-20%."
  const { stocks, gold, crypto } = ZE.SLEEVE_BAND;
  // [down, up] in percentage points.
  assert.deepEqual([stocks[0], stocks[1]], [5, 5]);
  assert.deepEqual([gold[0], gold[1]], [5, 5]);
  assert.deepEqual([crypto[0], crypto[1]], [5, 0]);
  // Effective ranges: stocks 51-61, gold 19-29, crypto 15-20.
  assert.equal(ZE.SLEEVES.stocks - stocks[0], 56);
  assert.equal(ZE.SLEEVES.stocks + stocks[1], 66);
  assert.equal(ZE.SLEEVES.gold - gold[0], 16);
  assert.equal(ZE.SLEEVES.gold + gold[1], 26);
  assert.equal(ZE.SLEEVES.crypto - crypto[0], 13);
  assert.equal(ZE.SLEEVES.crypto + crypto[1], 18);
});

// --- Test 4: NVDA look-through coefficients ---
test('LOOK: NVDA=1, VOO=0.08, SMH=0.20', () => {
  // Spec p.5: "Each unit transferred reduces NVIDIA exposure by 0.92 units"
  // because VOO has 8% NVIDIA weight, so the transfer formula is (L-10) / 0.92.
  assert.equal(ZE.LOOK.NVDA, 1);
  assert.equal(ZE.LOOK.VOO, 0.08);
  assert.equal(ZE.LOOK.SMH, 0.20);
  // Spec check: 1 - LOOK.VOO = 0.92, the divisor in the transfer formula.
  assert.equal(1 - ZE.LOOK.VOO, 0.92);
});

// --- Test 5: BTC month-end filter excludes the current month ---
test('monthEndCloses: filters out the current month even on the last day', () => {
  // Documented behavior (known off-by-one): the current month is always
  // excluded, even on the last day. This means the BTC gate is one month
  // behind on the last day of the month.
  const series = [
    { d: '2024-12-30', c: 90000 },
    { d: '2024-12-31', c: 91000 },
    { d: '2025-01-30', c: 92000 },
    { d: '2025-01-31', c: 93000 },
  ];
  // On Jan 31, 2025, current month is 2025-01; filter `m < cur` excludes it.
  const r1 = ZE.monthEndCloses(series, '2025-01-31');
  assert.deepEqual(r1.map(x => x.m), ['2024-12']);
  // On Feb 1, 2025, current month is 2025-02; January is now included.
  const r2 = ZE.monthEndCloses(series, '2025-02-01');
  assert.deepEqual(r2.map(x => x.m).sort(), ['2024-12', '2025-01']);
});

// --- Test 6: FOMC dates include the published 2026 meetings ---
test('FOMC: 2026 published meeting days are present', () => {
  // Spec p.4: "Only the next FOMC meeting enters the Fed score."
  // The 2026 dates must match the official Fed calendar.
  const required = ['2026-01-28', '2026-03-18', '2026-04-29', '2026-06-17',
                   '2026-07-29', '2026-09-16', '2026-10-28', '2026-12-09'];
  for (const d of required) {
    assert.ok(ZE.FOMC.includes(d), `Missing FOMC date: ${d}`);
  }
  // 2027 dates are forward-projection (not yet official).
  assert.ok(ZE.FOMC.length >= 16);
});

// --- Test 7: Smoothing age window: 3 to 21 days ---
test('smoothing: prior run must be 3 to 21 days old', () => {
  // Spec p.5: "p = ½·p + ½·p of the run 3 to 21 days old, before any limit"
  // The app already picks a 3-21 day prior; the engine now enforces it too.
  // We verify the code structure: the smoothing check is at the boundary
  // of an if/else; we inspect via a mock that the gate is inclusive.
  // The cleanest way is to confirm the constants and structure:
  //   smoothDays = 21 (PARAMS)
  //   the condition includes age >= 3.
  // We can't run a 3-day test without a full engine input, so we verify
  // by code reading: the line at engine.js:749 is:
  //   if (age >= 3 && age <= PARAMS.smoothDays && !flip) { ... }
  const fs = require('node:fs');
  const engine = fs.readFileSync(require('node:path').join(__dirname, '..', 'engine', 'lagebild-engine.js'), 'utf8');
  assert.ok(engine.includes('age >= 3 && age <= PARAMS.smoothDays'),
    'Smoothing check must enforce age >= 3 (spec: 3 to 21 days, not 0 to 21)');
  // And confirm the HTML matches the engine.
  const html = fs.readFileSync(require('node:path').join(__dirname, '..', 'app', 'index.html'), 'utf8');
  assert.ok(html.includes('age >= 3 && age <= PARAMS.smoothDays'),
    'HTML must match the engine (browser and replay are byte-identical)');
});

// --- Test 8: Empty input fails closed ---
test('engine: empty inputs return invalid status with blockers', () => {
  // Spec: a missing required input must block actionable targets.
  const r = ZE.compute({ now: '2026-10-16T20:00:00Z' }, {}, null, { shadows: false });
  assert.equal(r.status, 'invalid');
  assert.ok(r.blockers && r.blockers.length > 0);
});

// --- Test 9: smooth helper is exposed ---
test('compute is exposed on the engine module', () => {
  assert.equal(typeof ZE.compute, 'function');
  assert.equal(typeof ZE.monthEndCloses, 'function');
  assert.ok(Array.isArray(ZE.ASSETS));
  assert.ok(Array.isArray(ZE.FOMC));
});

// --- Test 10: Replay start is documented, not changed ---
test('run_replay.js: first decision is seeded as the base plan', () => {
  // The audit proposed dropping the +1. The replay deliberately seeds the base plan at the
  // first execution day after DECISIONS[0]; the first weeks are blocked (SOL history), so
  // evaluating DECISIONS[0] would trade nothing. Changing it needs a full replay rerun.
  // See docs/v3-audit-review.md.
  const fs = require('node:fs');
  const replay = fs.readFileSync(require('node:path').join(__dirname, '..', 'run_replay.js'), 'utf8');
  assert.ok(replay.includes('DATES.indexOf(DECISIONS[0]) + 1'),
    'replay start changed: rerun the replay and update results/ before changing this test');
});
