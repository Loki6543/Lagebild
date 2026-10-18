'use strict';
// CPI is only knowable once BLS publishes it, and year-on-year compares observation months; the replay never borrows.
// Run: node --test tests/test_point_in_time.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'engine', 'lagebild-engine.js'), 'utf8');
// the engine keeps these helpers private; evaluate exactly the shipped text
const pick = name => { const m = new RegExp('  function ' + name + '\\(([\\s\\S]*?)\\n  }\\n|  function ' + name + '\\(.*\\n').exec(src); assert.ok(m, name); return m[0]; };
const cpiYoY = new Function(pick('valueAtOrBefore') + pick('shiftMonths') + pick('cpiYoY') + 'return cpiYoY;')();

// September 2025 published Oct 24; October 2025 never published; November published later
const rows = [];
for (let m = 1; m <= 12; m++) rows.push({ p: '2024-' + String(m).padStart(2, '0'), d: '2024-' + String(m === 12 ? 12 : m + 1).padStart(2, '0') + '-12', v: 100 + m });
rows.push({ p: '2025-08', d: '2025-09-11', v: 112.0 }, { p: '2025-09', d: '2025-10-24', v: 113.0 }, { p: '2025-11', d: '2025-12-18', v: 114.0 });
rows.sort((a, b) => a.d < b.d ? -1 : 1);

test('September 2025 CPI is unavailable on Oct 17 and available after the Oct 24 release', () => {
  assert.equal(cpiYoY(rows, '2025-10-17'), (112 / 108 - 1) * 100);   // still August vs August
  assert.equal(cpiYoY(rows, '2025-10-24'), (113 / 109 - 1) * 100);   // September vs September
});

test('a missing month does not shift the twelve-month comparison', () => {
  assert.equal(cpiYoY(rows, '2025-12-20'), (114 / 111 - 1) * 100);  // November vs November, not vs October
});

test('rows without an observation month keep the old behaviour', () => {
  const old = [{ d: '2024-01-15', v: 100 }, { d: '2025-01-15', v: 103 }];
  assert.ok(Math.abs(cpiYoY(old, '2025-01-20') - 3) < 1e-9);
});

const PANEL = path.join(ROOT, 'data', 'panel', 'panel.json');
test('replay cash never goes below zero (fees funded, no borrowing)', { skip: !fs.existsSync(PANEL) && 'needs data/panel/panel.json' }, () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'lb-cash-'));
  cp.execFileSync('node', [path.join(ROOT, 'run_replay.js'), 'base', 'v3'], { env: Object.assign({}, process.env, { LAGEBILD_RESULTS: out }), stdio: 'ignore' });
  for (const id of ['base', 'v3']) {
    const r = JSON.parse(fs.readFileSync(path.join(out, 'runs', id + '.json'), 'utf8'));
    assert.ok(r.minCash >= -1e-12, id + ' min cash ' + r.minCash);
  }
});
