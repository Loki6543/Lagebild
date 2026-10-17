/* Weekly replay of the Zobiris Lagebild engine, February 2021 to October 2026.

   Each Friday the shipped engine (engine/lagebild-engine.js) gets only what was knowable at that
   Friday's US close: ETF closes through Friday, crypto daily bars through Thursday (the 00:00 UTC
   bar closes before the US close; Friday's own bar closes four hours after it), and macro values
   whose publication date is on or before Friday. Its Add and Trim calls are executed at the next
   session's close; Hold leaves a position alone; a blocked (fail-closed) run trades nothing.
   Costs: 0.10% of traded value for ETFs and stocks, 0.50% for crypto. Cash earns the 3-month T-bill.

   Every configuration's weekly returns are written to results/runs so analyze.py can judge the
   whole search, not only the winner. Usage: node run_replay.js [configId ...] */
'use strict';
const fs = require('fs');
const path = require('path');
const ZE = require('./engine/lagebild-engine.js');

const HERE = __dirname;
const P = JSON.parse(fs.readFileSync(path.join(HERE, 'data/panel/panel.json'), 'utf8'));
const EQ = ['VOO', 'SMH', 'NVDA', 'MSFT', 'TSM', 'XLE', 'IAUM', 'GDX'], CX = ['BTC', 'ETH', 'SOL', 'LINK'], ALL = EQ.concat(CX);
const START = '2021-02-05', END = '2026-10-09';
const COST = { eq: 0.001, cx: 0.005 };
const BASE = {}; ZE.ASSETS.forEach(a => { BASE[a.s] = a.base; });
const DEFAULT_PARAMS = JSON.parse(JSON.stringify(ZE.PARAMS));

/* ---------- configurations: every one that is run is kept and counted as a trial ---------- */
const OFF = { signals: false, macro: false, monthlyGate: false, cryptoCap: false, volCap: false, smoothing: false };
const CONFIGS = [
  { id: 'base', label: 'Base plan, band rebalance', opts: OFF },
  { id: 'base_gate10', label: 'Base + BTC gate (10 months)', opts: Object.assign({}, OFF, { monthlyGate: true }) },
  { id: 'base_gate8', label: 'Base + BTC gate (8 months)', opts: Object.assign({}, OFF, { monthlyGate: true }), params: { gateMonths: 8 } },
  { id: 'base_gate12', label: 'Base + BTC gate (12 months)', opts: Object.assign({}, OFF, { monthlyGate: true }), params: { gateMonths: 12 } },
  { id: 'gate_caps', label: 'Base + gate + risk caps, no tilts', opts: Object.assign({}, OFF, { monthlyGate: true, cryptoCap: true, volCap: true }) },
  { id: 'v3', label: 'v3 default', opts: {} },
  { id: 'v3_dd', label: 'v3 + drawdown overlay', opts: { ddOverlay: true } },
  { id: 'v3_alt', label: 'v3 + alt trend gate', opts: { altGate: true } },
  { id: 'v3_graded', label: 'v3 + trend-distance gate', opts: { gradedGate: true } },
  { id: 'v3_all', label: 'v3 + all three switches', opts: { ddOverlay: true, altGate: true, gradedGate: true } },
  { id: 'v3_nomacro', label: 'v3 without macro', opts: { macro: false } },
  { id: 'v3_macro40', label: 'v3, macro at 0.4', opts: { macroWeight: 0.4 } },
  { id: 'v3_k04', label: 'v3, tilt strength 0.4', opts: {}, params: { kappa: 0.4 } },
  { id: 'v3_k06', label: 'v3, tilt strength 0.6', opts: {}, params: { kappa: 0.6 } },
  { id: 'v3_nosmooth', label: 'v3 without smoothing', opts: { smoothing: false } },
  { id: 'v3_novol', label: 'v3 without volatility ceiling', opts: { volCap: false } },
  { id: 'v3_nocrypto', label: 'v3 without crypto risk cap', opts: { cryptoCap: false } },
  { id: 'v3_nocaps', label: 'v3 without either risk cap', opts: { volCap: false, cryptoCap: false } },
  { id: 'v3_nogate', label: 'v3 without BTC gate', opts: { monthlyGate: false } },
  { id: 'v3_gate8', label: 'v3, gate 8 months', opts: {}, params: { gateMonths: 8 } },
  { id: 'v3_gate12', label: 'v3, gate 12 months', opts: {}, params: { gateMonths: 12 } },
  { id: 'tilts_only', label: 'Tilts only, no gate or caps', opts: { monthlyGate: false, volCap: false, cryptoCap: false } }
];

