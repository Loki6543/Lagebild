'use strict';
// Tests for the minimum-CVaR configuration of run_replay.js on a small synthetic panel.
//
// data/panel/panel.json is not in git, so the panel is built here in the shape build_panel.py writes
// ({ px, tr, macro: { tsy10, real, ff, cpi }, tbill }: [date, value] rows), then written to a temp directory and
// handed to the replay through LAGEBILD_PANEL, with LAGEBILD_RESULTS pointing at another temp directory.
// Nothing under the repository is written. The synthetic history starts in June 2019 and ends in September 2021,
// so the replay (which starts 2021-02-05) has about 35 weekly decisions; SOL starts on 2020-06-01, which leaves the
// challenger without 253 aligned closes for the first part of the run and exercises the hold-and-count path.
//
// What is checked: the run completes; every target respects the plan's limits; trades follow the engine's action
// band; a failing solver holds and is counted; the target at a decision does not move when later data change; and
// the configurations that existed before are byte-identical to the run of the commit that preceded this change.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const ZE = require('../engine/lagebild-engine.js');

const REPO = path.join(__dirname, '..');
// the last commit before the min_cvar configuration existed; its run_replay.js is the reference for "unchanged"
const BASELINE_REV = 'b1527d0';
const COMPARE = ['base', 'base_gate10', 'v3', 'v3_dd'];            // existing configurations compared byte for byte
const SYMS = ['VOO', 'SMH', 'NVDA', 'MSFT', 'TSM', 'XLE', 'IAUM', 'GDX', 'BTC', 'ETH', 'SOL', 'LINK'];
const EQ = SYMS.slice(0, 8), CX = SYMS.slice(8);
const VOL = [.16, .32, .45, .25, .35, .25, .16, .35, .50, .70, .85, .85];
const PANEL_START = '2019-06-03', PANEL_END = '2021-09-30', SOL_START = '2020-06-01';
const HOLIDAYS = new Set(['2019-07-04', '2019-09-02', '2019-11-28', '2019-12-25', '2020-01-01', '2020-01-20', '2020-02-17', '2020-04-10',
  '2020-05-25', '2020-07-03', '2020-09-07', '2020-11-26', '2020-12-25', '2021-01-01', '2021-01-18', '2021-02-15', '2021-04-02', '2021-05-31',
  '2021-07-05', '2021-09-06']);

