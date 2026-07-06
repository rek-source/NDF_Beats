// test/helpers/fake-dom.js  (OWNER: frontend)
// Minimal DOM + browser-globals harness so the REAL public/*.js field-flow
// bundle (offline.js, auth.js, app.js) can run unmodified inside `node --test`
// against a live server — no jsdom/puppeteer dependency (repo policy: no
// external test deps). It implements exactly the DOM surface those three
// files use: getElementById, create/appendChild/replaceWith, classList,
// dataset, innerHTML (parsed), querySelector(All) with tag/#id/.class/[attr]
// compound + descendant selectors, event listeners, and click().
//
// It is NOT a general DOM. If app.js grows new DOM usage, extend this shim —
// the e2e test failing loudly is the point.

import fs from 'node:fs';
import vm from 'node:vm';
import nodeCrypto from 'node:crypto';

const VOID_TAGS = new Set(['br', 'meta', 'link', 'img', 'input', 'hr', 'source']);
const RAW_TEXT_TAGS = new Set(['script', 'style']);

function decodeEntities(s) {
  return s
    .replace(/&rarr;/g, '→')
    .replace(/&larr;/g, '←')
    .replace(/&copy;/g, '©')
    .replace(/&times;/g, '×')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');
}

function dataAttrToCamel(name) {
  // 'data-disp' -> 'disp', 'data-foo-bar' -> 'fooBar'
  return name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

// ---------------------------------------------------------------------------
// Elements
// ---------------------------------------------------------------------------

export class FakeElement {
  constructor(doc, tagName) {
    this._doc = doc;
    this.tagName = String(tagName).toUpperCase();
    this.isFragment = false;
    this.children = [];       // FakeElement | string (text node)
    this.parentNode = null;
    this.id = '';
    this._className = '';
    this.dataset = {};
    this.attrs = {};          // non-class/id/data-* attributes
    this.style = {};
    this.listeners = {};
    this.hidden = false;
    this.disabled = false;
    this.value = '';
    this.type = '';
    this.title = '';

    const el = this;
    this.classList = {
      _list() {
        return el._className.split(/\s+/).filter(Boolean);
      },
      contains(c) { return this._list().includes(c); },
      add(...cs) {
        const list = this._list();
        for (const c of cs) if (!list.includes(c)) list.push(c);
        el._className = list.join(' ');
      },
      remove(...cs) {
        el._className = this._list().filter((x) => !cs.includes(x)).join(' ');
      },
      toggle(c, force) {
        const has = this.contains(c);
        const want = force === undefined ? !has : !!force;
        if (want && !has) this.add(c);
        if (!want && has) this.remove(c);
        return want;
      },
    };
  }

  get className() { return this._className; }
  set className(v) { this._className = String(v); }

  get textContent() {
    let out = '';
    for (const c of this.children) out += typeof c === 'string' ? c : c.textContent;
    return out;
  }

  set textContent(v) {
    this.children = v == null || v === '' ? [] : [String(v)];
  }

  set innerHTML(html) {
    this.children = [];
    const nodes = parseFragment(this._doc, String(html));
    for (const n of nodes) this.appendChild(n);
  }

  get innerHTML() { return this.textContent; } // nothing in the app reads markup back

  setAttribute(name, value) {
    if (name === 'id') this.id = String(value);
    else if (name === 'class') this._className = String(value);
    else if (name.startsWith('data-')) this.dataset[dataAttrToCamel(name)] = String(value);
    else if (name === 'hidden') this.hidden = true;
    else if (name === 'disabled') this.disabled = true;
    else this.attrs[name] = String(value);
  }

  getAttribute(name) {
    if (name === 'id') return this.id || null;
    if (name === 'class') return this._className || null;
    if (name.startsWith('data-')) {
      const v = this.dataset[dataAttrToCamel(name)];
      return v === undefined ? null : v;
    }
    return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null;
  }

  removeAttribute(name) {
    if (name === 'id') this.id = '';
    else if (name === 'class') this._className = '';
    else if (name.startsWith('data-')) delete this.dataset[dataAttrToCamel(name)];
    else delete this.attrs[name];
  }

  appendChild(node) {
    if (typeof node !== 'string' && node.isFragment) {
      const kids = node.children.slice();
      node.children = [];
      for (const k of kids) this.appendChild(k);
      return node;
    }
    if (typeof node !== 'string') {
      if (node.parentNode) node.remove();
      node.parentNode = this;
    }
    this.children.push(node);
    return node;
  }

  removeChild(node) {
    const i = this.children.indexOf(node);
    if (i !== -1) {
      this.children.splice(i, 1);
      if (typeof node !== 'string') node.parentNode = null;
    }
    return node;
  }

  remove() {
    if (this.parentNode) this.parentNode.removeChild(this);
  }

  replaceWith(node) {
    const p = this.parentNode;
    if (!p) return;
    const i = p.children.indexOf(this);
    if (node.parentNode) node.remove();
    p.children[i] = node;
    node.parentNode = p;
    this.parentNode = null;
  }

  addEventListener(type, fn) {
    (this.listeners[type] ||= []).push(fn);
  }

  removeEventListener(type, fn) {
    if (this.listeners[type]) {
      this.listeners[type] = this.listeners[type].filter((f) => f !== fn);
    }
  }

  dispatchEvent(type, evt = {}) {
    const e = { type, target: this, ...evt };
    for (const fn of (this.listeners[type] || []).slice()) fn(e);
    return e;
  }

  /** Browser-faithful: click on a disabled button fires nothing. */
  click() {
    if (this.disabled && (this.tagName === 'BUTTON' || this.tagName === 'INPUT')) return;
    this.dispatchEvent('click');
  }

  scrollIntoView() { /* layout no-op */ }

  // ---- selectors ----

  *descendants() {
    for (const c of this.children) {
      if (typeof c === 'string') continue;
      yield c;
      yield* c.descendants();
    }
  }

  querySelectorAll(selector) {
    const parts = String(selector).trim().split(/\s+/).map(parseCompound);
    const last = parts[parts.length - 1];
    const out = [];
    for (const el of this.descendants()) {
      if (!matchesCompound(el, last)) continue;
      // earlier parts must match an ancestor chain, in order, above `el`
      let need = parts.length - 2;
      let anc = el.parentNode;
      while (need >= 0 && anc) {
        if (matchesCompound(anc, parts[need])) need--;
        anc = anc.parentNode;
      }
      if (need < 0 || parts.length === 1) out.push(el);
    }
    return out;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }
}

class FakeFragment extends FakeElement {
  constructor(doc) {
    super(doc, '#fragment');
    this.isFragment = true;
  }
}

// ---------------------------------------------------------------------------
// Selector engine (tag, #id, .class, [attr="value"], descendant combinator)
// ---------------------------------------------------------------------------

function parseCompound(part) {
  const out = { tag: null, ids: [], classes: [], attrs: [] };
  let s = part;
  const tagMatch = /^[a-zA-Z][\w-]*/.exec(s);
  if (tagMatch) {
    out.tag = tagMatch[0].toUpperCase();
    s = s.slice(tagMatch[0].length);
  }
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '#') {
      const m = /^[\w\\-]+/.exec(s.slice(i + 1));
      out.ids.push(m[0].replace(/\\/g, ''));
      i += 1 + m[0].length;
    } else if (c === '.') {
      const m = /^[\w\\-]+/.exec(s.slice(i + 1));
      out.classes.push(m[0].replace(/\\/g, ''));
      i += 1 + m[0].length;
    } else if (c === '[') {
      const end = s.indexOf(']', i);
      const inner = s.slice(i + 1, end);
      const eq = inner.indexOf('=');
      if (eq === -1) out.attrs.push({ name: inner.trim(), value: null });
      else {
        out.attrs.push({
          name: inner.slice(0, eq).trim(),
          value: inner.slice(eq + 1).trim().replace(/^["']|["']$/g, '').replace(/\\/g, ''),
        });
      }
      i = end + 1;
    } else {
      throw new Error(`fake-dom: unsupported selector token '${c}' in '${part}'`);
    }
  }
  return out;
}

function matchesCompound(el, c) {
  if (!(el instanceof FakeElement) || el.isFragment) return false;
  if (c.tag && el.tagName !== c.tag) return false;
  for (const id of c.ids) if (el.id !== id) return false;
  for (const cls of c.classes) if (!el.classList.contains(cls)) return false;
  for (const a of c.attrs) {
    const actual = el.getAttribute(a.name);
    if (a.value === null ? actual === null : actual !== a.value) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// HTML parser (subset: what index.html + the app's innerHTML templates use)
// ---------------------------------------------------------------------------

export function parseFragment(doc, html) {
  const root = new FakeFragment(doc);
  const stack = [root];
  let i = 0;

  const top = () => stack[stack.length - 1];

  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt === -1) {
      const text = decodeEntities(html.slice(i));
      if (text) top().appendChild(text);
      break;
    }
    if (lt > i) {
      const text = decodeEntities(html.slice(i, lt));
      if (text) top().appendChild(text);
    }
    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt);
      i = end === -1 ? html.length : end + 3;
      continue;
    }
    if (html.startsWith('<!', lt)) { // doctype
      i = html.indexOf('>', lt) + 1;
      continue;
    }
    if (html.startsWith('</', lt)) {
      const end = html.indexOf('>', lt);
      const name = html.slice(lt + 2, end).trim().toUpperCase();
      for (let s = stack.length - 1; s > 0; s--) {
        if (stack[s].tagName === name) { stack.length = s; break; }
      }
      i = end + 1;
      continue;
    }

    // open tag
    const end = html.indexOf('>', lt);
    const rawTag = html.slice(lt + 1, end);
    const selfClosed = rawTag.endsWith('/');
    const inner = selfClosed ? rawTag.slice(0, -1) : rawTag;
    const nameMatch = /^[a-zA-Z][\w-]*/.exec(inner);
    if (!nameMatch) { i = end + 1; continue; }
    const tagName = nameMatch[0].toLowerCase();
    const el = new FakeElement(doc, tagName);

    // attributes: name="value" | name='value' | bare name
    const attrRe = /([a-zA-Z_:][\w:.-]*)(?:\s*=\s*("([^"]*)"|'([^']*)'|[^\s"'>]+))?/g;
    const attrStr = inner.slice(nameMatch[0].length);
    let m;
    while ((m = attrRe.exec(attrStr)) !== null) {
      const name = m[1];
      let value = m[2];
      if (value === undefined) { el.setAttribute(name, ''); continue; }
      if (m[3] !== undefined) value = m[3];
      else if (m[4] !== undefined) value = m[4];
      el.setAttribute(name, decodeEntities(value));
      if (name === 'type') el.type = value;
      if (name === 'title') el.title = decodeEntities(value);
      if (name === 'value') el.value = value;
    }

    top().appendChild(el);
    i = end + 1;

    if (RAW_TEXT_TAGS.has(tagName)) {
      // capture raw content (not parsed, not executed here)
      const close = html.indexOf(`</${tagName}`, i);
      const stop = close === -1 ? html.length : close;
      const raw = html.slice(i, stop);
      if (raw) el.appendChild(raw);
      i = stop === html.length ? stop : html.indexOf('>', stop) + 1;
      continue;
    }
    if (!VOID_TAGS.has(tagName) && !selfClosed) stack.push(el);
  }

  return root.children.slice();
}

