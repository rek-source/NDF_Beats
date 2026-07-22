// scripts/khb-projects/parse.js
// Pure helpers for extracting completed-KHB-project seed addresses from the
// KHB Brain corpus (see extract.mjs). No I/O — fully unit-testable.

const STREET_SUFFIX_RE =
  /\b(Avenue|Ave|Street|St|Drive|Dr|Lane|Ln|Court|Ct|Circle|Cir|Way|Road|Rd|Boulevard|Blvd|Place|Pl)\.?\s*$/i;

// Words that describe the PROJECT, not the place or person.
const TYPE_WORD_RE =
  /\b(full\s+home|custom\s+home|custom\s+kitchen|home\s+addition|kitchen\s+remodel|kitchen|bath(room)?s?|addition|remodel|adu|jadu|barn|custom|home|project)\b/gi;

/**
 * Candidate street tokens from a BuilderTrend job name, best first.
 * "Fiesta Ct-Masquelier-Full Home" -> ['Fiesta Ct', 'Masquelier']
 * Segments that are ONLY project-type words are dropped entirely.
 */
export function streetCandidates(jobName) {
  const segments = String(jobName || '')
    .split('-')
    .map((s) => s.replace(TYPE_WORD_RE, ' ').replace(/[+&]/g, ' ').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  const suffixed = segments.filter((s) => STREET_SUFFIX_RE.test(s));
  const rest = segments.filter((s) => !STREET_SUFFIX_RE.test(s));
  return [...suffixed, ...rest];
}

const CITY_RE = /,?\s*(Modesto|Turlock|Ceres|Oakdale|Riverbank|Salida|Tracy|Manteca|Stockton|Lodi|Ripon|Patterson|Hughson|Denair|Merced|Atwater)\b/i;
const ZIP_RE = /\b(9\d{4})\b/;

/**
 * Majority-vote a full address out of noisy corpus matches.
 * Matches are raw strings like "410 Fiesta Court Tracy, CA". Votes are counted
 * per (house number + street) key; city/zip come from the fullest variants of
 * the winner. Losing house numbers are kept as `alternatives` for human review.
 * @returns {{address, city, zip, votes, alternatives: string[]}|null}
 */
export function pickAddress(matches) {
  const tally = new Map(); // key -> { count, address, city, zip, raw: [] }
  for (const raw of matches || []) {
    const cleaned = String(raw).replace(/\s+/g, ' ').trim();
    const m = cleaned.match(/^(\d{1,5}[A-Za-z]?)\s+(.+)$/);
    if (!m) continue;
    const num = m[1];
    let rest = m[2];
    const city = (rest.match(CITY_RE) || [])[1] ?? null;
    const zip = (rest.match(ZIP_RE) || [])[1] ?? null;
    // Street = everything before the city / state / zip noise.
    rest = rest
      .replace(CITY_RE, '')
      .replace(/,?\s*(CA|Ca|California)\b\.?/g, '')
      .replace(ZIP_RE, '')
      .replace(/[,.]+\s*$/, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!rest) continue;
    const key = `${num} ${rest.toLowerCase()}`;
    const entry = tally.get(key) ?? { count: 0, address: `${num} ${rest}`, city: null, zip: null };
    entry.count += 1;
    if (city && !entry.city) entry.city = titleCase(city);
    if (zip && !entry.zip) entry.zip = zip;
    // Prefer the longest street spelling seen ("Fiesta Court" over "Fiesta Ct").
    if (`${num} ${rest}`.length > entry.address.length) entry.address = `${num} ${rest}`;
    tally.set(key, entry);
  }
  if (tally.size === 0) return null;
  const ranked = [...tally.values()].sort((a, b) => b.count - a.count);
  const winner = ranked[0];
  return {
    address: winner.address,
    city: winner.city,
    zip: winner.zip,
    votes: winner.count,
    alternatives: ranked.slice(1).map((e) => e.address),
  };
}

function titleCase(s) {
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}