/* ---------- synthetic panel, same shape as build_panel.py ---------- */
function mulberry32(a) {
  return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
const addDays = (iso, n) => { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const isTradingDay = iso => { const wd = new Date(iso + 'T00:00:00Z').getUTCDay(); return wd !== 0 && wd !== 6 && !HOLIDAYS.has(iso); };
function calendar(from, to) { const out = []; for (let d = from; d <= to; d = addDays(d, 1)) out.push(d); return out; }

function makePanel(seed) {
  const rnd = mulberry32(seed);
  const norm = () => { let u = 0; while (!u) u = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rnd()); };
  const sector = [0, 0, 0, 0, 0, 0, 1, 1, 2, 2, 2, 2], load = [0.7, 0.1, 0.5];
  const px = {}, tr = {}, last = {}, lastTr = {};
  SYMS.forEach(s => { px[s] = []; tr[s] = []; });
  const divYield = { VOO: 0.015, SMH: 0.005, MSFT: 0.01, TSM: 0.015, XLE: 0.03, GDX: 0.01 };
  calendar(PANEL_START, PANEL_END).forEach(d => {
    const m = 0.6 * norm(), sec = [norm(), norm(), norm()];
    SYMS.forEach((s, i) => {
      const isCx = i >= 8;
      if (!isCx && !isTradingDay(d)) return;
      if (s === 'SOL' && d < SOL_START) return;
      const sig = VOL[i] / Math.sqrt(isCx ? 365 : 252);
      const r = sig * (load[sector[i]] * m + 0.42 * sec[sector[i]] + 0.5 * norm()) / 1.2 + 0.0002;
      if (last[s] == null) { last[s] = isCx ? 50 + 400 * rnd() : 40 + 300 * rnd(); lastTr[s] = 1; }
      else {
        const next = last[s] * Math.exp(r);
        lastTr[s] *= next / last[s] * (1 + (divYield[s] || 0) / 252);
        last[s] = next;
      }
      px[s].push([d, Math.round(last[s] * 1e6) / 1e6]);
      tr[s].push([d, Math.round(lastTr[s] * 1e8) / 1e8]);
    });
  });
  // macro, dated the day it becomes knowable (build_panel.py: yields +1 day, Fed funds the 1st, CPI the 15th of the next month)
  const weekdays = calendar('2018-01-01', PANEL_END).filter(d => { const wd = new Date(d + 'T00:00:00Z').getUTCDay(); return wd !== 0 && wd !== 6; });
  const walk = (start, lo, hi, step) => { let v = start; return weekdays.map(d => { v = Math.min(hi, Math.max(lo, v + step * norm())); return [addDays(d, 1), Math.round(v * 100) / 100]; }); };
  const months = []; for (let y = 2018; y <= 2021; y++) for (let mo = 1; mo <= 12; mo++) { const k = y + '-' + String(mo).padStart(2, '0'); if (k <= '2021-09') months.push(k); }
  let ff = 1.5, cpi = 250;
  const macro = {
    tsy10: walk(2.4, 0.6, 3.5, 0.04), real: walk(0.4, -1.2, 1.5, 0.03),
    ff: months.map(k => { ff = Math.max(0.05, ff + 0.02 * norm() - 0.03); return [addDays(k + '-01', 31).slice(0, 7) + '-01', Math.round(ff * 1e4) / 1e4]; }),
    cpi: months.map(k => { cpi *= 1 + 0.002 + 0.001 * norm(); return [addDays(k + '-01', 31).slice(0, 7) + '-15', Math.round(cpi * 1e3) / 1e3]; })
  };
  return { built: '2026-10-17T00:00:00+00:00', assets: SYMS, px, tr, macro, tbill: walk(1.5, 0.05, 2.0, 0.01).map(([d, v]) => [addDays(d, -1), v]).filter(([d]) => d >= '2019-01-01') };
}

// same history up to and including cut, new random prices after it; crypto bars dated cryptoFrom or later are replaced too.
// The first replaced bar of every asset is a 40 % crash, so a decision that used it would see a huge tail loss and move.
function perturbAfter(panel, cut, cryptoFrom, seed) {
  const rnd = mulberry32(seed), p = JSON.parse(JSON.stringify(panel));
  const norm = () => { let u = 0; while (!u) u = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rnd()); };
  SYMS.forEach((s, i) => {
    const from = i >= 8 ? cryptoFrom : addDays(cut, 1);
    const k = p.px[s].findIndex(r => r[0] >= from);
    if (k <= 0) return;
    for (let j = k; j < p.px[s].length; j++) {
      const f = j === k ? 0.6 : Math.exp(VOL[i] / 16 * norm() * 1.5);
      p.px[s][j][1] = Math.round(p.px[s][j - 1][1] * f * 1e6) / 1e6;
      p.tr[s][j][1] = Math.round(p.tr[s][j - 1][1] * f * 1e8) / 1e8;
    }
  });
  return p;
}

/* ---------- running the replay ---------- */
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'lagebild_replay_'));
process.on('exit', () => { try { fs.rmSync(WORK, { recursive: true, force: true }); } catch (e) { /* best effort */ } });

const PRELOAD = path.join(WORK, 'preload_fail_solver.js');
fs.writeFileSync(PRELOAD, `'use strict';
// test double: make some or all calls of the solver fail, as a real solver may
const m = require(process.env.MC_MODULE), orig = m.minCvarWeights; let n = 0;
m.minCvarWeights = function (r, o) {
  n++; const mode = process.env.MC_FAIL;
  if (mode === 'all' || (mode === 'some' && n % 3 === 0)) return { status: n % 2 ? 'infeasible' : 'iteration_limit', weights: null, cvar: null, var: null, objective: null, iterations: 0 };
  return orig(r, o);
};
`);

