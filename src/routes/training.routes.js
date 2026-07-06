// src/routes/training.routes.js  (owner: training)
// Server-side certification (finding #10). The old flow had no integrity:
// plaintext answer key in training.js, key revealed on grade, unlimited
// retakes, self-typed client-side certificate. Now:
//   - POST /api/training/attempt          (rep token) -> randomized question set
//     drawn server-side from a larger bank; NO answers in the payload.
//   - POST /api/training/attempt/:id/grade (rep token) -> graded server-side
//     against the stored attempt; completion recorded to training_certs keyed
//     to the AUTHED rep (id, score, curriculum version, UTC timestamp).
//     The response says WHICH questions were missed (topic), never the key.
//   - GET  /api/training/status            (rep token) -> the rep's latest cert.
//   - Retakes throttled: MAX_ATTEMPTS_PER_DAY per rolling 24h.
import { Router } from 'express';
import { randomUUID, randomInt } from 'node:crypto';
import {
  insertTrainingAttempt,
  getTrainingAttempt,
  markTrainingAttemptGraded,
  countRecentTrainingAttempts,
  insertTrainingCert,
  getLatestCertForRep,
  countCertAttempts,
} from '../db/repo.js';
import {
  QUESTION_BANK, QUIZ_SIZE, PASS_THRESHOLD, MAX_ATTEMPTS_PER_DAY,
  CURRICULUM_VERSION, publicQuestion, questionById,
} from '../training/questions.js';

export const trainingRouter = Router();

/** Crypto-shuffled draw of n questions from the bank (server-side RNG). */
function drawQuestions(n) {
  const pool = QUESTION_BANK.slice();
  for (let i = pool.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, Math.min(n, pool.length));
}

// ---- POST /api/training/attempt ---------------------------------------------
trainingRouter.post('/training/attempt', (req, res) => {
  const attemptsToday = countRecentTrainingAttempts(req.repId, 24);
  if (attemptsToday >= MAX_ATTEMPTS_PER_DAY) {
    return res.status(429).json({
      error: `attempt limit reached (${MAX_ATTEMPTS_PER_DAY} per 24h) — re-study the modules and try again tomorrow`,
    });
  }

  const questions = drawQuestions(QUIZ_SIZE);
  const attempt = {
    id: `tat_${randomUUID()}`,
    rep_id: req.repId,
    question_ids: JSON.stringify(questions.map((q) => q.id)),
    curriculum_version: CURRICULUM_VERSION,
  };
  insertTrainingAttempt(attempt);

  res.status(201).json({
    attempt_id: attempt.id,
    curriculum_version: CURRICULUM_VERSION,
    pass_threshold: PASS_THRESHOLD,
    questions: questions.map(publicQuestion), // no answers, ever
  });
});

// ---- POST /api/training/attempt/:id/grade -----------------------------------
trainingRouter.post('/training/attempt/:id/grade', (req, res) => {
  const attempt = getTrainingAttempt(req.params.id);
  if (!attempt || attempt.rep_id !== req.repId) {
    return res.status(404).json({ error: 'attempt not found' });
  }
  // Atomically claim the attempt (single grade per attempt).
  if (markTrainingAttemptGraded(attempt.id) === 0) {
    return res.status(409).json({ error: 'attempt already graded' });
  }

  const questionIds = JSON.parse(attempt.question_ids);
  const answers = req.body?.answers ?? {};

  let correct = 0;
  const missed = [];
  for (const qid of questionIds) {
    const q = questionById(qid);
    if (!q) continue;
    const given = Number(answers[qid]);
    if (Number.isInteger(given) && given === q.answer) {
      correct += 1;
    } else {
      // Reveal WHAT to restudy (topic), never the correct choice.
      missed.push({ id: q.id, topic: q.topic });
    }
  }

  const total = questionIds.length;
  const pct = total > 0 ? correct / total : 0;
  const passed = pct >= PASS_THRESHOLD;

  const cert = {
    id: `cert_${randomUUID()}`,
    rep_id: req.repId,
    score: correct,
    total,
    passed: passed ? 1 : 0,
    curriculum_version: attempt.curriculum_version,
    attempt_no: countCertAttempts(req.repId, attempt.curriculum_version) + 1,
  };
  insertTrainingCert(cert);
  const recorded = getLatestCertForRep(req.repId);

  res.json({
    passed,
    score: correct,
    total,
    pct: Math.round(pct * 100),
    missed, // topics to restudy; the key stays server-side
    cert: {
      id: recorded.id,
      rep_id: recorded.rep_id,
      rep_name: req.rep?.name ?? null, // certificate name comes from the AUTHED rep
      score: recorded.score,
      total: recorded.total,
      passed: !!recorded.passed,
      curriculum_version: recorded.curriculum_version,
      attempt_no: recorded.attempt_no,
      completed_at: recorded.completed_at, // UTC, server clock
    },
  });
});

// ---- GET /api/training/status ------------------------------------------------
trainingRouter.get('/training/status', (req, res) => {
  const cert = getLatestCertForRep(req.repId);
  res.json({
    rep: { id: req.repId, name: req.rep?.name ?? null },
    curriculum_version: CURRICULUM_VERSION,
    attempts_last_24h: countRecentTrainingAttempts(req.repId, 24),
    max_attempts_per_day: MAX_ATTEMPTS_PER_DAY,
    cert: cert
      ? {
          score: cert.score, total: cert.total, passed: !!cert.passed,
          curriculum_version: cert.curriculum_version,
          attempt_no: cert.attempt_no, completed_at: cert.completed_at,
        }
      : null,
  });
});
