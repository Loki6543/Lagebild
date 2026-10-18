/* Copied verbatim from the published Zobiris Lagebild app (artifact KNEopyQGNjuo5StoLe9HyG, version 1792236432-1f31).
   Do not edit here: change the app, then copy the engine again so the replay always tests the shipped code. */
/* Zobiris Lagebild allocation engine v3.0
   v3 answers the October 16 formula review: volatility-scaled log signals, reduced macro authority,
   shrunk PSD covariance, gates as upper bounds applied once, capacity-limited ballast, a closed-form
   crypto risk-share repair, uniform volatility scaling, a final constraint check, signal smoothing
   before the constraints, and actions measured against marked holdings when they are entered.
   v3.1 follows the October 16 technical whitepaper: every input carries a quality record, and a run fails closed
   (no actionable targets) when a required price, the BTC gate input, the risk model or a final check is missing or fails.
   Pure functions: parse connector payloads, compute target weights.
   Works in the browser (window.ZE) and in Node (module.exports). */
(function (root) {
  'use strict';

  var VERSION = 'Zobiris Lagebild v3.1';
  var ASSETS = [
    { s: 'VOO',  sleeve: 'stocks', base: 28, kind: 'eq', name: 'S&P 500 core' },
    { s: 'SMH',  sleeve: 'stocks', base: 13, kind: 'eq', name: 'Semiconductors' },
    { s: 'NVDA', sleeve: 'stocks', base: 4,  kind: 'eq', name: 'NVIDIA' },
    { s: 'MSFT', sleeve: 'stocks', base: 5,  kind: 'eq', name: 'Microsoft' },
    { s: 'TSM',  sleeve: 'stocks', base: 4,  kind: 'eq', name: 'TSMC' },
    { s: 'XLE',  sleeve: 'stocks', base: 8,  kind: 'eq', name: 'Energy hedge' },
    { s: 'IAUM', sleeve: 'gold',   base: 14, kind: 'eq', name: 'Physical gold' },
    { s: 'GDX',  sleeve: 'gold',   base: 7,  kind: 'eq', name: 'Gold miners' },
    { s: 'BTC',  sleeve: 'crypto', base: 8,  kind: 'cx', name: 'Bitcoin' },
    { s: 'ETH',  sleeve: 'crypto', base: 0,  kind: 'cx', name: 'Ethereum' },
    { s: 'SOL',  sleeve: 'crypto', base: 6,  kind: 'cx', name: 'Solana' },
    { s: 'LINK', sleeve: 'crypto', base: 3,  kind: 'cx', name: 'Chainlink' }
  ];
  var SYMS = ASSETS.map(function (a) { return a.s; });
  var SLEEVES = { gold: 21, stocks: 62, crypto: 17 };
  // how far each sleeve may move [down, up] from its base, in % of total capital; upper limits are hard,
  // lower limits relax only when a gate or risk control has to move money to cash
  var SLEEVE_BAND = { gold: [5, 5], stocks: [5, 5], crypto: [5, 0] };
  var ASSET_CAP = { BTC: 10 };
  var ALTS = ['ETH', 'SOL', 'LINK'], CRYPTO = ['BTC', 'ETH', 'SOL', 'LINK'];
  var DEFAULT_VOL = { VOO: .16, SMH: .32, NVDA: .45, MSFT: .25, TSM: .35, XLE: .25, IAUM: .16, GDX: .35, BTC: .50, ETH: .70, SOL: .85, LINK: .85 };
  // NVIDIA weight inside each holding; fund coefficients are supplied assumptions, not verified holdings
  var LOOK = { NVDA: 1, VOO: 0.08, SMH: 0.20 };
  var PARAMS = {
    kappa: 0.2, multMin: 0.6, multMax: 1.5,     // multiplier = clamp(exp(kappa * z)); 0.2, 0.4 and 0.6 replayed alike, 0.2 trades least
    macroWeight: 0.2,                           // z = 0.8 S + 0.2 macro (v2 used 0.4)
    trendH: { eq: 63 / 252, cx: 90 / 365 },     // trend distance is measured in volatility units over this horizon
    momH: { eq: 105 / 252, cx: 105 / 365 },     // 21 to 126 day momentum window, on each asset's own clock
    volFloor: 0.5,                              // sigma_eff = max(sigma, 0.5 x default vol)
    volCap: 0.24,
    cryptoRiskCap: 0.60, cryptoRiskCapStress: 0.50,
    nvdaLookCap: 10,
    smoothDays: 21, smooth: 0.5,
    corrWindow: 63, ewmaLambda: 0.94, stressThreshold: 0.15,
    shrinkMin: 0.25, shrinkMax: 0.75,           // guardrails on the Ledoit-Wolf constant-correlation intensity
    stressRho: 0.8,                             // adverse correlation scenario, diagnostic only
    gradedWarn: 0.5, gradedCut: 0.2, flowThreshold: -0.01,
    ddDeadband: 0.10, ddMax: 0.30, ddFloor: 0.5,
    semisWindow: 50,
    gateMonths: 10,                             // BTC month-end close vs its N-month average; 8 and 12 replayed for robustness
    ballast: { VOO: 0.6, IAUM: 0.4 },
    bandAbs: 1.5, bandRel: 0.2
  };
  // defaults follow the 2021-2026 weekly replay: the monthly BTC gate carries the drawdown protection; the alt gate,
  // the trend-distance gate and the drawdown overlay are switches the owner can turn on
  var DEFAULT_OPTS = { signals: true, macro: true, altGate: false, monthlyGate: true, gradedGate: false, cryptoCap: true, volCap: true,
    ddOverlay: false, smoothing: true, shadows: true, macroWeight: null };
  var RISK_SET = ['VOO', 'SMH', 'NVDA', 'TSM', 'BTC', 'ETH', 'SOL'];
  // 2026-2027 FOMC decision days (second day of each meeting)
  var FOMC = ['2026-01-28','2026-03-18','2026-04-29','2026-06-17','2026-07-29','2026-09-16','2026-10-28','2026-12-09',
              '2027-01-27','2027-03-17','2027-04-28','2027-06-16','2027-07-28','2027-09-22','2027-10-27','2027-12-08'];

  function clamp(x, lo, hi) { if (lo === undefined) { lo = -1; hi = 1; } return Math.max(lo, Math.min(hi, x)); }
  function mean(a) { var s = 0; for (var i = 0; i < a.length; i++) s += a[i]; return a.length ? s / a.length : NaN; }
  function sd(a) { var m = mean(a), s = 0; for (var i = 0; i < a.length; i++) s += (a[i] - m) * (a[i] - m); return a.length > 1 ? Math.sqrt(s / (a.length - 1)) : NaN; }
  function sign(x) { return x > 0 ? 1 : x < 0 ? -1 : 0; }
  function r4(x) { return Math.round(x * 10000) / 10000; }
  function r2(x) { return Math.round(x * 100) / 100; }
  function isNum(x) { return typeof x === 'number' && isFinite(x); }
  function sum(o, keys) { var s = 0; (keys || Object.keys(o)).forEach(function (k) { s += o[k] || 0; }); return s; }

  /* ---------- parsers ---------- */
  function textOf(p) {
    if (typeof p === 'string') return p;
    if (p && typeof p === 'object') {
      if (Array.isArray(p.content)) { for (var i = 0; i < p.content.length; i++) if (p.content[i].type === 'text') return p.content[i].text; }
      if (typeof p.text === 'string') return p.text;
      for (var k in p) { if (typeof p[k] === 'string' && p[k].indexOf('\n') >= 0) return p[k]; }
    }
    return null;
  }
  function jsonOf(p) {
    if (p && typeof p === 'object' && !Array.isArray(p.content)) return p;
    var t = textOf(p); if (t == null) return null;
    try { return JSON.parse(t); } catch (e) { return null; }
  }
  var parse = {
    // Twelve Data get_time_series: "datetime;open;high;low;close;volume" newest first
    twelve: function (p) {
      var t = textOf(p);
      if (!t) { var j = jsonOf(p); if (j && Array.isArray(j.values)) return j.values.map(function (v) { return { d: v.datetime.slice(0, 10), c: +v.close }; }).filter(function (x) { return isNum(x.c); }).reverse(); return null; }
      if (/run out of API credits|^Error/i.test(t)) { var e = new Error(t); e.rateLimited = /credits/i.test(t); throw e; }
      var lines = t.trim().split(/\r?\n/), hdr = lines[0].split(/[;,]/).map(function (h) { return h.trim().toLowerCase(); });
      var di = hdr.indexOf('datetime'), ci = hdr.indexOf('close');
      if (di < 0 || ci < 0) return null;
      var out = [];
      for (var i = 1; i < lines.length; i++) { var f = lines[i].split(/[;,]/); var c = parseFloat(f[ci]); if (isNum(c)) out.push({ d: f[di].slice(0, 10), c: c }); }
      out.sort(function (a, b) { return a.d < b.d ? -1 : 1; });
      return out;
    },
    // CoinDesk fetch_index_ohlcv: {Data:[{TIMESTAMP, CLOSE}]} oldest first; TIMESTAMP is the bar open (UTC)
    coindesk: function (p) {
      var j = jsonOf(p); if (!j || !Array.isArray(j.Data)) return null;
      return j.Data.map(function (r) { return { d: new Date(r.TIMESTAMP * 1000).toISOString().slice(0, 10), c: +r.CLOSE }; })
        .filter(function (x) { return isNum(x.c) && x.c > 0; })
        .sort(function (a, b) { return a.d < b.d ? -1 : 1; });
    },
    // Crypto.com get_candlestick: {data:[{close, timestamp}]} newest first
    cryptocom: function (p) {
      var j = jsonOf(p); var arr = j && (j.data || (j.result && j.result.data)); if (!Array.isArray(arr)) return null;
      return arr.map(function (r) { var ts = r.timestamp || r.t; var d = typeof ts === 'number' ? new Date(ts).toISOString() : String(ts); return { d: d.slice(0, 10), c: +(r.close || r.c) }; })
        .filter(function (x) { return isNum(x.c); }).sort(function (a, b) { return a.d < b.d ? -1 : 1; });
    },
    // Alpha Vantage economic series (TREASURY_YIELD, CPI, FEDERAL_FUNDS_RATE): {data:[{date,value}]} or CSV
    avSeries: function (p) {
      var j = jsonOf(p), rows = [];
      if (j && j.error) { var e0 = new Error(j.error.message || 'Alpha Vantage error'); e0.rateLimited = /rate/i.test(j.error.type || ''); throw e0; }
      if (j && (j.Information || j.Note)) { var e1 = new Error(j.Information || j.Note); e1.rateLimited = true; throw e1; }
      if (j && Array.isArray(j.data)) rows = j.data.map(function (r) { return { d: r.date, v: parseFloat(r.value) }; });
      else { var t = textOf(p); if (!t) return null; var L = t.trim().split(/\r?\n/); for (var i = 1; i < L.length; i++) { var f = L[i].split(','); rows.push({ d: f[0], v: parseFloat(f[1]) }); } }
      rows = rows.filter(function (r) { return isNum(r.v); });
      rows.sort(function (a, b) { return a.d < b.d ? -1 : 1; });
      return rows.length ? rows : null;
    },
    // Gemini gemini_list_prediction_events: JSON wrapped in <tool-output> tags (kept for tests; the app no longer calls Gemini)
    gemini: function (p) {
      var j = (p && typeof p === 'object' && Array.isArray(p.data)) ? p : null;
      if (!j) { var t = textOf(p) || (typeof p === 'string' ? p : null); if (!t) return null; var a = t.indexOf('{'), b = t.lastIndexOf('}'); if (a < 0 || b < a) return null; try { j = JSON.parse(t.slice(a, b + 1)); } catch (e) { return null; } }
      return Array.isArray(j.data) ? j.data : null;
    },
    // Alpha Vantage DIGITAL_CURRENCY_MONTHLY csv: timestamp,open,high,low,close,volume (newest first)
    avMonthly: function (p) {
      var j = jsonOf(p);
      if (j && j.error) { var e = new Error(j.error.message || 'Alpha Vantage error'); e.rateLimited = true; throw e; }
      var t = textOf(p); if (!t) return null;
      var L = t.trim().split(/\r?\n/), out = [];
      for (var i = 1; i < L.length; i++) { var f = L[i].split(','); var c = parseFloat(f[4]); if (isNum(c)) out.push({ d: f[0], c: c }); }
      out.sort(function (a, b) { return a.d < b.d ? -1 : 1; });
      return out.length ? out : null;
    },
    // FRED graph CSV read through Firecrawl: {markdown:"observation\\_date,DFII10\n2026-06-01,2.07\n..."}; blank values skipped
    fred: function (p) {
      var t = null;
      if (p && typeof p === 'object') t = p.markdown || (p.data && p.data.markdown) || textOf(p); else if (typeof p === 'string') t = p;
      if (!t) return null;
      var rows = [];
      t.split(/\r?\n/).forEach(function (ln) { var m = ln.match(/^(\d{4}-\d{2}-\d{2}),\s*(-?[\d.]+)\s*$/); if (m) rows.push({ d: m[1], v: parseFloat(m[2]) }); });
      rows.sort(function (a, b) { return a.d < b.d ? -1 : 1; });
      return rows.length ? rows : null;
    }
  };

  /* ---------- small helpers ---------- */
  function logRets(a) { var r = []; for (var i = 1; i < a.length; i++) r.push(Math.log(a[i] / a[i - 1])); return r; }
  function smaAt(closes, len, lag) { var n = closes.length - (lag || 0); return n >= len ? mean(closes.slice(n - len, n)) : null; }
  function annVol(closes, n, ann) { if (!closes || closes.length < 22) return null; var s = sd(logRets(closes.slice(-(n + 1)))); return isNum(s) && s > 0 ? s * Math.sqrt(ann) : null; }
  function monthEndCloses(series, nowISO) {
    var byMonth = {}, order = [];
    series.forEach(function (x) { var m = x.d.slice(0, 7); if (!(m in byMonth)) order.push(m); byMonth[m] = x.c; });
    var cur = nowISO.slice(0, 7);
    return order.filter(function (m) { return m < cur; }).map(function (m) { return { m: m, c: byMonth[m] }; });
  }
  function valueAtOrBefore(series, iso) { var v = null; for (var i = 0; i < series.length; i++) { if (series[i].d <= iso) v = series[i].v; else break; } return v; }
  function shiftDays(iso, days) { var d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); }
  function shiftMonths(iso, m) { var d = new Date(iso + 'T00:00:00Z'); d.setUTCMonth(d.getUTCMonth() + m); return d.toISOString().slice(0, 10); }
  function cpiYoY(cpi, iso) {
    var cur = null, i; for (i = 0; i < cpi.length; i++) { if (cpi[i].d <= iso) cur = cpi[i]; else break; }
    if (cur && cur.p) {   // rows carry their observation month: compare with the same month a year earlier, if it was published by iso
      var want = shiftMonths(cur.p + '-01', -12).slice(0, 7), then = null;
      for (i = 0; i < cpi.length; i++) if (cpi[i].p === want && cpi[i].d <= iso) then = cpi[i];
      return then && then.v ? (cur.v / then.v - 1) * 100 : null;
    }
    var now = valueAtOrBefore(cpi, iso), prev = valueAtOrBefore(cpi, shiftMonths(iso, -12)); return now && prev ? (now / prev - 1) * 100 : null;
  }
  function pctField(x) { if (x == null) return null; var v = parseFloat(String(x).replace(/[+%\s]/g, '')); return isNum(v) ? v : null; }
  function erf(x) { var t = 1 / (1 + 0.3275911 * Math.abs(x)); var y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x); return x >= 0 ? y : -y; }
  function Phi(x) { return 0.5 * (1 + erf(x / Math.SQRT2)); }

  /* ---------- linear algebra ---------- */
  function jacobiEig(A) {
    var n = A.length, a = A.map(function (r) { return r.slice(); }), v = [], i, j, k;
    for (i = 0; i < n; i++) { v.push([]); for (j = 0; j < n; j++) v[i].push(i === j ? 1 : 0); }
    for (var sweep = 0; sweep < 100; sweep++) {
      var off = 0; for (i = 0; i < n; i++) for (j = i + 1; j < n; j++) off += a[i][j] * a[i][j];
      if (off < 1e-22) break;
      for (var p = 0; p < n; p++) for (var q = p + 1; q < n; q++) {
        if (Math.abs(a[p][q]) < 1e-300) continue;
        var th = (a[q][q] - a[p][p]) / (2 * a[p][q]), t = sign(th || 1) / (Math.abs(th) + Math.sqrt(th * th + 1)), c = 1 / Math.sqrt(t * t + 1), s = t * c;
        for (k = 0; k < n; k++) { var akp = a[k][p], akq = a[k][q]; a[k][p] = c * akp - s * akq; a[k][q] = s * akp + c * akq; }
        for (k = 0; k < n; k++) { var apk = a[p][k], aqk = a[q][k]; a[p][k] = c * apk - s * aqk; a[q][k] = s * apk + c * aqk; }
        for (k = 0; k < n; k++) { var vkp = v[k][p], vkq = v[k][q]; v[k][p] = c * vkp - s * vkq; v[k][q] = s * vkp + c * vkq; }
      }
    }
    return { vals: a.map(function (r, ii) { return r[ii]; }), vecs: v };
  }
  // nearest valid correlation matrix by eigenvalue clipping and unit-diagonal rescaling
  function psdCorr(R) {
    var e = jacobiEig(R), n = R.length, minE = Math.min.apply(null, e.vals);
    if (minE >= 1e-8) return { R: R, repaired: false, minEig: minE };
    var lam = e.vals.map(function (x) { return Math.max(x, 1e-8); }), M = [], i, j, k;
    for (i = 0; i < n; i++) { M.push([]); for (j = 0; j < n; j++) { var s = 0; for (k = 0; k < n; k++) s += e.vecs[i][k] * lam[k] * e.vecs[j][k]; M[i].push(s); } }
    var d = M.map(function (r, ii) { return 1 / Math.sqrt(r[ii]); });
    for (i = 0; i < n; i++) for (j = 0; j < n; j++) M[i][j] = i === j ? 1 : M[i][j] * d[i] * d[j];
    return { R: M, repaired: true, minEig: minE };
  }
  function covFrom(R, vol, syms) { return syms.map(function (a, i) { return syms.map(function (b, j) { return R[i][j] * vol[a] * vol[b]; }); }); }
  function portRisk(w, syms, C) {
    var n = syms.length, Cw = [], v = 0;
    for (var i = 0; i < n; i++) { var s = 0; for (var j = 0; j < n; j++) s += C[i][j] * (w[syms[j]] || 0) / 100; Cw.push(s); }
    for (var k = 0; k < n; k++) v += (w[syms[k]] || 0) / 100 * Cw[k];
    var rc = {}; syms.forEach(function (s, i) { rc[s] = v > 1e-14 ? (w[s] || 0) / 100 * Cw[i] / v : 0; });
    return { vol: Math.sqrt(Math.max(v, 0)), v: v, rc: rc, Cw: Cw };
  }
  function cryptoShareOf(rk) { return CRYPTO.reduce(function (s, x) { return s + (rk.rc[x] || 0); }, 0); }

  /* ---------- risk model ---------- */
  // daily log returns on the stock calendar; crypto closes are sampled at each stock date, so weekend moves land in Monday
  function alignedReturns(prices, syms, win) {
    var anchor = prices.VOO || prices.SMH || prices.IAUM; if (!anchor) return null;
    var dates = anchor.map(function (x) { return x.d; });
    var cols = {}, have = syms.filter(function (s) { return prices[s] && prices[s].length; });
    have.forEach(function (s) {
      var arr = [], last = null, src = prices[s], j = 0;
      for (var i = 0; i < dates.length; i++) { while (j < src.length && src[j].d <= dates[i]) { last = src[j].c; j++; } arr.push(last); }
      cols[s] = arr;
    });
    var idx = []; for (var i2 = dates.length - 1; i2 >= 0 && idx.length < win + 1; i2--) { var ok = have.every(function (s) { return cols[s][i2] != null; }); if (ok) idx.unshift(i2); else break; }
    if (idx.length < 31) return null;
    var R = {}; have.forEach(function (s) { R[s] = logRets(idx.map(function (k) { return cols[s][k]; })); });
    return { syms: have, R: R, n: idx.length - 1, from: dates[idx[0]], to: dates[idx[idx.length - 1]] };
  }
  function sampleCorr(ar, syms) {
    var n = syms.length, corr = [], have = ar ? ar.syms : [];
    for (var a = 0; a < n; a++) { corr.push([]); for (var b = 0; b < n; b++) corr[a].push(a === b ? 1 : null); }
    for (var x = 0; x < n; x++) for (var y = x + 1; y < n; y++) {
      var s1 = syms[x], s2 = syms[y];
      if (have.indexOf(s1) >= 0 && have.indexOf(s2) >= 0) {
        var r1 = ar.R[s1], r2_ = ar.R[s2], m1 = mean(r1), m2 = mean(r2_), cv = 0;
        for (var k = 0; k < r1.length; k++) cv += (r1[k] - m1) * (r2_[k] - m2);
        cv /= (r1.length - 1);
        var c = cv / (sd(r1) * sd(r2_)); corr[x][y] = corr[y][x] = isNum(c) ? c : null;
      }
    }
    return corr;
  }
  function ewmaStats(ar, syms, lambda) {
    var n = syms.length, corr = [], vol = {};
    for (var i = 0; i < n; i++) { corr.push([]); for (var j = 0; j < n; j++) corr[i].push(i === j ? 1 : null); }
    if (!ar || ar.n < 30) return { corr: corr, vol: vol };
    var have = ar.syms, k = have.length, T = ar.n, S = [], seed = Math.min(20, T);
    for (var a = 0; a < k; a++) { S.push([]); for (var b = 0; b < k; b++) { var v = 0; for (var t = 0; t < seed; t++) v += ar.R[have[a]][t] * ar.R[have[b]][t]; S[a].push(v / seed); } }
    for (var t2 = seed; t2 < T; t2++) for (var a2 = 0; a2 < k; a2++) for (var b2 = a2; b2 < k; b2++) {
      var val = lambda * S[a2][b2] + (1 - lambda) * ar.R[have[a2]][t2] * ar.R[have[b2]][t2]; S[a2][b2] = val; S[b2][a2] = val;
    }
    have.forEach(function (s1, a3) {
      vol[s1] = Math.sqrt(S[a3][a3] * 252);
      have.forEach(function (s2, b3) { var i2 = syms.indexOf(s1), j2 = syms.indexOf(s2); if (i2 !== j2) corr[i2][j2] = S[a3][b3] / Math.sqrt(S[a3][a3] * S[b3][b3]); });
    });
    return { corr: corr, vol: vol };
  }
  // Ledoit and Wolf (2004) shrinkage intensity toward the constant-correlation target, on the equal-weight sample
  function ledoitWolf(ar) {
    if (!ar || ar.n < 30 || ar.syms.length < 3) return null;
    var S0 = ar.syms, N = S0.length, T = ar.n, Y = [], i, j, t;
    for (i = 0; i < N; i++) { var r = ar.R[S0[i]], m = mean(r); Y.push(r.map(function (x) { return x - m; })); }
    var S = [];
    for (i = 0; i < N; i++) { S.push([]); for (j = 0; j < N; j++) { var c = 0; for (t = 0; t < T; t++) c += Y[i][t] * Y[j][t]; S[i].push(c / T); } }
    var rb = 0, cnt = 0;
    for (i = 0; i < N; i++) for (j = i + 1; j < N; j++) { rb += S[i][j] / Math.sqrt(S[i][i] * S[j][j]); cnt++; }
    rb /= cnt;
    var pi = 0, rho = 0, gamma = 0;
    var th = []; // theta_ii,ij
    for (i = 0; i < N; i++) { th.push([]); for (j = 0; j < N; j++) { var s1 = 0; for (t = 0; t < T; t++) s1 += (Y[i][t] * Y[i][t] - S[i][i]) * (Y[i][t] * Y[j][t] - S[i][j]); th[i].push(s1 / T); } }
    for (i = 0; i < N; i++) for (j = 0; j < N; j++) {
      var p = 0; for (t = 0; t < T; t++) { var d = Y[i][t] * Y[j][t] - S[i][j]; p += d * d; } pi += p / T;
      var f = i === j ? S[i][i] : rb * Math.sqrt(S[i][i] * S[j][j]); gamma += (f - S[i][j]) * (f - S[i][j]);
      if (i !== j) rho += (rb / 2) * (Math.sqrt(S[j][j] / S[i][i]) * th[i][j] + Math.sqrt(S[i][i] / S[j][j]) * th[j][i]);
    }
    for (i = 0; i < N; i++) { var pd = 0; for (t = 0; t < T; t++) { var dd = Y[i][t] * Y[i][t] - S[i][i]; pd += dd * dd; } rho += pd / T; }
    var kappa = gamma > 0 ? (pi - rho) / gamma : 1;
    return { delta: clamp(kappa / T, 0, 1), rbar: rb };
  }
  // base risk model: long-window volatilities with EWMA correlations shrunk toward constant correlation, made PSD
  function riskModel(prices, longC, syms) {
    var ar = alignedReturns(prices, syms, 250), ar63 = alignedReturns(prices, syms, PARAMS.corrWindow);
    var E = ewmaStats(ar, syms, PARAMS.ewmaLambda), lw = ledoitWolf(ar63);
    var rbar = lw ? clamp(lw.rbar, 0, 0.9) : 0.3, delta = lw ? clamp(lw.delta, PARAMS.shrinkMin, PARAMS.shrinkMax) : PARAMS.shrinkMax;
    var n = syms.length, Rb = [], Re = [], Rs = [], Rst = [], volL = {}, volE = {}, srcVol = {};
    syms.forEach(function (s, i) {
      var a = ASSETS[i], v = null;
      if (a.kind === 'eq') { var c = prices[s] ? prices[s].map(function (x) { return x.c; }) : null; v = annVol(c, 252, 252); srcVol[s] = v ? 'daily, ' + Math.min(252, c.length - 1) + 'd' : 'default'; }
      else {
        var lc = longC[s] ? longC[s].map(function (x) { return x.c; }) : null, dc = prices[s] ? prices[s].map(function (x) { return x.c; }) : null;
        v = lc && lc.length >= 40 ? annVol(lc, lc.length - 1, 365 / 3) : null; srcVol[s] = v ? '3-day bars, ' + (lc.length - 1) * 3 + 'd' : '';
        if (!v) { v = annVol(dc, 99, 365); srcVol[s] = v ? 'daily, ' + Math.min(99, dc.length - 1) + 'd' : 'default'; }
      }
      volL[s] = v || DEFAULT_VOL[s];
      volE[s] = E.vol[s] || volL[s];
    });
    var S63 = sampleCorr(ar63, syms);
    for (var i = 0; i < n; i++) { Rb.push([]); Re.push([]); Rs.push([]); Rst.push([]);
      for (var j = 0; j < n; j++) {
        if (i === j) { Rb[i].push(1); Re[i].push(1); Rs[i].push(1); Rst[i].push(1); continue; }
        var e = E.corr[i][j], s63 = S63[i][j];
        Re[i].push(e != null ? e : rbar);
        Rb[i].push(e != null ? (1 - delta) * e + delta * rbar : rbar);
        Rs[i].push(s63 != null ? s63 : rbar);
        Rst[i].push(PARAMS.stressRho);
      }
    }
    var pb = psdCorr(Rb), pe = psdCorr(Re), ps = psdCorr(Rs);
    return {
      syms: syms, ar: ar, ar63: ar63, delta: delta, rbar: rbar, lwRaw: lw ? lw.delta : null,
      Rbase: pb.R, Rewma: pe.R, Rsample: ps.R, Rraw: { ewma: E.corr, sample: S63 },
      Cbase: covFrom(pb.R, volL, syms), Cewma: covFrom(pe.R, volE, syms), Csample: covFrom(ps.R, volL, syms), Cstress: covFrom(Rst, volL, syms),
      volL: volL, volE: volE, srcVol: srcVol, psd: { base: pb.repaired, ewma: pe.repaired, sample: ps.repaired, minEigBase: pb.minEig }
    };
  }
  /* ---------- diagnostic only: 1-day historical expected shortfall (CVaR), never an input to any weight, action, check or status ---------- */
  var CVAR_ALPHA = 0.95, CVAR_MIN_DAYS = 60;
  // portfolio simple return per day from the aligned log-return panel: sum of (w_i / 100) x (exp(r_i) - 1), cash earns 0;
  // null when a held asset has no aligned returns or a weight is not a finite number
  function portReturns(ar, w) {
    if (!ar || !ar.R || !(ar.n > 0)) return null;
    var held = [], i, t, s, r, out = [];
    for (i = 0; i < SYMS.length; i++) {
      s = SYMS[i];
      if (!isNum(w[s])) return null;
      if (w[s] !== 0) { if (!ar.R[s] || ar.R[s].length < ar.n) return null; held.push(s); }
    }
    for (t = 0; t < ar.n; t++) { r = 0; for (i = 0; i < held.length; i++) r += w[held[i]] / 100 * (Math.exp(ar.R[held[i]][t]) - 1); out.push(r); }
    return out;
  }
  // Rockafellar-Uryasev expected shortfall: mean loss over the worst (1 - alpha) share of days, with a fractional weight on the
  // boundary day. A positive result is a loss fraction; null when the series is empty or holds a non-finite return.
  function histCvar(rets, alpha) {
    var a = alpha == null ? CVAR_ALPHA : alpha;
    if (!rets || !rets.length || !(a > 0 && a < 1)) return null;
    var n = rets.length, k = (1 - a) * n, loss = [], i, m, s = 0;
    for (i = 0; i < n; i++) { if (!isNum(rets[i])) return null; loss.push(-rets[i]); }
    loss.sort(function (x, y) { return y - x; });
    m = Math.min(Math.floor(k), n);
    for (i = 0; i < m; i++) s += loss[i];
    if (m < n) s += (k - m) * loss[m];
    return s / k + 0;
  }

  function avgCorr(corr, syms, set) {
    var idx = set.map(function (s) { return syms.indexOf(s); }).filter(function (i) { return i >= 0; }), s = 0, c = 0;
    for (var a = 0; a < idx.length; a++) for (var b = a + 1; b < idx.length; b++) { var v = corr[idx[a]][idx[b]]; if (v != null) { s += v; c++; } }
    return c ? s / c : null;
  }

  /* ---------- Fed, flows, semis, drawdown ---------- */
  var FED_STEP = { MAINTAIN: 0, HIKE25: 0.25, HIKEGT25: 0.5, CUT25: -0.25, CUTGT25: -0.5 };
  // prediction-market odds; each meeting quotes the move relative to today's rate, so only the next meeting is used
  function fedOdds(events, nowISO) {
    if (!Array.isArray(events)) return null;
    var fed = events.filter(function (e) { return /^FED\d{6}$/.test(e.ticker || '') && e.expiryDate && e.expiryDate.slice(0, 10) >= nowISO; })
      .sort(function (a, b) { return a.expiryDate < b.expiryDate ? -1 : 1; }).slice(0, 2);
    if (!fed.length) return null;
    var meetings = fed.map(function (e) {
      var pr = {}, tot = 0;
      (e.contracts || []).forEach(function (c) {
        if (!(c.ticker in FED_STEP)) return;
        var bid = c.prices && parseFloat(c.prices.bestBid), ask = c.prices && parseFloat(c.prices.bestAsk);
        var mid = isNum(bid) && isNum(ask) ? (bid + ask) / 2 : isNum(ask) ? ask / 2 : isNum(bid) ? bid : 0;
        pr[c.ticker] = mid; tot += mid;
      });
      if (tot <= 0) return null;
      var exp = 0; Object.keys(pr).forEach(function (k) { pr[k] /= tot; exp += pr[k] * FED_STEP[k]; });
      var exD = e.expiryDate.slice(0, 10), dec = FOMC.filter(function (f) { return f <= exD && (new Date(exD) - new Date(f)) / 864e5 <= 10; }).pop() || exD;
      return { ticker: e.ticker, date: dec, hike: r2((pr.HIKE25 || 0) + (pr.HIKEGT25 || 0)), hold: r2(pr.MAINTAIN || 0), cut: r2((pr.CUT25 || 0) + (pr.CUTGT25 || 0)), exp: r4(exp) };
    }).filter(Boolean);
    if (!meetings.length) return null;
    return { source: 'prediction markets', meetings: meetings, cumExp: meetings[0].exp };
  }
  // CME FedWatch via Firecrawl page extraction: {json:{meetings:[{date,hike,hold,cut}]}} in percent; next meeting only
  function fedWatchOdds(p, nowISO) {
    var j = p; if (typeof j === 'string') { try { j = JSON.parse(j); } catch (e) { return null; } }
    var ms = j && ((j.json && j.json.meetings) || (j.data && j.data.json && j.data.json.meetings) || j.meetings);
    if (!Array.isArray(ms) || !ms.length) return null;
    var m = ms[0], hike = +m.hike || 0, hold = +m.hold || 0, cut = +m.cut || 0, tot = hike + hold + cut;
    if (!(tot > 50 && tot < 150)) return null;
    hike /= tot; hold /= tot; cut /= tot;
    var d = new Date(m.date); var iso = isNaN(d) ? null : new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())).toISOString().slice(0, 10);
    var fomc = FOMC.filter(function (f) { return f >= nowISO; })[0];
    var exp = 0.25 * (hike - cut);
    return { source: 'CME FedWatch', meetings: [{ date: iso || fomc, hike: r2(hike), hold: r2(hold), cut: r2(cut), exp: r4(exp) }], cumExp: r4(exp) };
  }
  function parseBillions(x) { if (x == null) return null; var m = String(x).match(/([\d.]+)\s*([TBM])?/); if (!m) return null; var v = parseFloat(m[1]); return m[2] === 'T' ? v * 1000 : m[2] === 'M' ? v / 1000 : v; }
  // spot BTC ETF assets minus the price effect: a creation/redemption proxy, shown only
  function etfFlow(global, btcDaily) {
    var e = global && global.trad_fi_flows && global.trad_fi_flows.etf_aum && global.trad_fi_flows.etf_aum.btc;
    if (!e || !e.history || !btcDaily || btcDaily.length < 8) return null;
    var now = parseBillions(e.current), wk = parseBillions(e.history.last_week);
    if (!isNum(now) || !isNum(wk) || wk <= 0) return null;
    var p0 = btcDaily[btcDaily.length - 8].c, p1 = btcDaily[btcDaily.length - 1].c;
    var flow = now - wk * (p1 / p0);
    return { aum: r2(now), flowB: r2(flow), pct: r4(flow / wk) };
  }
  function semisZ(prices) {
    var a = prices.SMH, b = prices.VOO; if (!a || !b) return null;
    var mb = {}; b.forEach(function (x) { mb[x.d] = x.c; });
    var rs = a.filter(function (x) { return mb[x.d]; }).map(function (x) { return x.c / mb[x.d]; });
    if (rs.length < PARAMS.semisWindow) return null;
    var win = rs.slice(-PARAMS.semisWindow), m = mean(win), s = sd(win);
    return s > 0 ? r2((rs[rs.length - 1] - m) / s) : null;
  }
  // drawdown of the base plan over the available window (about one year; crypto before its last 100 days uses 3-day bars)
  function drawdownBudget(prices, longC) {
    var anchor = prices.VOO; if (!anchor || anchor.length < 60) return null;
    var dates = anchor.map(function (x) { return x.d; });
    function series(s) {
      var src = (longC[s] || []).concat(prices[s] || []).sort(function (a, b) { return a.d < b.d ? -1 : 1; });
      if (!src.length) return null;
      var out = [], last = null, j = 0;
      for (var i = 0; i < dates.length; i++) { while (j < src.length && src[j].d <= dates[i]) { last = src[j].c; j++; } out.push(last); }
      return out;
    }
    var cols = {}, wts = {}, tw = 0;
    ASSETS.forEach(function (a) { var c = series(a.s); if (c) { cols[a.s] = c; wts[a.s] = a.base; tw += a.base; } });
    var start = 0; for (var i = 0; i < dates.length; i++) { var ok = Object.keys(cols).every(function (s) { return cols[s][i] != null; }); if (ok) { start = i; break; } }
    var nav = [1];
    for (var t = start + 1; t < dates.length; t++) {
      var r = 0; Object.keys(cols).forEach(function (s) { r += wts[s] / tw * (cols[s][t] / cols[s][t - 1] - 1); }); nav.push(nav[nav.length - 1] * (1 + r));
    }
    if (nav.length < 40) return null;
    var peak = 1, maxDD = 0; nav.forEach(function (v) { peak = Math.max(peak, v); maxDD = Math.max(maxDD, 1 - v / peak); });
    var D = 1 - nav[nav.length - 1] / Math.max.apply(null, nav);
    var m = D <= PARAMS.ddDeadband ? 1 : Math.max(PARAMS.ddFloor, 1 - (1 - PARAMS.ddFloor) * (D - PARAMS.ddDeadband) / (PARAMS.ddMax - PARAMS.ddDeadband));
    return { D: r4(D), maxDD: r4(maxDD), m: r4(m), days: nav.length - 1, from: dates[start] };
  }

  /* ---------- RSPS regime: read weekly and daily verdicts from whatever shape TEXT TO QUANT returns ---------- */
  function regimeList(p) {
    if (!p) return [];
    var j = p;
    if (typeof j === 'string') { try { j = JSON.parse(j); } catch (e) { j = { text: p }; } }
    if (j && typeof j === 'object' && !Array.isArray(j.regimes)) { var t = textOf(j); if (t) { try { var jj = JSON.parse(t); if (jj && typeof jj === 'object') j = jj; } catch (e) {} } }
    var out = [], seen = {};
    function tfOf(x) { x = String(x).toLowerCase(); return /\b1w\b|week/.test(x) ? '1w' : /\b1d\b|daily|\bday\b/.test(x) ? '1d' : null; }
    function verdictOf(v) { var s0 = typeof v === 'string' ? v : v && typeof v === 'object' ? (v.verdict && typeof v.verdict === 'object' ? v.verdict.verdict : v.verdict || v.value || v.text || v.display || v.label || v.state) : null; var m = s0 && String(s0).toUpperCase().match(/\b(RUN|REVIEW|SKIP)\b/); return m ? m[1] : null; }
    function add(tf, v) { var k = tfOf(tf), vv = verdictOf(v); if (k && vv && !seen[k]) { seen[k] = 1; out.push({ timeframe: k, verdict: { verdict: vv } }); } }
    (function walk(o, depth) {
      if (!o || typeof o !== 'object' || depth > 6) return;
      if (Array.isArray(o)) { o.forEach(function (x) { walk(x, depth + 1); }); return; }
      var tf = o.timeframe != null ? o.timeframe : o.tf != null ? o.tf : o.interval != null ? o.interval : o.label != null ? o.label : o.title != null ? o.title : o.name;
      var v = o.verdict != null ? o.verdict : o.value != null ? o.value : o.state;
      if (tf != null && v != null) add(tf, v);
      Object.keys(o).forEach(function (k) { if (/^(1w|1d|weekly|daily)$/i.test(k)) add(k, o[k]); walk(o[k], depth + 1); });
    })(j, 0);
    if (!out.length) { var txt = typeof p === 'string' ? p : JSON.stringify(j); var re = /\b(1w|1d|weekly|daily)\b[^A-Za-z]{0,40}?(RUN|REVIEW|SKIP)\b/gi, m; while ((m = re.exec(txt))) add(m[1], m[2]); }
    return out;
  }

  /* ---------- macro scores, each in [-1, 1]; missing parts count as 0 and are never reweighted ---------- */
  function macroScores(inp, nowISO, notes, ext) {
    ext = ext || {};
    var out = { gold: 0, stocks: 0, crypto: 0, detail: {} }, D = out.detail;
    var m = inp.macro || {};
    var ffTerm = 0, semisTerm = ext.semisZ != null ? clamp(ext.semisZ / 1.5) : 0;
    if (ext.semisZ != null) D.semisZ = ext.semisZ;
    if (m.ff && m.ff.length > 6) { var ffl = m.ff[m.ff.length - 1].v, ff6 = m.ff[m.ff.length - 7].v; D.fedFunds = ffl; D.fedFundsChg6m = r2(ffl - ff6); ffTerm = ffl - ff6 > 0.1 ? -1 : ffl - ff6 < -0.1 ? 1 : 0; }
    if (ext.fed) { ffTerm = clamp(-ext.fed.cumExp / 0.25); D.fedSource = ext.fed.source; D.fedOdds = ext.fed; } else D.fedSource = m.ff && m.ff.length > 6 ? 'Fed funds 6-month change' : 'unavailable';
    D.fedTerm = r2(ffTerm);
    var y = null, y13 = null, lastD = nowISO;
    if (m.tsy10 && m.tsy10.length) {
      lastD = m.tsy10[m.tsy10.length - 1].d; y = m.tsy10[m.tsy10.length - 1].v; y13 = valueAtOrBefore(m.tsy10, shiftDays(lastD, -91));
      D.tsy10 = y; D.tsy10Chg3m = y13 != null ? r2(y - y13) : null;
      var levelTerm = y >= 5 ? -1 : y >= 4.5 ? -0.5 : y >= 4 ? 0 : 0.5;
      out.stocks = clamp(0.3 * clamp(-(D.tsy10Chg3m || 0) / 0.5) + 0.3 * levelTerm + 0.15 * ffTerm + 0.25 * semisTerm);
    } else {
      notes.push('Treasury yields unavailable: the stock macro score uses only the Fed and semis terms.');
      out.stocks = clamp(0.15 * ffTerm + 0.25 * semisTerm);
    }
    // real yield: market TIPS yield when available, otherwise the labeled CPI proxy
    var realChg = null;
    if (m.real && m.real.length >= 40) {
      var rl = m.real[m.real.length - 1], r3 = valueAtOrBefore(m.real, shiftDays(rl.d, -91));
      if (r3 != null) { D.realYield = rl.v; D.realYieldChg3m = r2(rl.v - r3); D.realSource = '10-year TIPS yield (FRED DFII10)'; realChg = rl.v - r3; }
    }
    if (realChg == null && y != null && m.cpi && m.cpi.length > 15) {
      var cpiNow = cpiYoY(m.cpi, lastD), cpiThen = cpiYoY(m.cpi, shiftDays(lastD, -91));
      if (cpiNow != null && cpiThen != null && y13 != null) { D.realYield = r2(y - cpiNow); D.realYieldChg3m = r2((y - cpiNow) - (y13 - cpiThen)); D.realSource = 'proxy: 10-year yield minus trailing CPI'; realChg = D.realYieldChg3m; }
    }
    if (m.cpi && m.cpi.length > 15) { var cy = cpiYoY(m.cpi, lastD); if (cy != null) D.cpiYoY = r2(cy); }
    out.gold = clamp((realChg != null ? 0.55 * clamp(-realChg / 0.5) : 0) + 0.3 * ffTerm - 0.15 * semisTerm);

    // crypto: price regime 0.6 and leverage 0.4; Fear & Greed and wallet positioning are shown, not used
    var c = 0, used = 0;
    var regs = regimeList(inp.regime);
    if (inp.regime && !regs.length) { D.regimeUnread = true; notes.push('TEXT TO QUANT answered, but no weekly or daily verdict could be read from its response: crypto regime counts as 0.'); }
    if (regs.length) {
      var map = { RUN: 1, REVIEW: 0, SKIP: -1 }, val = {};
      regs.forEach(function (r) { val[r.timeframe] = map[r.verdict && r.verdict.verdict] || 0; });
      D.regime1w = regs.filter(function (r) { return r.timeframe === '1w'; }).map(function (r) { return r.verdict.verdict; })[0] || null;
      D.regime1d = regs.filter(function (r) { return r.timeframe === '1d'; }).map(function (r) { return r.verdict.verdict; })[0] || null;
      c += 0.6 * (0.6 * (val['1w'] || 0) + 0.4 * (val['1d'] || 0)); used++;
    }
    if (inp.global) {
      var g = inp.global, fg = g.sentiment && g.sentiment.fear_greed && g.sentiment.fear_greed.current && g.sentiment.fear_greed.current.index;
      if (isNum(fg)) D.fearGreed = fg;
      var oi = pctField(g.leverage && g.leverage.open_interest && g.leverage.open_interest.total && g.leverage.open_interest.total.percent_change && g.leverage.open_interest.total.percent_change['30d']);
      var mc = pctField(g.market_size && g.market_size.total_crypto_market_cap_usd && g.market_size.total_crypto_market_cap_usd.percent_change && g.market_size.total_crypto_market_cap_usd.percent_change['30d']);
      // a 30-day change beyond 150% either way is treated as a bad reading, not a market move
      if ((oi != null && Math.abs(oi) > 150) || (mc != null && Math.abs(mc) > 150)) {
        D.oiFlag = 'inconsistent'; notes.push('CoinMarketCap 30-day change looked implausible (open interest ' + oi + '%, market cap ' + mc + '%): leverage term set to 0.'); oi = null;
      }
      if (oi != null) {
        D.oi30d = oi; if (mc != null) D.mcap30d = mc;
        var net = oi - (mc != null ? mc : 0); D.oiNet30d = r2(net);
        var levS = net > 20 ? -1 : net > 10 ? -0.5 : net < -10 ? 0.5 : 0; c += 0.4 * levS; used++;
      }
      var dom = g.dominance && g.dominance.btc && g.dominance.btc.current; if (dom) D.btcDominance = pctField(dom);
      var alt = g.rotation && g.rotation.altcoin_season && g.rotation.altcoin_season.current && g.rotation.altcoin_season.current.index; if (isNum(alt)) D.altSeason = alt;
    }
    if (inp.bias && Array.isArray(inp.bias.tiers)) {
      var L = 0, S = 0, crowd = null;
      inp.bias.tiers.forEach(function (t) {
        if (t.tier === 'money_printer' || t.tier === 'smart_money') { L += t.longNotional || 0; S += t.shortNotional || 0; }
        if (t.tier === 'exit_liquidity') crowd = t.netBiasByNotional;
      });
      if (L + S > 0 && crowd != null) { D.smartBias = r2((L - S) / (L + S)); D.crowdBias = r2(crowd); }
    }
    out.crypto = clamp(c);
    if (!used) notes.push('Crypto regime and leverage unavailable: crypto macro score set to neutral.');
    out.gold = r2(out.gold); out.stocks = r2(out.stocks); out.crypto = r2(out.crypto);
    return out;
  }

  /* ---------- signals ---------- */
  function assetSignal(a, prices, longC) {
    var o = { T: 0, M: 0, S: 0, ok: false }, dv = DEFAULT_VOL[a.s];
    if (a.kind === 'eq') {
      var cl = prices[a.s] ? prices[a.s].map(function (x) { return x.c; }) : null;
      if (cl && cl.length >= 220) {
        var n = cl.length, p = cl[n - 1], sma = smaAt(cl, 200, 0), smaPrev = smaAt(cl, 200, 20);
        var vol = annVol(cl, 63, 252) || dv, ve = Math.max(vol, PARAMS.volFloor * dv);
        var trendLog = Math.log(p / sma), momLog = Math.log(cl[n - 22] / cl[n - 127]);
        o = { ok: true, p: p, sma: sma, slope: sma - smaPrev, vol: vol, volEff: ve, dist: trendLog, mom: momLog,
          T: clamp(trendLog / (ve * Math.sqrt(PARAMS.trendH.eq))), M: clamp(momLog / (ve * Math.sqrt(PARAMS.momH.eq))) };
      }
    } else {
      var lc = longC[a.s] ? longC[a.s].map(function (x) { return x.c; }) : null, dd = prices[a.s];
      if (lc && lc.length >= 77) {
        var m = lc.length, sma3 = smaAt(lc, 70, 0), smaPrev3 = smaAt(lc, 70, 7);
        var pNow = dd && dd.length ? dd[dd.length - 1].c : lc[m - 1];
        var dcl = dd ? dd.map(function (x) { return x.c; }) : null;
        var vol2 = annVol(dcl, 63, 365) || (lc.length > 40 ? annVol(lc, 42, 365 / 3) : null) || dv, ve2 = Math.max(vol2, PARAMS.volFloor * dv);
        var tl = Math.log(pNow / sma3), ml = Math.log(lc[m - 8] / lc[m - 43]);
        o = { ok: true, p: pNow, sma: sma3, slope: sma3 - smaPrev3, vol: vol2, volEff: ve2, dist: tl, mom: ml,
          T: clamp(tl / (ve2 * Math.sqrt(PARAMS.trendH.cx))), M: clamp(ml / (ve2 * Math.sqrt(PARAMS.momH.cx))) };
      }
    }
    o.S = o.ok ? 0.5 * o.T + 0.5 * o.M : 0;
    return o;
  }

  /* ---------- sleeve projection: exact, sleeve totals clamped to their bands and summing to 100 ---------- */
  function sleeveLimits(sl) { return [SLEEVES[sl] - SLEEVE_BAND[sl][0], SLEEVES[sl] + SLEEVE_BAND[sl][1]]; }
  function projectSleeves(w) {
    var tot = { gold: 0, stocks: 0, crypto: 0 };
    ASSETS.forEach(function (a) { tot[a.sleeve] += w[a.s]; });
    function f(k) { var s = 0; Object.keys(tot).forEach(function (sl) { var L = sleeveLimits(sl); s += clamp(k * tot[sl], L[0], L[1]); }); return s; }
    var lo = 0, hi = 10; for (var it = 0; it < 200; it++) { var mid = (lo + hi) / 2; if (f(mid) < 100) lo = mid; else hi = mid; }
    var k = (lo + hi) / 2, out = {};
    var tgt = {}; Object.keys(tot).forEach(function (sl) { var L = sleeveLimits(sl); tgt[sl] = clamp(k * tot[sl], L[0], L[1]); });
    var s = sum(tgt); Object.keys(tgt).forEach(function (sl) { tgt[sl] *= 100 / s; });
    ASSETS.forEach(function (a) { out[a.s] = tot[a.sleeve] > 0 ? w[a.s] * tgt[a.sleeve] / tot[a.sleeve] : 0; });
    return out;
  }

  /* ---------- closed-form crypto risk-share repair (crypto scaled by a, freed weight to cash) ---------- */
  function cryptoScale(w, C, q) {
    var n = {}, k = {}; SYMS.forEach(function (s) { n[s] = CRYPTO.indexOf(s) >= 0 ? 0 : w[s] / 100; k[s] = CRYPTO.indexOf(s) >= 0 ? w[s] / 100 : 0; });
    function quad(x, y) { var s = 0; for (var i = 0; i < SYMS.length; i++) for (var j = 0; j < SYMS.length; j++) s += x[SYMS[i]] * C[i][j] * y[SYMS[j]]; return s; }
    var A = quad(k, k), B = quad(k, n), Cc = quad(n, n);
    if (A <= 1e-14) return 1;
    var V1 = A + 2 * B + Cc; if (V1 <= 1e-14) return 1;
    if ((A + B) / V1 <= q) return 1;
    if (Cc <= 1e-14) return 0;
    var K = (1 - q) * A, L = (1 - 2 * q) * B, disc = Math.sqrt(L * L + 4 * K * q * Cc);
    var root = L >= 0 ? 2 * q * Cc / (disc + L) : (-L + disc) / (2 * K);
    return clamp(root, 0, 1);
  }

  /* ---------- the constraint pipeline: every step after the projection only moves money down or to cash ---------- */
  function enforce(p, ctx) {
    var w = {}, cash = 0, by = { capacity: 0, gate: 0, cryptoRisk: 0, vol: 0, drawdown: 0 }, cut = {}, log = [];
    SYMS.forEach(function (s) { w[s] = p[s]; cut[s] = 0; });
    var ub = ctx.ubBallast || {}, uc = ctx.ubCash || {};
    // 1. upper bounds whose excess is redeployed to ballast
    var Eb = 0; SYMS.forEach(function (s) { if (ub[s] != null && w[s] > ub[s]) { var e = w[s] - ub[s]; w[s] = ub[s]; cut[s] += e; Eb += e; } });
    // 2. NVDA look-through: moving NVDA into VOO lowers look-through by 0.92 per point, so the transfer is excess / 0.92
    function look() { return w.NVDA * LOOK.NVDA + w.VOO * LOOK.VOO + w.SMH * LOOK.SMH; }
    var L0 = look();
    if (L0 > PARAMS.nvdaLookCap + 1e-12) {
      var need = (L0 - PARAMS.nvdaLookCap) / (1 - LOOK.VOO), x = Math.min(w.NVDA, need);
      var roomV = ub.VOO != null ? Math.max(0, ub.VOO - w.VOO) : Infinity, toV = Math.min(x, roomV);
      w.NVDA -= x; cut.NVDA += x; w.VOO += toV; cash += x - toV; by.capacity += x - toV;
      log.push('NVDA look-through ' + r2(L0) + '% above ' + PARAMS.nvdaLookCap + '%: moved ' + r2(x) + ' points of NVDA into VOO.');
      var L1 = look(); if (L1 > PARAMS.nvdaLookCap + 1e-12) { var y = Math.min(w.SMH, (L1 - PARAMS.nvdaLookCap) / LOOK.SMH); w.SMH -= y; cut.SMH += y; cash += y; by.capacity += y; }
    }
    // 3. ballast fill, limited by the stock and gold sleeve ceilings and the look-through room
    if (Eb > 1e-12) {
      var st = sum(w, ['VOO', 'SMH', 'NVDA', 'MSFT', 'TSM', 'XLE']), go = w.IAUM + w.GDX;
      var capV = Math.max(0, Math.min(sleeveLimits('stocks')[1] - st, (PARAMS.nvdaLookCap - look()) / LOOK.VOO, ub.VOO != null ? ub.VOO - w.VOO : Infinity));
      var capG = Math.max(0, Math.min(sleeveLimits('gold')[1] - go, ub.IAUM != null ? ub.IAUM - w.IAUM : Infinity));
      var addV = Math.min(Eb * PARAMS.ballast.VOO, capV), addG = Math.min(Eb * PARAMS.ballast.IAUM, capG);
      var left = Eb - addV - addG, extraV = Math.min(left, capV - addV); addV += extraV; left -= extraV;
      var extraG = Math.min(left, capG - addG); addG += extraG; left -= extraG;
      w.VOO += addV; w.IAUM += addG;
      if (left > 1e-9) { cash += left; by.capacity += left; log.push('Ballast was full (sleeve ceilings): ' + r2(left) + ' points went to cash instead of VOO and gold.'); }
    }
    // 4. gate bounds whose excess goes to cash
    SYMS.forEach(function (s) { if (uc[s] != null && w[s] > uc[s]) { var e = w[s] - uc[s]; w[s] = uc[s]; cut[s] += e; cash += e; by.gate += e; } });
    // 5. crypto share of risk, under every covariance scenario: smallest admissible scale wins
    var aStar = 1;
    if (ctx.cryptoCap != null) (ctx.shareScenarios || []).forEach(function (C) { aStar = Math.min(aStar, cryptoScale(w, C, ctx.cryptoCap)); });
    if (aStar < 1 - 1e-9) {
      var fr = 0; CRYPTO.forEach(function (s) { var e = w[s] * (1 - aStar); w[s] -= e; cut[s] += e; fr += e; }); cash += fr; by.cryptoRisk += fr;
      log.push('Crypto carried more than ' + Math.round(ctx.cryptoCap * 100) + '% of risk: crypto scaled to ' + r2(aStar * 100) + '% of its weight, ' + r2(fr) + ' points to cash.');
    }
    // 6. volatility ceiling: uniform scale of every risky holding (keeps risk shares and every upper bound)
    var sv = 1;
    if (ctx.volCap != null && ctx.volC) { var vv = portRisk(w, SYMS, ctx.volC).vol; if (vv > ctx.volCap) sv = ctx.volCap / vv; }
    if (sv < 1 - 1e-9) { var fr2 = 0; SYMS.forEach(function (s) { var e = w[s] * (1 - sv); w[s] -= e; cut[s] += e; fr2 += e; }); cash += fr2; by.vol += fr2; log.push('Volatility above ' + Math.round(ctx.volCap * 100) + '%: every holding scaled to ' + r2(sv * 100) + '%, ' + r2(fr2) + ' points to cash.'); }
    // 7. optional drawdown overlay
    if (ctx.ddMult != null && ctx.ddMult < 1) { var fr3 = 0; SYMS.forEach(function (s) { var e = w[s] * (1 - ctx.ddMult); w[s] -= e; cut[s] += e; fr3 += e; }); cash += fr3; by.drawdown += fr3; }
    return { w: w, cash: cash, by: by, cut: cut, aStar: aStar, volScale: sv, log: log };
  }

  /* ---------- final verification ---------- */
  function verify(w, cash, ctx) {
    var tol = 1e-6, out = [], sl = { stocks: 0, gold: 0, crypto: 0 };
    ASSETS.forEach(function (a) { sl[a.sleeve] += w[a.s]; });
    var neg = SYMS.filter(function (s) { return w[s] < -tol; }); out.push({ k: 'No negative weights', v: neg.length, lim: 0, ok: !neg.length && cash >= -tol });
    var bad = SYMS.filter(function (s) { return !isNum(w[s]); }); out.push({ k: 'All weights are finite numbers', v: bad.length, lim: 0, ok: !bad.length && isNum(cash) });
    var tot = sum(w) + cash; out.push({ k: 'Weights plus cash = 100%', v: r4(tot), lim: 100, ok: Math.abs(tot - 100) < 1e-6 });
    out.push({ k: 'BTC at most 10%', v: r2(w.BTC), lim: 10, ok: w.BTC <= 10 + tol });
    ['stocks', 'gold', 'crypto'].forEach(function (k) { var L = sleeveLimits(k); out.push({ k: k.charAt(0).toUpperCase() + k.slice(1) + ' at most ' + L[1] + '%', v: r2(sl[k]), lim: L[1], ok: sl[k] <= L[1] + tol }); });
    var lk = w.NVDA + LOOK.VOO * w.VOO + LOOK.SMH * w.SMH; out.push({ k: 'NVDA look-through at most 10%', v: r2(lk), lim: 10, ok: lk <= 10 + tol });
    SYMS.forEach(function (s) { var u = Math.min(ctx.ubBallast[s] != null ? ctx.ubBallast[s] : Infinity, ctx.ubCash[s] != null ? ctx.ubCash[s] : Infinity); if (u < Infinity && s !== 'BTC') out.push({ k: s + ' within its gate limit', v: r2(w[s]), lim: r2(u), ok: w[s] <= u + tol }); });
    if (ctx.cryptoCap != null) ctx.shareScenarios.forEach(function (C, i) { var rk = portRisk(w, SYMS, C); var sh = rk.v > 1e-12 ? cryptoShareOf(rk) : 0; out.push({ k: 'Crypto share of risk at most ' + Math.round(ctx.cryptoCap * 100) + '% (' + (i ? 'EWMA' : 'base') + ' model)', v: r4(sh), lim: ctx.cryptoCap, ok: sh <= ctx.cryptoCap + 1e-6 }); });
    if (ctx.volCap != null) { var vb = portRisk(w, SYMS, ctx.volC).vol; out.push({ k: 'Volatility at most ' + Math.round(ctx.volCap * 100) + '% (base model)', v: r4(vb), lim: ctx.volCap, ok: vb <= ctx.volCap + 1e-6 }); }
    ['stocks', 'gold', 'crypto'].forEach(function (k) { var L = sleeveLimits(k); var met = sl[k] >= L[0] - 1e-6; out.push({ k: k.charAt(0).toUpperCase() + k.slice(1) + ' at least ' + L[0] + '%', v: r2(sl[k]), lim: L[0], ok: true, relaxed: !met, note: met ? null : 'relaxed: money moved to cash by a gate or risk control' }); });
    return out;
  }

  /* ---------- risk budgeting (Roncalli CCD) and clustering for the shadow portfolios ---------- */
  function riskBudget(C, b) {
    var n = b.length, y = []; for (var i = 0; i < n; i++) y.push(1 / Math.sqrt(C[i][i]));
    for (var it = 0; it < 500; it++) {
      var maxd = 0;
      for (var k = 0; k < n; k++) {
        var c = 0; for (var j = 0; j < n; j++) if (j !== k) c += C[k][j] * y[j];
        var disc = Math.sqrt(c * c + 4 * C[k][k] * b[k]);
        var ny = c > 0 ? 2 * b[k] / (disc + c) : (-c + disc) / (2 * C[k][k]);   // stable form when c > 0
        maxd = Math.max(maxd, Math.abs(ny - y[k]) / (y[k] || 1)); y[k] = ny;
      }
      if (maxd < 1e-10) break;
    }
    var tot = y.reduce(function (s, v) { return s + v; }, 0);
    return y.map(function (v) { return v / tot; });
  }
  function clusterAssets(corr, syms, K) {
    var groups = syms.map(function (s, i) { return [i]; });
    function dist(i, j) { return Math.sqrt(Math.max(0, 2 * (1 - corr[i][j]))); }
    while (groups.length > K) {
      var best = null;
      for (var a = 0; a < groups.length; a++) for (var b = a + 1; b < groups.length; b++) {
        var s = 0, c = 0; groups[a].forEach(function (i) { groups[b].forEach(function (j) { s += dist(i, j); c++; }); });
        var d = s / c; if (!best || d < best.d) best = { a: a, b: b, d: d };
      }
      groups[best.a] = groups[best.a].concat(groups[best.b]); groups.splice(best.b, 1);
    }
    return groups.map(function (g) { return g.map(function (i) { return syms[i]; }); });
  }

  /* ---------- holdings: units x latest price ---------- */
  function markHoldings(h, prices, longC) {
    if (!h || !h.units) return null;
    var val = {}, missingPx = [], tot = 0;
    SYMS.forEach(function (s) {
      var u = +h.units[s] || 0; if (!u) { val[s] = 0; return; }
      var ser = prices[s] && prices[s].length ? prices[s] : longC[s];
      var px = ser && ser.length ? ser[ser.length - 1].c : (h.px && h.px[s]) || null;
      if (!px) { missingPx.push(s); val[s] = 0; return; }
      val[s] = u * px; tot += val[s];
    });
    var cash = Math.max(0, +h.cash || 0); tot += cash;
    if (tot <= 0) return null;
    var pctW = {}; SYMS.forEach(function (s) { pctW[s] = val[s] / tot * 100; });
    return { total: tot, value: val, pct: pctW, cashPct: cash / tot * 100, cash: cash, missingPx: missingPx, asOf: h.asOf || null };
  }

  /* ---------- input records and run status: fail closed ---------- */
  // quality states from the October 16 technical whitepaper: observed, delayed, missing, inconsistent, proxy
  function gradeInput(r, nowISO) {
    var o = Object.assign({}, r);
    o.ageDays = o.observedAt ? Math.max(0, Math.round((new Date(nowISO.slice(0, 10)) - new Date(o.observedAt.slice(0, 10))) / 864e5)) : null;
    var old = !!o.tooOld || (o.hardAgeDays != null && o.ageDays != null && o.ageDays > o.hardAgeDays);
    o.quality = !o.have ? 'missing' : o.inconsistent ? 'inconsistent' : o.proxy ? 'proxy'
      : (o.fallback || old || (o.maxAgeDays != null && o.ageDays != null && o.ageDays > o.maxAgeDays)) ? 'delayed' : 'observed';
    o.tooOld = old;
    o.blocks = o.role === 'critical' && (o.quality === 'missing' || o.quality === 'inconsistent' || old);
    return o;
  }
  // invalid when a required input, the gate, the risk model or a final check fails; degraded when an optional input is not observed
  function assessRun(evidence, ctx) {
    var blockers = [], degraded = [], blockedAsset = {}, gateBlocked = false;
    evidence.forEach(function (r) {
      if (r.blocks) {
        blockers.push(r.label + ' ' + (r.quality === 'missing' ? 'missing' : r.quality === 'inconsistent' ? 'inconsistent' : 'too old' + (r.ageDays != null ? ' (' + r.ageDays + ' days)' : '')));
        if (r.asset) blockedAsset[r.asset] = 1;
        if (r.id === 'btcMonthly') gateBlocked = true;
      } else if (r.role !== 'shown' && r.quality !== 'observed') degraded.push(r.label + ' ' + r.quality);
    });
    var miss = ctx.missing.filter(function (s) { return !blockedAsset[s]; });
    if (miss.length) blockers.push('Too little price history for a signal: ' + miss.join(', '));
    if (ctx.gateUnchecked && !gateBlocked) blockers.push('Monthly BTC gate could not be evaluated');
    if (!ctx.riskOk) blockers.push('Risk model lacked aligned daily returns');
    if (!ctx.checksOk) blockers.push('Final constraint check failed');
    return { status: blockers.length ? 'invalid' : degraded.length ? 'degraded' : 'valid', blockers: blockers, degraded: degraded };
  }

  /* ---------- main ---------- */
  function compute(inp, prev, ref, opts) {
    if (ref === undefined) ref = prev;
    opts = Object.assign({}, DEFAULT_OPTS, inp.policy || {}, opts || {});
    var mw = opts.macro ? (opts.macroWeight != null ? opts.macroWeight : PARAMS.macroWeight) : 0;
    var nowISO = (inp.now || new Date().toISOString()).slice(0, 10);
    var notes = [], missing = [], syms = SYMS;
    var prices = inp.prices || {}, longC = inp.cryptoLong || {};
    var fed = inp.predictions ? fedOdds(inp.predictions, nowISO) : (inp.fedwatch ? fedWatchOdds(inp.fedwatch, nowISO) : null);
    var sz = semisZ(prices);
    var macro = macroScores(inp, nowISO, notes, { fed: fed, semisZ: sz });
    if (mw > 0 && sz != null && Math.abs(sz) >= 1.5) notes.push('Semis ' + (sz > 0 ? 'leading' : 'lagging') + ' the S&P 500 (z ' + sz + '): stock macro score ' + (sz > 0 ? 'raised' : 'lowered') + '.');

    // 1. signals and capital tilt; a missing signal means no tilt at all
    var sig = {};
    ASSETS.forEach(function (a) {
      var o = assetSignal(a, prices, longC);
      if (!o.ok) missing.push(a.s);
      o.z = o.ok && opts.signals ? (1 - mw) * o.S + mw * macro[a.sleeve] : 0;
      o.mult = clamp(Math.exp(PARAMS.kappa * o.z), PARAMS.multMin, PARAMS.multMax);
      sig[a.s] = o;
    });
    var raw = {}; ASSETS.forEach(function (a) { raw[a.s] = a.base * sig[a.s].mult; });
    var rs = sum(raw); SYMS.forEach(function (s) { raw[s] *= 100 / rs; });

    // 2. gate states, read from prices before any weight is set
    var gates = { alts: {} };
    gates.altsReading = {}; gates.altGateOn = !!opts.altGate;
    ALTS.forEach(function (s) { var o = sig[s], below = o.ok && o.p < o.sma && o.slope < 0; gates.altsReading[s] = below ? 'below' : 'clear'; gates.alts[s] = opts.altGate && below ? 'halved' : 'clear'; });
    var flow = etfFlow(inp.global, prices.BTC);
    var lb = longC.BTC, bd = prices.BTC;
    if (lb && lb.length >= 70 && bd && bd.length >= 31) {
      var smaB = mean(lb.slice(-70).map(function (x) { return x.c; }));
      var pB = bd[bd.length - 1].c, sd30 = sd(logRets(bd.slice(-31).map(function (x) { return x.c; })));
      var zB = Math.log(pB / smaB) / (sd30 * Math.sqrt(30)), SB = Phi(zB);
      var reading = SB >= PARAMS.gradedWarn ? 'clear' : SB >= PARAMS.gradedCut ? 'trim' : 'cut';
      gates.graded = { S: r2(SB), z: r2(zB), sma210: Math.round(smaB), price: Math.round(pB), sigma30: r4(sd30 * Math.sqrt(30)), flow: flow, reading: reading, on: !!opts.gradedGate, level: opts.gradedGate ? reading : 'off' };
    } else gates.graded = { level: null, reading: null, on: !!opts.gradedGate, flow: flow };
    var bm = inp.btcMonthly ? monthEndCloses(inp.btcMonthly, nowISO) : null;
    var GM = PARAMS.gateMonths;
    if (bm && bm.length >= GM) {
      var last10 = bm.slice(-GM), sma10 = mean(last10.map(function (x) { return x.c; })), lastM = last10[last10.length - 1];
      gates.btc = { on: opts.monthlyGate ? lastM.c >= sma10 : null, raw: lastM.c >= sma10, month: lastM.m, close: Math.round(lastM.c), sma10: Math.round(sma10), live: sig.BTC.p ? Math.round(sig.BTC.p) : null };
    } else { gates.btc = { on: null }; if (opts.monthlyGate) notes.push('BTC monthly closes unavailable: gate not evaluated this run.'); }
    var gradedLevel = gates.graded.level;
    if (flow && flow.pct < PARAMS.flowThreshold) notes.push('Implied spot BTC ETF outflow of ' + Math.abs(flow.flowB) + 'B last week (shown only; it no longer moves the gate).');

    // 3. smoothing of the signal tilt, before any constraint, against the raw tilt of a run 3 to 21 days old
    var smoothed = false, pre = Object.assign({}, raw);
    if (opts.smoothing && prev && prev.preRaw && prev.asOf) {
      var age = (new Date(nowISO) - new Date(prev.asOf.slice(0, 10))) / 864e5;
      var flip = (prev.gates && prev.gates.btc && prev.gates.btc.on !== gates.btc.on) || (prev.gates && prev.gates.graded && prev.gates.graded.level !== gates.graded.level);
      if (age >= 3 && age <= PARAMS.smoothDays && !flip) { SYMS.forEach(function (s) { pre[s] = PARAMS.smooth * raw[s] + (1 - PARAMS.smooth) * (prev.preRaw[s] || 0); }); smoothed = true; }
    }
    var p = projectSleeves(pre);

    // 4. upper bounds: one bound per asset, the tightest wins; halvings never multiply
    var ubB = { BTC: ASSET_CAP.BTC }, ubC = {};
    ALTS.forEach(function (s) { if (gates.alts[s] === 'halved') ubB[s] = Math.min(ubB[s] != null ? ubB[s] : Infinity, 0.5 * p[s]); });
    var monthlyOff = gates.btc.on === false;
    if (!monthlyOff && gradedLevel === 'trim') {
      var f = 0.5 + 0.5 * (gates.graded.S - PARAMS.gradedCut) / (PARAMS.gradedWarn - PARAMS.gradedCut);
      ALTS.forEach(function (s) { ubB[s] = Math.min(ubB[s] != null ? ubB[s] : Infinity, f * p[s]); });
      notes.push('Trend-distance gate at ' + gates.graded.S + ': alts capped at ' + Math.round(f * 100) + '% of their target, freed weight to VOO and gold.');
    }
    if (monthlyOff || (gradedLevel === 'cut')) {
      ALTS.forEach(function (s) { ubC[s] = 0; }); ubC.BTC = 0.5 * Math.min(p.BTC, ASSET_CAP.BTC);
      notes.push(monthlyOff ? 'BTC gate OFF: alts sold, BTC halved, proceeds to your interest accounts.' : 'Trend-distance gate below ' + PARAMS.gradedCut + ': alts sold and BTC halved ahead of the month-end close, proceeds to your interest accounts.');
    }
    var hold = markHoldings(inp.holdings, prices, longC);
    if (hold) missing.forEach(function (s) { if (hold.missingPx.indexOf(s) < 0) ubB[s] = Math.min(ubB[s] != null ? ubB[s] : Infinity, Math.max(hold.pct[s], 0)); });

    // 5. risk model and correlation stress
    var RM = riskModel(prices, longC, syms);
    var avgE = avgCorr(RM.Rraw.ewma, syms, RISK_SET), avgS = avgCorr(RM.Rraw.sample, syms, RISK_SET);
    var spike = avgE != null && avgS != null && avgE - avgS > PARAMS.stressThreshold && avgE > 0.4;
    var cryptoCap = spike ? PARAMS.cryptoRiskCapStress : PARAMS.cryptoRiskCap;
    if (spike && opts.cryptoCap) notes.push('Correlation spike: risk assets now move together (EWMA ' + r2(avgE) + ' vs ' + r2(avgS) + ' over 63 days). Crypto risk cap tightened to ' + cryptoCap * 100 + '%.');
    var dd = drawdownBudget(prices, longC);

    // 6. enforce, then verify
    var ctx = { ubBallast: ubB, ubCash: ubC, cryptoCap: opts.cryptoCap ? cryptoCap : null, shareScenarios: [RM.Cbase, RM.Cewma],
      volCap: opts.volCap ? PARAMS.volCap : null, volC: RM.Cbase, ddMult: opts.ddOverlay && dd ? dd.m : null };
    var E = enforce(p, ctx), w = E.w, outside = E.cash;
    notes = notes.concat(E.log);
    if (opts.ddOverlay && dd && dd.m < 1) notes.push('Drawdown overlay: base plan is ' + r2(dd.D * 100) + '% below its peak, risk scaled to ' + r2(dd.m * 100) + '%.');
    var checks = verify(w, outside, ctx);
    var failed = checks.filter(function (c) { return !c.ok; });
    if (failed.length) notes.push('Constraint check failed: ' + failed.map(function (c) { return c.k; }).join(', ') + '.');
    var relaxed = checks.filter(function (c) { return c.relaxed; }).map(function (c) { return c.k; });
    var rk = portRisk(w, syms, RM.Cbase), rkE = portRisk(w, syms, RM.Cewma);

    // 6b. run status: a required input, the gate, the risk model or a failed check blocks every action;
    //     an optional input that is missing, delayed or a proxy only degrades the run
    var D0 = macro.detail || {};
    var evidence = (inp.evidence || []).map(function (r) {
      var o = Object.assign({}, r);
      if (o.id === 'real' && D0.realSource && /proxy/.test(D0.realSource)) { o.have = true; o.proxy = true; o.note = '10-year yield minus trailing CPI stands in for the TIPS yield'; }
      if (o.id === 'fed' && !fed && D0.fedSource === 'Fed funds 6-month change') { o.have = true; o.proxy = true; o.note = 'Fed funds 6-month change stands in for FedWatch odds; it looks back, not ahead'; }
      if (o.id === 'regime' && D0.regimeUnread) { o.inconsistent = true; o.note = 'answered, but no weekly or daily verdict was readable'; }
      if (o.id === 'oi' && D0.oiFlag) { o.inconsistent = true; o.note = 'implausible 30-day change, excluded'; }
      else if (o.id === 'oi' && D0.oi30d == null) o.have = false;
      return gradeInput(o, nowISO);
    });
    // every risk number the run publishes must be finite: a constant or zero price series gives NaN in the correlations or the drawdown
    var riskFinite = isNum(rk.vol) && isNum(rkE.vol) && (!dd || (isNum(dd.D) && isNum(dd.maxDD) && isNum(dd.m)));
    var heldMissing = missing.filter(function (s) { return ASSETS[SYMS.indexOf(s)].base > 0; });   // a holding with no base weight cannot block the run
    var status = assessRun(evidence, { missing: heldMissing, gateUnchecked: !!opts.monthlyGate && gates.btc.on == null, riskOk: !!RM.ar && riskFinite, checksOk: !failed.length });
    var blocked = status.status === 'invalid';
    if (blocked) notes.push('Fail closed: ' + status.blockers.length + ' blocker' + (status.blockers.length > 1 ? 's' : '') + ', so this run gives no actionable targets.');

    // 7. actions: against marked holdings when entered, else the latest run, else the base plan
    var basis = hold ? 'holdings' : ref && ref.weights ? 'last run' : 'base plan', actions = {};
    ASSETS.forEach(function (a) {
      var rv = hold ? hold.pct[a.s] : ref && ref.weights ? (ref.weights[a.s] || 0) : a.base, d = w[a.s] - rv, band = Math.max(PARAMS.bandAbs, PARAMS.bandRel * rv);
      var forced = d < -0.05 && E.cut[a.s] > 0.05;   // reductions forced by a gate or risk control are never held back by the band
      var act = blocked ? 'Blocked' : d > band ? 'Add' : (d < -band || forced) ? 'Trim' : 'Hold';
      actions[a.s] = { ref: r2(rv), diff: r2(d), act: act, forced: !blocked && forced && d >= -band, usd: hold && !blocked ? Math.round(d / 100 * hold.total) : null };
    });
    var cashRef = hold ? hold.cashPct : ref && ref.outside != null ? ref.outside : 0;
    actions.CASH = { ref: r2(cashRef), diff: r2(outside - cashRef), usd: hold && !blocked ? Math.round((outside - cashRef) / 100 * hold.total) : null };

    // 8. events and posture
    var events = FOMC.filter(function (fd) { var dd2 = (new Date(fd) - new Date(nowISO)) / 864e5; return dd2 >= 0 && dd2 <= 14; });
    if (events.length) notes.push('FOMC decision ' + events[0] + ': stage new gold and SMH buys after the announcement.');
    var avgMacro = (macro.stocks + macro.crypto + macro.gold) / 3, posture;
    var defending = monthlyOff || gradedLevel === 'cut' || spike || E.by.cryptoRisk > 0.05 || E.by.vol > 0.05 || E.by.drawdown > 0.05;
    if (defending) posture = { de: 'Hinhaltender Widerstand', en: 'Delaying defense: risk is being pulled back' };
    else if (avgMacro <= -0.3) posture = { de: 'Elastische Verteidigung', en: 'Elastic defense: hold core, tilt toward ballast' };
    else if (avgMacro >= 0.3) posture = { de: 'Bewegungskrieg', en: 'Maneuver: conditions favor adding risk' };
    else posture = { de: 'Zeitgewinn', en: 'Gaining time: stage entries, no big moves' };
    if (blocked) posture = { de: 'Lage unklar', en: 'Situation unclear: a required input or check failed, so this run gives no actionable targets' };

    var sleeves = { gold: 0, stocks: 0, crypto: 0 }; ASSETS.forEach(function (a) { sleeves[a.sleeve] += w[a.s]; });
    var mctr = {}; syms.forEach(function (x, i) { mctr[x] = rk.vol > 0 ? r4(rk.Cw[i] / rk.vol) : 0; });

    // 9. shadows: equal risk, cluster risk parity, and the same pipeline with macro switched off
    var shadows = null, clusters = null;
    if (opts.shadows) {
      clusters = clusterAssets(RM.Rsample, syms, 3);
      var shadow = function (b) {
        var wv = riskBudget(RM.Cbase, b), ws = {}; syms.forEach(function (x, i) { ws[x] = r2(wv[i] * 100); });
        var rr = portRisk(ws, syms, RM.Cbase), sl = { gold: 0, stocks: 0, crypto: 0 }; ASSETS.forEach(function (a) { sl[a.sleeve] += ws[a.s]; });
        return { weights: ws, vol: r4(rr.vol), cryptoShare: r4(cryptoShareOf(rr)), sleeves: { gold: r2(sl.gold), stocks: r2(sl.stocks), crypto: r2(sl.crypto) } };
      };
      var bERC = syms.map(function () { return 1 / syms.length; });
      var bCRP = syms.map(function (x) { var g = clusters.filter(function (c) { return c.indexOf(x) >= 0; })[0]; return 1 / (clusters.length * g.length); });
      shadows = { erc: shadow(bERC), crp: shadow(bCRP) };
      if (mw > 0) {
        var core = compute(inp, prev, ref, Object.assign({}, opts, { macro: false, shadows: false }));
        shadows.core = { weights: core.weights, outside: core.outside, sleeves: core.sleeves, vol: core.risk.vol, cryptoShare: core.risk.cryptoShare };
      }
    }

    // 10. output, rounded; cash takes the rounding remainder so the total is exactly 100
    var wOut = {}; syms.forEach(function (s) { wOut[s] = r2(w[s]); });
    var outsideR = r2(100 - sum(wOut));
    if (outsideR < 0) { var big = syms.reduce(function (m, x) { return wOut[x] > wOut[m] ? x : m; }, syms[0]); wOut[big] = r2(wOut[big] + outsideR); outsideR = 0; }
    var sigOut = {}; syms.forEach(function (s) { var o = sig[s]; sigOut[s] = { ok: o.ok, p: o.p != null ? r4(o.p) : null, sma: o.sma != null ? r4(o.sma) : null, T: r2(o.T), M: r2(o.M), S: r2(o.S), z: r2(o.z), mult: r2(o.mult), vol: o.vol != null ? r2(o.vol) : null, mom: o.mom != null ? r4(o.mom) : null, dist: o.dist != null ? r4(o.dist) : null }; });
    var rcOut = {}; syms.forEach(function (s) { rcOut[s] = r4(rk.rc[s]); });
    var rnd = function (o) { var r = {}; Object.keys(o).forEach(function (k) { r[k] = r2(o[k]); }); return r; };
    var bounds = {}; syms.forEach(function (s) { var u = Math.min(ubB[s] != null ? ubB[s] : Infinity, ubC[s] != null ? ubC[s] : Infinity); if (u < Infinity) bounds[s] = r2(u); });
    var corrOut = { syms: syms, m: RM.Rsample.map(function (row) { return row.map(r2); }), window: RM.ar63 ? { n: RM.ar63.n, from: RM.ar63.from, to: RM.ar63.to } : null };
    // 11. diagnostic only: 1-day historical expected shortfall at 95% of the final target and of the base plan, on the risk model's aligned window
    var cvar = null;
    if (RM.ar && RM.ar.n >= CVAR_MIN_DAYS) {
      var baseW = {}; ASSETS.forEach(function (a) { baseW[a.s] = a.base; });
      var cvT = histCvar(portReturns(RM.ar, w), CVAR_ALPHA), cvB = histCvar(portReturns(RM.ar, baseW), CVAR_ALPHA);
      if (isNum(cvT) && isNum(cvB)) cvar = { alpha: CVAR_ALPHA, horizon: '1d', n: RM.ar.n, from: RM.ar.from, to: RM.ar.to, target: r4(cvT), base: r4(cvB) };
    }
    return {
      engine: VERSION, asOf: inp.now || new Date().toISOString(),
      policy: { macroWeight: mw, kappa: PARAMS.kappa, ddOverlay: !!opts.ddOverlay, altGate: !!opts.altGate, gradedGate: !!opts.gradedGate, monthlyGate: !!opts.monthlyGate, cryptoCap: !!opts.cryptoCap, volCap: !!opts.volCap },
      weights: wOut, outside: outsideR, outsideBy: rnd(E.by),
      sleeves: { gold: r2(sleeves.gold), stocks: r2(sleeves.stocks), crypto: r2(sleeves.crypto) },
      preRaw: rnd(raw), pre: rnd(p), bounds: bounds,
      signals: sigOut, macro: macro, gates: gates,
      risk: { vol: r4(rk.vol), volEwma: r4(rkE.vol), volSample: r4(portRisk(w, syms, RM.Csample).vol), volStress: r4(portRisk(w, syms, RM.Cstress).vol),
        rc: rcOut, cryptoShare: r4(cryptoShareOf(rk)), cryptoShareEwma: r4(cryptoShareOf(rkE)), cryptoCap: cryptoCap,
        nvdaLook: r2(w.NVDA + LOOK.VOO * w.VOO + LOOK.SMH * w.SMH), mctr: mctr,
        C: RM.Cbase.map(function (row) { return row.map(function (v) { return Math.round(v * 1e6) / 1e6; }); }),
        vols: syms.reduce(function (o, x) { o[x] = r4(RM.volL[x]); return o; }, {}),
        volsEwma: syms.reduce(function (o, x) { o[x] = r4(RM.volE[x]); return o; }, {}),
        shrink: { delta: r4(RM.delta), lw: RM.lwRaw != null ? r4(RM.lwRaw) : null, rbar: r4(RM.rbar), psd: RM.psd },
        stress: { avgEwma: avgE != null ? r2(avgE) : null, avg63: avgS != null ? r2(avgS) : null, spike: spike }, dd: dd,
        cryptoScale: r4(E.aStar), volScale: r4(E.volScale), cvar: cvar },
      checks: checks, checksOk: !failed.length, relaxed: relaxed,
      shadows: shadows, clusters: clusters,
      corr: corrOut, actions: actions, actionBasis: basis,
      holdings: hold ? { total: Math.round(hold.total), pct: rnd(hold.pct), cashPct: r2(hold.cashPct), asOf: hold.asOf, missingPx: hold.missingPx } : null,
      posture: posture, events: events, notes: notes, missing: missing, smoothed: smoothed,
      status: status.status, blockers: status.blockers, degraded: status.degraded, evidence: evidence
    };
  }

  var api = { VERSION: VERSION, fedWatchOdds: fedWatchOdds, riskBudget: riskBudget, clusterAssets: clusterAssets, fedOdds: fedOdds, Phi: Phi,
    ASSETS: ASSETS, SLEEVES: SLEEVES, SLEEVE_BAND: SLEEVE_BAND, ASSET_CAP: ASSET_CAP, PARAMS: PARAMS, DEFAULT_OPTS: DEFAULT_OPTS, FOMC: FOMC, LOOK: LOOK,
    parse: parse, compute: compute, regimeList: regimeList, monthEndCloses: monthEndCloses, gradeInput: gradeInput, assessRun: assessRun,
    _internal: { enforce: enforce, verify: verify, cryptoScale: cryptoScale, projectSleeves: projectSleeves, psdCorr: psdCorr, jacobiEig: jacobiEig, ledoitWolf: ledoitWolf, portRisk: portRisk, cryptoShareOf: cryptoShareOf, markHoldings: markHoldings, histCvar: histCvar, portReturns: portReturns } };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.ZE = api;
})(typeof window !== 'undefined' ? window : this);