/* ---------- data access ---------- */
function series(rows) { return { d: rows.map(r => r[0]), v: rows.map(r => r[1]) }; }
function upto(s, iso) { let lo = 0, hi = s.d.length; while (lo < hi) { const m = (lo + hi) >> 1; if (s.d[m] <= iso) lo = m + 1; else hi = m; } return lo; } // count of entries <= iso
const PX = {}, TR = {};
ALL.forEach(s => { PX[s] = series(P.px[s]); TR[s] = series(P.tr[s]); });
const MAC = {}; Object.keys(P.macro).forEach(k => { MAC[k] = series(P.macro[k]); });
const TB = series(P.tbill);
const DATES = PX.VOO.d;   // the US trading calendar
function dayBefore(iso) { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() - 1); return d.toISOString().slice(0, 10); }
function lastN(s, iso, n) { const k = upto(s, iso); const out = []; for (let i = Math.max(0, k - n); i < k; i++) out.push({ d: s.d[i], c: s.v[i] }); return out; }
function valueAt(s, iso) { const k = upto(s, iso); return k ? s.v[k - 1] : null; }
// 3-day bars anchored on 2020-01-01, dated by their first day, the newest one still forming (as CoinDesk returns them)
const EPOCH = Date.UTC(2020, 0, 1);
function threeDay(s, iso, n) {
  const k = upto(s, iso), bars = [];
  for (let i = 0; i < k; i++) {
    const idx = Math.floor((Date.parse(s.d[i] + 'T00:00:00Z') - EPOCH) / (3 * 864e5));
    const start = new Date(EPOCH + idx * 3 * 864e5).toISOString().slice(0, 10);
    if (bars.length && bars[bars.length - 1].d === start) bars[bars.length - 1].c = s.v[i]; else bars.push({ d: start, c: s.v[i] });
  }
  return bars.slice(-n);
}
function macroAt(iso) { const o = {}; Object.keys(MAC).forEach(k => { const s = MAC[k], n = upto(s, iso); const out = []; for (let i = 0; i < n; i++) out.push({ d: s.d[i], v: s.v[i] }); o[k] = out; }); return o; }
function engineInput(fri, holdings) {
  const cxCut = dayBefore(fri), inp = { now: fri + 'T21:00:00Z', prices: {}, cryptoLong: {}, macro: macroAt(fri) };
  EQ.forEach(s => { inp.prices[s] = lastN(PX[s], fri, 260); });
  CX.forEach(s => { inp.prices[s] = lastN(PX[s], cxCut, 100); inp.cryptoLong[s] = threeDay(PX[s], cxCut, 100); });
  const b = PX.BTC, k = upto(b, cxCut); inp.btcMonthly = []; for (let i = 0; i < k; i++) inp.btcMonthly.push({ d: b.d[i], c: b.v[i] });
  inp.holdings = holdings;
  return inp;
}

/* ---------- decision dates: the last trading day of each week ---------- */
function weekKey(iso) { const d = new Date(iso + 'T00:00:00Z'); const day = (d.getUTCDay() + 6) % 7; d.setUTCDate(d.getUTCDate() - day); return d.toISOString().slice(0, 10); }
const DECISIONS = [];
for (let i = 0; i < DATES.length; i++) { const d = DATES[i]; if (d < START || d > END) continue; if (i + 1 >= DATES.length || weekKey(DATES[i + 1]) !== weekKey(d)) DECISIONS.push(d); }

