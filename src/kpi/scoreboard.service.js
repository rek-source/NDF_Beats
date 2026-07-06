// src/kpi/scoreboard.service.js
// Computes the 6 scoreboard KPIs (SPEC §5.5). All SQL is in repo.js; this file
// builds the period window, calls the aggregation repo functions, and shapes the
// frozen JSON. No better-sqlite3 here.
//
// KPI definitions (authoritative, SPEC §5.5):
//   doors_knocked = count(knocks) in period
//   doors_answered = count(knocks where answered=1); answer_rate = answered/knocked (0 if 0)
//   yeses = count(knocks where disposition='sold')
//   nos   = count(knocks where disposition IN ('refused','not_interested'))
//   avg_sale_usd = avg(sales.amount_cents)/100 in period (0 if none)
//   top_package  = package with max count (ties -> highest amount; null if none)
// Period windows are computed in America/Los_Angeles, converted to UTC for SQL.

import {
  aggregateKnocksByRep,
  aggregateTeamKnocks,
  aggregateTeamSales,
  aggregateSalesByRep,
  packageCountsTeam,
  packageCountsByRep,
} from '../db/repo.js';
import { MARKET_TIMEZONE } from '../config.js';

const VALID_PERIODS = new Set(['today', 'week', 'month']);

/**
 * Compute the [fromUtc, toUtc) ISO window for a period, anchored to the current
 * wall-clock time in the market timezone (America/Los_Angeles).
 *
 *   today -> local midnight today .. now
 *   week  -> local Monday 00:00 of this week .. now
 *   month -> local 1st 00:00 of this month .. now
 *
 * We derive the local Y/M/D and weekday using Intl (DST-correct), then find the
 * exact UTC instant of that local midnight by probing the tz offset at that date.
 *
 * @param {'today'|'week'|'month'} period
 * @param {Date} [now] - injectable clock for tests
 * @returns {{ fromUtc: string, toUtc: string }}
 */
export function periodWindow(period, now = new Date()) {
  const parts = localParts(now, MARKET_TIMEZONE);
  // Days to subtract to reach the start of the window (local).
  let dayOffset = 0;
  if (period === 'week') {
    // Intl weekday: Mon..Sun. Convert to 0=Mon..6=Sun.
    dayOffset = (parts.weekday + 6) % 7;
  }

  let startYear = parts.year;
  let startMonth = parts.month; // 1..12
  let startDay = parts.day;

  if (period === 'month') {
    startDay = 1;
  } else if (period === 'week') {
    // Walk back dayOffset calendar days using a UTC-date arithmetic trick that
    // is safe across month/year boundaries.
    const d = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
    d.setUTCDate(d.getUTCDate() - dayOffset);
    startYear = d.getUTCFullYear();
    startMonth = d.getUTCMonth() + 1;
    startDay = d.getUTCDate();
  }
  // 'today' uses parts as-is.

  const fromUtc = localMidnightToUtcISO(startYear, startMonth, startDay, MARKET_TIMEZONE);
  const toUtc = now.toISOString();
  return { fromUtc, toUtc };
}

/**
 * Extract local calendar parts (year, month 1..12, day, weekday 1=Mon..7=Sun)
 * for an instant in a given IANA timezone.
 */
function localParts(date, timeZone) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
    hour12: false,
  });
  const map = {};
  for (const p of fmt.formatToParts(date)) map[p.type] = p.value;
  const weekdayIndex = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    weekday: weekdayIndex[map.weekday],
  };
}

/**
 * Given a local wall-clock midnight (Y-M-D 00:00:00 in `timeZone`), return the
 * exact UTC instant as an ISO string. Computes the tz offset at that local time
 * (DST-correct) and applies it.
 */
function localMidnightToUtcISO(year, month, day, timeZone) {
  // Provisional UTC guess for local midnight.
  const guess = Date.UTC(year, month - 1, day, 0, 0, 0);
  // Offset (minutes) between local time and UTC at that instant.
  const offsetMin = tzOffsetMinutes(new Date(guess), timeZone);
  // local = utc + offset  =>  utc = local - offset.
  const utcMs = guess - offsetMin * 60_000;
  return new Date(utcMs).toISOString();
}

/**
 * Offset in minutes (local - UTC) for a given instant and timezone.
 * Positive east of UTC, negative west (LA is negative).
 */
function tzOffsetMinutes(date, timeZone) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const map = {};
  for (const p of fmt.formatToParts(date)) map[p.type] = p.value;
  // Reconstruct the local wall-clock as if it were UTC, then diff against the
  // real instant.
  let hour = Number(map.hour);
  if (hour === 24) hour = 0; // some engines render midnight as 24
  const asUtc = Date.UTC(
    Number(map.year),
    Number(map.month) - 1,
    Number(map.day),
    hour,
    Number(map.minute),
    Number(map.second),
  );
  return Math.round((asUtc - date.getTime()) / 60_000);
}