function node(args, opts) {
  const env = Object.assign({}, process.env); delete env.LAGEBILD_PANEL; delete env.LAGEBILD_RESULTS; delete env.MC_FAIL;
  const r = cp.spawnSync(process.execPath, args, { cwd: opts.cwd, env: Object.assign(env, opts.env || {}), encoding: 'utf8', maxBuffer: 1 << 28 });
  assert.equal(r.status, 0, 'node ' + args.join(' ') + ' failed:\n' + r.stdout + r.stderr);
  return r;
}
const readJson = f => JSON.parse(fs.readFileSync(f, 'utf8'));
const memo = {}; const once = (k, f) => (k in memo ? memo[k] : (memo[k] = f()));

// the synthetic panel, written once
const panelFile = () => once('panel', () => { const f = path.join(WORK, 'panel.json'); fs.writeFileSync(f, JSON.stringify(makePanel(2026))); return f; });

// the repository script with the environment overrides: min_cvar plus the comparison configurations
const mainRun = () => once('main', () => {
  const res = path.join(WORK, 'main_results'), panel = panelFile();
  const r = node([path.join(REPO, 'run_replay.js'), 'min_cvar'].concat(COMPARE), { cwd: WORK, env: { LAGEBILD_PANEL: panel, LAGEBILD_RESULTS: res } });
  return { res, stdout: r.stdout, run: id => readJson(path.join(res, 'runs', id + '.json')) };
});

// the replay with the solver forced to fail
const failRun = mode => once('fail_' + mode, () => {
  const res = path.join(WORK, 'fail_' + mode);
  node(['-r', PRELOAD, path.join(REPO, 'run_replay.js'), 'min_cvar'], { cwd: WORK, env: { LAGEBILD_PANEL: panelFile(), LAGEBILD_RESULTS: res, MC_FAIL: mode, MC_MODULE: path.join(REPO, 'lib/min_cvar.js') } });
  return readJson(path.join(res, 'runs', 'min_cvar.json'));
});

// a copy of a tree laid out as the repository is, so a script reads data/panel/panel.json and writes results/ beside itself
function tree(name, scriptSource, withLib) {
  const dir = path.join(WORK, name);
  fs.mkdirSync(path.join(dir, 'engine'), { recursive: true }); fs.mkdirSync(path.join(dir, 'data/panel'), { recursive: true });
  fs.copyFileSync(path.join(REPO, 'engine/lagebild-engine.js'), path.join(dir, 'engine/lagebild-engine.js'));
  fs.copyFileSync(panelFile(), path.join(dir, 'data/panel/panel.json'));
  if (withLib) { fs.mkdirSync(path.join(dir, 'lib')); fs.copyFileSync(path.join(REPO, 'lib/min_cvar.js'), path.join(dir, 'lib/min_cvar.js')); }
  fs.writeFileSync(path.join(dir, 'run_replay.js'), scriptSource);
  return dir;
}

function baselineSource() {
  const show = rev => cp.spawnSync('git', ['-C', REPO, 'show', rev + ':run_replay.js'], { encoding: 'utf8', maxBuffer: 1 << 26 });
  let r = show(BASELINE_REV);
  if (r.status !== 0) { const h = show('HEAD'); if (h.status === 0 && !h.stdout.includes('min_cvar')) r = h; }   // HEAD is the baseline until this change is committed
  return r.status === 0 ? r.stdout : null;
}
const BASELINE = baselineSource();
const baselineRun = () => once('baseline', () => {
  const dir = tree('baseline_tree', BASELINE, false);
  node(['run_replay.js'].concat(COMPARE), { cwd: dir });
  return { dir, run: id => fs.readFileSync(path.join(dir, 'results/runs', id + '.json'), 'utf8'), configs: readJson(path.join(dir, 'results/configs.json')) };
});
// the working-tree script with no environment variables at all: the defaults must be the old paths
const defaultsRun = () => once('defaults', () => {
  const dir = tree('defaults_tree', fs.readFileSync(path.join(REPO, 'run_replay.js'), 'utf8'), true);
  node(['run_replay.js'].concat(COMPARE), { cwd: dir });
  return { dir, run: id => fs.readFileSync(path.join(dir, 'results/runs', id + '.json'), 'utf8') };
});

