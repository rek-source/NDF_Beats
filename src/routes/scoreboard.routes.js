// src/routes/scoreboard.routes.js
// GET /api/scoreboard?period=today|week|month  (SPEC §5.5, default today)
// Delegates all computation to the KPI service.

import { Router } from 'express';
import { buildScoreboard } from '../kpi/scoreboard.service.js';

export const scoreboardRouter = Router();

scoreboardRouter.get('/scoreboard', (req, res) => {
  const period = req.query.period ?? 'today';
  // The service normalizes any invalid period back to 'today'.
  const payload = buildScoreboard(String(period));
  res.json(payload);
});
