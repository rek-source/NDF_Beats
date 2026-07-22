// scripts/khb-projects/extract.mjs
//
// OPS TOOL — runs on Ryan's workstation ONLY (needs the khb_brain_db docker
// container). Mines completed KHB projects out of KHB Brain:
//   1. bt_invoices  -> jobs with >= $50k paid (the social-proof projects)
//   2. documents    -> full site address via regex majority-vote over the
//                      email/chat corpus (job names carry street + client only)
//   3. geocode.js   -> lat/lng (Census→Nominatim, works from a residential IP)
//
// Output: data/khb-projects.json (GITIGNORED — contains customer addresses;
// the NDF_Beats repo is public, PII never leaves this rig except to the box).
// Usage: node scripts/khb-projects/extract.mjs [--min-paid=50000] [--cities=Modesto,Turlock]

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { streetCandidates, pickAddress } from './parse.js';
import { geocodeAddress } from '../../src/adapters/geocode.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, '..', '..', 'data', 'khb-projects.json');

const argOf = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=')[1] : dflt;
};
const MIN_PAID = Number(argOf('min-paid', '50000'));
const CITIES = new Set(argOf('cities', 'Modesto,Turlock').split(',').map((c) => c.trim().toLowerCase()));

function psql(sql) {
  return execFileSync(
    'docker', ['exec', 'khb_brain_db', 'psql', '-U', 'brain', '-d', 'khb_brain', '-At', '-c', sql],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  ).trim();
}

const esc = (s) => s.replace(/'/g, "''");
const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const SUFFIXES = '(Avenue|Ave|Street|St|Drive|Dr|Lane|Ln|Court|Ct|Circle|Cir|Way|Road|Rd|Boulevard|Blvd|Place|Pl)';
const SUFFIX_TAIL_RE = new RegExp(`\\s+${SUFFIXES}\\.?$`, 'i');

function corpusMatches(token) {
  const base = token.replace(SUFFIX_TAIL_RE, '');
  const pattern = `(\\d{1,5}[A-Za-z]?\\s+${reEsc(base)}\\.?(\\s+${SUFFIXES})?\\.?[^\\n]{0,45})`;
  const sql = `
    SELECT (regexp_matches(content, $PAT$${pattern}$PAT$, 'gi'))[1]
    FROM documents WHERE content ILIKE '%${esc(base)}%' LIMIT 80`;
  const out = psql(sql);
  if (!out) return [];
  return out.split('\n')
    // Strip HTML tags/entities that ride along in email bodies, cut at the tag.
    .map((l) => l.split(/<[^>]*>?/)[0].replace(/&[a-z]+;/gi, ' ').trim())
    // KHB's own office/showroom shows up in every email signature — never a job site.
    .filter((l) => l && !/2020\s+Standiford/i.test(l));
}

async function main() {
  console.log(`═══ KHB project seed extraction (min paid $${MIN_PAID.toLocaleString()}) ═══`);
  const jobsRaw = psql(`
    SELECT entity || '|' || job_name || '|' || COALESCE(SUM(amount_paid),0)
    FROM bt_invoices GROUP BY entity, job_name
    HAVING COALESCE(SUM(amount_paid),0) >= ${MIN_PAID}
    ORDER BY SUM(amount_paid) DESC`);
  const jobs = jobsRaw.split('\n').filter(Boolean).map((l) => {
    const [entity, job_name, paid] = l.split('|');
    return { entity, job_name, paid_cents: Math.round(Number(paid) * 100) };
  });
  console.log(`${jobs.length} jobs >= $${(MIN_PAID).toLocaleString()} paid`);

  const projects = [];
  const skipped = [];
  for (const job of jobs) {
    const candidates = streetCandidates(job.job_name).slice(0, 2);
    let picked = null;
    for (const token of candidates) {
      const matches = corpusMatches(token);
      const vote = pickAddress(matches);
      // Accept a confident majority, or a weaker one that at least names a city.
      if (vote && (vote.votes >= 2 || (vote.votes === 1 && vote.city))) { picked = vote; break; }
    }
    if (!picked) {
      skipped.push({ ...job, reason: 'no address found in corpus' });
      console.log(`  ✗ ${job.job_name} — no address`);
      continue;
    }
    const inArea = picked.city && CITIES.has(picked.city.toLowerCase());
    if (!inArea) {
      skipped.push({ ...job, ...picked, reason: `outside target cities (${picked.city ?? 'city unknown'})` });
      console.log(`  – ${job.job_name} -> ${picked.address}, ${picked.city ?? '?'} (outside area)`);
      continue;
    }
    const geo = await geocodeAddress(`${picked.address}, ${picked.city}, CA${picked.zip ? ' ' + picked.zip : ''}`);
    if (!geo) {
      skipped.push({ ...job, ...picked, reason: 'geocode failed' });
      console.log(`  ✗ ${job.job_name} -> ${picked.address}, ${picked.city} (geocode failed)`);
      continue;
    }
    projects.push({
      job_name: job.job_name, entity: job.entity, paid_cents: job.paid_cents,
      address: picked.address, city: picked.city, zip: picked.zip,
      lat: geo.lat, lng: geo.lng,
      votes: picked.votes, alternatives: picked.alternatives,
    });
    console.log(`  ✓ ${job.job_name} -> ${picked.address}, ${picked.city} (${picked.votes} votes, $${Math.round(job.paid_cents / 100).toLocaleString()})`);
    await new Promise((r) => setTimeout(r, 1100)); // be polite to the geocoders
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({
    generated_at: new Date().toISOString(),
    min_paid_cents: MIN_PAID * 100,
    cities: [...CITIES],
    projects, skipped,
  }, null, 2));
  console.log(`\n${projects.length} seed projects in area, ${skipped.length} skipped -> ${OUT}`);
  console.log('REVIEW the file before ingesting — check votes/alternatives on low-confidence rows.');
}

main().catch((err) => { console.error(err); process.exit(1); });
