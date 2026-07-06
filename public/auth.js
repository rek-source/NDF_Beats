/* ============================================================================
 * NDF Beats — Rep identity (PIN -> signed token) front-end.
 * Owned by: frontend. Pairs with src/auth/* on the server.
 *
 * Responsibilities:
 *   - Render the login overlay: rep picker -> 4-digit PIN pad -> unlock.
 *   - Exchange {rep_id, pin} for a signed token via POST /api/auth/login.
 *   - Persist token + rep + expiry; expose authHeaders() for protected writes.
 *   - Enforce the session window: expired token OR calendar-day rollover -> the
 *     rep must re-enter their PIN ("day rollover" per design).
 *   - Offline grace: never hard-lock a rep mid-beat in a dead zone — if the token
 *     is expired but the device is offline, keep working behind a reconnect banner.
 *
 * Public API (window.BeatsAuth):
 *   .ensureSession()        -> Promise<rep>  (shows login until a valid session)
 *   .getRep()               -> { id, name } | null
 *   .getToken()             -> string | null  (only if currently valid)
 *   .authHeaders()          -> { Authorization } | {}   (token if present at all)
 *   .isValid()              -> boolean        (token present, unexpired, same day)
 *   .switchRep()            -> void           (clear session, back to picker)
 *   .handleUnauthorized()   -> void           (server rejected a write -> re-auth)
 *   .onAuthed(fn)           -> void           (called with rep after each login)
 * ==========================================================================*/

