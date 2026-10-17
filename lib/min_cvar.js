/* Minimum-CVaR portfolio weights by linear programming. CommonJS, no dependencies. Research only.

   minCvarWeights(returns, opts) solves the Rockafellar-Uryasev (2000) linear programme

       minimize    zeta + 1 / ((1 - alpha) T) * sum_t u_t
       subject to  u_t >= -(r_t . w) - zeta        (one row per scenario t)
                   u_t >= 0
                   sum_i w_i = 1,  w >= 0           (fully invested, long only)
                   lo <= sum_{i in group} w_i <= hi (linear group constraints)
                   w_i <= ub_i                      (per-asset upper bounds)
                   sum_i coef_i w_i <= hi           (look-through constraints)

   whose optimal value is the lowest historical expected shortfall (CVaR) at level alpha that any weight vector
   in the feasible set can reach on the T scenarios, and whose optimal w attains it. r_t holds the simple returns
   of the N assets in scenario t; losses are -(r_t . w).

   The solver is a dense two-phase tableau simplex. Dantzig's largest-coefficient rule drives it; after a run of
   degenerate pivots it switches to Bland's smallest-index rule until the objective strictly improves, which rules
   out cycling. Nothing here throws on a data or numerical problem: every failure is a status.

   Statuses: 'optimal', 'infeasible', 'unbounded', 'iteration_limit', plus two guards, 'invalid_input' (malformed
   arguments or non-finite returns) and 'numerical_error' (the solution failed the final feasibility or objective
   audit). Only 'optimal' carries weights. */
'use strict';

const PIV_TOL = 1e-9;      // smallest pivot element accepted in the ratio test
const RC_TOL = 1e-9;       // reduced cost below -RC_TOL makes a column eligible to enter
const FEAS_TOL = 1e-8;     // phase-1 objective at or below this counts as feasible
const PROGRESS = 1e-11;    // a pivot whose step is not larger than this is degenerate
const BLAND_AFTER = 40;    // consecutive degenerate pivots before the anti-cycling rule takes over
const DROP = 1e-14;        // tableau entries smaller than this are rounding noise and are set to zero (data are O(1))

/* ---------- general LP: minimize c.x subject to rows, x >= 0 ---------- */

/* rows: [{ a, op, b }] with a a dense array or a sparse {col: coefficient} object, op one of '<=', '>=', '='.
   Returns { status, x, objective, iterations } and never throws. */