// ---------------------------------------------------------------------------
// Document
// ---------------------------------------------------------------------------

export class FakeDocument {
  constructor(html) {
    this.hidden = false;
    this.listeners = {};
    const nodes = parseFragment(this, html);
    this.documentElement =
      nodes.find((n) => typeof n !== 'string' && n.tagName === 'HTML') || nodes[0];
    this.body = this.documentElement.querySelector('body');
  }

  getElementById(id) {
    if (this.documentElement.id === id) return this.documentElement;
    for (const el of this.documentElement.descendants()) {
      if (el.id === id) return el;
    }
    return null;
  }

  createElement(tag) { return new FakeElement(this, tag); }
  createDocumentFragment() { return new FakeFragment(this); }

  querySelectorAll(sel) { return this.documentElement.querySelectorAll(sel); }
  querySelector(sel) { return this.documentElement.querySelector(sel); }

  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  removeEventListener(type, fn) {
    if (this.listeners[type]) this.listeners[type] = this.listeners[type].filter((f) => f !== fn);
  }
  dispatchEvent(type, evt = {}) {
    for (const fn of (this.listeners[type] || []).slice()) fn({ type, target: this, ...evt });
  }
}

// ---------------------------------------------------------------------------
// Browser context: vm sandbox with window/document/fetch/localStorage/L/...
// ---------------------------------------------------------------------------

