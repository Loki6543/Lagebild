// Runs the crypto risk-cap proof (crypto_cap_proof.py) against the shipped engine itself, not a re-implementation:
// 10,000 random long-only portfolios, two random covariance models each, caps 0.6 and 0.5. The engine's cryptoScale
// result (minimum over both models) must bring the crypto share of variance to the cap or below in both models, and
// must never raise a weight. Seeded, so the result is reproducible. Run: node verification/engine_crypto_cap_check.js
'use strict';
const ZE = require('../engine/lagebild-engine.js');
const { cryptoScale, portRisk, cryptoShareOf } = ZE._internal;
const SYMS = ['VOO', 'SMH', 'NVDA', 'MSFT', 'TSM', 'XLE', 'IAUM', 'GDX', 'BTC', 'ETH', 'SOL', 'LINK'];
const CRYPTO = new Set(['BTC', 'ETH', 'SOL', 'LINK']);

let seed = 20261016 >>> 0;
const rand = () => { seed = (seed + 0x6d2b79f5) >>> 0; let t = seed; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const normal = () => Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
function randomCov(n) { // X Xᵀ + 0.05 I, as in the Python proof
  const X = Array.from({ length: n }, () => Array.from({ length: n }, normal));
  return X.map((r, i) => X.map((c, j) => r.reduce((s, v, k) => s + v * c[k], 0) + (i === j ? 0.05 : 0)));
}
function dirichletPct(n) { const g = Array.from({ length: n }, () => -Math.log(1 - rand())); const t = g.reduce((a, b) => a + b, 0); return g.map((x) => (100 * x) / t); }

let failures = 0, worst = -Infinity, raised = 0;
for (let c = 0; c < 10000; c++) {
  const q = c % 2 ? 0.5 : 0.6;
  const w = {}; dirichletPct(12).forEach((v, i) => { w[SYMS[i]] = v; });
  const models = [randomCov(12), randomCov(12)];
  const a = Math.min(...models.map((C) => cryptoScale(w, C, q)));
  const t = {}; SYMS.forEach((s) => { t[s] = CRYPTO.has(s) ? w[s] * a : w[s]; if (t[s] > w[s] + 1e-12) raised++; });
  for (const C of models) {
    const excess = cryptoShareOf(portRisk(t, SYMS, C)) - q;
    worst = Math.max(worst, excess);
    if (excess > 1e-9) failures++;
  }
}
console.log(JSON.stringify({ engine: ZE.VERSION, portfolios: 10000, model_checks: 20000, failures, raised_weights: raised, max_excess: worst }));
if (failures || raised) process.exit(1);