function solveLP(c, rows, options) {
  const o = options || {};
  const n = c.length, m = rows.length;
  if (!n || !c.every(Number.isFinite)) return fail('invalid_input');
  // normalise: sparse column/value lists, rhs >= 0
  const sp = new Array(m), op = new Array(m), rhs = new Float64Array(m), colCount = new Int32Array(n);
  for (let i = 0; i < m; i++) {
    const row = rows[i];
    if (!row || !Number.isFinite(row.b) || (row.op !== '<=' && row.op !== '>=' && row.op !== '=')) return fail('invalid_input');
    const js = [], vs = [];
    if (Array.isArray(row.a) || ArrayBuffer.isView(row.a)) {
      if (row.a.length !== n) return fail('invalid_input');
      for (let j = 0; j < n; j++) if (row.a[j] !== 0) { js.push(j); vs.push(row.a[j]); }
    } else if (row.a && typeof row.a === 'object') {
      for (const k of Object.keys(row.a)) { const j = +k; if (!Number.isInteger(j) || j < 0 || j >= n) return fail('invalid_input'); if (row.a[k] !== 0) { js.push(j); vs.push(row.a[k]); } }
    } else return fail('invalid_input');
    if (!vs.every(Number.isFinite)) return fail('invalid_input');
    const flip = row.b < 0;
    op[i] = flip ? (row.op === '<=' ? '>=' : row.op === '>=' ? '<=' : '=') : row.op;
    rhs[i] = flip ? -row.b : row.b;
    if (flip) for (let k = 0; k < vs.length; k++) vs[k] = -vs[k];
    sp[i] = { js, vs };
    for (const j of js) colCount[j]++;
  }
  // columns: structural 0..n-1, one slack or surplus per inequality row, then artificials
  let nCol = n; const slackCol = new Int32Array(m).fill(-1);
  for (let i = 0; i < m; i++) if (op[i] !== '=') slackCol[i] = nCol++;
  const basis = new Int32Array(m).fill(-1), art = [];
  // a basic variable per row: the slack of a '<=' row, else a structural column that is a unit column of that row
  const rowUnit = new Int32Array(m).fill(-1), taken = new Uint8Array(n);
  for (let i = 0; i < m; i++) {
    if (op[i] === '<=') { basis[i] = slackCol[i]; continue; }
    const { js, vs } = sp[i];
    for (let k = 0; k < js.length; k++) if (colCount[js[k]] === 1 && vs[k] > PIV_TOL && !taken[js[k]]) { rowUnit[i] = k; taken[js[k]] = 1; basis[i] = js[k]; break; }
  }
  for (let i = 0; i < m; i++) if (basis[i] < 0) { art.push(i); }
  const nElig = nCol;                     // columns allowed to enter the basis (everything but artificials)
  const total = nCol + art.length, W = total + 1;
  const tab = new Float64Array(m * W);
  for (let i = 0; i < m; i++) {
    const { js, vs } = sp[i], base = i * W;
    for (let k = 0; k < js.length; k++) tab[base + js[k]] = vs[k];
    if (op[i] === '<=') tab[base + slackCol[i]] = 1; else if (op[i] === '>=') tab[base + slackCol[i]] = -1;
    tab[base + total] = rhs[i];
    if (rowUnit[i] >= 0) { const p = vs[rowUnit[i]]; for (let k = 0; k < W; k++) tab[base + k] /= p; tab[base + js[rowUnit[i]]] = 1; }
  }
  art.forEach((i, k) => { tab[i * W + nCol + k] = 1; basis[i] = nCol + k; });

  const maxIter = o.maxIter || 10 * (m + total) + 1000;
  const st = { it: 0, maxIter, tab, m, W, total, basis, nz: new Int32Array(W), rc: new Float64Array(W), nElig };

  if (art.length) {            // phase 1: drive the artificial variables to zero
    const cost1 = new Float64Array(total); for (let k = 0; k < art.length; k++) cost1[nCol + k] = 1;
    const r1 = runSimplex(st, cost1);
    if (r1 === 'iteration_limit') return fail('iteration_limit', st.it);
    let infeas = 0; for (let i = 0; i < m; i++) if (basis[i] >= nCol) infeas += tab[i * W + total];
    if (infeas > FEAS_TOL) return fail('infeasible', st.it);
    for (let i = 0; i < m; i++) {          // move leftover (zero-level) artificials out of the basis where a real column can replace them
      if (basis[i] < nCol) continue;
      let best = -1, bv = PIV_TOL; for (let j = 0; j < nElig; j++) { const v = Math.abs(tab[i * W + j]); if (v > bv) { bv = v; best = j; } }
      if (best >= 0) pivot(st, i, best, null);
    }
  }
  const cost2 = new Float64Array(total); for (let j = 0; j < n; j++) cost2[j] = c[j];
  const r2 = runSimplex(st, cost2);
  if (r2 !== 'optimal') return fail(r2, st.it);
  const x = new Float64Array(n); let obj = 0;
  for (let i = 0; i < m; i++) if (basis[i] < n) x[basis[i]] = Math.max(0, tab[i * W + total]);
  for (let j = 0; j < n; j++) obj += c[j] * x[j];
  return { status: 'optimal', x: Array.from(x), objective: obj, iterations: st.it };

  function fail(status, it) { return { status, x: null, objective: null, iterations: it || 0 }; }
}

function pivot(st, r, j, rc) {
  const { tab, W, m, nz, basis } = st, pr = r * W, inv = 1 / tab[pr + j];
  let cnt = 0;
  for (let k = 0; k < W; k++) { const v = tab[pr + k]; if (v !== 0) { tab[pr + k] = v * inv; nz[cnt++] = k; } }
  tab[pr + j] = 1;
  for (let i = 0; i < m; i++) {
    if (i === r) continue;
    const base = i * W, f = tab[base + j];
    if (f === 0) continue;
    for (let q = 0; q < cnt; q++) { const k = nz[q], v = tab[base + k] - f * tab[pr + k]; tab[base + k] = v < DROP && v > -DROP ? 0 : v; }
    tab[base + j] = 0;
  }
  if (rc) {
    const f = rc[j];
    if (f !== 0) { for (let q = 0; q < cnt; q++) { const k = nz[q]; rc[k] -= f * tab[pr + k]; } rc[j] = 0; }
  }
  basis[r] = j;
}

