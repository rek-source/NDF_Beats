/* NDF Beats — Scoreboard SPA
 * Owner: scoreboard. Consumes ONLY GET /api/scoreboard?period=today|week|month (SPEC §5.5).
 * No build step, no framework. Vanilla ES module-free script (loaded with defer).
 *
 * Response contract (frozen, SPEC §5.5):
 * {
 *   period, generated_at,
 *   team: { doors_knocked, doors_answered, answer_rate, yeses, nos, avg_sale_usd, top_package },
 *   leaderboard: [ { rep_id, name, rank, doors_knocked, doors_answered, answer_rate,
 *                    yeses, nos, avg_sale_usd, top_package } ]
 * }
 */
(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Constants
  // ---------------------------------------------------------------------------
  var POLL_MS = 20000; // live poll cadence per SPEC §8
  var API_BASE = location.pathname.replace(/\/[^/]*$/, '') + '/api/scoreboard';

  // Package display labels + ordering for "top package" emphasis.
  var PACKAGE_LABELS = {
    essential: 'Essential',
    preferred: 'Preferred',
    total_home: 'Total Home'
  };

  // Rank medal glyphs for the top 3.
  var MEDALS = { 1: '\u{1F947}', 2: '\u{1F948}', 3: '\u{1F949}' };

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------
  var state = {
    period: 'today',
    view: 'leaderboard',
    selectedRepId: null, // active rep on the Rep Boards view
    data: null, // last successful payload
    pollTimer: null,
    inFlight: null, // AbortController of the active request
    failures: 0,
    // remembers last numeric values per element for count-up animation
    lastNums: new WeakMap()
  };

  // ---------------------------------------------------------------------------
  // Element refs
  // ---------------------------------------------------------------------------
  var els = {};
  function cacheEls() {
    els.banner = document.getElementById('banner');
    els.board = document.getElementById('board');
    els.teamStrip = document.getElementById('team-strip');
    els.liveDot = document.getElementById('live-dot');
    els.liveLabel = document.getElementById('live-label');
    els.refreshBtn = document.getElementById('refresh-btn');
    els.generatedAt = document.getElementById('generated-at');

    els.viewLeaderboard = document.getElementById('view-leaderboard');
    els.viewManager = document.getElementById('view-manager');
    els.viewReps = document.getElementById('view-reps');
    els.repChips = document.getElementById('rep-chips');
    els.repBoard = document.getElementById('rep-board');
    els.repEmpty = document.getElementById('rep-empty');
    els.rbAvatar = document.getElementById('rb-avatar');
    els.rbName = document.getElementById('rb-name');
    els.rbRank = document.getElementById('rb-rank');
    els.rbKpis = document.getElementById('rb-kpis');
    els.mgrRollup = document.getElementById('mgr-rollup');
    els.mgrFunnel = document.getElementById('mgr-funnel');
    els.mgrTbody = document.getElementById('mgr-tbody');

    els.tabs = Array.prototype.slice.call(document.querySelectorAll('.sb-tab'));
    els.periods = Array.prototype.slice.call(document.querySelectorAll('.sb-period'));
  }

  // ---------------------------------------------------------------------------
  // Formatting helpers
  // ---------------------------------------------------------------------------
  function fmtInt(n) {
    if (n == null || isNaN(n)) return '0';
    return Math.round(n).toLocaleString('en-US');
  }

  function fmtUsd(n) {
    if (n == null || isNaN(n)) n = 0;
    return '$' + Number(n).toLocaleString('en-US', {
      minimumFractionDigits: 0,
      maximumFractionDigits: 0
    });
  }

  function fmtUsd2(n) {
    if (n == null || isNaN(n)) n = 0;
    return '$' + Number(n).toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    });
  }

  function fmtPct(rate) {
    if (rate == null || isNaN(rate)) rate = 0;
    return Math.round(rate * 1000) / 10 + '%';
  }

  function pkgLabel(pkg) {
    if (!pkg) return '—'; // em dash when no sales
    return PACKAGE_LABELS[pkg] || pkg;
  }

  function escapeHtml(s) {
    if (s == null) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function initials(name) {
    if (!name) return '?';
    var parts = String(name).trim().split(/\s+/);
    var a = parts[0] ? parts[0][0] : '';
    var b = parts.length > 1 ? parts[parts.length - 1][0] : '';
    return (a + b).toUpperCase() || '?';
  }

  // ---------------------------------------------------------------------------
  // Count-up animation: animates an element's text from its last numeric value
  // to the new one. Honors prefers-reduced-motion.
  // ---------------------------------------------------------------------------
  var REDUCE_MOTION = window.matchMedia &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function animateNumber(el, toValue, formatter) {
    var fmt = formatter || fmtInt;
    var from = state.lastNums.has(el) ? state.lastNums.get(el) : null;
    state.lastNums.set(el, toValue);

    if (from === null || REDUCE_MOTION || from === toValue) {
      el.textContent = fmt(toValue);
      flash(el, from !== null && from !== toValue);
      return;
    }

    var start = performance.now();
    var dur = 600;

    function step(now) {
      var t = Math.min(1, (now - start) / dur);
      // easeOutCubic
      var eased = 1 - Math.pow(1 - t, 3);
      var val = from + (toValue - from) * eased;
      el.textContent = fmt(val);
      if (t < 1) {
        requestAnimationFrame(step);
      } else {
        el.textContent = fmt(toValue);
      }
    }
    requestAnimationFrame(step);
    flash(el, true);
  }

  function flash(el, changed) {
    if (!changed) return;
    el.classList.remove('sb-flash');
    // force reflow so the animation can restart
    void el.offsetWidth;
    el.classList.add('sb-flash');
  }

  // ---------------------------------------------------------------------------
  // Networking
  // ---------------------------------------------------------------------------
  function fetchScoreboard() {
    if (state.inFlight) {
      state.inFlight.abort();
    }
    var ctrl = new AbortController();
    state.inFlight = ctrl;
    setLive('loading');

    var url = API_BASE + '?period=' + encodeURIComponent(state.period);
    return fetch(url, {
      signal: ctrl.signal,
      headers: { Accept: 'application/json' },
      cache: 'no-store'
    })
      .then(function (res) {
        return res.text().then(function (txt) {
          var body;
          try {
            body = txt ? JSON.parse(txt) : null;
          } catch (e) {
            throw new Error('Bad JSON from scoreboard API (HTTP ' + res.status + ')');
          }
          if (!res.ok) {
            var msg = body && body.error ? body.error : 'HTTP ' + res.status;
            throw new Error(msg);
          }
          return body;
        });
      })
      .then(function (body) {
        state.inFlight = null;
        state.failures = 0;
        state.data = body;
        render(body);
        setLive('live');
        hideBanner();
      })
      .catch(function (err) {
        state.inFlight = null;
        if (err && err.name === 'AbortError') return; // superseded by a newer request
        state.failures += 1;
        setLive('error');
        showBanner(
          'Could not reach the scoreboard API: ' + (err && err.message ? err.message : 'unknown error') +
            (state.data ? ' · showing last good data.' : ''),
          'error'
        );
      });
  }

  // ---------------------------------------------------------------------------
  // Live indicator + banner
  // ---------------------------------------------------------------------------
  function setLive(mode) {
    if (!els.liveDot) return;
    els.liveDot.className = 'sb-live__dot is-' + mode;
    var labels = { live: 'Live', loading: 'Updating…', error: 'Offline' };
    els.liveLabel.textContent = labels[mode] || 'Live';
  }

  function showBanner(msg, kind) {
    if (!els.banner) return;
    els.banner.textContent = msg;
    els.banner.className = 'sb-banner is-' + (kind || 'info');
    els.banner.hidden = false;
  }

  function hideBanner() {
    if (!els.banner) return;
    els.banner.hidden = true;
  }

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------
  function render(data) {
    if (!data) return;
    renderTeamStrip(data.team || {});
    renderBoard(data.leaderboard || [], data.team || {});
    renderRepBoards(data.leaderboard || []);
    renderManager(data);
    renderGeneratedAt(data.generated_at, data.period);
  }

  function renderGeneratedAt(iso, period) {
    if (!els.generatedAt) return;
    var when = '—';
    if (iso) {
      var d = new Date(iso);
      if (!isNaN(d.getTime())) {
        when = d.toLocaleString('en-US', {
          timeZone: 'America/Los_Angeles',
          month: 'short',
          day: 'numeric',
          hour: 'numeric',
          minute: '2-digit'
        }) + ' PT';
      }
    }
    var periodLabel = { today: 'Today', week: 'This Week', month: 'This Month' }[period] || period;
    els.generatedAt.textContent = periodLabel + ' · updated ' + when;
  }

  // --- Team rollup strip (the 6 KPIs) ---
  function renderTeamStrip(team) {
    fillKpiTiles(els.teamStrip, team);
  }

  // Fill a .sb-team tile grid (team strip OR a per-rep board) with the 6 KPIs.
  // `stats` has the same shape for team totals and a single leaderboard row.
  function fillKpiTiles(root, stats) {
    if (!root) return;
    var tiles = root.querySelectorAll('.sb-team__kpi');
    Array.prototype.forEach.call(tiles, function (tile) {
      var kpi = tile.getAttribute('data-kpi');
      var numEl = tile.querySelector('[data-num]');
      var subEl = tile.querySelector('[data-sub]');
      if (!numEl) return;

      switch (kpi) {
        case 'doors_knocked':
          animateNumber(numEl, stats.doors_knocked || 0, fmtInt);
          break;
        case 'doors_answered':
          animateNumber(numEl, stats.doors_answered || 0, fmtInt);
          if (subEl) subEl.textContent = fmtPct(stats.answer_rate || 0);
          break;
        case 'yeses':
          animateNumber(numEl, stats.yeses || 0, fmtInt);
          break;
        case 'nos':
          animateNumber(numEl, stats.nos || 0, fmtInt);
          break;
        case 'avg_sale_usd':
          animateNumber(numEl, stats.avg_sale_usd || 0, fmtUsd2);
          break;
        case 'top_package':
          numEl.textContent = pkgLabel(stats.top_package);
          break;
      }
    });
  }

  // --- Rep Boards: each rep their own dedicated 6-KPI board (Ryan req #1) ---
  function renderRepBoards(leaderboard) {
    if (!els.repChips) return;

    if (!leaderboard.length) {
      els.repChips.innerHTML = '';
      if (els.repBoard) els.repBoard.hidden = true;
      if (els.repEmpty) els.repEmpty.hidden = false;
      return;
    }
    if (els.repEmpty) els.repEmpty.hidden = true;
    if (els.repBoard) els.repBoard.hidden = false;

    // Default / reconcile selection: keep current rep if still present, else
    // fall back to the top-ranked rep.
    var selected = leaderboard.filter(function (r) {
      return r.rep_id === state.selectedRepId;
    })[0];
    if (!selected) {
      selected = leaderboard[0];
      state.selectedRepId = selected.rep_id;
    }

    // Selector chips (rebuilt each render; clicks handled via delegation).
    els.repChips.innerHTML = leaderboard
      .map(function (rep) {
        var on = rep.rep_id === state.selectedRepId;
        return (
          '<button type="button" class="sb-chip' + (on ? ' is-active' : '') + '"' +
          ' role="tab" aria-selected="' + (on ? 'true' : 'false') + '"' +
          ' data-rep-id="' + escapeHtml(rep.rep_id) + '">' +
          '<span class="sb-chip__rank">' + (MEDALS[rep.rank] || '#' + rep.rank) + '</span>' +
          '<span class="sb-chip__name">' + escapeHtml(rep.name || 'Unknown') + '</span>' +
          '<span class="sb-chip__yes">' + fmtInt(rep.yeses || 0) + ' yes</span>' +
          '</button>'
        );
      })
      .join('');

    // Header (avatar / name / rank line)
    if (els.rbAvatar) els.rbAvatar.textContent = initials(selected.name);
    if (els.rbName) els.rbName.textContent = selected.name || 'Unknown';
    if (els.rbRank) {
      var medal = MEDALS[selected.rank] || '';
      els.rbRank.textContent =
        'Rank ' + selected.rank + ' of ' + leaderboard.length +
        (medal ? '  ' + medal : '');
    }

    // The rep's own 6 KPIs.
    fillKpiTiles(els.rbKpis, selected);
  }

  function selectRep(repId) {
    if (!repId || repId === state.selectedRepId) return;
    state.selectedRepId = repId;
    try { localStorage.setItem('ndf_sb_rep', repId); } catch (e) {}
    // clear count-up baselines so the newly-selected rep reads fresh, not a delta
    state.lastNums = new WeakMap();
    if (state.data) renderRepBoards(state.data.leaderboard || []);
  }

  // --- Ranked rep cards ---
  function renderBoard(leaderboard, team) {
    if (!els.board) return;

    if (!leaderboard.length) {
      els.board.innerHTML =
        '<li class="sb-empty">No knocks logged for this period yet. ' +
        'Reps will appear here as they hit the doors.</li>';
      return;
    }

    // Reconcile DOM by rep_id so count-up animation persists across polls and
    // ordering changes are reflected via flexbox order.
    var existing = {};
    Array.prototype.forEach.call(els.board.querySelectorAll('.sb-rep'), function (card) {
      existing[card.getAttribute('data-rep-id')] = card;
    });

    var seen = {};
    leaderboard.forEach(function (rep) {
      seen[rep.rep_id] = true;
      var card = existing[rep.rep_id];
      if (!card) {
        card = buildRepCard(rep);
        els.board.appendChild(card);
      }
      updateRepCard(card, rep);
    });

    // remove cards for reps no longer present
    Object.keys(existing).forEach(function (id) {
      if (!seen[id]) {
        var c = existing[id];
        if (c && c.parentNode) c.parentNode.removeChild(c);
      }
    });

    // re-order DOM to match leaderboard rank
    leaderboard.forEach(function (rep) {
      var card = els.board.querySelector('.sb-rep[data-rep-id="' + cssEscape(rep.rep_id) + '"]');
      if (card) els.board.appendChild(card);
    });
  }

  function cssEscape(s) {
    if (window.CSS && CSS.escape) return CSS.escape(s);
    return String(s).replace(/["\\]/g, '\\$&');
  }

  function buildRepCard(rep) {
    var li = document.createElement('li');
    li.className = 'sb-rep';
    li.setAttribute('data-rep-id', rep.rep_id);
    li.innerHTML = [
      '<div class="sb-rep__rank"><span class="sb-rep__rank-num" data-rank></span><span class="sb-rep__medal" data-medal></span></div>',
      '<div class="sb-rep__id">',
      '  <span class="sb-rep__avatar" data-avatar></span>',
      '  <span class="sb-rep__name" data-name></span>',
      '</div>',
      '<div class="sb-rep__kpis">',
      kpiBlock('Knocked', 'knocked'),
      kpiBlock('Answered', 'answered'),
      '  <div class="sb-rep__kpi sb-rep__kpi--rate">',
      '    <span class="sb-rep__kpi-num" data-rate-num></span>',
      '    <span class="sb-rep__kpi-lbl">Answer Rate</span>',
      '    <span class="sb-rep__bar"><span class="sb-rep__bar-fill" data-rate-bar></span></span>',
      '  </div>',
      '  <div class="sb-rep__kpi sb-rep__kpi--yes">',
      '    <span class="sb-rep__kpi-num" data-yeses></span>',
      '    <span class="sb-rep__kpi-lbl">Yeses</span>',
      '  </div>',
      kpiBlock('Nos', 'nos'),
      kpiBlock('Avg Sale', 'avg'),
      '  <div class="sb-rep__kpi sb-rep__kpi--pkg">',
      '    <span class="sb-rep__kpi-num sb-rep__kpi-num--pkg" data-pkg></span>',
      '    <span class="sb-rep__kpi-lbl">Top Package</span>',
      '  </div>',
      '</div>'
    ].join('');
    return li;
  }

  function kpiBlock(label, key) {
    return (
      '  <div class="sb-rep__kpi">' +
      '    <span class="sb-rep__kpi-num" data-' + key + '></span>' +
      '    <span class="sb-rep__kpi-lbl">' + label + '</span>' +
      '  </div>'
    );
  }

  function updateRepCard(card, rep) {
    var rank = rep.rank;
    card.classList.toggle('is-leader', rank === 1);
    card.classList.toggle('is-podium', rank >= 1 && rank <= 3);

    var rankNum = card.querySelector('[data-rank]');
    var medal = card.querySelector('[data-medal]');
    if (rankNum) rankNum.textContent = rank != null ? rank : '—';
    if (medal) medal.textContent = MEDALS[rank] || '';

    var avatar = card.querySelector('[data-avatar]');
    var name = card.querySelector('[data-name]');
    if (avatar) avatar.textContent = initials(rep.name);
    if (name) name.textContent = rep.name || 'Unknown';

    animateNumber(card.querySelector('[data-knocked]'), rep.doors_knocked || 0, fmtInt);
    animateNumber(card.querySelector('[data-answered]'), rep.doors_answered || 0, fmtInt);
    animateNumber(card.querySelector('[data-nos]'), rep.nos || 0, fmtInt);
    animateNumber(card.querySelector('[data-yeses]'), rep.yeses || 0, fmtInt);
    animateNumber(card.querySelector('[data-avg]'), rep.avg_sale_usd || 0, fmtUsd2);

    var rateNum = card.querySelector('[data-rate-num]');
    if (rateNum) rateNum.textContent = fmtPct(rep.answer_rate || 0);
    var rateBar = card.querySelector('[data-rate-bar]');
    if (rateBar) {
      var pct = Math.max(0, Math.min(1, rep.answer_rate || 0)) * 100;
      rateBar.style.width = pct + '%';
    }

    var pkg = card.querySelector('[data-pkg]');
    if (pkg) pkg.textContent = pkgLabel(rep.top_package);
  }

  // --- Manager view ---
  function renderManager(data) {
    var team = data.team || {};
    var lb = data.leaderboard || [];
    renderRollup(team);
    renderFunnel(team);
    renderRepTable(lb);
  }

  function renderRollup(team) {
    if (!els.mgrRollup) return;
    var rows = [
      ['Doors Knocked', fmtInt(team.doors_knocked || 0)],
      ['Doors Answered', fmtInt(team.doors_answered || 0)],
      ['Answer Rate', fmtPct(team.answer_rate || 0)],
      ['Yeses', fmtInt(team.yeses || 0)],
      ['Nos', fmtInt(team.nos || 0)],
      ['Avg Sale', fmtUsd2(team.avg_sale_usd || 0)],
      ['Top Package', pkgLabel(team.top_package)]
    ];
    els.mgrRollup.innerHTML = rows
      .map(function (r) {
        return (
          '<div class="sb-rollup-cell">' +
          '<span class="sb-rollup-num">' + escapeHtml(r[1]) + '</span>' +
          '<span class="sb-rollup-lbl">' + escapeHtml(r[0]) + '</span>' +
          '</div>'
        );
      })
      .join('');
  }

  function renderFunnel(team) {
    if (!els.mgrFunnel) return;
    var knocked = team.doors_knocked || 0;
    var answered = team.doors_answered || 0;
    var sold = team.yeses || 0;

    function pctOf(part, whole) {
      if (!whole) return 0;
      return Math.max(0, Math.min(1, part / whole));
    }

    var stages = [
      { label: 'Knocked', value: knocked, frac: 1, note: '' },
      {
        label: 'Answered',
        value: answered,
        frac: pctOf(answered, knocked),
        note: knocked ? fmtPct(answered / knocked) + ' of knocked' : ''
      },
      {
        label: 'Sold',
        value: sold,
        frac: pctOf(sold, knocked),
        note: answered ? fmtPct(sold / answered) + ' of answered' : ''
      }
    ];

    els.mgrFunnel.innerHTML = stages
      .map(function (s) {
        var widthPct = Math.max(s.frac * 100, s.value > 0 ? 6 : 2); // keep a sliver visible
        return (
          '<div class="sb-funnel__row">' +
          '<div class="sb-funnel__meta">' +
          '<span class="sb-funnel__label">' + escapeHtml(s.label) + '</span>' +
          '<span class="sb-funnel__note">' + escapeHtml(s.note) + '</span>' +
          '</div>' +
          '<div class="sb-funnel__track">' +
          '<div class="sb-funnel__bar" style="width:' + widthPct + '%">' +
          '<span class="sb-funnel__value">' + fmtInt(s.value) + '</span>' +
          '</div>' +
          '</div>' +
          '</div>'
        );
      })
      .join('');
  }

  function renderRepTable(lb) {
    if (!els.mgrTbody) return;
    if (!lb.length) {
      els.mgrTbody.innerHTML =
        '<tr><td colspan="9" class="sb-table__empty">No rep activity for this period.</td></tr>';
      return;
    }
    els.mgrTbody.innerHTML = lb
      .map(function (rep) {
        return (
          '<tr' + (rep.rank === 1 ? ' class="is-leader"' : '') + '>' +
          '<td class="sb-table__rank">' + escapeHtml(rep.rank) + '</td>' +
          '<td>' + escapeHtml(rep.name || 'Unknown') + '</td>' +
          '<td class="sb-num-col">' + fmtInt(rep.doors_knocked || 0) + '</td>' +
          '<td class="sb-num-col">' + fmtInt(rep.doors_answered || 0) + '</td>' +
          '<td class="sb-num-col">' + fmtPct(rep.answer_rate || 0) + '</td>' +
          '<td class="sb-num-col sb-num-col--yes">' + fmtInt(rep.yeses || 0) + '</td>' +
          '<td class="sb-num-col">' + fmtInt(rep.nos || 0) + '</td>' +
          '<td class="sb-num-col">' + fmtUsd2(rep.avg_sale_usd || 0) + '</td>' +
          '<td>' + escapeHtml(pkgLabel(rep.top_package)) + '</td>' +
          '</tr>'
        );
      })
      .join('');
  }

  // ---------------------------------------------------------------------------
  // View / period controls
  // ---------------------------------------------------------------------------
  function setView(view) {
    state.view = view;
    els.tabs.forEach(function (t) {
      var on = t.getAttribute('data-view') === view;
      t.classList.toggle('is-active', on);
      t.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    if (els.viewLeaderboard) els.viewLeaderboard.hidden = view !== 'leaderboard';
    if (els.viewReps) els.viewReps.hidden = view !== 'reps';
    if (els.viewManager) els.viewManager.hidden = view !== 'manager';
    // persist preference
    try { localStorage.setItem('ndf_sb_view', view); } catch (e) {}
  }

  function setPeriod(period) {
    if (period === state.period) return;
    state.period = period;
    els.periods.forEach(function (p) {
      var on = p.getAttribute('data-period') === period;
      p.classList.toggle('is-active', on);
      p.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    try { localStorage.setItem('ndf_sb_period', period); } catch (e) {}
    // clear count-up baselines so the new period reads as fresh, not a delta
    state.lastNums = new WeakMap();
    fetchScoreboard();
    restartPoll();
  }

  // ---------------------------------------------------------------------------
  // Polling lifecycle
  // ---------------------------------------------------------------------------
  function restartPoll() {
    stopPoll();
    state.pollTimer = setInterval(function () {
      if (document.hidden) return; // skip polling when tab not visible
      fetchScoreboard();
    }, POLL_MS);
  }

  function stopPoll() {
    if (state.pollTimer) {
      clearInterval(state.pollTimer);
      state.pollTimer = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Event wiring
  // ---------------------------------------------------------------------------
  function wireEvents() {
    els.tabs.forEach(function (t) {
      t.addEventListener('click', function () {
        setView(t.getAttribute('data-view'));
      });
    });
    els.periods.forEach(function (p) {
      p.addEventListener('click', function () {
        setPeriod(p.getAttribute('data-period'));
      });
    });
    // Rep Boards chip selection (event delegation — chips rebuild each render).
    if (els.repChips) {
      els.repChips.addEventListener('click', function (e) {
        var chip = e.target.closest ? e.target.closest('.sb-chip') : null;
        if (chip) selectRep(chip.getAttribute('data-rep-id'));
      });
    }
    if (els.refreshBtn) {
      els.refreshBtn.addEventListener('click', function () {
        fetchScoreboard();
        restartPoll();
      });
    }
    // refresh immediately when the tab regains focus
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) fetchScoreboard();
    });
  }

  function restorePrefs() {
    try {
      var v = localStorage.getItem('ndf_sb_view');
      if (v === 'leaderboard' || v === 'reps' || v === 'manager') state.view = v;
      var p = localStorage.getItem('ndf_sb_period');
      if (p === 'today' || p === 'week' || p === 'month') state.period = p;
      var rep = localStorage.getItem('ndf_sb_rep');
      if (rep) state.selectedRepId = rep;
    } catch (e) {}

    // reflect restored prefs into the controls
    els.tabs.forEach(function (t) {
      var on = t.getAttribute('data-view') === state.view;
      t.classList.toggle('is-active', on);
      t.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    if (els.viewLeaderboard) els.viewLeaderboard.hidden = state.view !== 'leaderboard';
    if (els.viewReps) els.viewReps.hidden = state.view !== 'reps';
    if (els.viewManager) els.viewManager.hidden = state.view !== 'manager';

    els.periods.forEach(function (p) {
      var on = p.getAttribute('data-period') === state.period;
      p.classList.toggle('is-active', on);
      p.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }

  // ---------------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------------
  function init() {
    cacheEls();
    restorePrefs();
    wireEvents();
    fetchScoreboard();
    restartPoll();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
