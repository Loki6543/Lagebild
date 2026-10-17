'use strict';
// Tests for lib/min_cvar.js: the simplex solver and the Rockafellar-Uryasev minimum-CVaR programme.
//
// Hand cases have a known answer worked out on paper. The cross-check solves seeded random problems
// (T from 60 to 260, 12 assets, the Lagebild limits) with this solver and with scipy's HiGHS, and
// requires the objectives to agree within 1e-7 relative. The scipy tests are skipped, with a message,
// only when python3 cannot import scipy.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const { minCvarWeights, solveLP, cvarOf } = require('../lib/min_cvar.js');
const ZE = require('../engine/lagebild-engine.js');

/* ---------- the Lagebild limits, as fractions of capital ---------- */
const SYMS = ['VOO', 'SMH', 'NVDA', 'MSFT', 'TSM', 'XLE', 'IAUM', 'GDX', 'BTC', 'ETH', 'SOL', 'LINK'];
const VOL = [.16, .32, .45, .25, .35, .25, .16, .35, .50, .70, .85, .85];   // annual, as in the engine's defaults
const BASE = [28, 12, 5, 5, 4, 7, 14, 7, 8, 3, 5, 2].map(x => x / 100);
const LAGEBILD = {
  groups: [
    { idx: [0, 1, 2, 3, 4, 5], lo: 0.56, hi: 0.66 },    // stocks sleeve
    { idx: [6, 7], lo: 0.16, hi: 0.26 },                // gold sleeve
    { idx: [8, 9, 10, 11], lo: 0.13, hi: 0.18 }         // crypto sleeve
  ],
  ub: { 8: 0.10 },                                       // BTC
  lookthrough: [{ coef: { 0: 0.08, 1: 0.20, 2: 1 }, hi: 0.10 }]   // NVDA + 0.08 VOO + 0.20 SMH
};

test('the limits used here are the engine\'s own', () => {
  assert.deepEqual(ZE.ASSETS.map(a => a.s), SYMS);
  assert.deepEqual(ZE.ASSETS.map(a => a.base / 100), BASE);
  const sl = s => ZE.ASSETS.map((a, i) => (a.sleeve === s ? i : -1)).filter(i => i >= 0);
  [['stocks', 0], ['gold', 1], ['crypto', 2]].forEach(([name, g]) => {
    assert.deepEqual(sl(name), LAGEBILD.groups[g].idx);
    assert.ok(Math.abs((ZE.SLEEVES[name] - ZE.SLEEVE_BAND[name][0]) / 100 - LAGEBILD.groups[g].lo) < 1e-12, name + ' lower band');
    assert.ok(Math.abs((ZE.SLEEVES[name] + ZE.SLEEVE_BAND[name][1]) / 100 - LAGEBILD.groups[g].hi) < 1e-12, name + ' upper band');
  });
  assert.equal(ZE.ASSET_CAP.BTC / 100, LAGEBILD.ub[8]);
  assert.equal(ZE.PARAMS.nvdaLookCap / 100, LAGEBILD.lookthrough[0].hi);
  assert.equal(ZE.LOOK.VOO, LAGEBILD.lookthrough[0].coef[0]);
  assert.equal(ZE.LOOK.SMH, LAGEBILD.lookthrough[0].coef[1]);
  assert.equal(ZE.LOOK.NVDA, LAGEBILD.lookthrough[0].coef[2]);
});

/* ---------- seeded problem generator ---------- */
function mulberry32(a) {
  return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}

// fat-tailed daily simple returns: a market factor, three sector factors (stocks, gold, crypto) and idiosyncratic noise, Student-t draws
function scenarios(seed, T) {
  const rnd = mulberry32(seed);
  const norm = () => { let u = 0; while (!u) u = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rnd()); };
  const tdraw = df => { let c = 0; for (let i = 0; i < df; i++) { const z = norm(); c += z * z; } return norm() / Math.sqrt(c / df); };
  const sector = [0, 0, 0, 0, 0, 0, 1, 1, 2, 2, 2, 2], load = [0.7, 0.1, 0.5], R = [];
  for (let t = 0; t < T; t++) {
    const m = 0.6 * tdraw(4), sec = [tdraw(4), tdraw(4), tdraw(4)], row = [];
    for (let i = 0; i < 12; i++) {
      const z = load[sector[i]] * m + 0.42 * sec[sector[i]] + 0.5 * tdraw(5);
      row.push(Math.max(-0.9, VOL[i] / Math.sqrt(252) * z / 1.2 + 0.0003 * (rnd() - 0.4)));
    }
    R.push(row);
  }
  return R;
}