/* one simplex phase on the shared tableau; returns 'optimal', 'unbounded' or 'iteration_limit' */
function runSimplex(st, cost) {
  const { tab, m, W, total, basis, rc, nElig } = st;
  for (let k = 0; k < total; k++) rc[k] = cost[k];
  rc[total] = 0;
  for (let i = 0; i < m; i++) {                      // reduced costs for the current basis
    const cb = cost[basis[i]]; if (cb === 0) continue;
    const base = i * W; for (let k = 0; k < W; k++) rc[k] -= cb * tab[base + k];
  }
  let degenerate = 0, bland = false;
  for (;;) {
    let ent = -1;
    if (bland) { for (let j = 0; j < nElig; j++) if (rc[j] < -RC_TOL) { ent = j; break; } }
    else { let best = -RC_TOL; for (let j = 0; j < nElig; j++) if (rc[j] < best) { best = rc[j]; ent = j; } }
    if (ent < 0) return 'optimal';
    // ratio test; ties go to the smallest basic index under Bland's rule, to the largest pivot otherwise
    let lv = -1, ratio = Infinity, bigPiv = 0;
    for (let i = 0; i < m; i++) {
      const a = tab[i * W + ent]; if (a <= PIV_TOL) continue;
      let b = tab[i * W + total]; if (b < 0) b = 0;
      const t = b / a, tieTol = 1e-12 * (1 + Math.abs(ratio === Infinity ? t : ratio));
      if (t < ratio - tieTol) { ratio = t; lv = i; bigPiv = a; }
      else if (t <= ratio + tieTol) {
        if (bland ? basis[i] < basis[lv] : a > bigPiv) { if (t < ratio) ratio = t; lv = i; bigPiv = a; }
      }
    }
    if (lv < 0) return 'unbounded';
    if (st.it++ >= st.maxIter) return 'iteration_limit';
    pivot(st, lv, ent, rc);
    for (let i = 0; i < m; i++) { const q = i * W + total; if (tab[q] < 0 && tab[q] > -1e-11) tab[q] = 0; }
    if (ratio > PROGRESS) { degenerate = 0; bland = false; }
    else if (++degenerate > BLAND_AFTER) bland = true;
  }
}

/* ---------- historical CVaR of a given weight vector ---------- */

/* Rockafellar-Uryasev expected shortfall: the mean loss over the worst (1 - alpha) share of scenarios, with a
   fractional weight on the boundary scenario. var is the alpha-quantile of the loss (the (floor(k)+1)-th largest
   loss, k = (1 - alpha) T), the zeta that minimises the shortfall function. Positive numbers are losses. */
function cvarOf(returns, w, alpha) {
  const a = alpha == null ? 0.95 : alpha, T = returns.length;
  if (!T || !(a > 0 && a < 1)) return null;
  const loss = new Float64Array(T);
  for (let t = 0; t < T; t++) {
    const row = returns[t]; let r = 0;
    for (let i = 0; i < w.length; i++) r += row[i] * w[i];
    if (!Number.isFinite(r)) return null;
    loss[t] = -r;
  }
  loss.sort();                                      // ascending; the worst losses are at the end
  const k = (1 - a) * T, m = Math.min(Math.floor(k), T);
  let s = 0; for (let i = 0; i < m; i++) s += loss[T - 1 - i];
  if (m < T) s += (k - m) * loss[T - 1 - m];
  return { cvar: s / k + 0, var: loss[T - 1 - Math.min(m, T - 1)] + 0 };
}

/* ---------- minimum-CVaR weights ---------- */

/* returns: T x N array of simple returns. opts:
     alpha        confidence level, default 0.95
     groups       [{ idx: [asset indices], lo, hi }]            sums of weights, as fractions of the portfolio
     ub           per-asset upper bounds: an array of length N (null or Infinity for none) or { index: bound }
     lookthrough  [{ coef: { index: c } or length-N array, hi }] sum of coef_i w_i <= hi
     maxIter      pivot limit
   Returns { status, weights, cvar, var, objective, iterations }. cvar and var are evaluated from the returned
   weights; objective is the LP value, which equals cvar at an optimum. */
