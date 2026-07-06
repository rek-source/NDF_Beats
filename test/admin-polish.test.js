// test/admin-polish.test.js  (OWNER: frontend)
// Regression guards accumulated across the /polish loop (file-scan style, like
// static-paths.test.js). Behaviour is verified in-browser; these lock the wiring.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pub = path.join(__dirname, '..', 'public');
const HTML = fs.readFileSync(path.join(pub, 'admin.html'), 'utf8');
const JS = fs.readFileSync(path.join(pub, 'admin.js'), 'utf8');
const CSS = fs
  .readFileSync(path.join(pub, 'styles', 'admin.css'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '');
const TOKENS = fs.readFileSync(path.join(pub, 'styles', 'tokens.css'), 'utf8');

// ---- Iteration 1: accessibility live-region + labels ----
test('i1: action banner is a polite live region', () => {
  assert.match(HTML, /id="banner"[^>]*aria-live="polite"/);
  assert.match(HTML, /id="banner"[^>]*role="status"/);
  assert.match(JS, /aria-live'?,?\s*err\s*\?\s*'assertive'/, 'errors should announce assertively');
});
test('i1: icon-only / jargon controls carry accessible names', () => {
  assert.match(HTML, /id="themeToggle"[^>]*aria-label=/);
  assert.match(HTML, /ad-refresh__glyph"[^>]*aria-hidden="true"/);
});
test('i1: per-rep action buttons are name-qualified for screen readers', () => {
  assert.match(JS, /aria-label="Edit '/);
  assert.match(JS, /'Set PIN for '|'Reset PIN for '/);
  assert.match(JS, /ad-rep__avatar"\s*aria-hidden="true"/);
});

// ---- Iteration 2: keyboard — Escape, focus-return, Enter-advance ----
test('i2: inline editors close on Escape and restore focus to the rep list', () => {
  assert.match(JS, /function reloadFocus\(/, 'a focus-restoring reload helper must exist');
  assert.equal((JS.match(/ev\.key === 'Escape'/g) || []).length >= 2, true, 'both editors must handle Escape');
  assert.match(JS, /reloadFocus\(pinBtnSel\)/);
  assert.match(JS, /reloadFocus\(editBtnSel\)/);
});
test('i2: Enter in the first PIN field advances to confirm', () => {
  assert.match(JS, /ev\.key === 'Enter' && \/\^\\d\{4\}\$\/\.test\(input\.value\)/);
});

// ---- Iteration 3: only one inline editor open at a time ----
test('i3: opening an editor while another is open closes the first', () => {
  assert.match(JS, /function openEditorFor\(/);
  assert.match(JS, /querySelector\('\.ad-pin__edit, \.ad-rep__edit-form'\)/, 'must detect an already-open editor');
});

// ---- Iteration 4: rep-row layout (name not crushed) ----
function ruleBody(css, sel) {
  const re = /([^{}]+)\{([^}]*)\}/g; let m;
  while ((m = re.exec(css))) if (m[1].split(',').map((s) => s.trim()).includes(sel)) return m[2];
  return null;
}
test('i4: pin + actions clusters do not shrink the name column', () => {
  assert.match(ruleBody(CSS, '.ad-rep__pin') || '', /flex-shrink:\s*0/);
  assert.match(ruleBody(CSS, '.ad-rep__actions') || '', /flex-shrink:\s*0/);
  assert.match(ruleBody(CSS, '.ad-rep__name') || '', /text-overflow:\s*ellipsis/);
  assert.doesNotMatch(ruleBody(CSS, '.ad-rep__pin') || '', /margin-left:\s*12px/, 'double gap removed');
});

// ---- Iteration 5-7: motion, contrast, status, HC theme ----
test('i5: reduced-motion is honored and --muted lifted to AA', () => {
  assert.match(CSS, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(CSS, /:root\s*\{\s*--muted:\s*#5C5851/);
});
test('i6: every beat status has an explicit, legible style', () => {
  assert.ok(ruleBody(CSS, '.ad-status--ready'), '.ad-status--ready must exist');
  assert.match(ruleBody(CSS, '.ad-status--complete') || '', /color:\s*var\(--ink\)/, 'complete must use legible ink, not muted-only');
});
test('i7: HC theme keeps default weight bar + unassigned tint distinguishable', () => {
  assert.match(CSS, /\[data-theme="hc"\]\s*\.ad-w__bar--default/);
  assert.match(CSS, /\[data-theme="hc"\][^{]*\.is-unassigned/);
});

// ---- Iteration 8-10 ----
test('i8: loading skeletons render before the first fetch', () => {
  assert.match(JS, /function renderSkeleton\(/);
  assert.match(JS, /renderSkeleton\(\);\s*\n\s*loadOverview\(\)/);
  assert.match(CSS, /@keyframes ad-shimmer/);
  assert.match(CSS, /\.ad-skel\b/);
});
test('i9: assign dropdown handles inactive reps + beat names truncate', () => {
  assert.match(JS, /\(inactive\)/, 'inactive reps must be marked in the assign dropdown');
  assert.match(JS, /if \(!r\.active && r\.id !== selectedId\) return/, 'inactive non-assignees excluded');
  assert.match(ruleBody(CSS, '.ad-beat__name') || '', /text-overflow:\s*ellipsis/);
  assert.match(JS, /ad-beat__name"[^']*title="/, 'beat name cell needs a title for the full text');
});
test('i10: defensive edges — initials, edit email, skip link', () => {
  assert.match(JS, /\\p\{L\}/, 'initials must be unicode/emoji-safe');
  assert.match(JS, /Email is required\./, 'edit form must require email');
  assert.match(HTML, /class="skip-link" href="#main"/);
  assert.match(HTML, /<main[^>]*id="main"/);
  assert.match(CSS, /\.skip-link:focus\s*\{[^}]*left:/);
});