// 36 problems: T in [60, 260], alpha mostly 0.95; every third one has tighter (still feasible) crypto, BTC and look-through limits
function problem(k) {
  const rnd = mulberry32(900 + k), T = 60 + Math.floor(rnd() * 201);
  const alpha = [0.95, 0.95, 0.90, 0.975][k % 4];
  const o = JSON.parse(JSON.stringify(LAGEBILD)); o.alpha = alpha;
  if (k % 3 === 2) {
    o.groups[2].hi = 0.13 + rnd() * 0.04 + 0.0001;       // crypto 13 % to 17 %
    o.ub = { 8: 0.05 + rnd() * 0.05 };                    // BTC 5 % to 10 %
    o.lookthrough[0].hi = 0.06 + rnd() * 0.04;            // look-through 6 % to 10 %
  }
  return { T, alpha, returns: scenarios(1000 + k, T), opts: o };
}
const N_PROBLEMS = 36;

function checkFeasible(w, o, tol) {
  const sum = w.reduce((s, v) => s + v, 0);
  assert.ok(Math.abs(sum - 1) <= tol, 'weights sum to 1, got ' + sum);
  w.forEach((v, i) => assert.ok(v >= -tol, 'long only: w[' + i + '] = ' + v));
  o.groups.forEach(g => { const s = g.idx.reduce((t, i) => t + w[i], 0); assert.ok(s >= g.lo - tol && s <= g.hi + tol, 'group ' + g.idx + ' sum ' + s + ' outside [' + g.lo + ', ' + g.hi + ']'); });
  Object.keys(o.ub).forEach(i => assert.ok(w[i] <= o.ub[i] + tol, 'upper bound on asset ' + i));
  o.lookthrough.forEach(l => { const s = Object.keys(l.coef).reduce((t, i) => t + l.coef[i] * w[i], 0); assert.ok(s <= l.hi + tol, 'look-through ' + s + ' above ' + l.hi); });
}

/* ---------- hand cases ---------- */
// Two assets, 20 days, alpha 0.9, so CVaR is the mean of the worst 2 days.
// A: -4 % on days 0-1, +1 % otherwise.  B: -2 % on days 2-3, +0.5 % otherwise.
// With weight w on A, the loss on an A day is 4.5w - 0.5 (in %) and on a B day 2 - 3w. Two days of each, so
// CVaR = max(4.5w - 0.5, 2 - 3w), lowest where they cross: w = 1/3, CVaR = 1.0 %. Every other day is a gain.
function twoAssets() {
  const R = [];
  for (let t = 0; t < 20; t++) { let a = 0.01, b = 0.005; if (t < 2) a = -0.04; else if (t < 4) b = -0.02; R.push([a, b]); }
  return R;
}
const near = (x, y, tol, msg) => assert.ok(Math.abs(x - y) <= (tol || 1e-9), (msg || '') + ' expected ' + y + ', got ' + x);

test('hand case: two assets whose tail days differ, minimum at w = 1/3', () => {
  const r = minCvarWeights(twoAssets(), { alpha: 0.9 });
  assert.equal(r.status, 'optimal');
  near(r.weights[0], 1 / 3); near(r.weights[1], 2 / 3);
  near(r.cvar, 0.01); near(r.var, 0.01); near(r.objective, 0.01);
});

