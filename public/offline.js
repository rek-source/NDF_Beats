/* ============================================================================
 * NDF Beats — Offline queue + sync (SPEC §7)
 * Owned by: frontend.
 *
 * Contract:
 *  - Every knock/sale is written to a durable local queue with a client_uuid
 *    BEFORE the network attempt. Server idempotency on client_uuid makes
 *    replays safe (POST /api/knocks and /api/sales return the existing row).
 *  - A sync loop flushes the queue whenever the browser is online.
 *  - Phase 1 is best-effort queue+replay: localStorage durability, no service
 *    worker, no offline map tiles (documented in README).
 *
 * Persistence: localStorage (synchronous, durable across reloads, simple).
 *
 * Public API (window.OfflineQueue):
 *   .enqueue(kind, url, body)  -> { item, promise }
 *        kind: 'knock' | 'sale'. body MUST contain client_uuid (caller sets it).
 *        Returns the queued item and a promise that resolves with the server
 *        response for THIS item once it is successfully delivered.
 *   .flush()                   -> Promise (attempts to deliver all pending)
 *   .pendingCount()            -> number
 *   .isOnline()                -> boolean
 *   .on(event, fn)             -> subscribe: 'change' | 'online' | 'offline' | 'delivered'
 * ==========================================================================*/

(function () {
  'use strict';

  var STORAGE_KEY = 'ndfbeats.queue.v1';
  var FLUSH_INTERVAL_MS = 5000;

  // ---- durable storage -----------------------------------------------------

  function load() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch (e) {
      console.warn('[offline] queue read failed, resetting', e);
      return [];
    }
  }

  function save(items) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
    } catch (e) {
      console.error('[offline] queue write failed', e);
    }
  }

  // ---- queue state ----------------------------------------------------------

  var queue = load();          // [{ client_uuid, kind, url, body, attempts }]
  var resolvers = {};          // client_uuid -> { resolve, reject } for live callers
  var listeners = { change: [], online: [], offline: [], delivered: [], auth: [] };
  var flushing = false;
  // Provider for per-request auth headers (Authorization: Bearer <token>). The
  // app sets this; it's read at DELIVERY time so queued items flushed after a
  // re-auth carry the CURRENT token, not a stale one.
  var headersProvider = function () { return {}; };

  function emit(evt, payload) {
    (listeners[evt] || []).forEach(function (fn) {
      try { fn(payload); } catch (e) { console.error('[offline] listener error', e); }
    });
  }

  function persistAndNotify() {
    save(queue);
    emit('change', { pending: queue.length });
  }

  // ---- public: subscribe ----------------------------------------------------

  function on(evt, fn) {
    if (listeners[evt]) listeners[evt].push(fn);
  }

  // ---- public: enqueue ------------------------------------------------------

  function enqueue(kind, url, body) {
    if (!body || !body.client_uuid) {
      throw new Error('enqueue requires body.client_uuid (idempotency key)');
    }
    var item = {
      client_uuid: body.client_uuid,
      kind: kind,
      url: url,
      body: body,
      attempts: 0
    };
    queue.push(item);
    persistAndNotify();

    var promise = new Promise(function (resolve, reject) {
      resolvers[item.client_uuid] = { resolve: resolve, reject: reject };
    });

    // fire-and-forget flush; promise resolves when this item is delivered
    flush();
    return { item: item, promise: promise };
  }

  // ---- delivery -------------------------------------------------------------

  function deliver(item) {
    var headers = { 'Content-Type': 'application/json' };
    try {
      var extra = headersProvider() || {};
      for (var k in extra) { if (extra.hasOwnProperty(k)) headers[k] = extra[k]; }
    } catch (e) { /* no auth headers available */ }
    return fetch(item.url, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify(item.body)
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        return { status: res.status, ok: res.ok, data: data };
      });
    });
  }

  // Determine if a non-2xx response is permanent (drop) vs transient (retry).
  // 4xx (except 408/429) = client/contract error: dropping prevents an infinite
  // loop on a malformed item. Idempotent replays return 2xx so a previously
  // delivered item never appears as a 4xx here.
  function isPermanentFailure(status) {
    if (status >= 400 && status < 500) {
      return status !== 408 && status !== 429;
    }
    return false;
  }

  function flush() {
    if (flushing) return Promise.resolve();
    if (!navigator.onLine) return Promise.resolve();
    if (queue.length === 0) return Promise.resolve();

    flushing = true;

    // Process sequentially: sales may depend on knock ordering, and sequential
    // delivery keeps server-side ordering deterministic.
    function step() {
      if (queue.length === 0) {
        flushing = false;
        return Promise.resolve();
      }
      if (!navigator.onLine) {
        flushing = false;
        return Promise.resolve();
      }

      var item = queue[0];

      return deliver(item).then(function (resp) {
        if (resp.ok || resp.status === 200 || resp.status === 201) {
          // delivered (201 created, or 200 idempotent replay)
          queue.shift();
          persistAndNotify();
          var r = resolvers[item.client_uuid];
          if (r) { r.resolve(resp.data); delete resolvers[item.client_uuid]; }
          emit('delivered', { kind: item.kind, client_uuid: item.client_uuid, data: resp.data });
          return step();
        }

        if (resp.status === 401 || resp.status === 403) {
          // Token missing/expired/rejected. Do NOT drop the item (offline grace:
          // the rep may just need to re-auth). Pause the flush and signal the app
          // to re-authenticate; the item stays at the head of the queue and is
          // retried with a fresh token after re-login.
          item.attempts++;
          persistAndNotify();
          flushing = false;
          emit('auth', { kind: item.kind, status: resp.status });
          return Promise.resolve();
        }

        if (isPermanentFailure(resp.status)) {
          // unrecoverable: drop so the queue isn't wedged, surface to caller
          queue.shift();
          persistAndNotify();
          var rr = resolvers[item.client_uuid];
          if (rr) {
            rr.reject(new Error((resp.data && resp.data.error) || ('HTTP ' + resp.status)));
            delete resolvers[item.client_uuid];
          }
          console.error('[offline] permanent failure, dropped item', item.kind, resp);
          return step();
        }

        // transient (5xx / 408 / 429): stop, retry on next tick
        item.attempts++;
        persistAndNotify();
        flushing = false;
        return Promise.resolve();
      }).catch(function (err) {
        // network error: stop, retry on next online/interval tick
        item.attempts++;
        persistAndNotify();
        flushing = false;
        console.warn('[offline] network error, will retry', err && err.message);
        return Promise.resolve();
      });
    }

    return step();
  }

  // ---- connectivity wiring --------------------------------------------------

  window.addEventListener('online', function () {
    emit('online', {});
    flush();
  });
  window.addEventListener('offline', function () {
    emit('offline', {});
  });

  // periodic flush catches transient failures + flaky connectivity
  setInterval(function () {
    if (navigator.onLine && queue.length > 0) flush();
  }, FLUSH_INTERVAL_MS);

  // ---- expose ---------------------------------------------------------------

  window.OfflineQueue = {
    enqueue: enqueue,
    flush: flush,
    pendingCount: function () { return queue.length; },
    isOnline: function () { return navigator.onLine; },
    on: on,
    // Register a function returning extra headers (e.g. Authorization) merged
    // into every delivery. Read at delivery time so re-auth refreshes the token.
    setHeadersProvider: function (fn) { if (typeof fn === 'function') headersProvider = fn; }
  };

  // attempt an initial flush in case items survived a reload while online
  if (navigator.onLine && queue.length > 0) {
    setTimeout(flush, 250);
  }
})();