/* ---------- one configuration ---------- */
function run(cfg) {
  Object.assign(ZE.PARAMS, JSON.parse(JSON.stringify(DEFAULT_PARAMS)), cfg.params || {});
  const opts = Object.assign({ shadows: false }, cfg.opts);
  const iStart = DATES.indexOf(DECISIONS[0]) + 1;          // first execution day
  const val = {}; let cash = 0, nav = 1, turnover = 0, costPaid = 0, cashIdx = 1;
  const seed = DATES[iStart];
  ALL.forEach(s => { val[s] = BASE[s] / 100; });
  ALL.forEach(s => { const c = Math.abs(val[s]) * (CX.includes(s) ? COST.cx : COST.eq); costPaid += c; cash -= c; });
  turnover += 0.5;   // building the first portfolio counts as half a one-way turn, the same for every configuration
  let prevRun = null, pending = null, blocked = 0, statusCount = { valid: 0, degraded: 0, invalid: 0 };
  const daily = [], weekly = [], weights = [];
  const decisionAt = new Set(DECISIONS);
  for (let i = iStart; i < DATES.length && DATES[i] <= END; i++) {
    const d = DATES[i], dp = DATES[i - 1];
    if (i > iStart) {   // mark to market from the previous close
      ALL.forEach(s => { const a = valueAt(TR[s], dp), b = valueAt(TR[s], d); if (a && b) val[s] *= b / a; });
      const y = valueAt(TB, dp) || 0, days = (Date.parse(d) - Date.parse(dp)) / 864e5, g = 1 + y / 100 * days / 365;
      cash *= g; cashIdx *= g;
    }
    if (pending) {      // execute last Friday's decision at this close
      nav = cash + ALL.reduce((t, s) => t + val[s], 0);
      const tgt = {}; let add = 0, free = cash;
      ALL.forEach(s => { if (pending[s] == null) return; tgt[s] = pending[s] / 100 * nav; const dv = tgt[s] - val[s]; if (dv > 0) add += dv; else free -= dv; });
      const scale = add > free && add > 0 ? Math.max(0, free) / add : 1;   // never borrow to fund additions
      ALL.forEach(s => {
        if (tgt[s] == null) return; let dv = tgt[s] - val[s]; if (dv > 0) dv *= scale;
        const c = Math.abs(dv) * (CX.includes(s) ? COST.cx : COST.eq);
        val[s] += dv; cash -= dv + c; costPaid += c; turnover += Math.abs(dv) / nav / 2;
      });
      pending = null;
    }
    nav = cash + ALL.reduce((t, s) => t + val[s], 0);
    daily.push([d, nav]);
    if (decisionAt.has(d)) {
      const units = {}; ALL.forEach(s => { const pxs = CX.includes(s) ? valueAt(PX[s], dayBefore(d)) : valueAt(PX[s], d); units[s] = pxs ? val[s] / pxs : 0; });
      const res = ZE.compute(engineInput(d, { units: units, cash: Math.max(0, cash), asOf: d }), prevRun, null, opts);
      statusCount[res.status] = (statusCount[res.status] || 0) + 1;
      if (res.status === 'invalid') blocked++;
      else {
        pending = {}; ALL.forEach(s => { const a = res.actions[s]; if (a && (a.act === 'Add' || a.act === 'Trim')) pending[s] = res.weights[s]; });
        if (!Object.keys(pending).length) pending = null;
        prevRun = res;
      }
      weekly.push([d, nav, cashIdx]);
      const sl = res.sleeves || {};
      weights.push([d, res.status, Math.round(sl.stocks * 10) / 10, Math.round(sl.gold * 10) / 10, Math.round(sl.crypto * 10) / 10, Math.round(res.outside * 10) / 10, res.gates && res.gates.btc ? res.gates.btc.on : null]);
    }
  }
  const years = (Date.parse(daily[daily.length - 1][0]) - Date.parse(daily[0][0])) / (365.25 * 864e5);
  return { id: cfg.id, label: cfg.label, opts: cfg.opts, params: cfg.params || {}, engine: ZE.VERSION, start: daily[0][0], end: daily[daily.length - 1][0],
    years: years, turnoverOneWayPerYear: turnover / years, costPaid: costPaid, blockedWeeks: blocked, statusCount: statusCount,
    weekly: weekly, daily: daily, weights: weights };
}

/* ---------- main ---------- */
const want = process.argv.slice(2), todo = want.length ? CONFIGS.filter(c => want.includes(c.id)) : CONFIGS;
const outDir = path.join(HERE, 'results/runs'); fs.mkdirSync(outDir, { recursive: true });
const t0 = Date.now();
todo.forEach(cfg => {
  const t1 = Date.now(), r = run(cfg);
  fs.writeFileSync(path.join(outDir, cfg.id + '.json'), JSON.stringify(r));
  const navEnd = r.daily[r.daily.length - 1][1];
  console.log(`${cfg.id.padEnd(12)} nav ${navEnd.toFixed(3)}  cagr ${((Math.pow(navEnd, 1 / r.years) - 1) * 100).toFixed(1)}%  turnover ${(r.turnoverOneWayPerYear * 100).toFixed(0)}%/yr  blocked ${r.blockedWeeks}w  ${((Date.now() - t1) / 1000).toFixed(1)}s`);
});
fs.writeFileSync(path.join(HERE, 'results/configs.json'), JSON.stringify({ engine: ZE.VERSION, start: START, end: END, decisions: DECISIONS.length, configs: CONFIGS }, null, 1));
console.log(`${todo.length} configurations, ${DECISIONS.length} weekly decisions, ${((Date.now() - t0) / 1000).toFixed(0)}s`);