test('hand case: a group floor, a per-asset cap and a look-through cap each move the answer to the boundary', () => {
  // A at least 50 %: A-day loss 4.5 * 0.5 - 0.5 = 1.75 %
  let r = minCvarWeights(twoAssets(), { alpha: 0.9, groups: [{ idx: [0], lo: 0.5 }] });
  assert.equal(r.status, 'optimal'); near(r.weights[0], 0.5); near(r.cvar, 0.0175);
  // A at most 20 %: B-day loss 2 - 3 * 0.2 = 1.4 %
  r = minCvarWeights(twoAssets(), { alpha: 0.9, ub: [0.2, null] });
  assert.equal(r.status, 'optimal'); near(r.weights[0], 0.2); near(r.cvar, 0.014);
  r = minCvarWeights(twoAssets(), { alpha: 0.9, ub: { 0: 0.2 } });
  near(r.weights[0], 0.2); near(r.cvar, 0.014);
  // A + 0.5 B <= 0.6 means 0.5 + 0.5 w_A <= 0.6, so w_A <= 0.2 again
  r = minCvarWeights(twoAssets(), { alpha: 0.9, lookthrough: [{ coef: { 0: 1, 1: 0.5 }, hi: 0.6 }] });
  assert.equal(r.status, 'optimal'); near(r.weights[0], 0.2); near(r.cvar, 0.014);
  r = minCvarWeights(twoAssets(), { alpha: 0.9, lookthrough: [{ coef: [1, 0.5], hi: 0.6 }] });
  near(r.weights[0], 0.2);
  // a slack constraint changes nothing
  r = minCvarWeights(twoAssets(), { alpha: 0.9, groups: [{ idx: [0], lo: 0.1, hi: 0.9 }], ub: [0.9, 0.9] });
  near(r.weights[0], 1 / 3); near(r.cvar, 0.01);
});

test('hand case: a perfect hedge has zero CVaR at 50/50', () => {
  const R = []; for (let t = 0; t < 60; t++) { const a = 0.01 * Math.sin(1 + 0.7 * t); R.push([a, -a]); }
  const r = minCvarWeights(R, { alpha: 0.95 });
  assert.equal(r.status, 'optimal');
  near(r.weights[0], 0.5); near(r.weights[1], 0.5); near(r.cvar, 0, 1e-12);
  // cap the hedge leg at 30 %: the portfolio return is (0.3 - 0.7) * r_A = -0.4 r_A
  const c = minCvarWeights(R, { alpha: 0.95, ub: [0.3, null] });
  near(c.weights[0], 0.3);
  near(c.cvar, cvarOf(R, [0.3, 0.7], 0.95).cvar, 1e-12);
});

test('hand case: an asset that always gains takes the whole portfolio; CVaR is then minus its return', () => {
  const R = []; for (let t = 0; t < 40; t++) R.push([0.01, 0.02 * Math.cos(t) - 0.001]);
  const r = minCvarWeights(R, { alpha: 0.95 });
  assert.equal(r.status, 'optimal');
  near(r.weights[0], 1); near(r.weights[1], 0); near(r.cvar, -0.01); near(r.var, -0.01);
});

test('cvarOf: fractional tail weight, the engine\'s histCvar and a hand-computed tail agree', () => {
  // 10 returns, alpha 0.75: k = 2.5, so the two worst losses plus half the third
  const rets = [-0.05, -0.03, -0.02, -0.01, 0, 0.01, 0.02, 0.03, 0.04, 0.05];
  const R = rets.map(x => [x]);
  const e = cvarOf(R, [1], 0.75);
  near(e.cvar, (0.05 + 0.03 + 0.5 * 0.02) / 2.5, 1e-15);
  near(e.var, 0.02, 1e-15);
  near(e.cvar, ZE._internal.histCvar(rets, 0.75), 1e-15);
  assert.equal(cvarOf([], [1], 0.95), null);
  assert.equal(cvarOf(R, [1], 1), null);
});

/* ---------- the LP solver ---------- */
test('solveLP: Beale\'s cycling example reaches -5/4', () => {
  const r = solveLP([0, 0, 0, -0.75, 20, -0.5, 6], [
    { a: [1, 0, 0, 0.25, -8, -1, 9], op: '=', b: 0 },
    { a: [0, 1, 0, 0.5, -12, -0.5, 3], op: '=', b: 0 },
    { a: [0, 0, 1, 0, 0, 1, 0], op: '=', b: 1 }]);
  assert.equal(r.status, 'optimal'); near(r.objective, -1.25);
});