/**
 * Build a vm sandbox that emulates the browser environment the rep app needs.
 * @param {object} opts
 * @param {string} opts.html      raw index.html markup
 * @param {string} opts.baseUrl   live server origin, e.g. http://127.0.0.1:PORT
 * @returns {{ sandbox, document, navigator, opened, confirms, fireWindow, domReady, runScript }}
 */
export function createBrowserContext({ html, baseUrl }) {
  const document = new FakeDocument(html);
  const store = new Map();
  const navigator = { onLine: true };
  const winListeners = {};
  const opened = [];   // window.open(url) calls
  const confirms = []; // confirm(msg) calls (auto-accepted)

  const realFetch = globalThis.fetch;
  function fetchShim(url, opts) {
    if (!navigator.onLine) {
      return Promise.reject(new TypeError('Failed to fetch (simulated offline)'));
    }
    const abs = /^https?:/.test(url) ? url : baseUrl + url;
    return realFetch(abs, opts);
  }

  // unref'd real timers so the test process can exit with intervals pending
  const setTimeoutU = (fn, ms, ...a) => { const t = setTimeout(fn, ms, ...a); t.unref?.(); return t; };
  const setIntervalU = (fn, ms, ...a) => { const t = setInterval(fn, ms, ...a); t.unref?.(); return t; };

  // Leaflet stub — the map is presentational; the list drives the e2e flow.
  const mapStub = () => ({
    setView() { return this; },
    remove() {},
    fitBounds() {},
    invalidateSize() {},
  });
  const L = {
    map: () => mapStub(),
    tileLayer: () => ({ addTo() { return this; } }),
    divIcon: (opts) => opts,
    marker: () => ({
      addTo() { return this; },
      on() { return this; },
      setIcon() {},
    }),
  };

  const sandbox = {
    document,
    navigator,
    location: { pathname: '/index.html', href: `${baseUrl}/index.html` },
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => { store.set(k, String(v)); },
      removeItem: (k) => { store.delete(k); },
      clear: () => store.clear(),
    },
    fetch: fetchShim,
    setTimeout: setTimeoutU,
    setInterval: setIntervalU,
    clearTimeout,
    clearInterval,
    console,
    crypto: { randomUUID: () => nodeCrypto.randomUUID() },
    confirm: (msg) => { confirms.push(msg); return true; },
    alert: () => {},
    open: (url) => { opened.push(url); return {}; },
    addEventListener: (t, fn) => { (winListeners[t] ||= []).push(fn); },
    removeEventListener: (t, fn) => {
      if (winListeners[t]) winListeners[t] = winListeners[t].filter((f) => f !== fn);
    },
    L,
    Promise,
    Error,
    TypeError,
    JSON,
    Math,
    Date,
    URLSearchParams,
  };
  sandbox.window = sandbox; // scripts do `window.OfflineQueue = ...`
  vm.createContext(sandbox);

  return {
    sandbox,
    document,
    navigator,
    opened,
    confirms,
    fireWindow(type, evt = {}) {
      for (const fn of (winListeners[type] || []).slice()) fn({ type, ...evt });
    },
    domReady() { document.dispatchEvent('DOMContentLoaded'); },
    runScript(code, filename) { vm.runInContext(code, sandbox, { filename }); },
  };
}

/**
 * Load the page's own local <script src> files (offline.js, auth.js, app.js —
 * external CDN scripts like Leaflet are stubbed) into the context, in the
 * order index.html declares them, then fire DOMContentLoaded.
 */
export function loadPageScripts(ctx, publicDir) {
  const scripts = ctx.document
    .querySelectorAll('script')
    .map((s) => s.getAttribute('src'))
    .filter((src) => src && !/^https?:|^\/\//.test(src));
  for (const src of scripts) {
    const file = src.split('?')[0];
    const code = fs.readFileSync(`${publicDir}/${file}`, 'utf8');
    ctx.runScript(code, file);
  }
  ctx.domReady();
  return scripts;
}
