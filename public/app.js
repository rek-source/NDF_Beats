/* ============================================================================
 * NDF Beats — Rep iPad SPA (SPEC §7)
 * Owned by: frontend. Talks to backend /api per SPEC §5. Writes via OfflineQueue.
 *
 * Flow:
 *   bootstrap rep  ->  GET /api/reps/:id/beats  ->  pick active beat
 *   GET /api/beats/:id (ordered targets)  ->  render map + list
 *   tap door  ->  sheet  ->  disposition
 *     non-sold:  queue POST /api/knocks                       (offline-safe)
 *     sold:      queue POST /api/knocks(sold) -> package pick
 *                -> queue POST /api/sales -> open agreement_url (new tab)
 *
 * Rep discovery: no "list reps" endpoint exists in the frozen contract, so we
 * derive the roster from GET /api/scoreboard (leaderboard[].rep_id/name) and
 * let the user pick. Selection persists in localStorage. ?rep=<id> overrides.
 * ==========================================================================*/

(function () {
  'use strict';

  // ------------------------------------------------------------------ const
  var API = location.pathname.replace(/\/[^/]*$/, '') + '/api';
  var REP_KEY = 'ndfbeats.rep_id';
  var THEME_KEY = 'ndfbeats.theme';

  // Status -> pin class (SPEC §7 palette). Keyed by last knock disposition.
  var DISP_PIN = {
    not_home: 'not_home',
    refused: 'refused',
    not_interested: 'not_interested',
    callback: 'callback',
    sold: 'sold'
  };
  var DISP_LABEL = {
    not_home: 'Not home',
    refused: 'Refused',
    callback: 'Callback',
    not_interested: 'Not interested',
    sold: 'Sold'
  };

  // Package catalog mirrors backend config (display only; price is server-authoritative).
  var PACKAGES = [
    { key: 'essential',  name: 'Essential',  price: '$15/mo', sub: 'Core seasonal Care Plan' },
    { key: 'preferred',  name: 'Preferred',  price: '$30/mo', sub: 'Priority service + included visits' },
    { key: 'total_home', name: 'Total Home', price: '$69/mo', sub: 'Whole-home coverage, top priority' }
  ];

  // ------------------------------------------------------------------ state
  var state = {
    rep: null,            // { id, name }
    beats: [],            // beat summaries
    beat: null,           // active beat { id, name, city, county, status, center }
    targets: [],          // ordered targets w/ live last_disposition
    targetById: {},       // id -> target
    markerById: {},       // target id -> leaflet marker
    activeTargetId: null, // open in sheet
    map: null
  };

  // ------------------------------------------------------------------ dom
  var $ = function (id) { return document.getElementById(id); };
  var els = {};
  function cacheEls() {
    [
      'app', 'repName', 'beatName', 'beatSub', 'kpiKnocked', 'kpiAnswered', 'kpiSold',
      'listScroll', 'listCount', 'conn', 'connLabel', 'pending', 'themeToggle',
      'scrim', 'sheetAddr', 'sheetSub', 'sheetClose', 'sheetScore', 'sheetFactors',
      'sheetLast', 'phaseDisp', 'phasePkg', 'pkgGrid', 'pkgBack', 'sheetNote',
      'sheetStatus', 'toast', 'curtain', 'curtainSpinner', 'curtainTitle',
      'curtainMsg', 'curtainSlot'
    ].forEach(function (id) { els[id] = $(id); });
  }

  // ------------------------------------------------------------------ net
  function api(path, opts) {
    return fetch(API + path, opts).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) {
          var msg = (data && data.error) || ('HTTP ' + res.status);
          var err = new Error(msg);
          err.status = res.status;
          throw err;
        }
        return data;
      });
    });
  }

  // ------------------------------------------------------------------ ui bits
  var toastTimer = null;
  function toast(msg, isErr) {
    els.toast.textContent = msg;
    els.toast.classList.toggle('err', !!isErr);
    els.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { els.toast.classList.remove('show'); }, 2600);
  }

  function curtain(title, msg, busy) {
    els.curtainTitle.textContent = title;
    els.curtainMsg.textContent = msg || '';
    els.curtainSpinner.style.display = busy ? '' : 'none';
    els.curtainSlot.innerHTML = '';
    els.curtain.classList.remove('hidden');
  }
  function hideCurtain() { els.curtain.classList.add('hidden'); }

  function scoreClass(s) { return s >= 75 ? 'hi' : (s >= 50 ? 'mid' : 'lo'); }

  // ------------------------------------------------------------------ theme
  function initTheme() {
    var saved = localStorage.getItem(THEME_KEY);
    if (saved === 'std' || saved === 'hc') {
      document.documentElement.setAttribute('data-theme', saved === 'hc' ? 'hc' : '');
      if (saved === 'std') document.documentElement.removeAttribute('data-theme');
    } // else keep markup default (hc)
    syncThemeBtn();
    els.themeToggle.addEventListener('click', function () {
      var isHc = document.documentElement.getAttribute('data-theme') === 'hc';
      if (isHc) {
        document.documentElement.removeAttribute('data-theme');
        localStorage.setItem(THEME_KEY, 'std');
      } else {
        document.documentElement.setAttribute('data-theme', 'hc');
        localStorage.setItem(THEME_KEY, 'hc');
      }
      syncThemeBtn();
    });
  }
  function syncThemeBtn() {
    var isHc = document.documentElement.getAttribute('data-theme') === 'hc';
    els.themeToggle.textContent = isHc ? 'HC' : 'STD';
    els.themeToggle.title = isHc ? 'Sunlight (high-contrast) — tap for indoor' : 'Indoor — tap for sunlight';
  }

  // ------------------------------------------------------------------ connectivity badge
  function syncConn() {
    var online = OfflineQueue.isOnline();
    var pending = OfflineQueue.pendingCount();
    els.conn.classList.toggle('conn--offline', !online);
    els.conn.classList.toggle('conn--pending', pending > 0);
    els.connLabel.textContent = online ? 'Online' : 'Offline';
    els.pending.textContent = pending + ' pending';
  }

  // ------------------------------------------------------------------ bootstrap rep
  function bootstrap() {
    initTheme();

    // Protected writes carry the rep's bearer token; queued items flushed after a
    // re-auth pick up the fresh token (provider is read at delivery time).
    OfflineQueue.setHeadersProvider(BeatsAuth.authHeaders);
    OfflineQueue.on('auth', function () { BeatsAuth.handleUnauthorized(); });

    OfflineQueue.on('change', syncConn);
    OfflineQueue.on('online', function () { syncConn(); toast('Back online — syncing'); });
    OfflineQueue.on('offline', function () { syncConn(); toast('Offline — logging to queue', false); });
    OfflineQueue.on('delivered', syncConn);
    syncConn();

    // Identity is server-issued now: require a valid PIN session before loading a
    // beat. onAuthed fires after EVERY successful login (initial, switch-rep,
    // day-rollover re-auth); the already-valid case below loads without a login.
    BeatsAuth.onAuthed(function (rep) {
      if (state.rep && state.rep.id === rep.id && state.beat) {
        OfflineQueue.flush(); // same rep returning — resume + flush queued work
        return;
      }
      loadRep(rep.id).catch(function (e) {
        toast('Failed to load: ' + (e.message || 'error'), true);
      });
    });

    if (BeatsAuth.isValid()) {
      loadRep(BeatsAuth.getRep().id).catch(function (e) {
        toast('Failed to load: ' + (e.message || 'error'), true);
      });
    } else {
      BeatsAuth.ensureSession(); // shows login; onAuthed handles the load
    }
  }

  // ------------------------------------------------------------------ load beats
  function loadRep(repId) {
    curtain('Loading your beats…', 'Fetching today\'s assignments.', true);
    return api('/reps/' + encodeURIComponent(repId) + '/beats').then(function (data) {
      state.rep = data.rep;
      state.beats = data.beats || [];
      localStorage.setItem(REP_KEY, repId);
      els.repName.textContent = state.rep.name;

      if (state.beats.length === 0) {
        curtain('No beats assigned', state.rep.name + ' has no beats yet. Ask your manager to assign one.', false);
        return;
      }
      pickBeat();
    });
  }

  // Choose the active beat: prefer status 'active', else single, else let rep pick.
  function pickBeat() {
    var active = state.beats.filter(function (b) { return b.status === 'active'; });
    if (active.length === 1) return loadBeat(active[0].id);
    if (active.length === 0 && state.beats.length === 1) return loadBeat(state.beats[0].id);
    renderBeatPicker();
  }

  function renderBeatPicker() {
    curtain('Pick a beat', state.rep.name + ' — choose which beat to work.', false);
    var wrap = document.createElement('div');
    wrap.className = 'beat-picker';
    state.beats.forEach(function (b) {
      var btn = document.createElement('button');
      btn.className = 'beat-pick';
      btn.type = 'button';
      var prog = b.progress || { knocked: 0, remaining: b.target_count };
      var left = document.createElement('span');
      var nm = document.createElement('span'); nm.className = 'bn'; nm.textContent = b.name;
      var sub = document.createElement('span'); sub.className = 'bs';
      sub.textContent = b.city + ' · ' + b.target_count + ' doors · ' + prog.knocked + ' knocked, ' + prog.remaining + ' left';
      left.appendChild(nm); left.appendChild(document.createElement('br')); left.appendChild(sub);
      var stat = document.createElement('span');
      stat.className = 'bstat bstat--' + b.status;
      stat.textContent = b.status;
      btn.appendChild(left); btn.appendChild(stat);
      btn.addEventListener('click', function () { loadBeat(b.id); });
      wrap.appendChild(btn);
    });
    els.curtainSlot.appendChild(wrap);
  }

  function loadBeat(beatId) {
    curtain('Loading beat…', 'Plotting doors.', true);
    return api('/beats/' + encodeURIComponent(beatId)).then(function (data) {
      state.beat = data.beat;
      state.targets = (data.targets || []).slice().sort(function (a, b) { return a.seq - b.seq; });
      state.targetById = {};
      state.targets.forEach(function (t) { state.targetById[t.id] = t; });

      els.beatName.textContent = state.beat.name;
      els.beatSub.textContent = state.beat.city + ', ' + state.beat.county + ' · ' + state.beat.status;

      els.app.hidden = false;
      hideCurtain();
      renderMap();
      renderList();
      recomputeKpis();
    }).catch(function (err) {
      curtain('Failed to load beat', err.message || 'error', false);
    });
  }

  // ------------------------------------------------------------------ map
  function pinHtml(target) {
    var cls = pinClassFor(target);
    var label = target.no_soliciting ? 'NS' : String(target.seq);
    return L.divIcon({
      className: '',
      html: '<div class="pin pin--' + cls + (target.id === state.activeTargetId ? ' pin--active' : '') +
            '" title="#' + target.seq + '">' + label + '</div>',
      iconSize: [34, 34],
      iconAnchor: [17, 17]
    });
  }

  function pinClassFor(target) {
    if (target.no_soliciting && !target.last_disposition) return 'no_solicit';
    if (target.last_disposition && DISP_PIN[target.last_disposition]) {
      return DISP_PIN[target.last_disposition];
    }
    return 'unknocked';
  }

  function renderMap() {
    if (state.map) { state.map.remove(); state.map = null; }
    state.markerById = {};

    var center = state.beat.center || { lat: 37.66, lng: -121.03 };
    state.map = L.map('map', { zoomControl: true, attributionControl: true })
      .setView([center.lat, center.lng], 16);

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap'
    }).addTo(state.map);

    var bounds = [];
    state.targets.forEach(function (t) {
      var m = L.marker([t.lat, t.lng], { icon: pinHtml(t) }).addTo(state.map);
      m.on('click', function () { openSheet(t.id); });
      state.markerById[t.id] = m;
      bounds.push([t.lat, t.lng]);
    });
    if (bounds.length > 1) {
      state.map.fitBounds(bounds, { padding: [40, 40] });
    }
    // Leaflet needs a size recalculation once visible in the grid.
    setTimeout(function () { if (state.map) state.map.invalidateSize(); }, 60);
  }

  function refreshMarker(targetId) {
    var t = state.targetById[targetId];
    var m = state.markerById[targetId];
    if (t && m) m.setIcon(pinHtml(t));
  }

  // ------------------------------------------------------------------ list
  function renderList() {
    var frag = document.createDocumentFragment();
    state.targets.forEach(function (t) {
      frag.appendChild(buildRow(t));
    });
    els.listScroll.innerHTML = '';
    els.listScroll.appendChild(frag);
    updateListCount();
  }

  function buildRow(t) {
    var row = document.createElement('button');
    row.type = 'button';
    row.className = 'row' + (t.last_disposition ? ' row--done' : '') + (t.id === state.activeTargetId ? ' row--active' : '');
    row.dataset.id = t.id;

    var seq = document.createElement('span');
    seq.className = 'seq';
    seq.textContent = t.seq;

    var addr = document.createElement('span');
    addr.className = 'addr';
    var a1 = document.createElement('span'); a1.className = 'a1'; a1.textContent = t.address;
    var a2 = document.createElement('span'); a2.className = 'a2';
    a2.textContent = t.city + ' ' + t.zip;
    addr.appendChild(a1); addr.appendChild(a2);

    var meta = document.createElement('span');
    meta.className = 'meta';
    if (t.no_soliciting) {
      var ns = document.createElement('span'); ns.className = 'nosolicit'; ns.textContent = 'NO SOLICIT';
      meta.appendChild(ns);
    }
    if (t.last_disposition) {
      var dc = document.createElement('span');
      dc.className = 'dispchip dispchip--' + t.last_disposition;
      dc.textContent = DISP_LABEL[t.last_disposition] || t.last_disposition;
      meta.appendChild(dc);
    }
    var sc = document.createElement('span');
    sc.className = 'scorechip scorechip--' + scoreClass(t.score);
    sc.textContent = t.score;
    meta.appendChild(sc);

    row.appendChild(seq); row.appendChild(addr); row.appendChild(meta);
    row.addEventListener('click', function () { openSheet(t.id); });
    return row;
  }

  function refreshRow(targetId) {
    var existing = els.listScroll.querySelector('.row[data-id="' + cssEscape(targetId) + '"]');
    if (!existing) return;
    var t = state.targetById[targetId];
    var fresh = buildRow(t);
    existing.replaceWith(fresh);
  }

  function cssEscape(s) {
    if (window.CSS && CSS.escape) return CSS.escape(s);
    return String(s).replace(/[^a-zA-Z0-9_-]/g, '\\$&');
  }

  function updateListCount() {
    var done = state.targets.filter(function (t) { return !!t.last_disposition; }).length;
    els.listCount.textContent = done + ' of ' + state.targets.length;
  }

  function setActiveRow(targetId) {
    var prev = els.listScroll.querySelector('.row--active');
    if (prev) prev.classList.remove('row--active');
    if (targetId) {
      var row = els.listScroll.querySelector('.row[data-id="' + cssEscape(targetId) + '"]');
      if (row) {
        row.classList.add('row--active');
        row.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }
    }
  }

  // Next un-knocked target after the given seq (wraps to first un-knocked).
  function nextUnknocked(afterSeq) {
    var after = state.targets.filter(function (t) { return t.seq > afterSeq && !t.last_disposition; });
    if (after.length) return after[0];
    var any = state.targets.filter(function (t) { return !t.last_disposition; });
    return any.length ? any[0] : null;
  }

  // ------------------------------------------------------------------ KPIs
  // Today's mini-KPIs are computed locally from this beat's live state plus a
  // running tally of dispositions logged this session, so they update instantly
  // and survive offline. (The scoreboard page owns the authoritative team view.)
  function recomputeKpis() {
    var knocked = 0, answered = 0, sold = 0;
    state.targets.forEach(function (t) {
      if (t.last_disposition) {
        knocked++;
        if (t.last_disposition !== 'not_home') answered++;
        if (t.last_disposition === 'sold') sold++;
      }
    });
    els.kpiKnocked.textContent = knocked;
    els.kpiAnswered.textContent = answered;
    els.kpiSold.textContent = sold;
  }

  // ------------------------------------------------------------------ sheet
  function openSheet(targetId) {
    var t = state.targetById[targetId];
    if (!t) return;
    state.activeTargetId = targetId;

    els.sheetAddr.textContent = t.address;
    els.sheetSub.textContent = t.city + ' ' + t.zip + (t.no_soliciting ? '  ·  ⚠ NO SOLICITING' : '');
    els.sheetScore.textContent = t.score;

    renderFactors(t);

    if (t.last_disposition) {
      els.sheetLast.hidden = false;
      els.sheetLast.innerHTML = 'Last logged: <b>' + (DISP_LABEL[t.last_disposition] || t.last_disposition) + '</b> — logging again will update this door.';
    } else {
      els.sheetLast.hidden = true;
    }

    els.sheetNote.value = '';
    showPhase('disp');
    setStatus('');
    els.scrim.classList.add('open');

    refreshMarker(targetId);
    setActiveRow(targetId);
  }

  function renderFactors(t) {
    var f = [
      ['Est. value', t.value_usd != null ? '$' + Number(t.value_usd).toLocaleString() : '—'],
      ['Home age', (t.home_age != null ? t.home_age + ' yrs' : '—')],
      ['Owner-occupied', t.owner_occupied ? 'Yes' : 'No'],
      ['Tenure', (t.tenure_years != null ? t.tenure_years + ' yrs' : '—')]
    ];
    els.sheetFactors.innerHTML = '';
    f.forEach(function (pair) {
      var li = document.createElement('li');
      li.innerHTML = pair[0] + ': <span class="f-val"></span>';
      li.querySelector('.f-val').textContent = pair[1];
      els.sheetFactors.appendChild(li);
    });
  }

  function closeSheet() {
    els.scrim.classList.remove('open');
    var prevActive = state.activeTargetId;
    state.activeTargetId = null;
    if (prevActive) { refreshMarker(prevActive); }
    setActiveRow(null);
  }

  function showPhase(which) {
    els.phaseDisp.hidden = which !== 'disp';
    els.phasePkg.hidden = which !== 'pkg';
  }

  function setStatus(msg, kind) {
    els.sheetStatus.textContent = msg || '';
    els.sheetStatus.className = 'sheet__status' + (msg ? ' show' : '') + (kind ? ' ' + kind : '');
  }

  function setDispButtonsDisabled(disabled) {
    var btns = els.phaseDisp.querySelectorAll('.dispbtn');
    btns.forEach(function (b) { b.disabled = disabled; });
  }

  // ------------------------------------------------------------------ logging
  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    // RFC4122-ish fallback
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = (Math.random() * 16) | 0, v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  // Optimistically apply a disposition to local state so the UI advances even
  // while offline; the queue guarantees eventual server delivery.
  function applyLocalDisposition(targetId, disposition) {
    var t = state.targetById[targetId];
    if (!t) return;
    t.last_disposition = disposition;
    refreshMarker(targetId);
    refreshRow(targetId);
    updateListCount();
    recomputeKpis();
  }

  function logKnock(targetId, disposition) {
    var t = state.targetById[targetId];
    if (!t) return Promise.reject(new Error('unknown target'));

    var body = {
      beat_id: state.beat.id,
      target_id: targetId,
      // rep_id is intentionally omitted: the server attributes the knock to the
      // authenticated token's rep, never a client-supplied id.
      disposition: disposition,
      note: (els.sheetNote.value || '').trim() || undefined,
      client_uuid: uuid(),
      knocked_at: new Date().toISOString()
    };

    var q = OfflineQueue.enqueue('knock', API + '/knocks', body);
    // Optimistic local update happens regardless of network outcome.
    applyLocalDisposition(targetId, disposition);
    return q.promise; // resolves with { knock: {...} } when delivered
  }

  function handleDisposition(disposition) {
    var targetId = state.activeTargetId;
    if (!targetId) return;
    var t = state.targetById[targetId];

    if (t.no_soliciting && disposition !== 'not_home') {
      // Honor no-soliciting: allow only "not home" pass-through, warn otherwise.
      if (!confirm('This address is flagged NO SOLICITING. Log "' + DISP_LABEL[disposition] + '" anyway?')) {
        return;
      }
    }

    if (disposition === 'sold') {
      return startSold(targetId);
    }

    setDispButtonsDisabled(true);
    setStatus('Logging…');
    logKnock(targetId, disposition).then(function () {
      finishNonSold(t);
    }).catch(function (err) {
      // Queue keeps the item; surface but don't block — it will retry.
      finishNonSold(t);
      toast('Queued (will sync): ' + (err.message || ''), true);
    });
    // Don't wait on the network: advance the UI immediately (offline-first).
    finishNonSoldImmediate(t);
  }

  // Immediate (offline-first) close + advance; the network promise above only
  // adjusts the toast. We guard against double-advance with a flag.
  var advancing = false;
  function finishNonSoldImmediate(t) {
    if (advancing) return;
    advancing = true;
    var next = nextUnknocked(t.seq);
    closeSheet();
    toast(DISP_LABEL[t.last_disposition] + ' logged');
    if (next) {
      setTimeout(function () { openSheet(next.id); advancing = false; }, 220);
    } else {
      toast('Beat complete — every door logged');
      advancing = false;
    }
  }
  function finishNonSold() { /* network resolution no-op; advance already done */ }

  // ------------------------------------------------------------------ sold flow
  function startSold(targetId) {
    // The sale references the server-issued knock_id, so the package picker +
    // agreement open require connectivity. Offline: mark the door Sold, queue
    // the knock, and tell the rep to finish the agreement once reconnected.
    if (!OfflineQueue.isOnline()) {
      logKnock(targetId, 'sold'); // queued; client_uuid guarantees safe replay
      applyLocalDisposition(targetId, 'sold');
      setStatus('Offline: door marked Sold and queued. Reconnect to pick a package and open the agreement.', 'err');
      setTimeout(closeSheet, 1800);
      return;
    }

    setStatus('Recording sale — logging knock…');
    setDispButtonsDisabled(true);

    // 1) log the knock as 'sold' (queued, idempotent)
    logKnock(targetId, 'sold').then(function (knockResp) {
      var knock = knockResp && knockResp.knock;
      if (!knock || !knock.id) {
        throw new Error('no knock id returned');
      }
      showPackagePicker(targetId, knock.id);
    }).catch(function (err) {
      // If offline, the knock is queued but we have no server knock id yet, so we
      // cannot create the sale (which references knock_id). Tell the rep clearly.
      setDispButtonsDisabled(false);
      if (!OfflineQueue.isOnline()) {
        setStatus('Offline: door marked Sold and queued. Reconnect to choose a package and open the agreement.', 'err');
        // still reflect the sold disposition locally
        applyLocalDisposition(targetId, 'sold');
      } else {
        setStatus('Could not record the sale: ' + (err.message || 'error'), 'err');
      }
    });
  }

  function showPackagePicker(targetId, knockId) {
    setStatus('');
    showPhase('pkg');
    els.pkgGrid.innerHTML = '';
    PACKAGES.forEach(function (p) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'pkgbtn pkgbtn--' + p.key;
      var left = document.createElement('span');
      var nm = document.createElement('span'); nm.className = 'pkg-name'; nm.textContent = p.name;
      var sub = document.createElement('span'); sub.className = 'pkg-sub'; sub.textContent = p.sub;
      left.appendChild(nm); left.appendChild(document.createElement('br')); left.appendChild(sub);
      var price = document.createElement('span'); price.className = 'pkg-price'; price.textContent = p.price;
      b.appendChild(left); b.appendChild(price);
      b.addEventListener('click', function () { recordSale(targetId, knockId, p); });
      els.pkgGrid.appendChild(b);
    });
  }

  function recordSale(targetId, knockId, pkg) {
    setStatus('Recording ' + pkg.name + ' sale…');
    var btns = els.pkgGrid.querySelectorAll('.pkgbtn');
    btns.forEach(function (b) { b.disabled = true; });

    var body = {
      knock_id: knockId,
      package: pkg.key,
      client_uuid: uuid(),
      sold_at: new Date().toISOString()
    };

    // Sale must round-trip to the server to obtain the authoritative
    // agreement_url + amount, and the rep should open the agreement now. We
    // attempt directly (online path); the queue still guarantees durability.
    OfflineQueue.enqueue('sale', API + '/sales', body).promise.then(function (resp) {
      var sale = resp && resp.sale;
      if (!sale) throw new Error('no sale returned');
      applyLocalDisposition(targetId, 'sold');
      setStatus('Sold ' + sale.package + ' — opening agreement…', 'ok');

      // Open the EXISTING branded Care Plan agreement for e-sign + first visit.
      if (sale.agreement_url) {
        var w = window.open(sale.agreement_url, '_blank', 'noopener');
        if (!w) {
          // popup blocked — give the rep a manual link
          setStatus('Sold. Agreement link blocked by browser — tap to open.', 'ok');
          showAgreementFallback(sale.agreement_url);
          return;
        }
      }
      setTimeout(function () {
        var t = state.targetById[targetId];
        closeSheet();
        toast('Sold — ' + sale.package + ' ($' + sale.amount_usd + ')');
        var next = nextUnknocked(t ? t.seq : 0);
        if (next) setTimeout(function () { openSheet(next.id); }, 240);
      }, 600);
    }).catch(function (err) {
      btns.forEach(function (b) { b.disabled = false; });
      setStatus('Sale failed: ' + (err.message || 'error') + ' — try again.', 'err');
    });
  }

  function showAgreementFallback(url) {
    var a = document.createElement('a');
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = 'Open Care Plan agreement →';
    a.style.display = 'inline-block';
    a.style.marginTop = '8px';
    a.style.fontWeight = '700';
    els.sheetStatus.appendChild(document.createElement('br'));
    els.sheetStatus.appendChild(a);
  }

  // ------------------------------------------------------------------ events
  function wireEvents() {
    // Tapping the rep name switches rep (clears the session -> PIN login).
    if (els.repName) {
      els.repName.addEventListener('click', function () {
        if (window.BeatsAuth) BeatsAuth.switchRep();
      });
    }

    els.sheetClose.addEventListener('click', closeSheet);
    els.scrim.addEventListener('click', function (e) {
      if (e.target === els.scrim) closeSheet();
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && els.scrim.classList.contains('open')) closeSheet();
    });

    els.phaseDisp.querySelectorAll('.dispbtn').forEach(function (b) {
      b.addEventListener('click', function () { handleDisposition(b.dataset.disp); });
    });
    els.pkgBack.addEventListener('click', function () {
      showPhase('disp');
      setStatus('');
      setDispButtonsDisabled(false);
    });
  }

  // ------------------------------------------------------------------ go
  document.addEventListener('DOMContentLoaded', function () {
    cacheEls();
    wireEvents();
    bootstrap();
  });
})();
