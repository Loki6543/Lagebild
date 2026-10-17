'use strict';
// The engine that ships inside app/index.html must be byte-for-byte the engine in engine/lagebild-engine.js, so the replay
// and the tests always exercise the shipped code. The engine file carries a 2-line header comment that the app does not.
// Run: node --test tests/test_app_engine_sync.js
//
// This test is expected to FAIL until the rebuilt app (with the engine's historical CVaR diagnostic) is installed at
// app/index.html; the engine file changed first.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'app', 'index.html'), 'utf8');
const engine = fs.readFileSync(path.join(__dirname, '..', 'engine', 'lagebild-engine.js'), 'utf8');
const dropOneTrailingNewline = (s) => s.replace(/\n$/, '');

test('app/index.html embeds the engine file (minus its 2-line header) verbatim', () => {
  // the block starts on the line after a bare <script> line that begins "/* Zobiris Lagebild allocation engine"
  // and ends before the next </script>
  const m = /^<script>\n(\/\* Zobiris Lagebild allocation engine[\s\S]*?)\n<\/script>/m.exec(html);
  assert.ok(m, 'no <script> block starting with "/* Zobiris Lagebild allocation engine" in app/index.html');
  const lines = engine.split('\n');
  assert.ok(lines[0].startsWith('/*'), 'engine line 1 must open the header comment');
  assert.ok(lines[1].trimEnd().endsWith('*/'), 'engine line 2 must close the header comment');
  assert.ok(lines[2].startsWith('/* Zobiris Lagebild allocation engine'), 'engine line 3 must be the engine banner');
  const expected = lines.slice(2).join('\n');
  const actual = m[1];
  if (dropOneTrailingNewline(actual) !== dropOneTrailingNewline(expected)) {
    // point at the first line that differs, which is what a person needs to fix it
    const a = dropOneTrailingNewline(actual).split('\n'), e = dropOneTrailingNewline(expected).split('\n');
    let i = 0; while (i < a.length && i < e.length && a[i] === e[i]) i++;
    assert.fail('app engine block differs from the engine file at engine line ' + (i + 3) + ' (block line ' + (i + 1) + ')\n  app:    ' + String(a[i]).slice(0, 160) + '\n  engine: ' + String(e[i]).slice(0, 160) + '\n  block lines: app ' + a.length + ', engine ' + e.length);
  }
});

test('the app runs exactly one engine block', () => {
  const count = (html.match(/^\/\* Zobiris Lagebild allocation engine/gm) || []).length;
  assert.equal(count, 1, 'app/index.html must contain the engine banner exactly once');
});