/* ---------- limits, in percent of capital ---------- */
function checkLimits(w, tol, where) {
  const sum = a => a.reduce((t, i) => t + w[i], 0);
  assert.ok(Math.abs(sum(SYMS.map((_, i) => i)) - 100) <= tol, where + ': fully invested, sum ' + sum(SYMS.map((_, i) => i)));
  w.forEach((v, i) => assert.ok(v >= -tol, where + ': long only, ' + SYMS[i] + ' = ' + v));
  const stocks = sum([0, 1, 2, 3, 4, 5]), gold = sum([6, 7]), crypto = sum([8, 9, 10, 11]);
  assert.ok(stocks >= 51 - tol && stocks <= 61 + tol, where + ': stocks ' + stocks);
  assert.ok(gold >= 19 - tol && gold <= 29 + tol, where + ': gold ' + gold);
  assert.ok(crypto >= 15 - tol && crypto <= 20 + tol, where + ': crypto ' + crypto);
  assert.ok(w[8] <= 10 + tol, where + ': BTC ' + w[8]);
  const look = w[2] + 0.08 * w[0] + 0.20 * w[1];
  assert.ok(look <= 10 + tol, where + ': NVDA look-through ' + look);
}

/* ---------- tests ---------- */
test('the synthetic panel has the shape build_panel.py writes', () => {
  const p = readJson(panelFile());
  assert.deepEqual(Object.keys(p).sort(), ['assets', 'built', 'macro', 'px', 'tbill', 'tr']);
  assert.deepEqual(p.assets, SYMS);
  SYMS.forEach(s => { assert.ok(p.px[s].length > 250 && p.px[s].length === p.tr[s].length, s); assert.equal(typeof p.px[s][0][0], 'string'); assert.equal(typeof p.px[s][0][1], 'number'); });
  assert.deepEqual(Object.keys(p.macro).sort(), ['cpi', 'ff', 'real', 'tsy10']);
  assert.ok(p.px.BTC.length > p.px.VOO.length, 'crypto trades every day, equities on session days');
  assert.equal(p.px.SOL[0][0], SOL_START);
  assert.equal(p.px.VOO.find(r => r[0] === '2021-04-02'), undefined, 'Good Friday is not a session');
});

test('baseline run_replay.js is available from git (the reference for "unchanged")', { skip: BASELINE ? false : 'git cannot supply run_replay.js at ' + BASELINE_REV + ' (shallow clone or no repository): skipping the byte-identity checks' }, () => {
  assert.ok(BASELINE.includes('const CONFIGS = ['));
  assert.ok(!BASELINE.includes('min_cvar'), 'the reference predates the min_cvar configuration');
});

