/* ==========================================================================
   training.js  (owner: training)
   Certification quiz is SERVER-BACKED (finding #10):
     - No answer key ships to the browser — the server draws a randomized
       question set from a larger bank and grades it server-side.
     - Completions are recorded against the AUTHED rep (PIN login via
       auth.js/BeatsAuth), with score, curriculum version and UTC timestamp.
     - Retakes are throttled server-side; grading reveals missed TOPICS only.
   Still client-side: ride-along checklist persistence + scrollspy.
   ========================================================================== */
(function () {
  'use strict';

  var API = location.pathname.replace(/\/[^/]*$/, '') + '/api';
  var STORE_CHECK = 'ndfbeats.training.checklist.v1';

  var LETTERS = ['A', 'B', 'C', 'D', 'E'];

  /* ---- DOM refs ---- */
  var qContainer = document.getElementById('quizQuestions');
  var form = document.getElementById('quizForm');
  var resultEl = document.getElementById('result');
  var resultTitle = document.getElementById('resultTitle');
  var resultScore = document.getElementById('resultScore');
  var resultMsg = document.getElementById('resultMsg');
  var certBlock = document.getElementById('certBlock');
  var certPrint = document.getElementById('certPrint');
  var printBtn = document.getElementById('printBtn');
  var gradeBtn = document.getElementById('gradeBtn');
  var resetBtn = document.getElementById('resetBtn');
  var quizHint = document.getElementById('quizHint');
  var certStatus = document.getElementById('certStatus');

  var attempt = null; // { attempt_id, questions:[{id,q,choices}] }

  /* ---------------------------------------------------------------------- */
  /* Auth helpers (BeatsAuth from auth.js)                                   */
  /* ---------------------------------------------------------------------- */
  function auth() { return window.BeatsAuth || null; }
  function authHeaders() {
    var a = auth();
    return a && a.authHeaders ? a.authHeaders() : {};
  }
  function api(method, path, body) {
    var headers = Object.assign(
      body ? { 'content-type': 'application/json' } : {},
      authHeaders()
    );
    return fetch(API + path, {
      method: method,
      headers: headers,
      body: body ? JSON.stringify(body) : undefined,
      cache: 'no-store'
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (json) {
        return { status: res.status, ok: res.ok, json: json };
      });
    });
  }

  /* ---------------------------------------------------------------------- */
  /* Start state — sign in, then the server deals a fresh randomized set     */
  /* ---------------------------------------------------------------------- */
  function renderStart(message) {
    attempt = null;
    if (gradeBtn) gradeBtn.style.display = 'none';
    if (resetBtn) resetBtn.style.display = 'none';
    qContainer.innerHTML =
      '<div class="quiz-start">' +
      '<p>' + (message || 'The quiz is graded on the server and your certification is recorded to your rep profile — sign in with your PIN to begin. Questions are drawn at random from a larger bank each attempt.') + '</p>' +
      '<p class="sub">Retakes are limited per day, so study the modules first.</p>' +
      '<button type="button" class="btn" id="startQuizBtn">Sign in &amp; start the quiz</button>' +
      '</div>';
    var btn = document.getElementById('startQuizBtn');
    if (btn) btn.addEventListener('click', startAttempt);
  }

  function startAttempt() {
    var a = auth();
    var begin = function () {
      api('POST', '/training/attempt').then(function (r) {
        if (r.status === 401) {
          if (a && a.handleUnauthorized) a.handleUnauthorized();
          renderStart('Your session expired — sign in again to start the quiz.');
          return;
        }
        if (r.status === 429) {
          renderStart((r.json && r.json.error) || 'Attempt limit reached — try again tomorrow.');
          return;
        }
        if (!r.ok) {
          renderStart('Could not start the quiz (' + ((r.json && r.json.error) || ('HTTP ' + r.status)) + '). Try again.');
          return;
        }
        attempt = r.json;
        renderQuiz(attempt.questions);
      }).catch(function () {
        renderStart('Network error — check your connection and try again.');
      });
    };
    if (a && a.ensureSession) a.ensureSession().then(begin);
    else begin();
  }

  /* ---------------------------------------------------------------------- */
  /* Render served questions (no answers in the payload)                     */
  /* ---------------------------------------------------------------------- */
  function renderQuiz(questions) {
    var html = '';
    questions.forEach(function (item, qi) {
      html += '<div class="quiz-q" id="q' + qi + '">';
      html += '<div class="qhead"><span class="qn">' + (qi + 1) + '.</span>' +
              '<span class="qtext">' + escapeHtml(item.q) + '</span></div>';
      html += '<ul class="choices">';
      item.choices.forEach(function (choice, ci) {
        var id = 'q' + qi + 'c' + ci;
        html += '<li><label class="choice" for="' + id + '">' +
                  '<input type="radio" id="' + id + '" name="' + item.id + '" value="' + ci + '">' +
                  '<span><b>' + LETTERS[ci] + '.</b> ' + escapeHtml(choice) + '</span>' +
                '</label></li>';
      });
      html += '</ul></div>';
    });
    qContainer.innerHTML = html;
    if (gradeBtn) gradeBtn.style.display = '';
    if (resetBtn) resetBtn.style.display = '';
    resultEl.classList.remove('show', 'pass', 'fail');
    quizHint.textContent = '';
  }

  /* ---------------------------------------------------------------------- */
  /* Grade — on the server                                                   */
  /* ---------------------------------------------------------------------- */
  function gradeQuiz(e) {
    if (e) e.preventDefault();
    if (!attempt) return;

    var answers = {};
    var answered = 0;
    attempt.questions.forEach(function (item) {
      var chosen = form.querySelector('input[name="' + item.id + '"]:checked');
      if (chosen) {
        answers[item.id] = parseInt(chosen.value, 10);
        answered++;
      }
    });

    if (answered < attempt.questions.length) {
      quizHint.textContent = 'Answer all ' + attempt.questions.length + ' questions (' +
                             (attempt.questions.length - answered) + ' left).';
      return;
    }
    quizHint.textContent = 'Grading…';
    if (gradeBtn) gradeBtn.disabled = true;

    api('POST', '/training/attempt/' + attempt.attempt_id + '/grade', { answers: answers })
      .then(function (r) {
        if (gradeBtn) gradeBtn.disabled = false;
        quizHint.textContent = '';
        if (!r.ok) {
          quizHint.textContent = (r.json && r.json.error) || ('Grading failed (HTTP ' + r.status + ').');
          return;
        }
        showResult(r.json);
        refreshCertStatus();
        resultEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
      })
      .catch(function () {
        if (gradeBtn) gradeBtn.disabled = false;
        quizHint.textContent = 'Network error — your answers were not graded. Try again.';
      });
  }

  function showResult(res) {
    resultEl.classList.add('show');
    resultEl.classList.toggle('pass', res.passed);
    resultEl.classList.toggle('fail', !res.passed);

    resultTitle.textContent = res.passed ? 'Certified — nice work.' : 'Not yet — review and retake.';
    resultScore.innerHTML = 'You scored <b>' + res.score + ' of ' + res.total + '</b> (' + res.pct +
                            '%). Passing is 80%.';

    if (res.passed) {
      resultMsg.textContent = 'Your certification is recorded on the server against your rep profile. You’re cleared for ride-alongs — complete a supervised beat before canvassing solo.';
      certBlock.style.display = 'block';
      renderCertLine(res.cert);
    } else {
      var topics = (res.missed || []).map(function (m) {
        return '<li>' + escapeHtml(m.topic) + '</li>';
      }).join('');
      resultMsg.innerHTML = 'This attempt is recorded. Re-study the modules covering:' +
        '<ul class="missed-topics">' + topics + '</ul>' +
        'then start a fresh quiz (new questions each attempt, limited retakes per day).';
      certBlock.style.display = 'none';
    }

    // The served set is spent — a retake needs a fresh server draw.
    attempt = null;
    if (gradeBtn) gradeBtn.style.display = 'none';
    if (resetBtn) resetBtn.style.display = 'none';
    var again = document.createElement('button');
    again.type = 'button';
    again.className = 'btn secondary';
    again.textContent = res.passed ? 'Take again (new questions)' : 'Retake with new questions';
    again.style.marginTop = '14px';
    again.addEventListener('click', function () { startAttempt(); });
    qContainer.innerHTML = '';
    qContainer.appendChild(again);
  }

  // Certificate line comes from the SERVER record: authed rep name, score,
  // curriculum version, UTC completion — never self-typed.
  function renderCertLine(cert) {
    if (!cert) { certPrint.innerHTML = ''; return; }
    var when = cert.completed_at ? new Date(cert.completed_at) : new Date();
    var dateStr = when.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
    certPrint.innerHTML = '<b>' + escapeHtml(cert.rep_name || 'NDF Rep') + '</b> certified on NDF Beats D2D Care Plan Sales — ' +
      Math.round((cert.score / cert.total) * 100) + '% — curriculum ' + escapeHtml(cert.curriculum_version) +
      ' — ' + dateStr + ' (recorded server-side, cert ' + escapeHtml(cert.id || '') + ').';
  }

  /* ---------------------------------------------------------------------- */
  /* Header cert status (from the server when signed in)                     */
  /* ---------------------------------------------------------------------- */
  function refreshCertStatus() {
    if (!certStatus) return;
    var a = auth();
    if (!a || !a.isValid || !a.isValid()) {
      certStatus.textContent = 'sign in to view';
      certStatus.style.color = '';
      return;
    }
    api('GET', '/training/status').then(function (r) {
      if (!r.ok) return;
      var c = r.json.cert;
      if (c && c.passed) {
        certStatus.textContent = 'passed (' + Math.round((c.score / c.total) * 100) + '% · ' + c.curriculum_version + ')';
        certStatus.style.color = 'var(--ok)';
      } else if (c) {
        certStatus.textContent = 'attempted (' + Math.round((c.score / c.total) * 100) + '%)';
        certStatus.style.color = 'var(--bad)';
      } else {
        certStatus.textContent = 'not started';
        certStatus.style.color = '';
      }
    }).catch(function () { /* non-fatal */ });
  }

  /* ---------------------------------------------------------------------- */
  /* Ride-along checklist persistence (unchanged, local-only)                */
  /* ---------------------------------------------------------------------- */
  function loadChecklist() {
    var state = {};
    try {
      var raw = localStorage.getItem(STORE_CHECK);
      state = raw ? JSON.parse(raw) : {};
    } catch (err) { state = {}; }

    var boxes = document.querySelectorAll('#checklist input[type="checkbox"]');
    boxes.forEach(function (box) {
      var key = box.getAttribute('data-key');
      if (state[key]) box.checked = true;
      box.addEventListener('change', saveChecklist);
    });
  }
  function saveChecklist() {
    var state = {};
    document.querySelectorAll('#checklist input[type="checkbox"]').forEach(function (box) {
      state[box.getAttribute('data-key')] = box.checked;
    });
    try { localStorage.setItem(STORE_CHECK, JSON.stringify(state)); } catch (err) { /* ignore */ }
  }

  /* ---------------------------------------------------------------------- */
  /* Scrollspy TOC                                                           */
  /* ---------------------------------------------------------------------- */
  function initScrollspy() {
    var links = Array.prototype.slice.call(document.querySelectorAll('#tocNav a'));
    var sections = links.map(function (a) {
      return document.querySelector(a.getAttribute('href'));
    }).filter(Boolean);

    if (!('IntersectionObserver' in window) || sections.length === 0) return;

    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          links.forEach(function (a) {
            a.classList.toggle('active', a.getAttribute('href') === '#' + entry.target.id);
          });
        }
      });
    }, { rootMargin: '-20% 0px -70% 0px', threshold: 0 });

    sections.forEach(function (s) { observer.observe(s); });
  }

  /* ---------------------------------------------------------------------- */
  /* Util                                                                   */
  /* ---------------------------------------------------------------------- */
  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /* ---------------------------------------------------------------------- */
  /* Wire up                                                                */
  /* ---------------------------------------------------------------------- */
  function init() {
    renderStart();
    loadChecklist();
    initScrollspy();
    refreshCertStatus();

    form.addEventListener('submit', gradeQuiz);
    if (resetBtn) resetBtn.addEventListener('click', function () { renderStart(); });
    if (printBtn) printBtn.addEventListener('click', function () { window.print(); });
    var a = auth();
    if (a && a.onAuthed) a.onAuthed(function () { refreshCertStatus(); });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
