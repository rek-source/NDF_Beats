// src/server.js
// Express bootstrap: JSON body parsing, /api/* routes, static public/ (rep app,
// scoreboard, training), health check, and error/404 handling. Runs entirely on
// the seeded SQLite DB — no external network calls (SPEC §0, §12).

import express from 'express';
import { PORT, PUBLIC_DIR } from './config.js';
import { getDb } from './db/connection.js';
import { beatsRouter } from './routes/beats.routes.js';
import { knocksRouter } from './routes/knocks.routes.js';
import { salesRouter } from './routes/sales.routes.js';
import { scoreboardRouter } from './routes/scoreboard.routes.js';
import { adminRouter } from './routes/admin.routes.js';
import { authRouter } from './routes/auth.routes.js';
import { trainingRouter } from './routes/training.routes.js';
import { requireRepToken } from './auth/middleware.js';

export function createApp() {
  const app = express();

  app.use(express.json({ limit: '256kb' }));

  // Health check (handy for the testing harness; no DB writes).
  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, service: 'ndf-beats', time: new Date().toISOString() });
  });

  // REST API (all mounted under /api).
  // Rep login is public; writes (knocks/sales) require a valid rep token so the
  // server attributes them to the token's rep_id, never the request body.
  app.use('/api', authRouter);
  app.use('/api/knocks', requireRepToken);
  app.use('/api/sales', requireRepToken);
  app.use('/api/training', requireRepToken);
  app.use('/api', trainingRouter);
  app.use('/api', beatsRouter);
  app.use('/api', knocksRouter);
  app.use('/api', salesRouter);
  app.use('/api', scoreboardRouter);
  app.use('/api', adminRouter);

  // Unknown API routes -> JSON 404 (so the frontend never gets HTML for /api).
  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'not found' });
  });

  // Static SPA assets (rep app at /, scoreboard.html, training.html, styles).
  app.use(express.static(PUBLIC_DIR, { extensions: ['html'] }));

  // Centralized error handler -> JSON envelope.
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    console.error('[error]', err);
    if (res.headersSent) return;
    res.status(500).json({ error: 'internal server error' });
  });

  return app;
}

// Start only when run directly (tests import createApp without listening).
if (import.meta.url === `file://${process.argv[1]}`) {
  // Open the DB up front so a missing/un-seeded DB fails fast and clearly.
  getDb();
  const app = createApp();
  app.listen(PORT, () => {
    console.log(`[ndf-beats] listening on http://localhost:${PORT}/`);
    console.log(`[ndf-beats] rep app: /  ·  scoreboard: /scoreboard.html  ·  training: /training.html`);
  });
}