test('min_cvar completes with LAGEBILD_PANEL and LAGEBILD_RESULTS set, and writes nothing into the repository', () => {
  const before = fs.existsSync(path.join(REPO, 'results/runs/min_cvar.json'));
  const m = mainRun();
  assert.match(m.stdout, /min_cvar\s+nav [\d.]+/);
  const r = m.run('min_cvar'), base = m.run('base');
  assert.equal(r.id, 'min_cvar'); assert.equal(r.label, 'Minimum CVaR within the plan limits');
  assert.equal(r.engine, ZE.VERSION);
  assert.ok(r.daily.length > 100 && r.weekly.length > 20);
  assert.deepEqual(r.daily.map(x => x[0]), base.daily.map(x => x[0]), 'same trading calendar as the engine configurations');
  assert.deepEqual(r.weekly.map(x => x[0]), base.weekly.map(x => x[0]), 'same decision dates');
  r.daily.forEach(x => assert.ok(Number.isFinite(x[1]) && x[1] > 0.3 && x[1] < 5, 'nav ' + x[1]));
  assert.equal(r.targets.length, r.weekly.length);
  assert.equal(r.minCvar.solved + r.minCvar.held, r.weekly.length);
  assert.ok(r.minCvar.solved >= 15, 'the challenger solved at least 15 decisions, got ' + r.minCvar.solved);
  assert.ok(r.minCvar.held >= 5, 'it held through the early weeks without 253 aligned closes, got ' + r.minCvar.held);
  assert.equal(r.blockedWeeks, r.minCvar.held);
  assert.equal(r.statusCount.valid, r.minCvar.solved); assert.equal(r.statusCount.invalid, r.minCvar.held);
  assert.equal(r.minCvar.byStatus.optimal, r.minCvar.solved);
  assert.equal(r.minCvar.byStatus.insufficient_history, r.minCvar.held);
  assert.ok(r.minCvar.firstSolved >= '2021-05-01', 'SOL has no 253 aligned closes before about June 2021: ' + r.minCvar.firstSolved);
  // the held weeks all come first, then every week is solved
  const firstOk = r.targets.findIndex(t => t.status === 'optimal');
  assert.ok(r.targets.slice(0, firstOk).every(t => t.status === 'insufficient_history'));
  assert.ok(r.targets.slice(firstOk).every(t => t.status === 'optimal'));
  // the configs file lists the 23rd trial last, and was written to the overridden directory only
  const cfgs = readJson(path.join(m.res, 'configs.json'));
  assert.equal(cfgs.configs.length, 23);
  assert.equal(cfgs.configs[22].id, 'min_cvar');
  assert.equal(fs.existsSync(path.join(REPO, 'results/runs/min_cvar.json')), before, 'the repository results directory was not touched');
});

test('every target respects every plan limit at every decision', () => {
  const r = mainRun().run('min_cvar');
  const solved = r.targets.filter(t => t.w);
  assert.ok(solved.length >= 15);
  solved.forEach(t => {
    assert.equal(t.w.length, 12);
    checkLimits(t.w, 1e-7, t.d);
    assert.ok(Number.isFinite(t.cvar) && t.cvar < 0.2, 'daily CVaR ' + t.cvar);
  });
  // the recorded sleeve weights are the targets' sleeves
  r.weights.forEach((row, i) => {
    const t = r.targets[i];
    assert.equal(row[0], t.d);
    if (!t.w) { assert.equal(row[1], 'invalid'); assert.deepEqual(row.slice(2), [null, null, null, null, null]); return; }
    assert.equal(row[1], 'valid');
    assert.ok(Math.abs(row[2] - t.w.slice(0, 6).reduce((a, b) => a + b, 0)) < 0.051);
    assert.ok(Math.abs(row[3] - (t.w[6] + t.w[7])) < 0.051);
    assert.ok(Math.abs(row[4] - t.w.slice(8).reduce((a, b) => a + b, 0)) < 0.051);
    assert.equal(row[5], 0);
  });
  // the limits recorded in the run are the plan's: sleeve bands, the BTC cap and the NVDA look-through cap, as fractions of capital
  const lim = r.minCvar.limits, band = idx => lim.groups.find(g => g.idx.join() === idx);
  [['0,1,2,3,4,5', 0.51, 0.61], ['6,7', 0.19, 0.29], ['8,9,10,11', 0.15, 0.20]].forEach(([idx, lo, hi]) => {
    const g = band(idx); assert.ok(g, 'group ' + idx);
    assert.ok(Math.abs(g.lo - lo) < 1e-12 && Math.abs(g.hi - hi) < 1e-12, 'group ' + idx + ' ' + g.lo + ' ' + g.hi);
  });
  assert.deepEqual(lim.ub, { 8: 0.1 });
  assert.deepEqual(lim.lookthrough, [{ coef: { 0: 0.08, 1: 0.2, 2: 1 }, hi: 0.1 }]);
  assert.deepEqual(r.minCvar.symbols, SYMS);
});

