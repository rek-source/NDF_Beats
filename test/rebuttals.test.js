// test/rebuttals.test.js  (OWNER: sales + frontend)
// Guards the on-door script copy (public/rebuttals.js) — structure the app
// renders from, plus the two compliance rails that are policy, not style:
//   1. NDF no-discounts policy (CA): no "say" line may script a labor
//      discount, member rate, % off, or fee waiver. Those belong ONLY in the
//      "never" column.
//   2. CA home-solicitation: the 3-business-day right to cancel must be in
//      the must-say compliance line AND in the spouse rebuttal.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(__dirname, '..', 'public', 'rebuttals.js');

function loadBrowserGlobal() {
  const sandbox = {};
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(FILE, 'utf8'), sandbox, { filename: 'rebuttals.js' });
  return sandbox.BeatsRebuttals;
}

// Lines that would be a discount/pressure violation if a rep SAYS them.
const BANNED_IN_SAY = /(discount|%\s*off|percent off|member rate|knock some off|waive the fee|beat whatever|price match|only good right now)/i;

test('rebuttals.js defines window.BeatsRebuttals with opener, compliance, and objections', () => {
  const rb = loadBrowserGlobal();
  assert.ok(rb, 'window.BeatsRebuttals must be defined');

  assert.ok(rb.opener && rb.opener.title && rb.opener.script.length > 40, 'opener block');
  assert.match(rb.opener.script, /Next Day Fix/, 'opener identifies the company (CA solicitation rule)');
  assert.match(rb.opener.script, /licensed/i, 'opener states licensed-contractor status');

  assert.ok(rb.compliance && rb.compliance.script, 'must-say compliance block');
  assert.match(rb.compliance.script, /three business days/i, '3-day right to cancel is the must-say line');

  assert.ok(Array.isArray(rb.objections) && rb.objections.length >= 5, 'at least 5 objections');
  const keys = rb.objections.map((o) => o.key);
  assert.equal(new Set(keys).size, keys.length, 'objection keys are unique');
  for (const k of ['price', 'diy', 'spouse', 'not_interested']) {
    assert.ok(keys.includes(k), `core objection "${k}" present (mirrors training.html §4)`);
  }

  for (const o of rb.objections) {
    assert.ok(o.key && o.label, `objection has key+label: ${JSON.stringify(o.key)}`);
    assert.ok(Array.isArray(o.say) && o.say.length >= 1, `${o.key}: has "say" lines`);
    assert.ok(Array.isArray(o.never) && o.never.length >= 1, `${o.key}: has "never" lines`);
    for (const line of [...o.say, ...o.never]) {
      assert.equal(typeof line, 'string');
      assert.ok(line.trim().length > 0, `${o.key}: no empty script lines`);
    }
  }
});

test('no-discounts policy: no "say" line scripts a discount, member rate, or pressure close', () => {
  const rb = loadBrowserGlobal();
  const sayLines = [
    rb.opener.script,
    rb.compliance.script,
    ...rb.objections.flatMap((o) => o.say),
  ];
  for (const line of sayLines) {
    assert.ok(
      !BANNED_IN_SAY.test(line),
      `banned discount/pressure language in a SAY line: ${JSON.stringify(line)}`,
    );
  }
});

test('spouse objection sells the CA 3-day cancel, never a now-or-never close', () => {
  const rb = loadBrowserGlobal();
  const spouse = rb.objections.find((o) => o.key === 'spouse');
  assert.ok(spouse, 'spouse objection exists');
  assert.match(spouse.say.join(' '), /three business days/i);
  assert.match(spouse.never.join(' '), /only good right now/i, 'the pressure close is explicitly banned');
});

test('rebuttals.js is plain-script (no ESM syntax) so index.html + fake-dom can run it', () => {
  const src = fs.readFileSync(FILE, 'utf8');
  assert.ok(!/^\s*(import|export)\s/m.test(src), 'must not use import/export');
  // And it parses standalone in a bare sandbox (no DOM, no OfflineQueue).
  assert.ok(loadBrowserGlobal(), 'evaluates with only window in scope');
});
