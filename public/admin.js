/* NDF Beats — Manager Portal SPA
 * Owner: backend portal. Consumes (all gated by the central KHB login, which
 * injects X-Auth-User at the Caddy edge):
 *   GET  /api/admin/overview
 *   POST /api/admin/reps                  { name, email, role }
 *   POST /api/admin/beats/:beatId/assign  { rep_id|null }
 *   POST /api/admin/reps/:repId/pin       { pin }   (set / reset 4-digit login PIN)
 * Vanilla, no framework, no build step (loaded with defer).
 */
(function () {
  'use strict';

  var API = location.pathname.replace(/\/[^/]*$/, '') + '/api';
  var THEME_KEY = 'ndfbeats.theme'; // shared with the rep app

  var state = { data: null };
  var els = {};

  function cacheEls() {
    els.banner = document.getElementById('banner');
    els.dataStats = document.getElementById('data-stats');
    els.dataCounties = document.getElementById('data-counties');
    els.repForm = document.getElementById('rep-form');
    els.repName = document.getElementById('rep-name');
    els.repEmail = document.getElementById('rep-email');
    els.repRole = document.getElementById('rep-role');
    els.repSubmit = document.getElementById('rep-submit');
    els.repMsg = document.getElementById('rep-msg');
    els.repList = document.getElementById('rep-list');
    els.repCount = document.getElementById('rep-count');
    els.beatForm = document.getElementById('beat-form');
    els.beatName = document.getElementById('beat-name');
    els.beatCity = document.getElementById('beat-city');
    els.beatCounty = document.getElementById('beat-county');
    els.beatRep = document.getElementById('beat-rep');
    els.beatSubmit = document.getElementById('beat-submit');
    els.beatMsg = document.getElementById('beat-msg');
    els.beatsTbody = document.getElementById('beats-tbody');
    els.unassignedPill = document.getElementById('unassigned-pill');
    els.refreshBtn = document.getElementById('refresh-btn');
    els.generatedAt = document.getElementById('generated-at');
    els.profileWeights = document.getElementById('profile-weights');
    els.profileState = document.getElementById('profile-state');
    els.profileHint = document.getElementById('profile-hint');
    els.themeToggle = document.getElementById('themeToggle');
  }

  // ---- theme (sunlight high-contrast) — mirrors the rep app (app.js) ----
  function initTheme() {
    if (!els.themeToggle) return;
    var saved = localStorage.getItem(THEME_KEY);
    if (saved === 'hc') document.documentElement.setAttribute('data-theme', 'hc');
    else if (saved === 'std') document.documentElement.removeAttribute('data-theme');
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
    if (!els.themeToggle) return;
    var isHc = document.documentElement.getAttribute('data-theme') === 'hc';
    els.themeToggle.textContent = isHc ? 'HC' : 'STD';
    els.themeToggle.setAttribute('aria-pressed', isHc ? 'true' : 'false');
    els.themeToggle.title = isHc ? 'Sunlight (high-contrast) — tap for indoor' : 'Indoor — tap for sunlight';
  }

  // ---- helpers ----
  function escapeHtml(s) {
    if (s == null) return '';
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function fmtInt(n) {
    if (n == null || isNaN(n)) return '0';
    return Math.round(n).toLocaleString('en-US');
  }
  function roleLabel(r) { return r === 'manager' ? 'Manager' : 'Rep'; }
  function fmtDate(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d)) return '';
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }

  function showBanner(msg, kind) {
    if (!els.banner) return;
    // errors interrupt (assertive/alert); successes announce politely (status).
    var err = kind === 'error';
    els.banner.setAttribute('role', err ? 'alert' : 'status');
    els.banner.setAttribute('aria-live', err ? 'assertive' : 'polite');
    els.banner.textContent = msg;
    els.banner.className = 'ad-banner is-' + (kind || 'info');
    els.banner.hidden = false;
  }
  function hideBanner() { if (els.banner) els.banner.hidden = true; }

  // ---- networking ----
  function api(method, path, body) {
    return fetch(API + path, {
      method: method,
      headers: body ? { 'content-type': 'application/json', Accept: 'application/json' }
                    : { Accept: 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      cache: 'no-store'
    }).then(function (res) {
      return res.text().then(function (txt) {
        var json = null;
        try { json = txt ? JSON.parse(txt) : null; } catch (e) { /* non-json */ }
        return { status: res.status, ok: res.ok, json: json };
      });
    });
  }

  // Reload the overview, then return keyboard focus to a control in the rep list
  // (so closing an inline editor doesn't dump focus to <body>). `selector` is
  // scoped to the rep list. Resolves to loadOverview's ok flag.
  function reloadFocus(selector) {
    return loadOverview().then(function (ok) {
      var el = selector && els.repList ? els.repList.querySelector(selector) : null;
      if (el) el.focus();
      return ok;
    });
  }

  function loadProfile() {
    return api('GET', '/admin/profile').then(function (r) {
      if (r.ok) renderProfile(r.json);
    }).catch(function () { /* non-fatal */ });
  }

  function renderProfile(p) {
    if (!els.profileWeights) return;
    var signals = p.signals || [];
    var def = p.default_weights || {};
    var learned = p.weights || {};
    // scale bars to the largest weight across both sets so differences read clearly
    var max = 0;
    signals.forEach(function (s) {
      max = Math.max(max, def[s.key] || 0, learned[s.key] || 0);
    });
    if (max <= 0) max = 1;

    els.profileWeights.innerHTML = signals.map(function (s) {
      var d = def[s.key] || 0;
      var l = learned[s.key] || 0;
      var delta = l - d;
      var arrow = Math.abs(delta) < 0.005 ? '' :
        (delta > 0 ? '<span class="ad-w__delta is-up">&#9650; ' + pct(delta) + '</span>'
                   : '<span class="ad-w__delta is-down">&#9660; ' + pct(-delta) + '</span>');
      return (
        '<div class="ad-w">' +
        '  <div class="ad-w__label">' + escapeHtml(s.label) + arrow + '</div>' +
        '  <div class="ad-w__bars">' +
        '    <div class="ad-w__row"><div class="ad-w__bar ad-w__bar--default" style="width:' + (d / max * 100).toFixed(1) + '%"></div><span class="ad-w__pct">' + pct(d) + '</span></div>' +
        '    <div class="ad-w__row"><div class="ad-w__bar ad-w__bar--learned" style="width:' + (l / max * 100).toFixed(1) + '%"></div><span class="ad-w__pct">' + pct(l) + '</span></div>' +
        '  </div>' +
        '</div>'
      );
    }).join('');

    // header pill + hint reflect whether the model has learned yet
    if (els.profileState) {
      if (p.learned) {
        els.profileState.textContent = 'Learned · ' + p.learned.n_sold + ' sales · conf ' + pct(p.learned.alpha);
        els.profileState.hidden = false;
      } else {
        els.profileState.textContent = 'Default · awaiting sales';
        els.profileState.hidden = false;
      }
    }
    if (els.profileHint && !p.learned) {
      els.profileHint.innerHTML = 'How each signal is weighted when scoring a door. ' +
        'No sales logged yet &mdash; weights stay at the hand-set <em>Default</em> until ' +
        'outcomes accrue, then the <em>Learned</em> bars adapt.';
    }
  }

  function pct(x) { return Math.round((x || 0) * 100) + '%'; }

  // Resolves to true when the reload succeeded, false otherwise. Callers show a
  // transient success banner AFTER this resolves (showing it before would race
  // the hideBanner() below, which clears any stale banner once data loads).
  function loadOverview() {
    return api('GET', '/admin/overview').then(function (r) {
      if (!r.ok) {
        showBanner('Could not load overview: ' + ((r.json && r.json.error) || ('HTTP ' + r.status)), 'error');
        return false;
      }
      hideBanner();
      state.data = r.json;
      render(r.json);
      return true;
    }).catch(function (err) {
      showBanner('Network error: ' + (err && err.message ? err.message : 'unknown'), 'error');
      return false;
    });
  }

  // ---- render ----
  function render(data) {
    renderDataStatus(data.data || {}, data.unassigned_count || 0);
    renderReps(data.reps || []);
    renderBeats(data.beats || [], data.reps || []);
    renderBeatRepOptions(data.reps || []);
    renderGeneratedAt();
  }

  // Populate the Create-a-Beat "Assign to" dropdown from the same reps array
  // the team list renders (active reps only — don't assign new work to someone
  // who can't log in). Preserves the current selection across reloads.
  function renderBeatRepOptions(reps) {
    if (!els.beatRep) return;
    var current = els.beatRep.value;
    var opts = ['<option value="">— Unassigned —</option>'];
    reps.forEach(function (r) {
      if (!r.active) return;
      opts.push('<option value="' + escapeHtml(r.id) + '">' + escapeHtml(r.name) + '</option>');
    });
    els.beatRep.innerHTML = opts.join('');
    if (current) els.beatRep.value = current;
  }

  function renderGeneratedAt() {
    if (!els.generatedAt) return;
    var d = new Date();
    els.generatedAt.textContent = 'Loaded ' + d.toLocaleString('en-US', {
      month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'
    });
  }

  function renderDataStatus(d, unassigned) {
    if (els.dataStats) {
      var cells = [
        ['Scored Homes', fmtInt(d.targets || 0)],
        ['Owner-Occupied', fmtInt(d.owner_occupied || 0)],
        ['No-Soliciting', fmtInt(d.no_soliciting || 0)],
        ['Unassigned Beats', fmtInt(unassigned)]
      ];
      els.dataStats.innerHTML = cells.map(function (c) {
        return '<div class="ad-stat"><span class="ad-stat__num">' + escapeHtml(c[1]) +
          '</span><span class="ad-stat__lbl">' + escapeHtml(c[0]) + '</span></div>';
      }).join('');
    }
    if (els.dataCounties) {
      var counties = d.counties || [];
      if (!counties.length) { els.dataCounties.innerHTML = ''; return; }
      els.dataCounties.innerHTML = '<span class="ad-counties__lbl">By county:</span> ' +
        counties.map(function (c) {
          var src = c.free_assessor
            ? '<em class="ad-src ad-src--free" title="Free county assessor value/age available">FREE data</em>'
            : '<em class="ad-src ad-src--paid" title="Value/age requires paid enrichment (Tracerfy)">paid</em>';
          return '<span class="ad-tag">' + escapeHtml(c.county) + ' &middot; ' + fmtInt(c.count) + ' ' + src + '</span>';
        }).join(' ');
    }
  }

  function renderReps(reps) {
    if (els.repCount) els.repCount.textContent = '(' + reps.length + ')';
    if (!els.repList) return;
    if (!reps.length) {
      els.repList.innerHTML = '<li class="ad-empty">No reps yet. Add one to get started.</li>';
      return;
    }
    els.repList.innerHTML = reps.map(function (r) {
      var data = ' data-rep-id="' + escapeHtml(r.id) + '" data-rep-name="' + escapeHtml(r.name) + '"';
      var pinBadge = r.locked
        ? '<span class="ad-pin__badge is-locked" title="Locked out after too many wrong PINs">Locked</span>'
        : (r.pin_set
          ? '<span class="ad-pin__badge is-set" title="A login PIN is set' + (r.pin_set_at ? ' — set ' + fmtDate(r.pin_set_at) : '') + '">PIN set</span>'
          : '<span class="ad-pin__badge is-unset" title="No login PIN — this rep cannot sign in yet">No PIN</span>');
      var pinSetAt = (r.pin_set && r.pin_set_at)
        ? '<span class="ad-rep__since" title="PIN last set">set ' + escapeHtml(fmtDate(r.pin_set_at)) + '</span>' : '';
      var nm = escapeHtml(r.name);
      var pinBtn = '<button type="button" class="ad-pin__btn"' + data + ' aria-label="' +
        (r.pin_set ? 'Reset PIN for ' : 'Set PIN for ') + nm + '">' + (r.pin_set ? 'Reset PIN' : 'Set PIN') + '</button>';
      var unlockBtn = r.locked
        ? '<button type="button" class="ad-pin__unlock"' + data + ' aria-label="Unlock ' + nm + ' now">Unlock now</button>' : '';
      var editBtn = '<button type="button" class="ad-rep__edit"' + data +
        ' data-rep-email="' + escapeHtml(r.email) + '" data-rep-role="' + escapeHtml(r.role) +
        '" aria-label="Edit ' + nm + '">Edit</button>';
      var activeBtn = '<button type="button" class="ad-rep__toggle' + (r.active ? '' : ' is-reactivate') + '"' + data +
        ' data-active="' + (r.active ? '1' : '0') + '" aria-label="' + (r.active ? 'Deactivate ' : 'Reactivate ') + nm + '">' +
        (r.active ? 'Deactivate' : 'Reactivate') + '</button>';
      return (
        '<li class="ad-rep' + (r.active ? '' : ' is-inactive') + '">' +
        '<span class="ad-rep__avatar" aria-hidden="true">' + escapeHtml(initials(r.name)) + '</span>' +
        '<span class="ad-rep__main">' +
        '  <span class="ad-rep__name">' + escapeHtml(r.name) + (r.active ? '' : ' <em class="ad-rep__tag">inactive</em>') + '</span>' +
        '  <span class="ad-rep__email">' + escapeHtml(r.email) + '</span>' +
        '</span>' +
        '<span class="ad-rep__role ad-rep__role--' + escapeHtml(r.role) + '">' + escapeHtml(roleLabel(r.role)) + '</span>' +
        '<span class="ad-rep__beats">' + fmtInt(r.beat_count) + ' beat' + (r.beat_count === 1 ? '' : 's') + '</span>' +
        '<span class="ad-rep__pin">' + pinBadge + pinSetAt + pinBtn + unlockBtn + '</span>' +
        '<span class="ad-rep__actions">' + editBtn + activeBtn + '</span>' +
        '</li>'
      );
    }).join('');
  }

  function initials(name) {
    if (!name) return '?';
    // strip emoji/symbols so the avatar never shows mojibake; single-word names
    // use their first two letters rather than one lonely initial.
    var clean = String(name).replace(/[^\p{L}\p{N}\s'-]/gu, '').trim();
    if (!clean) return '?';
    var p = clean.split(/\s+/);
    var ini = p.length > 1 ? (p[0][0] + p[p.length - 1][0]) : p[0].slice(0, 2);
    return ini.toUpperCase() || '?';
  }

  function renderBeats(beats, reps) {
    if (!els.beatsTbody) return;

    var unassigned = beats.filter(function (b) { return !b.rep_id; }).length;
    if (els.unassignedPill) {
      if (unassigned > 0) {
        els.unassignedPill.textContent = unassigned + ' unassigned';
        els.unassignedPill.hidden = false;
      } else {
        els.unassignedPill.hidden = true;
      }
    }

    if (!beats.length) {
      els.beatsTbody.innerHTML = '<tr><td colspan="5" class="ad-empty">No beats generated yet.</td></tr>';
      return;
    }

    var optionsFor = function (selectedId) {
      var opts = ['<option value="">— Unassigned —</option>'];
      reps.forEach(function (r) {
        // Keep an inactive rep visible only if they're the current assignee
        // (so the dropdown shows truth); otherwise mark them so a manager won't
        // assign new work to someone who can't log in.
        if (!r.active && r.id !== selectedId) return;
        var sel = r.id === selectedId ? ' selected' : '';
        var label = escapeHtml(r.name) + (r.active ? '' : ' (inactive)');
        opts.push('<option value="' + escapeHtml(r.id) + '"' + sel + '>' + label + '</option>');
      });
      return opts.join('');
    };

    els.beatsTbody.innerHTML = beats.map(function (b) {
      // data-label drives the <=768px stacked-card reflow (td::before labels).
      return (
        '<tr' + (b.rep_id ? '' : ' class="is-unassigned"') + '>' +
        '<td class="ad-beat__name" data-label="Beat" title="' + escapeHtml(b.name) + '"><button type="button" class="ad-beat__maplink" data-beat-id="' + escapeHtml(b.id) + '" data-beat-name="' + escapeHtml(b.name) + '" title="View ' + escapeHtml(b.name) + ' on a map">' + escapeHtml(b.name) + ' <span class="ad-beat__mappin" aria-hidden="true">&#9656;</span></button>' +
          '<button type="button" class="ad-beat__rename" data-beat-id="' + escapeHtml(b.id) + '" data-beat-name="' + escapeHtml(b.name) + '" aria-label="Rename ' + escapeHtml(b.name) + '" title="Rename this beat">Rename</button></td>' +
        '<td data-label="City">' + escapeHtml(b.city) + '</td>' +
        '<td class="ad-num" data-label="Doors">' + fmtInt(b.target_count) + '</td>' +
        '<td data-label="Status"><span class="ad-status ad-status--' + escapeHtml(b.status) + '">' + escapeHtml(b.status) + '</span></td>' +
        '<td data-label="Assigned Rep"><select class="ad-assign" data-beat-id="' + escapeHtml(b.id) + '" aria-label="Assign ' + escapeHtml(b.name) + '">' +
          optionsFor(b.rep_id) + '</select></td>' +
        '</tr>'
      );
    }).join('');
  }

  // ---- actions ----
  function submitRep(e) {
    e.preventDefault();
    if (els.repMsg) { els.repMsg.textContent = ''; els.repMsg.className = 'ad-form__msg'; }
    var name = els.repName.value.trim();
    var email = els.repEmail.value.trim();
    var role = els.repRole.value;
    if (!name || !email) {
      setRepMsg('Name and email are required.', 'error');
      return;
    }
    els.repSubmit.disabled = true;
    api('POST', '/admin/reps', { name: name, email: email, role: role }).then(function (r) {
      els.repSubmit.disabled = false;
      if (r.status === 201) {
        setRepMsg('Added ' + name + '.', 'ok');
        els.repForm.reset();
        // focus after the reload settles so it can't be undone by a re-render
        loadOverview().then(function () { if (els.repName) els.repName.focus(); });
      } else {
        setRepMsg((r.json && r.json.error) || ('Failed (HTTP ' + r.status + ')'), 'error');
      }
    }).catch(function (err) {
      els.repSubmit.disabled = false;
      setRepMsg('Network error: ' + (err && err.message ? err.message : 'unknown'), 'error');
    });
  }

  // ---- Create a Beat (onboarding 2026-07-20) — mirrors submitRep ----
  function submitBeat(e) {
    e.preventDefault();
    if (els.beatMsg) { els.beatMsg.textContent = ''; els.beatMsg.className = 'ad-form__msg'; }
    var name = els.beatName.value.trim();
    var city = els.beatCity.value.trim();
    var county = els.beatCounty.value;
    var repId = els.beatRep.value || null;
    if (!name || !city) {
      setBeatMsg('Beat name and city are required.', 'error');
      return;
    }
    els.beatSubmit.disabled = true;
    api('POST', '/admin/beats', { name: name, city: city, county: county, rep_id: repId }).then(function (r) {
      els.beatSubmit.disabled = false;
      if (r.status === 201) {
        setBeatMsg('Created beat ' + name + '.', 'ok');
        els.beatForm.reset();
        loadOverview().then(function () { if (els.beatName) els.beatName.focus(); });
      } else {
        setBeatMsg((r.json && r.json.error) || ('Failed (HTTP ' + r.status + ')'), 'error');
      }
    }).catch(function (err) {
      els.beatSubmit.disabled = false;
      setBeatMsg('Network error: ' + (err && err.message ? err.message : 'unknown'), 'error');
    });
  }

  var beatMsgTimer = null;
  function setBeatMsg(msg, kind) {
    if (!els.beatMsg) return;
    els.beatMsg.textContent = msg;
    els.beatMsg.className = 'ad-form__msg is-' + (kind || 'info');
    if (beatMsgTimer) { clearTimeout(beatMsgTimer); beatMsgTimer = null; }
    if (kind === 'ok') beatMsgTimer = setTimeout(clearBeatMsg, 4000);
  }
  function clearBeatMsg() {
    if (beatMsgTimer) { clearTimeout(beatMsgTimer); beatMsgTimer = null; }
    if (els.beatMsg) { els.beatMsg.textContent = ''; els.beatMsg.className = 'ad-form__msg'; }
  }

  var repMsgTimer = null;
  function setRepMsg(msg, kind) {
    if (!els.repMsg) return;
    els.repMsg.textContent = msg;
    els.repMsg.className = 'ad-form__msg is-' + (kind || 'info');
    // A success message shouldn't linger forever while the manager does other
    // things (FT D3). Auto-clear it; errors stay until the next edit/submit.
    if (repMsgTimer) { clearTimeout(repMsgTimer); repMsgTimer = null; }
    if (kind === 'ok') repMsgTimer = setTimeout(clearRepMsg, 4000);
  }
  function clearRepMsg() {
    if (repMsgTimer) { clearTimeout(repMsgTimer); repMsgTimer = null; }
    if (els.repMsg) { els.repMsg.textContent = ''; els.repMsg.className = 'ad-form__msg'; }
  }

  function onAssignChange(e) {
    var sel = e.target;
    if (!sel.classList || !sel.classList.contains('ad-assign')) return;
    var beatId = sel.getAttribute('data-beat-id');
    var repId = sel.value || null;
    sel.disabled = true;
    api('POST', '/admin/beats/' + encodeURIComponent(beatId) + '/assign', { rep_id: repId }).then(function (r) {
      sel.disabled = false;
      if (r.ok) {
        // Show the banner AFTER the reload so loadOverview's hideBanner can't
        // race-clobber it; only if the reload itself succeeded.
        loadOverview().then(function (ok) {
          if (ok) { showBanner('Beat assignment updated.', 'ok'); setTimeout(hideBanner, 2000); }
        });
      } else {
        var msg = 'Assign failed: ' + ((r.json && r.json.error) || ('HTTP ' + r.status));
        loadOverview().then(function (ok) { if (ok) showBanner(msg, 'error'); }); // resync to truth
      }
    }).catch(function (err) {
      sel.disabled = false;
      showBanner('Network error: ' + (err && err.message ? err.message : 'unknown'), 'error');
    });
  }

  // ---- rep row actions (delegated) ----
  function onRepListClick(e) {
    if (!e.target.closest) return;
    var unlock = e.target.closest('.ad-pin__unlock');
    if (unlock) return unlockRep(unlock);
    var toggle = e.target.closest('.ad-rep__toggle');
    if (toggle) return toggleActive(toggle);
    var pin = e.target.closest('.ad-pin__btn');
    var edit = e.target.closest('.ad-rep__edit');
    if (!pin && !edit) return;
    var kind = pin ? 'pin' : 'edit';
    var repId = (pin || edit).getAttribute('data-rep-id');
    // Single editor at a time: if one is already open (on another row), close it
    // first (reload), then open the requested one by re-finding its button.
    if (document.querySelector('.ad-pin__edit, .ad-rep__edit-form')) {
      loadOverview().then(function (ok) { if (ok) openEditorFor(kind, repId); });
      return;
    }
    openEditorFor(kind, repId);
  }

  function openEditorFor(kind, repId) {
    if (!els.repList) return;
    if (document.querySelector('.ad-pin__edit, .ad-rep__edit-form')) return; // never double-open
    var sel = (kind === 'pin' ? '.ad-pin__btn' : '.ad-rep__edit') + '[data-rep-id="' + repId + '"]';
    var btn = els.repList.querySelector(sel);
    if (!btn) return;
    if (kind === 'pin') openPinEditor(btn); else openRepEditor(btn);
  }

  // ---- PIN management (set/reset with confirm + masking) ----
  function openPinEditor(btn) {
    var repId = btn.getAttribute('data-rep-id');
    var repName = btn.getAttribute('data-rep-name');
    var cell = btn.parentNode; // .ad-rep__pin
    cell.innerHTML =
      '<span class="ad-pin__edit">' +
      '<input class="ad-pin__input ad-pin__input--mask" type="tel" inputmode="numeric" maxlength="4" ' +
      'autocomplete="off" placeholder="PIN" aria-label="New 4-digit PIN for ' + escapeHtml(repName) + '">' +
      '<input class="ad-pin__input ad-pin__input--mask ad-pin__confirm" type="tel" inputmode="numeric" maxlength="4" ' +
      'autocomplete="off" placeholder="Re-enter PIN" aria-label="Confirm PIN for ' + escapeHtml(repName) + '">' +
      '<button type="button" class="ad-pin__save">Save</button>' +
      '<button type="button" class="ad-pin__cancel">Cancel</button>' +
      '</span>' +
      '<span class="ad-pin__msg" role="status"></span>';
    var input = cell.querySelector('.ad-pin__input');
    var confirm = cell.querySelector('.ad-pin__confirm');
    var save = cell.querySelector('.ad-pin__save');
    var cancel = cell.querySelector('.ad-pin__cancel');
    var msg = cell.querySelector('.ad-pin__msg');
    var digitsOnly = function (el) { el.value = el.value.replace(/\D/g, '').slice(0, 4); };
    var pinBtnSel = '.ad-pin__btn[data-rep-id="' + repId + '"]';
    var close = function () { reloadFocus(pinBtnSel); };
    input.focus();
    input.addEventListener('input', function () { digitsOnly(input); });
    confirm.addEventListener('input', function () { digitsOnly(confirm); });
    input.addEventListener('keydown', function (ev) { if (ev.key === 'Enter' && /^\d{4}$/.test(input.value)) confirm.focus(); });
    confirm.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') save.click(); });
    cell.addEventListener('keydown', function (ev) { if (ev.key === 'Escape') { ev.preventDefault(); close(); } });
    cancel.addEventListener('click', close);
    save.addEventListener('click', function () {
      var pin = input.value;
      if (!/^\d{4}$/.test(pin)) { msg.textContent = 'Enter exactly 4 digits.'; msg.className = 'ad-pin__msg is-error'; input.focus(); return; }
      if (confirm.value !== pin) { msg.textContent = 'PINs don’t match.'; msg.className = 'ad-pin__msg is-error'; confirm.focus(); return; }
      save.disabled = true; cancel.disabled = true;
      api('POST', '/admin/reps/' + encodeURIComponent(repId) + '/pin', { pin: pin }).then(function (r) {
        if (r.ok) {
          reloadFocus(pinBtnSel).then(function (ok) {
            if (ok) { showBanner('PIN updated for ' + repName + '.', 'ok'); setTimeout(hideBanner, 2000); }
          });
        } else {
          save.disabled = false; cancel.disabled = false;
          msg.textContent = (r.json && r.json.error) || ('Failed (HTTP ' + r.status + ')');
          msg.className = 'ad-pin__msg is-error';
        }
      }).catch(function (err) {
        save.disabled = false; cancel.disabled = false;
        msg.textContent = 'Network error: ' + (err && err.message ? err.message : 'unknown');
        msg.className = 'ad-pin__msg is-error';
      });
    });
  }

  // ---- Unlock now (clear a PIN lockout without forcing a reset) ----
  function unlockRep(btn) {
    var repId = btn.getAttribute('data-rep-id');
    var repName = btn.getAttribute('data-rep-name');
    btn.disabled = true;
    api('POST', '/admin/reps/' + encodeURIComponent(repId) + '/unlock', {}).then(function (r) {
      if (r.ok) {
        loadOverview().then(function (ok) {
          if (ok) { showBanner('Unlocked ' + repName + ' — they can sign in now.', 'ok'); setTimeout(hideBanner, 2000); }
        });
      } else {
        btn.disabled = false;
        showBanner('Unlock failed: ' + ((r.json && r.json.error) || ('HTTP ' + r.status)), 'error');
      }
    }).catch(function (err) {
      btn.disabled = false;
      showBanner('Network error: ' + (err && err.message ? err.message : 'unknown'), 'error');
    });
  }

  // ---- Deactivate / Reactivate ----
  function toggleActive(btn) {
    var repId = btn.getAttribute('data-rep-id');
    var repName = btn.getAttribute('data-rep-name');
    var isActive = btn.getAttribute('data-active') === '1';
    if (isActive && !window.confirm('Deactivate ' + repName + '? They will be signed out and cannot log in until reactivated.')) return;
    btn.disabled = true;
    api('PATCH', '/admin/reps/' + encodeURIComponent(repId), { active: !isActive }).then(function (r) {
      if (r.ok) {
        loadOverview().then(function (ok) {
          if (ok) { showBanner((isActive ? 'Deactivated ' : 'Reactivated ') + repName + '.', 'ok'); setTimeout(hideBanner, 2000); }
        });
      } else {
        btn.disabled = false;
        showBanner('Update failed: ' + ((r.json && r.json.error) || ('HTTP ' + r.status)), 'error');
      }
    }).catch(function (err) {
      btn.disabled = false;
      showBanner('Network error: ' + (err && err.message ? err.message : 'unknown'), 'error');
    });
  }

  // ---- Edit a rep (name / email / role) inline ----
  function openRepEditor(btn) {
    var repId = btn.getAttribute('data-rep-id');
    var name = btn.getAttribute('data-rep-name');
    var email = btn.getAttribute('data-rep-email') || '';
    var role = btn.getAttribute('data-rep-role') || 'rep';
    var li = btn.closest('.ad-rep');
    if (!li) return;
    li.classList.add('is-editing');
    li.innerHTML =
      '<form class="ad-rep__edit-form" autocomplete="off">' +
      '<input class="ad-input ad-rep__edit-name" type="text" value="' + escapeHtml(name) + '" aria-label="Name" placeholder="Full name">' +
      '<input class="ad-input ad-rep__edit-email" type="email" value="' + escapeHtml(email) + '" aria-label="Email" placeholder="Email">' +
      '<select class="ad-input ad-rep__edit-role" aria-label="Role">' +
      '<option value="rep"' + (role === 'rep' ? ' selected' : '') + '>Rep</option>' +
      '<option value="manager"' + (role === 'manager' ? ' selected' : '') + '>Manager</option>' +
      '</select>' +
      '<button type="submit" class="ad-pin__save ad-rep__edit-save">Save</button>' +
      '<button type="button" class="ad-pin__cancel ad-rep__edit-cancel">Cancel</button>' +
      '<span class="ad-pin__msg ad-rep__edit-msg" role="status"></span>' +
      '</form>';
    var form = li.querySelector('.ad-rep__edit-form');
    var nameEl = li.querySelector('.ad-rep__edit-name');
    var emailEl = li.querySelector('.ad-rep__edit-email');
    var roleEl = li.querySelector('.ad-rep__edit-role');
    var msg = li.querySelector('.ad-rep__edit-msg');
    var editBtnSel = '.ad-rep__edit[data-rep-id="' + repId + '"]';
    var close = function () { reloadFocus(editBtnSel); };
    nameEl.focus();
    li.querySelector('.ad-rep__edit-cancel').addEventListener('click', close);
    form.addEventListener('keydown', function (ev) { if (ev.key === 'Escape') { ev.preventDefault(); close(); } });
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var nm = nameEl.value.trim();
      var em = emailEl.value.trim();
      if (!nm) { msg.textContent = 'Name is required.'; msg.className = 'ad-pin__msg ad-rep__edit-msg is-error'; nameEl.focus(); return; }
      if (!em) { msg.textContent = 'Email is required.'; msg.className = 'ad-pin__msg ad-rep__edit-msg is-error'; emailEl.focus(); return; }
      // send only changed fields
      var body = {};
      if (nm !== name) body.name = nm;
      if (em !== email) body.email = em;
      if (roleEl.value !== role) body.role = roleEl.value;
      if (Object.keys(body).length === 0) { close(); return; }
      var save = li.querySelector('.ad-rep__edit-save');
      save.disabled = true;
      api('PATCH', '/admin/reps/' + encodeURIComponent(repId), body).then(function (r) {
        if (r.ok) {
          reloadFocus(editBtnSel).then(function (ok) {
            if (ok) { showBanner('Updated ' + (body.name || name) + '.', 'ok'); setTimeout(hideBanner, 2000); }
          });
        } else {
          save.disabled = false;
          msg.textContent = (r.json && r.json.error) || ('Failed (HTTP ' + r.status + ')');
          msg.className = 'ad-pin__msg ad-rep__edit-msg is-error';
        }
      }).catch(function (err) {
        save.disabled = false;
        msg.textContent = 'Network error: ' + (err && err.message ? err.message : 'unknown');
        msg.className = 'ad-pin__msg ad-rep__edit-msg is-error';
      });
    });
  }

  // Loading skeletons so the cards never flash empty before the first fetch.
  function renderSkeleton() {
    var bar = function (cls) { return '<div class="ad-skel ad-skel-line ' + (cls || '') + '"></div>'; };
    if (els.dataStats) {
      els.dataStats.innerHTML = Array.from({ length: 4 }, function () {
        return '<div class="ad-stat">' + bar('ad-skel--num') + bar() + '</div>';
      }).join('');
    }
    if (els.repList) {
      els.repList.innerHTML = Array.from({ length: 3 }, function () {
        return '<li class="ad-rep ad-rep--skel"><span class="ad-rep__avatar ad-skel"></span>' +
          '<span class="ad-rep__main">' + bar() + bar() + '</span></li>';
      }).join('');
    }
    if (els.beatsTbody) {
      els.beatsTbody.innerHTML = Array.from({ length: 4 }, function () {
        return '<tr><td colspan="5">' + bar() + '</td></tr>';
      }).join('');
    }
    if (els.profileWeights) {
      els.profileWeights.innerHTML = Array.from({ length: 4 }, function () { return bar(); }).join('');
    }
  }

  // ---- beat map (click a beat -> see its doors on a map) ----
  var beatMap = null;
  function scoreColor(s) { return s >= 75 ? '#16a34a' : (s >= 50 ? '#f59e0b' : '#9ca3af'); }

  function openBeatMap(beatId, name) {
    var scrim = document.getElementById('beatmap-scrim');
    if (!scrim || typeof L === 'undefined') return;
    var titleEl = document.getElementById('beatmap-title');
    var metaEl = document.getElementById('beatmap-meta');
    titleEl.textContent = name || 'Beat';
    metaEl.textContent = 'Loading…';
    scrim.classList.add('open');
    scrim.setAttribute('aria-hidden', 'false');
    api('GET', '/beats/' + encodeURIComponent(beatId)).then(function (r) {
      if (!r.ok || !r.json) { metaEl.textContent = 'Could not load this beat.'; return; }
      var beat = r.json.beat || {};
      var targets = (r.json.targets || []).filter(function (t) { return t.lat != null && t.lng != null; });
      metaEl.textContent = targets.length + ' door' + (targets.length === 1 ? '' : 's') +
        (beat.city ? ' · ' + beat.city : '');
      if (beatMap) { beatMap.remove(); beatMap = null; }
      var center = (beat.center && beat.center.lat != null)
        ? [beat.center.lat, beat.center.lng]
        : (targets.length ? [targets[0].lat, targets[0].lng] : [37.64, -120.99]);
      beatMap = L.map('beatmap-map', { zoomControl: true }).setView(center, 15);
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19, attribution: '&copy; OpenStreetMap contributors'
      }).addTo(beatMap);
      var pts = [];
      targets.forEach(function (t) {
        L.circleMarker([t.lat, t.lng], {
          radius: 7, color: '#ffffff', weight: 1.5, fillColor: scoreColor(t.score), fillOpacity: 0.9
        }).addTo(beatMap).bindPopup(
          '<b>' + escapeHtml(t.address || '') + '</b><br>Score ' + escapeHtml(String(t.score)) +
          (t.value_usd ? ' · $' + Number(t.value_usd).toLocaleString() : '') +
          (t.home_age != null ? ' · ' + escapeHtml(String(t.home_age)) + ' yr' : '')
        );
        pts.push([t.lat, t.lng]);
      });
      if (pts.length) beatMap.fitBounds(pts, { padding: [30, 30] });
      setTimeout(function () { if (beatMap) beatMap.invalidateSize(); }, 80);
    }).catch(function () { metaEl.textContent = 'Network error loading this beat.'; });
  }

  function closeBeatMap() {
    var scrim = document.getElementById('beatmap-scrim');
    if (scrim) { scrim.classList.remove('open'); scrim.setAttribute('aria-hidden', 'true'); }
    if (beatMap) { beatMap.remove(); beatMap = null; }
  }

  function onBeatsClick(e) {
    if (!e.target.closest) return;
    var rename = e.target.closest('.ad-beat__rename');
    if (rename) return openBeatRenamer(rename);
    var btn = e.target.closest('.ad-beat__maplink');
    if (!btn) return;
    openBeatMap(btn.getAttribute('data-beat-id'), btn.getAttribute('data-beat-name'));
  }

  // ---- Rename a beat inline (backlog #3) — mirrors openRepEditor ----
  // Auto-generated beat names ("Turlock · near El Capitan Dr N") are illegible
  // in the field; a manager renames the beat here without leaving the overview.
  function openBeatRenamer(btn) {
    var beatId = btn.getAttribute('data-beat-id');
    var name = btn.getAttribute('data-beat-name') || '';
    var cell = btn.closest('.ad-beat__name');
    if (!cell) return;
    cell.innerHTML =
      '<form class="ad-beat__edit-form" autocomplete="off">' +
      '<input class="ad-input ad-beat__edit-name" type="text" value="' + escapeHtml(name) + '" aria-label="Beat name" placeholder="Beat name">' +
      '<button type="submit" class="ad-pin__save ad-beat__edit-save">Save</button>' +
      '<button type="button" class="ad-pin__cancel ad-beat__edit-cancel">Cancel</button>' +
      '<span class="ad-pin__msg ad-beat__edit-msg" role="status"></span>' +
      '</form>';
    var form = cell.querySelector('.ad-beat__edit-form');
    var nameEl = cell.querySelector('.ad-beat__edit-name');
    var msg = cell.querySelector('.ad-beat__edit-msg');
    var renameBtnSel = '.ad-beat__rename[data-beat-id="' + beatId + '"]';
    var close = function () { reloadFocus(renameBtnSel); };
    nameEl.focus();
    cell.querySelector('.ad-beat__edit-cancel').addEventListener('click', close);
    form.addEventListener('keydown', function (ev) { if (ev.key === 'Escape') { ev.preventDefault(); close(); } });
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var nm = nameEl.value.trim();
      if (!nm) { msg.textContent = 'Beat name is required.'; msg.className = 'ad-pin__msg ad-beat__edit-msg is-error'; nameEl.focus(); return; }
      if (nm === name) { close(); return; }
      var save = cell.querySelector('.ad-beat__edit-save');
      save.disabled = true;
      api('POST', '/admin/beats/' + encodeURIComponent(beatId) + '/rename', { name: nm }).then(function (r) {
        if (r.ok) {
          reloadFocus(renameBtnSel).then(function (ok) {
            if (ok) { showBanner('Renamed beat to ' + nm + '.', 'ok'); setTimeout(hideBanner, 2000); }
          });
        } else {
          save.disabled = false;
          msg.textContent = (r.json && r.json.error) || ('Failed (HTTP ' + r.status + ')');
          msg.className = 'ad-pin__msg ad-beat__edit-msg is-error';
        }
      }).catch(function (err) {
        save.disabled = false;
        msg.textContent = 'Network error: ' + (err && err.message ? err.message : 'unknown');
        msg.className = 'ad-pin__msg ad-beat__edit-msg is-error';
      });
    });
  }

  // ---- boot ----
  function init() {
    cacheEls();
    initTheme();
    if (els.repForm) {
      els.repForm.addEventListener('submit', submitRep);
      els.repForm.addEventListener('input', clearRepMsg); // clear stale msg on edit
    }
    if (els.beatForm) {
      els.beatForm.addEventListener('submit', submitBeat);
      els.beatForm.addEventListener('input', clearBeatMsg); // clear stale msg on edit
    }
    if (els.beatsTbody) {
      els.beatsTbody.addEventListener('change', onAssignChange);
      els.beatsTbody.addEventListener('click', onBeatsClick);
    }
    var bmClose = document.getElementById('beatmap-close');
    if (bmClose) bmClose.addEventListener('click', closeBeatMap);
    var bmScrim = document.getElementById('beatmap-scrim');
    if (bmScrim) bmScrim.addEventListener('click', function (e) { if (e.target === bmScrim) closeBeatMap(); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeBeatMap(); });
    if (els.repList) els.repList.addEventListener('click', onRepListClick);
    if (els.refreshBtn) els.refreshBtn.addEventListener('click', function () { loadOverview(); loadProfile(); });
    renderSkeleton();
    loadOverview();
    loadProfile();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