test('trades follow the engine\'s action band: |target - current| > max(bandAbs, bandRel x current), and nothing else', () => {
  assert.equal(ZE.PARAMS.bandAbs, 1.5); assert.equal(ZE.PARAMS.bandRel, 0.2);
  const m = mainRun(), r = m.run('min_cvar');
  let trades = 0;
  r.targets.forEach(t => {
    assert.equal(t.cur.length, 12);
    const want = t.w ? SYMS.filter((s, j) => Math.abs(t.w[j] - t.cur[j]) > Math.max(1.5, 0.2 * t.cur[j])) : [];
    assert.deepEqual(t.traded, want, t.d);
    trades += t.traded.length;
  });
  assert.ok(trades > 0, 'the run trades at least once, or the band logic was not exercised');
  // the first target is far from the seeded base plan in places, so something trades; costs beyond the initial build prove it executed
  const buildCost = 0.001 * 80 / 100 + 0.005 * 20 / 100;
  assert.ok(r.costPaid > buildCost + 1e-6, 'trading added cost beyond the initial build: ' + r.costPaid);
  assert.ok(r.turnoverOneWayPerYear * r.years > 0.5 + 0.01);
});

test('a failing solver holds, trades nothing and is counted', () => {
  const buildCost = 0.001 * 80 / 100 + 0.005 * 20 / 100;   // 80 % in ETFs and stocks, 20 % in crypto, charged once when the base plan is seeded
  const all = failRun('all');
  assert.equal(all.minCvar.solved, 0); assert.equal(all.minCvar.held, all.weekly.length);
  assert.equal(all.blockedWeeks, all.weekly.length); assert.equal(all.statusCount.invalid, all.weekly.length); assert.equal(all.statusCount.valid, 0);
  assert.ok(all.targets.every(t => t.w === null && t.traded.length === 0 && t.cvar === null));
  assert.ok(all.minCvar.byStatus.infeasible > 0 && all.minCvar.byStatus.iteration_limit > 0, JSON.stringify(all.minCvar.byStatus));
  assert.ok(Math.abs(all.costPaid - buildCost) < 1e-12, 'no trade, so only the initial build cost: ' + all.costPaid);
  assert.ok(Math.abs(all.turnoverOneWayPerYear * all.years - 0.5) < 1e-9);
  assert.ok(Math.abs(all.daily[0][1] - (1 - buildCost)) < 1e-12, 'day-one nav is the seeded base plan after costs');

  // every third solver call fails; the other solves go through
  const some = failRun('some'), ref = mainRun().run('min_cvar');
  let call = 0, failed = 0;
  some.targets.forEach(t => {
    if (t.status === 'insufficient_history') return;
    call++;
    if (call % 3 === 0) {
      failed++;
      assert.equal(t.status, call % 2 ? 'infeasible' : 'iteration_limit'); assert.equal(t.w, null); assert.deepEqual(t.traded, []);
    } else assert.equal(t.status, 'optimal');
  });
  assert.ok(failed >= 4);
  assert.equal(some.minCvar.held, some.targets.filter(t => t.status !== 'optimal').length);
  assert.equal(some.blockedWeeks, some.minCvar.held);
  assert.equal(some.statusCount.invalid, some.blockedWeeks);
  assert.equal(some.statusCount.valid + some.statusCount.invalid, some.weekly.length);
  assert.ok(some.minCvar.held > ref.minCvar.held, 'failures add to the held weeks');
});