/** answer_rate rounded to 3dp, 0 when no knocks. */
function answerRate(knocked, answered) {
  if (!knocked) return 0;
  return Math.round((answered / knocked) * 1000) / 1000;
}

/**
 * Pick the top package from frequency rows.
 * @param {Array<{package:string, cnt:number, amount_cents:number}>} rows
 * @returns {string|null}
 */
function topPackage(rows) {
  if (!rows || rows.length === 0) return null;
  let best = null;
  for (const r of rows) {
    if (
      best === null ||
      r.cnt > best.cnt ||
      (r.cnt === best.cnt && r.amount_cents > best.amount_cents)
    ) {
      best = r;
    }
  }
  return best ? best.package : null;
}

/** avg sale in dollars (2dp), 0 when no sales. */
function avgSaleUsd(saleCount, sumCents) {
  if (!saleCount) return 0;
  return Math.round((sumCents / saleCount)) / 100;
}

/**
 * Build the full scoreboard payload for a period.
 * @param {'today'|'week'|'month'} periodInput
 * @param {Date} [now]
 * @returns {Object} SPEC §5.5 shape
 */
export function buildScoreboard(periodInput, now = new Date()) {
  const period = VALID_PERIODS.has(periodInput) ? periodInput : 'today';
  const { fromUtc, toUtc } = periodWindow(period, now);

  // ---- Team rollup ----
  const teamKnocks = aggregateTeamKnocks(fromUtc, toUtc);
  const teamSales = aggregateTeamSales(fromUtc, toUtc);
  const teamPkgs = packageCountsTeam(fromUtc, toUtc);

  const team = {
    doors_knocked: teamKnocks.doors_knocked,
    doors_answered: teamKnocks.doors_answered,
    answer_rate: answerRate(teamKnocks.doors_knocked, teamKnocks.doors_answered),
    yeses: teamKnocks.yeses,
    nos: teamKnocks.nos,
    avg_sale_usd: avgSaleUsd(teamSales.sale_count, teamSales.sum_cents),
    top_package: topPackage(teamPkgs),
  };

  // ---- Per-rep leaderboard ----
  const repKnocks = aggregateKnocksByRep(fromUtc, toUtc);
  const repSales = aggregateSalesByRep(fromUtc, toUtc);
  const repPkgs = packageCountsByRep(fromUtc, toUtc);

  const salesByRep = new Map();
  for (const s of repSales) salesByRep.set(s.rep_id, s);

  const pkgsByRep = new Map();
  for (const p of repPkgs) {
    if (!pkgsByRep.has(p.rep_id)) pkgsByRep.set(p.rep_id, []);
    pkgsByRep.get(p.rep_id).push(p);
  }

  let leaderboard = repKnocks.map((rk) => {
    const s = salesByRep.get(rk.rep_id);
    return {
      rep_id: rk.rep_id,
      name: rk.name,
      doors_knocked: rk.doors_knocked,
      doors_answered: rk.doors_answered,
      answer_rate: answerRate(rk.doors_knocked, rk.doors_answered),
      yeses: rk.yeses,
      nos: rk.nos,
      avg_sale_usd: avgSaleUsd(s?.sale_count ?? 0, s?.sum_cents ?? 0),
      top_package: topPackage(pkgsByRep.get(rk.rep_id) ?? []),
    };
  });

  // Sort: yeses desc, then answer_rate desc (SPEC §5.5).
  leaderboard.sort((a, b) => {
    if (b.yeses !== a.yeses) return b.yeses - a.yeses;
    if (b.answer_rate !== a.answer_rate) return b.answer_rate - a.answer_rate;
    return a.name.localeCompare(b.name);
  });
  leaderboard = leaderboard.map((row, i) => ({ rank: i + 1, ...row }));
  // Reorder keys so rank/name lead (matches §5.5 example ordering).
  leaderboard = leaderboard.map((row) => ({
    rep_id: row.rep_id,
    name: row.name,
    rank: row.rank,
    doors_knocked: row.doors_knocked,
    doors_answered: row.doors_answered,
    answer_rate: row.answer_rate,
    yeses: row.yeses,
    nos: row.nos,
    avg_sale_usd: row.avg_sale_usd,
    top_package: row.top_package,
  }));

  return {
    period,
    generated_at: now.toISOString(),
    team,
    leaderboard,
  };
}