test('solveLP: infeasible, unbounded, redundant equalities, a negative right-hand side, sparse rows', () => {
  assert.equal(solveLP([1], [{ a: [1], op: '>=', b: 2 }, { a: [1], op: '<=', b: 1 }]).status, 'infeasible');
  assert.equal(solveLP([-1, 0], [{ a: [1, -1], op: '<=', b: 1 }]).status, 'unbounded');
  let r = solveLP([1, 1], [{ a: [1, 1], op: '=', b: 1 }, { a: [2, 2], op: '=', b: 2 }]);
  assert.equal(r.status, 'optimal'); near(r.objective, 1);
  r = solveLP([1, 2], [{ a: [-1, -1], op: '<=', b: -3 }]);          // x + y >= 3, minimise x + 2y
  assert.equal(r.status, 'optimal'); near(r.objective, 3); near(r.x[0], 3);
  r = solveLP([1, 2, 5], [{ a: { 0: 1, 1: 1 }, op: '>=', b: 3 }, { a: { 2: 1 }, op: '<=', b: 4 }]);
  assert.equal(r.status, 'optimal'); near(r.objective, 3);
});

test('solveLP: bad input is a status, never an exception', () => {
  assert.equal(solveLP([], []).status, 'invalid_input');
  assert.equal(solveLP([NaN], []).status, 'invalid_input');
  assert.equal(solveLP([1], [{ a: [1, 2], op: '<=', b: 1 }]).status, 'invalid_input');
  assert.equal(solveLP([1], [{ a: [1], op: '<', b: 1 }]).status, 'invalid_input');
  assert.equal(solveLP([1], [{ a: { 3: 1 }, op: '<=', b: 1 }]).status, 'invalid_input');
  assert.equal(solveLP([1], [null]).status, 'invalid_input');
});

/* ---------- failure statuses ---------- */
test('minCvarWeights: infeasible, iteration limit and invalid input come back as statuses', () => {
  const R = twoAssets();
  const inf = minCvarWeights(R, { alpha: 0.9, groups: [{ idx: [0], hi: 0.3 }, { idx: [1], hi: 0.3 }] });   // 0.3 + 0.3 < 1
  assert.equal(inf.status, 'infeasible'); assert.equal(inf.weights, null); assert.equal(inf.cvar, null);
  assert.equal(minCvarWeights(R, { alpha: 0.9, groups: [{ idx: [0], lo: 0.8 }, { idx: [1], lo: 0.8 }] }).status, 'infeasible');
  assert.equal(minCvarWeights(R, { alpha: 0.9, lookthrough: [{ coef: { 0: 1, 1: 0.5 }, hi: 0.4 }] }).status, 'infeasible');
  const lim = minCvarWeights(R, { alpha: 0.9, maxIter: 1 });
  assert.equal(lim.status, 'iteration_limit'); assert.equal(lim.weights, null);
  [null, undefined, 'abc', [], [[]], [[1, 2], [1]], [[NaN, 1]], [[Infinity, 1]], [['a', 1]]].forEach(bad => assert.equal(minCvarWeights(bad, {}).status, 'invalid_input', JSON.stringify(bad)));
  assert.equal(minCvarWeights(R, { alpha: 1 }).status, 'invalid_input');
  assert.equal(minCvarWeights(R, { alpha: 0 }).status, 'invalid_input');
  assert.equal(minCvarWeights(R, { groups: [{ idx: [5], lo: 0 }] }).status, 'invalid_input');
  assert.equal(minCvarWeights(R, { ub: [0.5] }).status, 'invalid_input');
  assert.equal(minCvarWeights(R, { lookthrough: [{ coef: { 7: 1 }, hi: 1 }] }).status, 'invalid_input');
  assert.equal(minCvarWeights(R, { lookthrough: [{ coef: { 0: 1 } }] }).status, 'invalid_input');
});

test('minCvarWeights: ties and degenerate data (identical, zero and constant assets) still solve', () => {
  const R = []; for (let t = 0; t < 80; t++) { const a = 0.01 * Math.sin(t); R.push([a, a, 0, 0, -a, 0.001]); }
  const r = minCvarWeights(R, { alpha: 0.95, ub: [0.4, 0.4, 0.4, 0.4, 0.4, 0.4] });
  assert.equal(r.status, 'optimal');
  near(r.cvar, -0.0004, 1e-12);                       // 0.4 in the constant asset, a hedged pair for the rest
  assert.equal(minCvarWeights([[0, 0], [0, 0]], {}).status, 'optimal');
  assert.equal(minCvarWeights([[0.01, -0.02]], {}).status, 'optimal');   // one scenario
});