test('the target at a decision does not change when later data change (no lookahead)', () => {
  const ref = mainRun().run('min_cvar'), solved = ref.targets.filter(t => t.w);
  const cut = solved[Math.floor(solved.length / 2)].d;                    // a Friday (or the last session of the week)
  const perturbed = perturbAfter(readJson(panelFile()), cut, cut, 4242);   // equities after the decision day, crypto from the decision day on
  const pf = path.join(WORK, 'panel_perturbed.json'), res = path.join(WORK, 'perturbed_results');
  fs.writeFileSync(pf, JSON.stringify(perturbed));
  node([path.join(REPO, 'run_replay.js'), 'min_cvar'], { cwd: WORK, env: { LAGEBILD_PANEL: pf, LAGEBILD_RESULTS: res } });
  const alt = readJson(path.join(res, 'runs', 'min_cvar.json'));
  assert.equal(alt.targets.length, ref.targets.length);
  let before = 0, after = 0, differs = 0;
  ref.targets.forEach((t, i) => {
    const u = alt.targets[i];
    assert.equal(u.d, t.d);
    if (t.d <= cut) { before++; assert.deepEqual(u.w, t.w, 'target on ' + t.d + ' moved when only later data changed'); assert.equal(u.status, t.status); assert.equal(u.cvar, t.cvar); }
    if (t.d < cut) assert.deepEqual(u, t, 'everything on ' + t.d + ' (before the cut) is identical');
    if (t.d > cut) { after++; if (JSON.stringify(u.w) !== JSON.stringify(t.w)) differs++; }
  });
  assert.ok(before >= 10 && after >= 5, 'decisions on both sides of the cut: ' + before + '/' + after);
  assert.ok(differs >= 3, 'the perturbation does change later targets (otherwise the check proves nothing): ' + differs);
});

test('existing configurations are byte-identical to the previous run_replay.js', { skip: BASELINE ? false : 'baseline run_replay.js unavailable from git' }, () => {
  const old = baselineRun(), m = mainRun();
  COMPARE.forEach(id => {
    const a = old.run(id), b = fs.readFileSync(path.join(m.res, 'runs', id + '.json'), 'utf8');
    assert.ok(a.length > 1000, id + ' produced a run');
    assert.equal(b, a, id + ': run file differs from the previous script\'s output');
  });
  // the comparison is not trivial: the engine configurations made real decisions on this panel
  const base = readJson(path.join(m.res, 'runs', 'base.json'));
  assert.ok(base.statusCount.valid + base.statusCount.degraded > 5, 'engine decisions were not all blocked: ' + JSON.stringify(base.statusCount));
  assert.ok(base.turnoverOneWayPerYear * base.years > 0.5, 'base traded');
  // configs.json: the earlier 22 trials are unchanged and in order, min_cvar is the 23rd
  const cOld = old.configs, cNew = readJson(path.join(m.res, 'configs.json'));
  assert.equal(cOld.configs.length, 22);
  assert.deepEqual(cNew.configs.slice(0, 22), cOld.configs);
  assert.deepEqual({ engine: cNew.engine, start: cNew.start, end: cNew.end, decisions: cNew.decisions }, { engine: cOld.engine, start: cOld.start, end: cOld.end, decisions: cOld.decisions });
});

test('with no environment variables the script reads data/panel/panel.json and writes results/ beside itself', { skip: BASELINE ? false : 'baseline run_replay.js unavailable from git' }, () => {
  const d = defaultsRun(), old = baselineRun();
  COMPARE.forEach(id => assert.equal(d.run(id), old.run(id), id));
  assert.ok(fs.existsSync(path.join(d.dir, 'results/configs.json')));
});

test('the min_cvar run is deterministic', () => {
  const a = mainRun().run('min_cvar');
  const res = path.join(WORK, 'again');
  node([path.join(REPO, 'run_replay.js'), 'min_cvar'], { cwd: WORK, env: { LAGEBILD_PANEL: panelFile(), LAGEBILD_RESULTS: res } });
  assert.deepEqual(readJson(path.join(res, 'runs', 'min_cvar.json')), a);
});