function minCvarWeights(returns, opts) {
  const o = opts || {};
  const bad = () => ({ status: 'invalid_input', weights: null, cvar: null, var: null, objective: null, iterations: 0 });
  try {
    const alpha = o.alpha == null ? 0.95 : o.alpha;
    if (!Array.isArray(returns) || !returns.length || !(alpha > 0 && alpha < 1)) return bad();
    const T = returns.length, N = Array.isArray(returns[0]) || ArrayBuffer.isView(returns[0]) ? returns[0].length : 0;
    if (!N) return bad();
    let rmax = 0, rpos = 0;
    for (let t = 0; t < T; t++) {
      const row = returns[t];
      if (!row || row.length !== N) return bad();
      for (let i = 0; i < N; i++) { const v = row[i]; if (typeof v !== 'number' || !Number.isFinite(v)) return bad(); if (Math.abs(v) > rmax) rmax = Math.abs(v); if (v > rpos) rpos = v; }
    }
    const scale = rmax > 0 ? 1 / rmax : 1;            // work with |returns| <= 1; the objective scales by the same factor
    const M0 = Math.max(0, rpos * scale);             // zeta = zeta' - M0 with zeta' >= 0: no optimal zeta lies below the best scenario return
    const cu = 1 / ((1 - alpha) * T);
    // columns: w_0..w_{N-1}, zeta', u_0..u_{T-1}
    const nVar = N + 1 + T, cost = new Array(nVar).fill(0);
    cost[N] = 1; for (let t = 0; t < T; t++) cost[N + 1 + t] = cu;
    const rows = [];
    for (let t = 0; t < T; t++) {                      // u_t + r_t . w + zeta' >= M0
      const a = new Float64Array(nVar), row = returns[t];
      for (let i = 0; i < N; i++) a[i] = row[i] * scale;
      a[N] = 1; a[N + 1 + t] = 1;
      rows.push({ a, op: '>=', b: M0 });
    }
    const ones = {}; for (let i = 0; i < N; i++) ones[i] = 1;
    rows.push({ a: ones, op: '=', b: 1 });
    const groups = o.groups || [], looks = o.lookthrough || [];
    for (const g of groups) {
      if (!g || !Array.isArray(g.idx) || !g.idx.every(i => Number.isInteger(i) && i >= 0 && i < N)) return bad();
      const a = {}; g.idx.forEach(i => { a[i] = (a[i] || 0) + 1; });
      if (g.lo != null && !Number.isFinite(g.lo)) return bad();
      if (g.hi != null && !Number.isFinite(g.hi)) return bad();
      if (g.lo != null && g.lo > 0) rows.push({ a, op: '>=', b: g.lo });
      if (g.hi != null) rows.push({ a, op: '<=', b: g.hi });
    }
    const ubs = [];
    if (Array.isArray(o.ub)) { if (o.ub.length !== N) return bad(); o.ub.forEach((v, i) => ubs.push([i, v])); }
    else if (o.ub && typeof o.ub === 'object') Object.keys(o.ub).forEach(k => ubs.push([+k, o.ub[k]]));
    for (const [i, v] of ubs) {
      if (!Number.isInteger(i) || i < 0 || i >= N) return bad();
      if (v == null || v === Infinity) continue;
      if (!Number.isFinite(v)) return bad();
      rows.push({ a: { [i]: 1 }, op: '<=', b: v });
    }
    const lookRows = [];
    for (const l of looks) {
      if (!l || !Number.isFinite(l.hi)) return bad();
      const a = {};
      if (Array.isArray(l.coef)) { if (l.coef.length !== N) return bad(); l.coef.forEach((v, i) => { if (v) a[i] = v; }); }
      else if (l.coef && typeof l.coef === 'object') { for (const k of Object.keys(l.coef)) { const i = +k; if (!Number.isInteger(i) || i < 0 || i >= N) return bad(); if (l.coef[k]) a[i] = l.coef[k]; } }
      else return bad();
      if (!Object.keys(a).every(k => Number.isFinite(a[k]))) return bad();
      lookRows.push({ a, hi: l.hi });
      rows.push({ a, op: '<=', b: l.hi });
    }
    const sol = solveLP(cost, rows, { maxIter: o.maxIter });
    if (sol.status !== 'optimal') return { status: sol.status, weights: null, cvar: null, var: null, objective: null, iterations: sol.iterations };
    const w = sol.x.slice(0, N).map(v => (v < 0 ? 0 : v));
    // audit: the returned weights must satisfy every constraint, and the LP value must equal the evaluated CVaR
    const tol = 1e-7;
    let ok = Math.abs(w.reduce((s, v) => s + v, 0) - 1) <= tol;
    for (const g of groups) { const s = g.idx.reduce((t, i) => t + w[i], 0); if ((g.lo != null && s < g.lo - tol) || (g.hi != null && s > g.hi + tol)) ok = false; }
    for (const [i, v] of ubs) if (v != null && v !== Infinity && w[i] > v + tol) ok = false;
    for (const l of lookRows) { let s = 0; Object.keys(l.a).forEach(k => { s += l.a[k] * w[+k]; }); if (s > l.hi + tol) ok = false; }
    const ev = cvarOf(returns, w, alpha);
    const objective = (sol.objective - M0) / scale;    // undo the shift zeta = zeta' - M0 and the return scaling
    if (!ok || !ev || Math.abs(ev.cvar - objective) > 1e-6 * Math.max(rmax, 1e-12)) {
      return { status: 'numerical_error', weights: null, cvar: null, var: null, objective: null, iterations: sol.iterations };
    }
    return { status: 'optimal', weights: w, cvar: ev.cvar, var: ev.var, objective, iterations: sol.iterations };
  } catch (e) {
    return { status: 'numerical_error', weights: null, cvar: null, var: null, objective: null, iterations: 0, error: String(e && e.message || e) };
  }
}

module.exports = { minCvarWeights, solveLP, cvarOf };