/* ---------- the Lagebild problem ---------- */
test('Lagebild limits: every constraint holds on seeded problems, and no feasible point beats the optimum', () => {
  const opt = [];
  for (let k = 0; k < 12; k++) {
    const p = problem(k), r = minCvarWeights(p.returns, p.opts);
    assert.equal(r.status, 'optimal', 'problem ' + k);
    checkFeasible(r.weights, p.opts, 1e-9);
    near(cvarOf(p.returns, r.weights, p.alpha).cvar, r.cvar, 1e-15);
    near(r.cvar, r.objective, 1e-9, 'LP value equals evaluated CVaR');
    // the base plan is feasible, so the optimum cannot be worse; neither can any point on a segment to another feasible point
    assert.ok(r.cvar <= cvarOf(p.returns, BASE, p.alpha).cvar + 1e-12, 'optimum no worse than the base plan');
    opt.push({ p, r });
  }
  const rnd = mulberry32(77);
  opt.forEach(({ p, r }, k) => {
    // optima of other problems with the default limits are feasible here too (problems 0, 1, 3, 4 share LAGEBILD)
    [0, 1, 3, 4, 6, 7].filter(j => j !== k && j % 3 !== 2 && k % 3 !== 2).forEach(j => {
      const lam = rnd(), v = opt[j].r.weights.map((x, i) => r.weights[i] + lam * (x - r.weights[i]));
      assert.ok(cvarOf(p.returns, v, p.alpha).cvar >= r.cvar - 1e-12, 'a feasible mix beat the optimum on problem ' + k);
    });
  });
});

/* ---------- cross-check against scipy.optimize.linprog(method='highs') ---------- */
function scipyStatus() {
  const r = cp.spawnSync('python3', ['-I', '-c', 'import numpy, scipy.optimize; print(scipy.__version__)'], { encoding: 'utf8' });
  if (r.error || r.status !== 0) return { ok: false, msg: 'scipy is unavailable (python3 could not import numpy and scipy.optimize: ' + String(r.error ? r.error.message : (r.stderr || '').trim().split('\n').pop()) + '); skipping the HiGHS cross-check' };
  return { ok: true, version: r.stdout.trim() };
}
const SCIPY = scipyStatus();

const SCIPY_SRC = `
import json, sys
import numpy as np
from scipy.optimize import linprog

def cvar_lp(p):
    R = np.array(p['returns'], float); T, N = R.shape; a = p['alpha']; o = p['opts']
    nv = N + 1 + T                                  # w, zeta (free), u
    c = np.zeros(nv); c[N] = 1.0; c[N + 1:] = 1.0 / ((1.0 - a) * T)
    A, b = [], []
    for t in range(T):                              # -(r_t . w) - zeta - u_t <= 0
        row = np.zeros(nv); row[:N] = -R[t]; row[N] = -1.0; row[N + 1 + t] = -1.0; A.append(row); b.append(0.0)
    for g in o['groups']:
        row = np.zeros(nv); row[g['idx']] = 1.0; A.append(row); b.append(g['hi'])
        row = np.zeros(nv); row[g['idx']] = -1.0; A.append(row); b.append(-g['lo'])
    for l in o['lookthrough']:
        row = np.zeros(nv)
        for k, v in l['coef'].items(): row[int(k)] = v
        A.append(row); b.append(l['hi'])
    Aeq = np.zeros((1, nv)); Aeq[0, :N] = 1.0
    bounds = [(0, None)] * N + [(None, None)] + [(0, None)] * T
    for k, v in o['ub'].items(): bounds[int(k)] = (0, v)
    s = linprog(c, A_ub=np.array(A), b_ub=np.array(b), A_eq=Aeq, b_eq=[1.0], bounds=bounds, method='highs')
    return {'status': int(s.status), 'fun': None if s.fun is None else float(s.fun), 'x': None if s.x is None else [float(v) for v in s.x[:N]]}

def generic_lp(p):
    c = np.array(p['c'], float); Aub = []; bub = []; Aeq = []; beq = []
    for row in p['rows']:
        if row['op'] == '<=': Aub.append(row['a']); bub.append(row['b'])
        elif row['op'] == '>=': Aub.append([-x for x in row['a']]); bub.append(-row['b'])
        else: Aeq.append(row['a']); beq.append(row['b'])
    s = linprog(c, A_ub=Aub or None, b_ub=bub or None, A_eq=Aeq or None, b_eq=beq or None, bounds=(0, None), method='highs')
    return {'status': int(s.status), 'fun': None if s.fun is None else float(s.fun)}

data = json.load(open(sys.argv[1]))
out = {'cvar': [cvar_lp(p) for p in data['cvar']], 'lp': [generic_lp(p) for p in data['lp']]}
json.dump(out, open(sys.argv[2], 'w'))
`;

