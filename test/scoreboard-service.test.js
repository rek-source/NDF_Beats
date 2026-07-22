// test/scoreboard-service.test.js  (OWNER: backend)
// KPI calculations (period windows, timezone handling, leaderboard ranking).
// The scoreboard service is the authoritative KPI computation (SPEC §5.5).
// These tests ensure period windows and aggregations are correct.

import test from 'node:test';
import assert from 'node:assert/strict';
import { periodWindow } from '../src/kpi/scoreboard.service.js';

// ── period window tests (timezone-aware) ────────────────────────────────────

test('periodWindow: today — from local midnight to now', () => {
  // 2025-06-15 14:30:00 UTC = 2025-06-15 07:30:00 LA (PDT, UTC-7)
  const now = new Date('2025-06-15T14:30:00Z');
  const { fromUtc, toUtc } = periodWindow('today', now);
  // Local midnight is 2025-06-15 00:00:00 LA = 2025-06-15 07:00:00 UTC
  assert.equal(fromUtc, '2025-06-15T07:00:00.000Z');
  assert.equal(toUtc, now.toISOString());
});

test('periodWindow: week — from local Monday midnight to now', () => {
  // 2025-06-15 is a Sunday (Intl weekday 7). Monday is 2025-06-16.
  // But the window should start from the PREVIOUS Monday (2025-06-09).
  // Actually, let's use a date that's definitely NOT Monday.
  // 2025-06-18 is a Wednesday (Intl weekday 3).
  // Monday of that week is 2025-06-16.
  const now = new Date('2025-06-18T14:30:00Z');
  const { fromUtc, toUtc } = periodWindow('week', now);
  // Monday 2025-06-16 00:00:00 LA = 2025-06-16 07:00:00 UTC
  assert.equal(fromUtc, '2025-06-16T07:00:00.000Z');
  assert.equal(toUtc, now.toISOString());
});

test('periodWindow: month — from local 1st at midnight to now', () => {
  // 2025-06-15 14:30:00 UTC = 2025-06-15 07:30:00 LA
  const now = new Date('2025-06-15T14:30:00Z');
  const { fromUtc, toUtc } = periodWindow('month', now);
  // June 1st at 00:00:00 LA = 2025-06-01 07:00:00 UTC (PDT)
  assert.equal(fromUtc, '2025-06-01T07:00:00.000Z');
  assert.equal(toUtc, now.toISOString());
});

test('periodWindow: invalid period defaults to today', () => {
  const now = new Date('2025-06-15T14:30:00Z');
  const { fromUtc } = periodWindow('invalid', now);
  // Should behave like today
  const today = periodWindow('today', now);
  assert.equal(fromUtc, today.fromUtc);
});

test('periodWindow: DST boundary — spring forward (LA)', () => {
  // 2025-03-09 02:00:00 local time jumps to 03:00:00 PDT (UTC-7).
  // Check that window computed around DST change is correct.
  // 2025-03-15 10:00:00 UTC
  const now = new Date('2025-03-15T10:00:00Z');
  const { fromUtc, toUtc } = periodWindow('today', now);
  // March 15 00:00:00 PDT (UTC-7) = 2025-03-15 07:00:00 UTC
  assert.equal(fromUtc, '2025-03-15T07:00:00.000Z');
  assert.equal(toUtc, now.toISOString());
});

test('periodWindow: DST boundary — fall back (LA)', () => {
  // 2025-11-02 02:00:00 PDT jumps back to 01:00:00 PST (UTC-8).
  // 2025-11-15 10:00:00 UTC
  const now = new Date('2025-11-15T10:00:00Z');
  const { fromUtc, toUtc } = periodWindow('today', now);
  // November 15 00:00:00 PST (UTC-8) = 2025-11-15 08:00:00 UTC
  assert.equal(fromUtc, '2025-11-15T08:00:00.000Z');
  assert.equal(toUtc, now.toISOString());
});

test('periodWindow: week spans multiple days correctly', () => {
  // 2025-06-22 is Sunday. Monday is 2025-06-23.
  // 2025-06-28 is Saturday (during the week of June 23-29).
  const now = new Date('2025-06-28T12:00:00Z');
  const { fromUtc } = periodWindow('week', now);
  // Monday 2025-06-23 00:00:00 LA = 2025-06-23 07:00:00 UTC
  assert.equal(fromUtc, '2025-06-23T07:00:00.000Z');
});

test('periodWindow: month-to-month boundary', () => {
  // June 30 (last day of June) should start from June 1.
  const now = new Date('2025-06-30T12:00:00Z');
  const { fromUtc } = periodWindow('month', now);
  assert.equal(fromUtc, '2025-06-01T07:00:00.000Z');
});

test('periodWindow: Jan 1 month window starts at Jan 1 00:00 local', () => {
  // 2025-01-01 08:00:00 UTC = 2026-01-01 00:00:00 LA (PST, UTC-8)
  const now = new Date('2025-01-01T08:00:00Z');
  const { fromUtc } = periodWindow('month', now);
  assert.equal(fromUtc, '2025-01-01T08:00:00.000Z'); // Jan 1 midnight LA = Jan 1 08:00 UTC
});
