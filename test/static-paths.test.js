/**
 * Guard test: the app is served under a path prefix (Caddy mounts it at
 * `/beats/` via `uri strip_prefix /beats`). Same-app asset references
 * (stylesheets, scripts, internal page links) MUST be relative, never
 * root-absolute — an absolute `/styles/x.css` escapes the `/beats/` prefix,
 * resolves against the site root, and returns the wrong content (the khbvr
 * landing page), leaving the page unstyled with dead JS and bounced links.
 *
 * Allowed leading-slash exceptions:
 *   - External URLs:            https://..., http://..., //cdn...
 *   - Cross-surface mounts:     /gbb/...  (the agreements live at a different mount)
 *   - In-page anchors / schemes: #..., mailto:, tel:
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');

// Cross-surface mounts that legitimately live outside this app's prefix.
const ALLOWED_ABSOLUTE_PREFIXES = ['/gbb/'];

function extractRefs(html) {
  const refs = [];
  const re = /(?:href|src)\s*=\s*"([^"]*)"/gi;
  let m;
  while ((m = re.exec(html)) !== null) refs.push(m[1]);
  return refs;
}

function isOffending(ref) {
  if (!ref.startsWith('/')) return false; // relative — good
  if (ref.startsWith('//')) return false; // protocol-relative external
  if (ALLOWED_ABSOLUTE_PREFIXES.some((p) => ref.startsWith(p))) return false;
  return true; // root-absolute same-app path — breaks under the prefix mount
}

const htmlFiles = readdirSync(PUBLIC_DIR).filter((f) => f.endsWith('.html'));

test('every public HTML file exists to scan', () => {
  assert.ok(htmlFiles.length > 0, 'expected at least one HTML file in public/');
});

for (const file of htmlFiles) {
  test(`${file} uses no root-absolute same-app asset paths`, () => {
    const html = readFileSync(join(PUBLIC_DIR, file), 'utf8');
    const offenders = extractRefs(html).filter(isOffending);
    assert.deepEqual(
      offenders,
      [],
      `${file} references root-absolute same-app paths that escape the /beats/ prefix: ${JSON.stringify(offenders)}`
    );
  });
}
