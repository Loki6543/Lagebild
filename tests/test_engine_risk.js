'use strict';
// Tests for the diagnostic-only 1-day historical CVaR (expected shortfall at 95%) and for the fail-closed handling of
// non-finite risk numbers. Run: node --test tests/test_engine_risk.js
//
// Fields intentionally added or changed in the engine output, relative to the engine at the previous commit:
//   - run.risk.cvar  (new): { alpha, horizon, n, from, to, target, base } or null. Diagnostic only.
//   - run.status / run.blockers: a run whose risk model publishes a non-finite number (portfolio volatility, EWMA
//     volatility, or the drawdown figures) is now 'invalid' with the existing "Risk model lacked aligned daily returns"
//     blocker. Before, only a non-finite base volatility did that. No other field changes; the behaviour-lock tests below
//     prove it on real data.
//
// Fixtures: the saved live data (px.json, macro.json, real.json) from the app's database. Set ZOBIRIS_LIVEDB to the
// directory that holds them; the tests that need them are skipped, with a reason, when the files are missing.
// The behaviour lock compares against the engine at git revision ZOBIRIS_PREV_ENGINE_REV (default HEAD). Once this change
// is committed, point the variable at the commit before it, otherwise the lock compares the engine with itself.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const ZE = require('../engine/lagebild-engine');
const { histCvar, portReturns } = ZE._internal;
const SYMS = ZE.ASSETS.map((a) => a.s);
const EQ = ['VOO', 'SMH', 'NVDA', 'MSFT', 'TSM', 'XLE', 'IAUM', 'GDX'];
const CX = ['BTC', 'ETH', 'SOL', 'LINK'];

const LIVEDB = process.env.ZOBIRIS_LIVEDB ||
  '/tmp/claude-0/-home-user/fb608053-5006-55a1-ad06-6df71e181160/scratchpad/livedb/cache';
const HAVE_LIVE = ['px.json', 'macro.json', 'real.json'].every((f) => fs.existsSync(path.join(LIVEDB, f)));
const NO_LIVE = HAVE_LIVE ? false : 'saved live data not found (set ZOBIRIS_LIVEDB to the folder with px.json, macro.json, real.json)';

const clone = (o) => JSON.parse(JSON.stringify(o));
const close = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, (msg || 'values differ') + ': ' + a + ' vs ' + b + ' (tolerance ' + tol + ')');

