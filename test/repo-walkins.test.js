import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
process.env.DB_PATH = path.join(os.tmpdir(), `ndf-walkins-${randomUUID()}.db`);
const { migrate } = await import('../src/db/migrate.js');
migrate();
const repo = await import('../src/db/repo.js');
const { closeDb } = await import('../src/db/connection.js');

test.after(() => {
  closeDb();
  for (const ext of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(process.env.DB_PATH + ext); } catch { /* ignore */ }
  }
});

function makeRep() {
  const rep = { id: `rep_${randomUUID()}`, name: 'Knock Tester',
    email: `k${randomUUID()}@ndf.example`, role: 'rep', active: 1 };
  repo.insertRep(rep);
  return rep;
}

test('ensureWalkinsBeat is idempotent and returns one walkins beat per rep', () => {
  const rep = makeRep();
  const b1 = repo.ensureWalkinsBeat(rep);
  const b2 = repo.ensureWalkinsBeat(rep);
  assert.equal(b1.id, b2.id, 'same beat returned twice');
  assert.equal(b1.kind, 'walkins');
  assert.equal(b1.rep_id, rep.id);
});

test('nextSeqForBeat returns 1 then increments', () => {
  const rep = makeRep();
  const beat = repo.ensureWalkinsBeat(rep);
  assert.equal(repo.nextSeqForBeat(beat.id), 1);
  const t = `target_${randomUUID()}`;
  repo.insertTarget({ id: t, address: '1 A St', city: 'Modesto', county: 'Stanislaus',
    zip: '95350', lat: 37.6, lng: -121.0, ad_hoc: 1, score: 0 });
  repo.insertBeatTarget({ beat_id: beat.id, target_id: t, seq: 1 });
  assert.equal(repo.nextSeqForBeat(beat.id), 2);
});
