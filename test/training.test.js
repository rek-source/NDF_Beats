// test/training.test.js  (OWNER: training)
// Finding #10 — certification integrity:
//   - question payloads NEVER include the answer key
//   - grading is server-side, keyed to the AUTHED rep, recorded with score +
//     curriculum version + UTC timestamp
//   - retakes throttled; an attempt grades at most once
//   - grade response reveals missed TOPICS, not the key

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';

const TMP_DB = path.join(os.tmpdir(), `ndf-beats-training-${randomUUID()}.db`);
process.env.DB_PATH = TMP_DB;
process.env.PORT = '0';
process.env.BEATS_TOKEN_SECRET = 'unit-test-secret-000000000000000000000000';

const { migrate } = await import('../src/db/migrate.js');
const { closeDb, getDb } = await import('../src/db/connection.js');
const repo = await import('../src/db/repo.js');
const { hashPin } = await import('../src/auth/pin.js');
const { QUESTION_BANK, QUIZ_SIZE, MAX_ATTEMPTS_PER_DAY, CURRICULUM_VERSION, questionById } =
  await import('../src/training/questions.js');

migrate();

const { createApp } = await import('../src/server.js');

let server;
let baseUrl;

test.before(async () => {
  const app = createApp();
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

test.after(() => {
  if (server) server.close();
  closeDb();
  for (const ext of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(TMP_DB + ext); } catch { /* ignore */ }
  }
});

async function api(method, p, body, token) {
  const res = await fetch(baseUrl + p, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* non-json */ }
  return { status: res.status, json };
}

async function newRepToken() {
  const id = `rep_${randomUUID()}`;
  repo.insertRep({ id, name: 'Trainee T', email: `t+${id}@ndf.test`, role: 'rep' });
  const { hash, salt } = hashPin('4321');
  repo.setRepPin(id, hash, salt);
  const r = await api('POST', '/api/auth/login', { rep_id: id, pin: '4321' });
  assert.equal(r.status, 200);
  return { id, token: r.json.token };
}

test('quiz endpoints require a rep token', async () => {
  assert.equal((await api('POST', '/api/training/attempt')).status, 401);
  assert.equal((await api('GET', '/api/training/status')).status, 401);
});

test('attempt serves randomized questions WITHOUT answers; bank is larger than the quiz', async () => {
  assert.ok(QUESTION_BANK.length > QUIZ_SIZE, 'bank must exceed quiz size');
  const { token } = await newRepToken();
  const r = await api('POST', '/api/training/attempt', {}, token);
  assert.equal(r.status, 201);
  assert.equal(r.json.questions.length, QUIZ_SIZE);
  for (const q of r.json.questions) {
    assert.ok(q.id && q.q && Array.isArray(q.choices));
    assert.ok(!('answer' in q), 'answer key must NEVER ship to the client');
    assert.ok(!('explain' in q));
  }
  assert.equal(r.json.curriculum_version, CURRICULUM_VERSION);
});

test('grading is server-side, recorded to the authed rep, and hides the key', async () => {
  const { id, token } = await newRepToken();
  const a = await api('POST', '/api/training/attempt', {}, token);

  // Answer everything correctly using the SERVER bank (test-side only).
  const answers = {};
  for (const q of a.json.questions) answers[q.id] = questionById(q.id).answer;
  // …but flub two on purpose.
  const flubbed = a.json.questions.slice(0, 2).map((q) => q.id);
  for (const qid of flubbed) answers[qid] = (questionById(qid).answer + 1) % 4;

  const g = await api('POST', `/api/training/attempt/${a.json.attempt_id}/grade`, { answers }, token);
  assert.equal(g.status, 200);
  assert.equal(g.json.score, QUIZ_SIZE - 2);
  assert.equal(g.json.passed, true); // 8/10
  // Missed topics only — never the correct choice.
  assert.equal(g.json.missed.length, 2);
  for (const m of g.json.missed) {
    assert.ok(m.topic);
    assert.ok(!('answer' in m));
  }
  // Cert row recorded server-side against the AUTHED rep with UTC + version.
  const cert = g.json.cert;
  assert.equal(cert.rep_id, id);
  assert.equal(cert.rep_name, 'Trainee T');
  assert.equal(cert.curriculum_version, CURRICULUM_VERSION);
  assert.match(cert.completed_at, /^\d{4}-\d{2}-\d{2}T.*Z$/);
  const row = getDb().prepare('SELECT * FROM training_certs WHERE rep_id=?').get(id);
  assert.equal(row.score, QUIZ_SIZE - 2);
  assert.equal(row.passed, 1);

  // Status reflects the recorded cert.
  const s = await api('GET', '/api/training/status', null, token);
  assert.equal(s.json.cert.passed, true);
  assert.equal(s.json.cert.attempt_no, 1);
});

test('an attempt can only be graded once; other reps cannot grade it', async () => {
  const { token } = await newRepToken();
  const other = await newRepToken();
  const a = await api('POST', '/api/training/attempt', {}, token);
  const answers = {};
  for (const q of a.json.questions) answers[q.id] = questionById(q.id).answer;

  // Another rep's token -> not found (attempt is keyed to its owner).
  const cross = await api('POST', `/api/training/attempt/${a.json.attempt_id}/grade`, { answers }, other.token);
  assert.equal(cross.status, 404);

  assert.equal((await api('POST', `/api/training/attempt/${a.json.attempt_id}/grade`, { answers }, token)).status, 200);
  const again = await api('POST', `/api/training/attempt/${a.json.attempt_id}/grade`, { answers }, token);
  assert.equal(again.status, 409);
});

test('retakes are throttled per rolling 24h', async () => {
  const { token } = await newRepToken();
  for (let i = 0; i < MAX_ATTEMPTS_PER_DAY; i++) {
    assert.equal((await api('POST', '/api/training/attempt', {}, token)).status, 201);
  }
  const over = await api('POST', '/api/training/attempt', {}, token);
  assert.equal(over.status, 429);
  assert.match(over.json.error, /attempt limit/i);
});

test('failing grade records a non-passing cert and reveals topics to restudy', async () => {
  const { id, token } = await newRepToken();
  const a = await api('POST', '/api/training/attempt', {}, token);
  const answers = {};
  for (const q of a.json.questions) answers[q.id] = (questionById(q.id).answer + 1) % 4;
  const g = await api('POST', `/api/training/attempt/${a.json.attempt_id}/grade`, { answers }, token);
  assert.equal(g.json.passed, false);
  assert.equal(g.json.score, 0);
  assert.equal(g.json.missed.length, QUIZ_SIZE);
  const row = getDb().prepare('SELECT passed FROM training_certs WHERE rep_id=?').get(id);
  assert.equal(row.passed, 0);
});

test('manager view lists recorded certs (gated)', async () => {
  const r = await fetch(baseUrl + '/api/admin/certs', { headers: { 'x-auth-user': 'mgr@khb' } });
  const json = await r.json();
  assert.equal(r.status, 200);
  assert.ok(json.certs.length >= 2);
  assert.ok(json.certs[0].rep_name);
  assert.equal((await fetch(baseUrl + '/api/admin/certs')).status, 403);
});

test('training.html includes module m8 — Your First Day: Field Ops & Safety', () => {
  const html = fs.readFileSync(path.join(process.cwd(), 'public', 'training.html'), 'utf8');
  assert.match(html, /id="m8"/, 'module m8 section exists');
  assert.match(html, /Your First Day: Field Ops (&amp;|&) Safety/, 'm8 heading present');
  assert.match(html, /#m8/, 'TOC links to m8');
});

test('training.html includes module m9 — Using the Beats App (with walk-in logging)', () => {
  const html = fs.readFileSync(path.join(process.cwd(), 'public', 'training.html'), 'utf8');
  assert.match(html, /id="m9"/, 'module m9 section exists');
  assert.match(html, /Using the Beats App/, 'm9 heading present');
  assert.match(html, /Log a walk-in/, 'walk-in logging is taught');
  assert.match(html, /#m9/, 'TOC links to m9');
});

test('training.html opens with the first-week onboarding roadmap', () => {
  const html = fs.readFileSync(path.join(process.cwd(), 'public', 'training.html'), 'utf8');
  assert.match(html, /Your first week/i, 'roadmap heading present');
  assert.match(html, /Pass the certification quiz \(80%\+\)/, 'quiz step present');
  assert.match(html, /Ride-along with a manager/, 'ride-along step present');
  assert.match(html, /Run your first solo beat/, 'solo beat step present');
  assert.match(html, /Log every door — even the no-answers/, 'log-everything step present');
  // The roadmap sits BEFORE module 01.
  assert.ok(html.indexOf('Your first week') < html.indexOf('id="m1"'), 'roadmap precedes module 01');
});

test('the client bundle no longer contains the answer key', () => {
  const js = fs.readFileSync(path.join(process.cwd(), 'public', 'training.js'), 'utf8');
  assert.ok(!/answer:\s*\d/.test(js), 'training.js must not embed answers');
  assert.ok(!/QUESTIONS\s*=/.test(js), 'training.js must not embed the bank');
  assert.match(js, /\/training\/attempt/, 'quiz must be served by the API');
});