// ---------- the real engine input, built the way the app's refresh builds it ----------
function readDoc(file) {
  const d = JSON.parse(fs.readFileSync(path.join(LIVEDB, file), 'utf8'));
  return d && d.data && typeof d.data === 'object' && !Array.isArray(d.data) ? d.data : d;
}
const lastObs = (ser) => (ser && ser.length ? String(ser[ser.length - 1].d).slice(0, 10) : null);
const monthEndISO = (m) => new Date(Date.UTC(+m.slice(0, 4), +m.slice(5, 7), 0)).toISOString().slice(0, 10);
// mirror of buildEvidence in app/index.html; retrieval times are left out because they never enter the engine
function buildEvidence(inp) {
  const now = inp.now, out = [];
  const add = (r) => { r.fallback = false; out.push(r); };
  EQ.forEach((s) => { const ser = inp.prices[s]; add({ id: s, asset: s, label: s + ' daily closes', role: 'critical', source: 'Twelve Data', units: 'USD close', have: !!(ser && ser.length), observedAt: lastObs(ser), maxAgeDays: 4, hardAgeDays: 7 }); });
  CX.forEach((s) => {
    const d = inp.prices[s], l = inp.cryptoLong[s];
    add({ id: s, asset: s, label: s + ' daily closes', role: 'critical', source: 'CoinDesk', units: 'USD, 00:00 UTC bars', have: !!(d && d.length), observedAt: lastObs(d), maxAgeDays: 2, hardAgeDays: 5 });
    add({ id: s + '_l', asset: s, label: s + ' 3-day bars', role: 'critical', source: 'CoinDesk', units: 'USD, trend bars', have: !!(l && l.length), observedAt: lastObs(l), maxAgeDays: 4, hardAgeDays: 9 });
  });
  const bm = inp.btcMonthly ? ZE.monthEndCloses(inp.btcMonthly, now.slice(0, 10)) : [], lm = bm.length ? bm[bm.length - 1].m : null;
  const pd = new Date(now); pd.setUTCDate(1); pd.setUTCMonth(pd.getUTCMonth() - 1); const pm = pd.toISOString().slice(0, 7);
  add({ id: 'btcMonthly', label: 'BTC month-end closes', role: 'critical', source: 'Alpha Vantage', units: 'USD, monthly close', have: bm.length >= ZE.PARAMS.gateMonths, observedAt: lm ? monthEndISO(lm) : null, tooOld: !!lm && lm < pm, note: lm ? 'latest completed month ' + lm + (lm < pm ? '; ' + pm + ' is missing' : '') : null });
  const m = inp.macro || {};
  add({ id: 'tsy10', label: '10-year Treasury yield', role: 'optional', source: 'Alpha Vantage', units: 'percent, weekly', have: !!(m.tsy10 && m.tsy10.length), observedAt: lastObs(m.tsy10), maxAgeDays: 14 });
  add({ id: 'cpi', label: 'CPI', role: 'optional', source: 'Alpha Vantage', units: 'index, monthly', have: !!(m.cpi && m.cpi.length), observedAt: lastObs(m.cpi), maxAgeDays: 75 });
  add({ id: 'ff', label: 'Fed funds rate', role: 'optional', source: 'Alpha Vantage', units: 'percent, monthly average', have: !!(m.ff && m.ff.length), observedAt: lastObs(m.ff), maxAgeDays: 62 });
  add({ id: 'real', label: 'Real yield', role: 'optional', source: 'FRED DFII10 via Firecrawl', units: 'percent, daily', have: !!(m.real && m.real.length >= 40), observedAt: lastObs(m.real), maxAgeDays: 6 });
  add({ id: 'fed', label: 'Fed odds, next meeting', role: 'optional', source: 'CME FedWatch via Firecrawl', units: 'probability', have: !!inp.fedwatch, observedAt: null, note: inp.fedwatch ? 'page extraction, not an official feed' : null });
  add({ id: 'regime', label: 'Crypto regime', role: 'optional', source: 'TEXT TO QUANT RSPS', units: 'RUN, REVIEW or SKIP', have: !!inp.regime, observedAt: null, note: 'proprietary score' });
  add({ id: 'oi', label: 'Crypto leverage', role: 'optional', source: 'CoinMarketCap', units: '30-day change, open interest vs market cap', have: !!inp.global, observedAt: null });
  add({ id: 'fg', label: 'Fear & Greed', role: 'shown', source: 'CoinMarketCap', units: 'index 0 to 100', have: !!inp.global, observedAt: null });
  add({ id: 'cv', label: 'Hyperliquid positioning', role: 'shown', source: 'Coinversa Pulse', units: 'net bias by trader tier', have: !!inp.bias, observedAt: null, note: 'one venue' });
  return out;
}
// the sentiment connectors (regime, global metrics, FedWatch, positioning) are not saved in the database, so they are absent here
function realInput() {
  const px = readDoc('px.json'), macro = readDoc('macro.json'), real = readDoc('real.json');
  const pairs = (a) => a.map((x) => ({ d: x[0], c: x[1] }));
  const inp = { now: px.fetchedAt, prices: {}, cryptoLong: {}, macro: {} };
  EQ.forEach((s) => { inp.prices[s] = pairs(px.eq[s]); });
  CX.forEach((s) => { inp.prices[s] = pairs(px.cx[s].d); inp.cryptoLong[s] = pairs(px.cx[s].l); });
  inp.macro.tsy10 = macro.tsy10 || []; inp.macro.cpi = macro.cpi || []; inp.macro.ff = macro.ff || [];
  inp.macro.real = real.rows.map((x) => ({ d: x[0], v: x[1] }));
  inp.btcMonthly = macro.btcMonthly;
  inp.policy = { ddOverlay: false, altGate: false, gradedGate: false };
  inp.evidence = buildEvidence(inp);
  return inp;
}
// a fresh deep copy each time, with the evidence rebuilt so that edited series are reflected in it
function variant(edit) {
  const inp = realInput();
  if (edit) edit(inp);
  inp.evidence = buildEvidence(inp);
  return inp;
}