(function () {
  'use strict';

  var API = location.pathname.replace(/\/[^/]*$/, '') + '/api';
  var TOKEN_KEY = 'ndfbeats.token';
  var REP_KEY = 'ndfbeats.rep';
  var EXP_KEY = 'ndfbeats.exp';      // token expiry (UNIX seconds)
  var DAY_KEY = 'ndfbeats.loginday'; // local calendar day of login

  var authedCbs = [];
  var pendingResolve = null;         // resolver for the active ensureSession()
  var selectedRep = null;            // rep chosen on the picker step
  var pinBuffer = '';
  var lockTimer = null;

  // ------------------------------------------------------------------ net
  function api(path, opts) {
    return fetch(API + path, opts).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        return { status: res.status, ok: res.ok, data: data };
      });
    });
  }

  // ------------------------------------------------------------------ session state
  function todayStr() { return new Date().toDateString(); }

  function getToken() { return isValid() ? localStorage.getItem(TOKEN_KEY) : null; }

  function rawToken() { return localStorage.getItem(TOKEN_KEY); }

  function getRep() {
    try { return JSON.parse(localStorage.getItem(REP_KEY)); } catch (e) { return null; }
  }

  function isValid() {
    var tok = localStorage.getItem(TOKEN_KEY);
    if (!tok) return false;
    var exp = parseInt(localStorage.getItem(EXP_KEY), 10);
    if (!exp || (Date.now() / 1000) >= exp) return false;       // expired
    if (localStorage.getItem(DAY_KEY) !== todayStr()) return false; // day rollover
    return true;
  }

  function authHeaders() {
    var tok = rawToken();
    return tok ? { Authorization: 'Bearer ' + tok } : {};
  }

  function saveSession(token, rep, exp) {
    localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem(REP_KEY, JSON.stringify(rep));
    localStorage.setItem(EXP_KEY, String(exp));
    localStorage.setItem(DAY_KEY, todayStr());
  }

  function clearSession() {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(EXP_KEY);
    localStorage.removeItem(DAY_KEY);
    // keep REP_KEY so the picker can pre-highlight the last rep
  }

  function onAuthed(fn) { if (typeof fn === 'function') authedCbs.push(fn); }

  // ------------------------------------------------------------------ overlay DOM
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function overlay() {
    var o = document.getElementById('loginScreen');
    if (o) return o;
    o = el('div', 'login');
    o.id = 'loginScreen';
    o.innerHTML =
      '<div class="login__card">' +
        '<div class="login__brand"><span class="wordmark">NDF <b>Beats</b></span></div>' +
        '<div class="login__body" id="loginBody"></div>' +
        '<div class="login__hint" id="loginHint"></div>' +
        // Manager nav — relative hrefs resolve under /beats/ (admin.html is SSO-gated).
        '<div class="login__foot" style="margin-top:20px;padding-top:16px;border-top:1px solid rgba(140,106,74,.25);display:flex;gap:20px;justify-content:center;flex-wrap:wrap">' +
          '<a href="admin.html" style="font-family:Inter,system-ui,sans-serif;font-weight:600;font-size:13px;letter-spacing:.02em;color:#8C6A4A;text-decoration:none">Manager dashboard &rarr;</a>' +
          '<a href="scoreboard.html" style="font-family:Inter,system-ui,sans-serif;font-weight:600;font-size:13px;letter-spacing:.02em;color:#8C6A4A;text-decoration:none">Scoreboard</a>' +
        '</div>' +
      '</div>';
    document.body.appendChild(o);
    return o;
  }

  function showOverlay() { overlay().classList.add('open'); }
  function hideOverlay() { var o = document.getElementById('loginScreen'); if (o) o.classList.remove('open'); }
  function setHint(msg, kind, scroll) {
    var h = document.getElementById('loginHint');
    if (!h) return;
    h.textContent = msg || '';
    h.className = 'login__hint' + (kind ? ' login__hint--' + kind : '');
    // On short viewports (split-view / landscape) the hint can fall below the
    // fold — pull it into view so a rep always sees wrong-PIN feedback. Skipped
    // for the per-second lockout countdown (scroll=false) to avoid jitter.
    if (msg && scroll !== false && h.scrollIntoView) {
      try { h.scrollIntoView({ block: 'nearest' }); } catch (e) { h.scrollIntoView(); }
    }
  }

  // ------------------------------------------------------------------ step 1: rep picker
  function renderPicker(prefillError) {
    overlay();
    showOverlay();
    clearInterval(lockTimer);        // stop any rep's lockout countdown
    document.removeEventListener('keydown', padKeyHandler);
    selectedRep = null;
    pinBuffer = '';
    var body = document.getElementById('loginBody');
    body.innerHTML = '';
    body.appendChild(el('h1', 'login__title', 'Who is canvassing?'));
    body.appendChild(el('p', 'login__sub', 'Tap your name, then enter your PIN.'));
    var grid = el('div', 'login__reps');
    grid.id = 'loginReps';
    body.appendChild(grid);
    setHint(prefillError || '');

    api('/scoreboard?period=month').then(function (r) {
      var reps = ((r.data && r.data.leaderboard) || []).map(function (x) {
        return { id: x.rep_id, name: x.name };
      });
      grid.innerHTML = '';
      if (!reps.length) {
        setHint('No reps found — ask your manager to add you.', 'err');
        return;
      }
      var lastRep = getRep();
      reps.forEach(function (rep) {
        var b = el('button', 'login__rep', rep.name);
        b.type = 'button';
        if (lastRep && lastRep.id === rep.id) b.className += ' login__rep--last';
        b.addEventListener('click', function () { renderPinPad(rep); });
        grid.appendChild(b);
      });
    }).catch(function () {
      setHint('Cannot reach the server. Check your connection and try again.', 'err');
    });
  }

  // ------------------------------------------------------------------ step 2: PIN pad
  function renderPinPad(rep) {
    clearInterval(lockTimer);        // a fresh pad starts without a stale countdown
    selectedRep = rep;
    pinBuffer = '';
    var body = document.getElementById('loginBody');
    body.innerHTML = '';

    var back = el('button', 'login__back', '‹ Not you? Switch');
    back.type = 'button';
    back.addEventListener('click', function () { renderPicker(); });
    body.appendChild(back);

    body.appendChild(el('h1', 'login__title', rep.name));
    body.appendChild(el('p', 'login__sub', 'Enter your 4-digit PIN'));

    var dots = el('div', 'pinpad__dots');
    dots.id = 'pinDots';
    for (var i = 0; i < 4; i++) dots.appendChild(el('span', 'pinpad__dot'));
    body.appendChild(dots);

    var pad = el('div', 'pinpad');
    var keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', 'del'];
    keys.forEach(function (k) {
      if (k === '') { pad.appendChild(el('span', 'pinpad__key pinpad__key--blank')); return; }
      var btn = el('button', 'pinpad__key' + (k === 'del' ? ' pinpad__key--del' : ''), k === 'del' ? '⌫' : k);
      btn.type = 'button';
      if (k === 'del') {
        btn.setAttribute('aria-label', 'Delete');
        btn.addEventListener('click', function () { popPin(); });
      } else {
        btn.addEventListener('click', function () { pushPin(k); });
      }
      pad.appendChild(btn);
    });
    body.appendChild(pad);
    setHint('');
    renderDots();

    // Physical keyboard support (desktop / external iPad keyboard).
    document.addEventListener('keydown', padKeyHandler);
  }

  function padKeyHandler(e) {
    if (!document.getElementById('pinDots')) {
      document.removeEventListener('keydown', padKeyHandler);
      return;
    }
    if (e.key >= '0' && e.key <= '9') { pushPin(e.key); }
    else if (e.key === 'Backspace') { popPin(); }
  }

  function renderDots() {
    var dots = document.querySelectorAll('#pinDots .pinpad__dot');
    for (var i = 0; i < dots.length; i++) {
      dots[i].classList.toggle('pinpad__dot--filled', i < pinBuffer.length);
    }
  }

  function pushPin(d) {
    if (pinBuffer.length >= 4) return;
    pinBuffer += d;
    renderDots();
    if (pinBuffer.length === 4) setTimeout(submitPin, 120);
  }

  function popPin() {
    pinBuffer = pinBuffer.slice(0, -1);
    renderDots();
    setHint('');
  }

  function submitPin() {
    var rep = selectedRep;
    var pin = pinBuffer;
    setHint('Unlocking…');
    setPadDisabled(true);
    api('/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rep_id: rep.id, pin: pin })
    }).then(function (r) {
      if (r.ok && r.data && r.data.token) {
        saveSession(r.data.token, r.data.rep || rep, r.data.exp);
        document.removeEventListener('keydown', padKeyHandler);
        hideOverlay();
        var savedRep = getRep();
        authedCbs.forEach(function (fn) { try { fn(savedRep); } catch (e) {} });
        if (pendingResolve) { pendingResolve(savedRep); pendingResolve = null; }
        return;
      }
      // failure paths
      pinBuffer = '';
      renderDots();
      setPadDisabled(false);
      if (r.status === 423) {
        startLockCountdown(r.data && r.data.locked_until);
      } else if (r.status === 409) {
        setHint('No PIN set yet — ask your manager to set one for you.', 'err');
      } else {
        var rem = r.data && typeof r.data.attempts_remaining === 'number'
          ? r.data.attempts_remaining : null;
        setHint('Incorrect PIN' + (rem != null ? ' — ' + rem + ' attempt' + (rem === 1 ? '' : 's') + ' left' : ''), 'err');
      }
    }).catch(function () {
      pinBuffer = '';
      renderDots();
      setPadDisabled(false);
      setHint('Network error — try again.', 'err');
    });
  }

  function setPadDisabled(disabled) {
    var keys = document.querySelectorAll('.pinpad__key');
    for (var i = 0; i < keys.length; i++) {
      if (!keys[i].classList.contains('pinpad__key--blank')) keys[i].disabled = disabled;
    }
  }

  function startLockCountdown(until) {
    clearInterval(lockTimer);
    setPadDisabled(true);
    var untilMs = until ? Date.parse(until) : (Date.now() + 15 * 60000);
    function tick() {
      var secs = Math.max(0, Math.round((untilMs - Date.now()) / 1000));
      if (secs <= 0) {
        clearInterval(lockTimer);
        setPadDisabled(false);
        setHint('You can try again now.');
        return;
      }
      var m = Math.floor(secs / 60), s = secs % 60;
      setHint('Too many attempts. Locked for ' + m + ':' + (s < 10 ? '0' : '') + s, 'err', false);
    }
    tick();
    var hint = document.getElementById('loginHint');
    if (hint && hint.scrollIntoView) { try { hint.scrollIntoView({ block: 'nearest' }); } catch (e) {} }
    lockTimer = setInterval(tick, 1000);
  }

  // ------------------------------------------------------------------ public flows
  function ensureSession() {
    return new Promise(function (resolve) {
      if (isValid()) { resolve(getRep()); return; }
      pendingResolve = resolve;
      renderPicker();
    });
  }

  function switchRep() {
    clearSession();
    renderPicker();
  }

  function handleUnauthorized() {
    // A protected write was rejected. If we're offline, don't yank the rep into
    // a login they can't complete — show grace messaging and keep the queue.
    if (!navigator.onLine) {
      setHint('Offline — your work is saved and will sync when you reconnect.', 'err');
      return;
    }
    clearSession();
    renderPicker('Your session ended. Please sign back in to keep syncing.');
  }

  // Re-check the session when the rep returns to the app (day rollover / expiry).
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden && !isValid() && rawToken()) {
      // had a session, now stale -> re-auth (unless offline)
      if (navigator.onLine) { clearSession(); renderPicker('New day — please re-enter your PIN.'); }
    }
  });

  window.BeatsAuth = {
    ensureSession: ensureSession,
    getRep: getRep,
    getToken: getToken,
    authHeaders: authHeaders,
    isValid: isValid,
    switchRep: switchRep,
    handleUnauthorized: handleUnauthorized,
    onAuthed: onAuthed
  };
})();
