// test/server-error-handler.test.js  (OWNER: backend)
// The app-level error handler is the last line of defense: any middleware/route
// that throws must return the JSON envelope {error:'internal server error'},
// never leak an HTML stack trace to the rep app. express.json() is the first
// middleware, so a malformed JSON body throws a parse error that propagates
// straight to it — a deterministic way to exercise the handler (no route needed).

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';

const TMP_DB = path.join(os.tmpdir(), `ndf-beats-errh-${randomUUID()}.db`);
process.env.DB_PATH = TMP_DB;
process.env.PORT = '0';

const { migrate } = await import('../src/db/migrate.js');
const { closeDb } = await import('../src/db/connection.js');
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

test('a malformed JSON body returns the 500 JSON envelope, not HTML', async () => {
  const res = await fetch(`${baseUrl}/api/knocks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{ this is not valid json ',
  });
  assert.equal(res.status, 500);
  assert.match(res.headers.get('content-type') || '', /application\/json/);
  const json = await res.json();
  assert.equal(json.error, 'internal server error');
});