// every non-finite number found anywhere in a value, as a path
function nonFinite(o, p, out) {
  out = out || []; p = p || '';
  if (typeof o === 'number') { if (!isFinite(o)) out.push(p); }
  else if (Array.isArray(o)) o.forEach((v, i) => nonFinite(v, p + '[' + i + ']', out));
  else if (o && typeof o === 'object') Object.keys(o).forEach((k) => nonFinite(o[k], p ? p + '.' + k : k, out));
  return out;
}
// the fail-closed contract: a run that is not invalid publishes only finite weights, actions and risk numbers;
// an invalid run gives no actionable target
function assertFailClosed(res, label) {
  if (res.status === 'invalid') {
    SYMS.forEach((s) => assert.equal(res.actions[s].act, 'Blocked', label + ': ' + s + ' must be Blocked in an invalid run'));
    assert.ok(res.blockers.length > 0, label + ': an invalid run names its blockers');
  } else {
    ['weights', 'actions', 'outside', 'sleeves', 'risk', 'checks'].forEach((k) => {
      assert.deepEqual(nonFinite(res[k], k), [], label + ': non-finite numbers in a ' + res.status + ' run');
    });
  }
}

// ---------- the previous engine, from git, for the behaviour lock ----------
function loadPrevEngine() {
  const rev = process.env.ZOBIRIS_PREV_ENGINE_REV || 'HEAD';
  const r = spawnSync('git', ['-C', ROOT, 'show', rev + ':engine/lagebild-engine.js'], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (r.error || r.status !== 0) return null;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zobiris-prev-engine-'));
  try {
    const f = path.join(dir, 'lagebild-engine.prev.js');
    fs.writeFileSync(f, r.stdout);
    return require(f);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
const PREV = loadPrevEngine();
const NO_PREV = PREV ? false : 'previous engine not available from git (is this a git checkout with the revision ZOBIRIS_PREV_ENGINE_REV?)';
const PREV_HAS_CVAR = !!(PREV && PREV._internal && PREV._internal.histCvar);

// =====================================================================================================
// histCvar and portReturns: pure functions
// =====================================================================================================

// --- Test 1: the tail is a whole number of days ---
test('histCvar: 100 days at 95% is the mean of the worst 5 days', () => {
  // 5 bad days (8, 6, 5, 4, 3 percent losses) and 95 days that move at most 1 percent either way.
  const rets = [-0.08, -0.06, -0.05, -0.04, -0.03];
  for (let i = 0; i < 95; i++) rets.push(i % 2 ? 0.01 : -0.01);
  // hand computation: (0.08 + 0.06 + 0.05 + 0.04 + 0.03) / 5 = 0.26 / 5 = 0.052
  close(histCvar(rets, 0.95), 0.052, 1e-12);
});

// --- Test 2: the fractional boundary day ---
test('histCvar: a tail of 2.5 days puts half a weight on the third worst day', () => {
  // 50 days at 95% leaves 0.05 x 50 = 2.5 days in the tail. Worst losses 10%, 6%, 4%, then days of at most 1%.
  const rets = [-0.10, -0.06, -0.04];
  for (let i = 0; i < 47; i++) rets.push(i % 2 ? 0.01 : -0.01);
  // hand computation: (0.10 + 0.06 + 0.5 x 0.04) / 2.5 = 0.18 / 2.5 = 0.072
  close(histCvar(rets, 0.95), 0.072, 1e-12);
  // dropping the fractional weight (rounding the tail down to 2 days) would give 0.08, rounding up to 3 days 0.0667
  assert.ok(Math.abs(histCvar(rets, 0.95) - 0.08) > 1e-3);
  assert.ok(Math.abs(histCvar(rets, 0.95) - 0.2 / 3) > 1e-3);
});

test('histCvar: other alphas and the engine minimum of 60 days', () => {
  // 40 days at 90% is exactly 4 days: (0.12 + 0.09 + 0.07 + 0.05) / 4 = 0.0825
  const a = [-0.12, -0.09, -0.07, -0.05]; for (let i = 0; i < 36; i++) a.push(i % 2 ? 0.02 : -0.02);
  close(histCvar(a, 0.9), 0.0825, 1e-12);
  // 60 days at 95% is 3 days: (0.09 + 0.06 + 0.03) / 3 = 0.06
  const b = [-0.09, -0.06, -0.03]; for (let i = 0; i < 57; i++) b.push(i % 2 ? 0.005 : -0.005);
  close(histCvar(b, 0.95), 0.06, 1e-12);
  // 10 days at 92.5% is 0.75 of a day, less than one observation: the answer is the worst loss itself
  const c = [-0.07, -0.02, -0.01, 0, 0, 0.01, 0.01, 0.02, 0.03, 0.04];
  close(histCvar(c, 0.925), 0.07, 1e-12);
  // the default alpha is 0.95
  close(histCvar(b), 0.06, 1e-12);
});

test('histCvar: order does not matter, loss is positive, a gain tail is not hidden', () => {
  const rets = [-0.08, -0.06, -0.05, -0.04, -0.03]; for (let i = 0; i < 95; i++) rets.push(i % 2 ? 0.01 : -0.01);
  const shuffled = rets.slice(); let seed = 7;
  for (let i = shuffled.length - 1; i > 0; i--) { seed = (seed * 1664525 + 1013904223) >>> 0; const j = seed % (i + 1); const t = shuffled[i]; shuffled[i] = shuffled[j]; shuffled[j] = t; }
  assert.equal(histCvar(shuffled, 0.95), histCvar(rets, 0.95));
  assert.ok(histCvar(rets, 0.95) > 0);
  // no losing day at all: the shortfall is a negative number (a gain), it is not clipped to zero
  close(histCvar(new Array(60).fill(0.01), 0.95), -0.01, 1e-12);
  // a portfolio that never moves has a shortfall of exactly zero, not negative zero
  assert.ok(Object.is(histCvar(new Array(60).fill(0), 0.95), 0));
});

test('histCvar: properties on seeded random series (bounded by the worst day, rises with alpha, at least the mean loss)', () => {
  let seed = 20261017; const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  for (let c = 0; c < 200; c++) {
    const n = 60 + Math.floor(rand() * 200), rets = [];
    for (let i = 0; i < n; i++) rets.push((rand() - 0.5) * 0.08 + (rand() < 0.03 ? -0.05 : 0));
    const losses = rets.map((x) => -x), worst = Math.max.apply(null, losses), meanLoss = losses.reduce((a, b) => a + b, 0) / n;
    const e90 = histCvar(rets, 0.9), e95 = histCvar(rets, 0.95), e99 = histCvar(rets, 0.99);
    assert.ok(e99 >= e95 - 1e-12 && e95 >= e90 - 1e-12, 'shortfall must not fall as alpha rises');
    assert.ok(e99 <= worst + 1e-12, 'shortfall cannot exceed the worst day');
    assert.ok(e90 >= meanLoss - 1e-12, 'shortfall cannot be below the mean loss');
  }
});

test('histCvar: empty, malformed or non-finite input gives null, never a number', () => {
  assert.equal(histCvar(null, 0.95), null);
  assert.equal(histCvar([], 0.95), null);
  assert.equal(histCvar([0.01, NaN, -0.02], 0.95), null);
  assert.equal(histCvar([0.01, Infinity, -0.02], 0.95), null);
  assert.equal(histCvar([0.01, -Infinity, -0.02], 0.95), null);
  assert.equal(histCvar([0.01, -0.02], 1), null);
  assert.equal(histCvar([0.01, -0.02], 0), null);
  assert.equal(histCvar([0.01, -0.02], 1.5), null);
});

test('portReturns: simple return per day from log returns, cash earns zero', () => {
  // two assets, three days. VOO +10%, -10%, 0%; BTC 0%, +20%, -50% (log returns on the aligned panel).
  const ar = { n: 3, R: { VOO: [Math.log(1.1), Math.log(0.9), 0], BTC: [0, Math.log(1.2), Math.log(0.5)] } };
  const w = {}; SYMS.forEach((s) => { w[s] = 0; }); w.VOO = 60; w.BTC = 20;    // 20% stays in cash
  const r = portReturns(ar, w);
  // day 1: 0.6 x 0.10 + 0.2 x 0 = 0.06; day 2: 0.6 x -0.10 + 0.2 x 0.20 = -0.02; day 3: 0 + 0.2 x -0.50 = -0.10
  assert.equal(r.length, 3);
  close(r[0], 0.06, 1e-12); close(r[1], -0.02, 1e-12); close(r[2], -0.10, 1e-12);
  // the all-cash portfolio earns zero every day
  const cash = {}; SYMS.forEach((s) => { cash[s] = 0; });
  assert.deepEqual(portReturns(ar, cash), [0, 0, 0]);
  // a held asset without aligned returns, or a weight that is not a finite number, cannot be measured
  const wEth = Object.assign({}, w, { ETH: 5 });
  assert.equal(portReturns(ar, wEth), null);
  assert.equal(portReturns(ar, Object.assign({}, w, { VOO: NaN })), null);
  assert.equal(portReturns(null, w), null);
  // 3 days at 60% VOO, 20% BTC: the 95% shortfall of a 3-day tail of 0.15 days is the worst day itself, 0.10
  close(histCvar(r, 0.95), 0.10, 1e-12);
});

// =====================================================================================================
// the engine on a real input
// =====================================================================================================

// An independent re-computation of the shortfall from the saved prices (a different code path from the engine's):
// stock calendar from VOO, every series sampled as of each date, the last 251 aligned dates, tail filled by mass.
function independentCvar(prices, weightsPct, alpha) {
  const dates = prices.VOO.map((x) => x.d);
  const col = {};
  SYMS.forEach((s) => { col[s] = dates.map((d) => { let v = null; prices[s].forEach((x) => { if (x.d <= d) v = x.c; }); return v; }); });
  let from = dates.length;
  while (from > 0 && dates.length - from < 251 && SYMS.every((s) => col[s][from - 1] != null)) from--;
  const days = [];
  for (let t = from + 1; t < dates.length; t++) {
    let r = 0;
    SYMS.forEach((s) => { r += (weightsPct[s] / 100) * (col[s][t] / col[s][t - 1] - 1); });
    days.push(r);
  }
  const losses = days.map((x) => -x).sort((a, b) => b - a), tail = (1 - alpha) * days.length;
  let remaining = tail, total = 0;
  for (let i = 0; i < losses.length && remaining > 1e-12; i++) { const take = Math.min(1, remaining); total += take * losses[i]; remaining -= take; }
  return { n: days.length, from: dates[from], to: dates[dates.length - 1], es: total / tail };
}

// --- Test 3: CVaR on the real input ---
test('engine: risk.cvar on the saved live data is present, plausible and matches an independent recomputation', { skip: NO_LIVE }, () => {
  const inp = realInput();
  const res = ZE.compute(inp, null, null);
  assert.notEqual(res.status, 'invalid', 'the saved live data must give an actionable run: ' + JSON.stringify(res.blockers));
  const cv = res.risk.cvar;
  assert.ok(cv && typeof cv === 'object', 'risk.cvar must exist');
  assert.equal(cv.alpha, 0.95);
  assert.equal(cv.horizon, '1d');
  assert.ok(cv.target > 0 && cv.target < 0.2, 'target shortfall in (0, 0.2): ' + cv.target);
  assert.ok(cv.base > 0, 'base shortfall positive: ' + cv.base);
  assert.ok(cv.base < 0.2, 'base shortfall below 20%: ' + cv.base);
  assert.ok(cv.n >= 60 && cv.n <= 250, 'window of 60 to 250 days: ' + cv.n);
  assert.ok(cv.from < cv.to, 'window runs forward in time');
  [cv.target, cv.base].forEach((x) => assert.equal(Math.round(x * 1e4) / 1e4, x, 'rounded to 4 places like the other risk fields'));
  // independent check: same window, and the same shortfall from the published (2-decimal) weights and the base weights
  const base = {}; ZE.ASSETS.forEach((a) => { base[a.s] = a.base; });
  const eT = independentCvar(inp.prices, res.weights, 0.95), eB = independentCvar(inp.prices, base, 0.95);
  assert.equal(cv.n, eT.n); assert.equal(cv.from, eT.from); assert.equal(cv.to, eT.to);
  close(cv.target, eT.es, 1e-4, 'target shortfall');
  close(cv.base, eB.es, 1e-4, 'base shortfall');
  // the shortfall is a measurement, not a rule: it sits next to the volatility, which is what the limits use
  assert.equal(typeof res.risk.vol, 'number');
});

test('engine: risk.cvar is deterministic and leaves the input untouched', { skip: NO_LIVE }, () => {
  const inp = realInput(), snap = JSON.stringify(inp);
  const a = ZE.compute(inp, null, null), b = ZE.compute(inp, null, null);
  assert.deepEqual(a, b);
  assert.equal(JSON.stringify(inp), snap, 'compute must not mutate its input');
});

test('engine: risk.cvar is null with fewer than 60 aligned days, and the rest of the run is unchanged', { skip: NO_LIVE }, () => {
  // keep only 55 daily crypto closes: the aligned window shrinks to about 38 days, enough for the risk model (30) but not for CVaR (60)
  const inp = variant((x) => { CX.forEach((s) => { x.prices[s] = x.prices[s].slice(-55); }); });
  const res = ZE.compute(inp, null, null);
  assert.ok(res.corr.window && res.corr.window.n >= 30 && res.corr.window.n < 60, 'scenario must give a short but usable window: ' + JSON.stringify(res.corr.window));
  assert.equal(res.risk.cvar, null);
  assert.ok(isFinite(res.risk.vol), 'the risk model itself still runs on the short window');
  if (PREV) {
    const old = PREV.compute(inp, null, null);
    delete res.risk.cvar; if (PREV_HAS_CVAR) delete old.risk.cvar;
    assert.deepEqual(res, old);
  }
});

test('engine: an input with no prices gives risk.cvar null and stays invalid', () => {
  const r = ZE.compute({ now: '2026-10-16T20:00:00Z' }, {}, null, { shadows: false });
  assert.equal(r.status, 'invalid');
  assert.equal(r.risk.cvar, null);
});

// =====================================================================================================
// behaviour lock: the new engine equals the previous one except for risk.cvar
// =====================================================================================================

function lock(label, inp, prev, ref, opts, expect) {
  const oldRes = PREV.compute(clone(inp), prev ? clone(prev) : prev, ref ? clone(ref) : ref, opts);
  const newRes = ZE.compute(clone(inp), prev ? clone(prev) : prev, ref ? clone(ref) : ref, opts);
  if (expect) expect(newRes, oldRes);
  assert.ok('cvar' in newRes.risk, label + ': risk.cvar must be present (object or null)');
  if (PREV_HAS_CVAR) delete oldRes.risk.cvar;
  delete newRes.risk.cvar;
  assert.deepEqual(newRes, oldRes, label + ': output differs from the previous engine beyond risk.cvar');
  assert.equal(newRes.engine, oldRes.engine);
}

test('behaviour lock: real input, defaults', { skip: NO_LIVE || NO_PREV }, () => {
  lock('defaults', realInput(), null, null, undefined, (n) => assert.ok(n.risk.cvar && n.risk.cvar.target > 0));
});

test('behaviour lock: real input with a prior run (smoothing and action reference)', { skip: NO_LIVE || NO_PREV }, () => {
  const inp = realInput();
  const earlier = realInput(); earlier.now = new Date(Date.parse(inp.now) - 7 * 864e5).toISOString();
  const prior = PREV.compute(earlier, null, null);
  lock('smoothing', inp, prior, prior, undefined, (n, o) => {
    assert.equal(o.smoothed, true, 'scenario must engage smoothing in the previous engine');
    assert.equal(n.smoothed, true);
    assert.equal(n.actionBasis, 'last run');
  });
});

test('behaviour lock: real input with every optional control switched on', { skip: NO_LIVE || NO_PREV }, () => {
  const inp = realInput(); inp.policy = { ddOverlay: true, altGate: true, gradedGate: true };
  lock('all controls', inp, null, null, undefined, (n) => assert.equal(n.policy.ddOverlay, true));
  lock('macro and shadows off', realInput(), null, null, { macro: false, shadows: false, smoothing: false });
  lock('signals off', realInput(), null, null, { signals: false, volCap: false, cryptoCap: false });
});

test('behaviour lock: real input with holdings entered', { skip: NO_LIVE || NO_PREV }, () => {
  const inp = realInput();
  inp.holdings = { units: { VOO: 10, SMH: 5, IAUM: 200, BTC: 0.05, ETH: 1 }, cash: 2500, asOf: '2026-10-16' };
  lock('holdings', inp, null, null, undefined, (n) => { assert.equal(n.actionBasis, 'holdings'); assert.ok(n.holdings); });
});

test('behaviour lock: a blocked run (constant series) and an empty input', { skip: NO_LIVE || NO_PREV }, () => {
  const inp = variant((x) => { x.prices.GDX = x.prices.GDX.map((p) => ({ d: p.d, c: 50 })); });
  lock('constant GDX', inp, null, null, undefined, (n) => assert.equal(n.status, 'invalid'));
  lock('empty', { now: '2026-10-16T20:00:00Z' }, {}, null, { shadows: false });
});

test('behaviour lock: the only intended behaviour change is a non-finite risk number now failing closed', { skip: NO_LIVE || NO_PREV || PREV_HAS_CVAR }, () => {
  // a zero close older than the 63-day correlation window but inside the one-year drawdown window makes the drawdown figures
  // non-finite while the volatility stays finite. The previous engine called that run valid (and a requested drawdown overlay
  // silently did nothing); the new engine blocks it.
  const inp = variant((x) => { x.prices.XLE[x.prices.XLE.length - 150].c = 0; x.policy = { ddOverlay: true, altGate: false, gradedGate: false }; });
  const oldRes = PREV.compute(clone(inp), null, null), newRes = ZE.compute(clone(inp), null, null);
  assert.notEqual(oldRes.status, 'invalid', 'previous engine accepted it');
  assert.ok(nonFinite(oldRes.risk, 'risk').length > 0, 'with non-finite risk numbers');
  assert.equal(newRes.status, 'invalid');
  assert.ok(newRes.blockers.indexOf('Risk model lacked aligned daily returns') >= 0);
  SYMS.forEach((s) => assert.equal(newRes.actions[s].act, 'Blocked'));
  // the weights are the same either way: the guard changes status and actions only
  assert.deepEqual(newRes.weights, oldRes.weights);
});

// =====================================================================================================
// the known "constant series gives NaN" issue (docs/v3-audit-review.md)
// =====================================================================================================

// --- Test: a constant price series fails closed ---
test('constant series: an asset whose price never moves blocks the run, with finite weights and every action Blocked', { skip: NO_LIVE }, () => {
  // What happens: the asset's return variance is exactly zero, so its EWMA correlations are 0/0 = NaN. The NaN reaches the
  // covariance matrices and every volatility, but not the weights (the constraint steps leave them finite). The run is
  // invalid because the risk model reports no finite volatility and the final volatility check cannot pass.
  ['GDX', 'VOO', 'BTC', 'LINK'].forEach((sym) => {
    const inp = variant((x) => { x.prices[sym] = x.prices[sym].map((p) => ({ d: p.d, c: 50 })); });
    const res = ZE.compute(inp, null, null);
    assert.ok(!isFinite(res.risk.vol), sym + ': this input must reach the NaN path (otherwise the test proves nothing)');
    assert.equal(res.status, 'invalid', sym);
    assert.ok(res.blockers.indexOf('Risk model lacked aligned daily returns') >= 0, sym + ': ' + JSON.stringify(res.blockers));
    assert.equal(res.checksOk, false, sym);
    assertFailClosed(res, 'constant ' + sym);
    assert.deepEqual(nonFinite(res.weights, 'weights'), [], sym + ': weights stay finite');
    assert.ok(isFinite(res.outside), sym + ': cash stays finite');
    close(SYMS.reduce((s, k) => s + res.weights[k], 0) + res.outside, 100, 1e-6, sym + ': weights plus cash');
    assert.match(res.posture.en, /unclear/i, sym);
  });
});

test('constant series: the 3-day trend bars of a crypto asset alone do not block (volatility falls back to the daily series)', { skip: NO_LIVE }, () => {
  const inp = variant((x) => { x.cryptoLong.SOL = x.cryptoLong.SOL.map((p) => ({ d: p.d, c: 100 })); });
  const res = ZE.compute(inp, null, null);
  assertFailClosed(res, 'constant SOL trend bars');
  assert.equal(nonFinite(res.risk, 'risk').length, 0);
});

test('constant series: a flat tail is either measured with finite numbers or blocked, never half-finite', { skip: NO_LIVE }, () => {
  [5, 20, 40, 63, 90].forEach((len) => {
    ['VOO', 'NVDA', 'GDX', 'ETH'].forEach((sym) => {
      const inp = variant((x) => { const a = x.prices[sym], k = Math.min(len, a.length - 1), v = a[a.length - 1 - k].c; for (let i = a.length - k; i < a.length; i++) a[i].c = v; });
      assertFailClosed(ZE.compute(inp, null, null), 'flat ' + sym + ' for ' + len + ' days');
    });
  });
});

test('non-finite risk: a zero or missing close inside the window blocks the run instead of publishing NaN drawdown figures', { skip: NO_LIVE }, () => {
  // 12 days back is inside the correlation window (volatility is non-finite too); 150 days back is only inside the drawdown window
  [12, 150].forEach((back) => {
    [0, null].forEach((bad) => {
      ['XLE', 'VOO', 'MSFT'].forEach((sym) => {
        [{ ddOverlay: true, altGate: false, gradedGate: false }, { ddOverlay: false, altGate: false, gradedGate: false }].forEach((policy) => {
          const inp = variant((x) => { const a = x.prices[sym]; a[a.length - back].c = bad; x.policy = policy; });
          const res = ZE.compute(inp, null, null);
          const label = sym + ' close ' + bad + ' ' + back + ' days back, ddOverlay ' + policy.ddOverlay;
          assert.equal(res.status, 'invalid', label);
          assert.ok(res.blockers.indexOf('Risk model lacked aligned daily returns') >= 0, label);
          assertFailClosed(res, label);
        });
      });
    });
  });
});

test('fail-closed invariant on seeded random damage to the saved series', { skip: NO_LIVE }, () => {
  // For every damaged input: either the run is invalid and blocks every action, or every weight, action and risk number is finite.
  let seed = 424242; const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  const kinds = ['const', 'tail', 'zero', 'negative', 'null', 'twoConst', 'dupDays'];
  let invalid = 0, valid = 0;
  for (let it = 0; it < 70; it++) {
    const kind = kinds[it % kinds.length], sym = SYMS[Math.floor(rand() * SYMS.length)];
    const policy = { ddOverlay: it % 2 === 0, altGate: it % 3 === 0, gradedGate: it % 5 === 0 };
    const inp = variant((x) => {
      x.policy = policy;
      const a = x.prices[sym], n = a.length;
      if (kind === 'const') a.forEach((p) => { p.c = 50; });
      else if (kind === 'tail') { const k = Math.min(n - 1, 5 + Math.floor(rand() * 100)), v = a[n - 1 - k].c; for (let i = n - k; i < n; i++) a[i].c = v; }
      else if (kind === 'zero') a[Math.floor(rand() * n)].c = 0;
      else if (kind === 'negative') a[Math.floor(rand() * n)].c = -5;
      else if (kind === 'null') a[Math.floor(rand() * n)].c = null;
      else if (kind === 'twoConst') [sym, SYMS[Math.floor(rand() * SYMS.length)]].forEach((q) => x.prices[q].forEach((p) => { p.c = 77; }));
      else if (kind === 'dupDays') for (let i = 1; i < n; i += 2) a[i].c = a[i - 1].c;
    });
    const res = ZE.compute(inp, null, null);
    assertFailClosed(res, kind + ' ' + sym + ' #' + it);
    if (res.status === 'invalid') invalid++; else valid++;
    // the shortfall, when published, is a finite rounded number
    if (res.risk.cvar) { assert.ok(isFinite(res.risk.cvar.target) && isFinite(res.risk.cvar.base)); }
  }
  assert.ok(invalid > 0 && valid > 0, 'the damage set should produce both blocked and usable runs (' + invalid + ' blocked, ' + valid + ' usable)');
});