function degenerateLPs(n) {
  const out = [];
  for (let k = 0; k < n; k++) {
    const rnd = mulberry32(5000 + k), ri = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
    const nv = ri(2, 8), m = ri(2, 9), c = Array.from({ length: nv }, () => ri(-4, 4)), rows = [];
    for (let i = 0; i < m; i++) rows.push({ a: Array.from({ length: nv }, () => ri(-3, 3)), op: ['<=', '<=', '>=', '='][ri(0, 3)], b: rnd() < 0.6 ? 0 : ri(0, 6) * (rnd() < 0.8 ? 1 : -1) });   // mostly zero right-hand sides: heavily degenerate
    if (rnd() < 0.7) for (let j = 0; j < nv; j++) { const a = new Array(nv).fill(0); a[j] = 1; rows.push({ a, op: '<=', b: ri(1, 5) }); }
    out.push({ c, rows });
  }
  return out;
}

test('scipy HiGHS agrees with the simplex solver on 36 seeded Lagebild problems and 60 degenerate LPs', { skip: SCIPY.ok ? false : SCIPY.msg }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'min_cvar_scipy_'));
  try {
    const probs = Array.from({ length: N_PROBLEMS }, (_, k) => problem(k)), lps = degenerateLPs(60);
    assert.ok(probs.length >= 30);
    assert.ok(probs.every(p => p.T >= 60 && p.T <= 260 && p.returns[0].length === 12));
    assert.ok(new Set(probs.map(p => p.T)).size > 20, 'the problems differ in length');
    const input = path.join(dir, 'in.json'), output = path.join(dir, 'out.json');
    fs.writeFileSync(input, JSON.stringify({ cvar: probs.map(p => ({ returns: p.returns, alpha: p.alpha, opts: p.opts })), lp: lps }));
    const run = cp.spawnSync('python3', ['-I', '-c', SCIPY_SRC, input, output], { encoding: 'utf8', maxBuffer: 1 << 26 });
    assert.equal(run.status, 0, 'python3 failed: ' + run.stderr);
    const ref = JSON.parse(fs.readFileSync(output, 'utf8'));

    let worst = 0;
    probs.forEach((p, k) => {
      const s = ref.cvar[k], r = minCvarWeights(p.returns, p.opts);
      assert.equal(s.status, 0, 'scipy solved problem ' + k);
      assert.equal(r.status, 'optimal', 'problem ' + k + ' (T=' + p.T + ')');
      const rel = Math.abs(r.cvar - s.fun) / Math.max(Math.abs(s.fun), 1e-12);
      worst = Math.max(worst, rel);
      assert.ok(rel <= 1e-7, 'problem ' + k + ' (T=' + p.T + ', alpha=' + p.alpha + '): simplex ' + r.cvar + ' vs HiGHS ' + s.fun + ', relative gap ' + rel);
      // the weights are feasible and evaluate to the reported objective; scipy's own weights evaluate to the same value
      checkFeasible(r.weights, p.opts, 1e-9);
      near(cvarOf(p.returns, s.x, p.alpha).cvar, s.fun, 1e-8, 'scipy weights evaluate to its objective');
    });
    assert.ok(worst <= 1e-7);

    let nOpt = 0, nInf = 0, nUnb = 0;
    lps.forEach((p, k) => {
      const s = ref.lp[k], r = solveLP(p.c, p.rows);
      const want = { 0: 'optimal', 2: 'infeasible', 3: 'unbounded' }[s.status];
      assert.equal(r.status, want, 'degenerate LP ' + k);
      if (want === 'optimal') { nOpt++; assert.ok(Math.abs(r.objective - s.fun) <= 1e-7 * (1 + Math.abs(s.fun)), 'degenerate LP ' + k + ': ' + r.objective + ' vs ' + s.fun); }
      else if (want === 'infeasible') nInf++; else nUnb++;
    });
    assert.ok(nOpt >= 10 && nInf >= 5 && nUnb >= 1, 'the degenerate set exercises every status: ' + [nOpt, nInf, nUnb]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
