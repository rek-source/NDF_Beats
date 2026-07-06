/* ==========================================================================
   training.js  (owner: training)
   Client-side ONLY. No backend calls (per SPEC §9).
   Responsibilities:
     - Render + grade the certification quiz (pass = 80%)
     - Persist ride-along checklist + certification status to localStorage
     - Scrollspy for the table-of-contents
     - Generate a printable certificate on pass
   ========================================================================== */
(function () {
  'use strict';

  var STORE_QUIZ = 'ndfbeats.training.cert.v1';
  var STORE_CHECK = 'ndfbeats.training.checklist.v1';
  var PASS_THRESHOLD = 0.8;

  /* ----------------------------------------------------------------------
     Quiz — single source of truth.
     answer = index of correct choice. Content aligns with the curriculum
     above and the live Home Care Membership agreement.
     ---------------------------------------------------------------------- */
  var QUESTIONS = [
    {
      q: 'A homeowner says the $69/mo Total Home plan is too expensive. What is the correct move?',
      choices: [
        'Offer them a one-time 15% discount to close the sale',
        'Step down to the Preferred or Essential plan and reframe the value — never discount labor',
        'Tell them the price is only good today',
        'Waive the annual fee for the first year'
      ],
      answer: 1,
      explain: 'NDF does not discount labor in California. You change the <b>plan</b>, not the price. Acknowledge, reframe value, step down a tier.'
    },
    {
      q: 'Which best describes what a Care Plan member is actually buying?',
      choices: [
        'A discounted "member rate" on all NDF labor',
        'Home insurance that covers repairs',
        'Priority scheduling plus included services (annual inspection, included labor hours, priority response)',
        'A coupon book for future jobs'
      ],
      answer: 2,
      explain: 'The membership sells <b>priority + included service</b>. It is explicitly <b>not insurance or a warranty</b>, and it is never framed as a discount.'
    },
    {
      q: 'Under California law, when may a homeowner cancel a home-solicitation contract for a full refund?',
      choices: [
        'Before midnight of the third business day after signing',
        'Within 24 hours of signing',
        'Only with a doctor’s note',
        'They cannot cancel once signed'
      ],
      answer: 0,
      explain: 'California gives the buyer until <b>midnight of the third business day</b> after signing to cancel for a full refund. You must state this out loud before they sign.'
    },
    {
      q: 'You should state the 3-day right to cancel:',
      choices: [
        'Only if the homeowner asks about it',
        'Never — it talks people out of buying',
        'Out loud to every homeowner before they sign',
        'Only on the Total Home plan'
      ],
      answer: 2,
      explain: 'It is required and it builds trust. Say it proudly to <b>every</b> homeowner before signing — it lowers their risk to zero.'
    },
    {
      q: 'What is the correct order of the 5-step door approach?',
      choices: [
        'Value pitch → Approach → Book → Trial close → Pattern interrupt',
        'Approach → Pattern interrupt → Value pitch → Trial close → Book & sign',
        'Trial close → Value pitch → Approach → Book → Pattern interrupt',
        'Pattern interrupt → Book → Approach → Value pitch → Trial close'
      ],
      answer: 1,
      explain: 'Approach &amp; first impression → pattern interrupt &amp; permission → value pitch → trial close → book &amp; sign. Don’t skip the trust steps to rush the close.'
    },
    {
      q: 'Which tier should you anchor on and most often recommend?',
      choices: [
        'Essential ($15/mo)',
        'Preferred ($30/mo)',
        'Total Home ($69/mo)',
        'Whichever is cheapest'
      ],
      answer: 1,
      explain: 'Anchor on <b>Preferred ($30/mo)</b> — the middle tier. The included handyman labor hour makes the value obvious, and it’s what most homeowners choose.'
    },
    {
      q: 'You see a "No Soliciting" sign on the door. What do you do?',
      choices: [
        'Knock anyway — the beat list didn’t flag it',
        'Do not knock; log the door as Refused and move on',
        'Knock once softly to be polite',
        'Leave a flyer and knock'
      ],
      answer: 1,
      explain: 'Honor every sign you see in person, regardless of the list. Don’t knock — log <b>Refused</b> and move to the next door.'
    },
    {
      q: 'How is the annual pre-pay option correctly framed?',
      choices: [
        'As a discount on NDF’s labor rate',
        'As a member rate that beats non-members',
        'As a billing choice on the membership — "locks in the best rate," same great service, one simple payment',
        'As a waived service fee'
      ],
      answer: 2,
      explain: 'Annual pre-pay is a <b>billing choice on the plan</b>, not a cut to our labor rate. Never imply pre-pay buys cheaper labor.'
    },
    {
      q: 'A homeowner gives you a clear "no" twice. What is the right action?',
      choices: [
        'Push for two more minutes',
        'Offer a discount to change their mind',
        'Thank them, leave, and log the disposition (e.g., Not interested)',
        'Come back later the same day'
      ],
      answer: 2,
      explain: 'One clear "no" ends it. Repeated pressure is bad selling <b>and</b> a compliance risk. Thank them, log it, move on.'
    },
    {
      q: 'A sale is not complete until you have:',
      choices: [
        'Collected payment in cash',
        'Opened the agreement, booked the first inspection visit, and stated the 3-day cancel aloud',
        'Taken a photo of the home',
        'Gotten a verbal yes'
      ],
      answer: 1,
      explain: 'Finish the close: open the agreement, <b>book the first inspection</b>, and state the California 3-day right to cancel out loud.'
    }
  ];

  var LETTERS = ['A', 'B', 'C', 'D', 'E'];

  /* ---- DOM refs ---- */
  var qContainer = document.getElementById('quizQuestions');
  var form = document.getElementById('quizForm');
  var resultEl = document.getElementById('result');
  var resultTitle = document.getElementById('resultTitle');
  var resultScore = document.getElementById('resultScore');
  var resultMsg = document.getElementById('resultMsg');
  var certBlock = document.getElementById('certBlock');
  var certName = document.getElementById('certName');
  var certPrint = document.getElementById('certPrint');
  var printBtn = document.getElementById('printBtn');
  var resetBtn = document.getElementById('resetBtn');
  var quizHint = document.getElementById('quizHint');
  var certStatus = document.getElementById('certStatus');

  /* ---------------------------------------------------------------------- */
  /* Render quiz                                                            */
  /* ---------------------------------------------------------------------- */
  function renderQuiz() {
    var html = '';
    QUESTIONS.forEach(function (item, qi) {
      html += '<div class="quiz-q" id="q' + qi + '">';
      html += '<div class="qhead"><span class="qn">' + (qi + 1) + '.</span>' +
              '<span class="qtext">' + item.q + '</span></div>';
      html += '<ul class="choices">';
      item.choices.forEach(function (choice, ci) {
        var id = 'q' + qi + 'c' + ci;
        html += '<li><label class="choice" for="' + id + '">' +
                  '<input type="radio" id="' + id + '" name="q' + qi + '" value="' + ci + '">' +
                  '<span><b>' + LETTERS[ci] + '.</b> ' + choice + '</span>' +
                '</label></li>';
      });
      html += '</ul>';
      html += '<div class="explain" id="explain' + qi + '"></div>';
      html += '</div>';
    });
    qContainer.innerHTML = html;
  }

  /* ---------------------------------------------------------------------- */
  /* Grade                                                                  */
  /* ---------------------------------------------------------------------- */
  function gradeQuiz(e) {
    if (e) e.preventDefault();

    var answered = 0;
    var correct = 0;

    QUESTIONS.forEach(function (item, qi) {
      var qEl = document.getElementById('q' + qi);
      qEl.classList.add('graded');
      var chosen = form.querySelector('input[name="q' + qi + '"]:checked');
      var chosenIdx = chosen ? parseInt(chosen.value, 10) : -1;
      if (chosenIdx >= 0) answered++;

      // mark choices
      var labels = qEl.querySelectorAll('.choice');
      labels.forEach(function (lbl, ci) {
        lbl.classList.remove('correct', 'chosen-wrong');
        if (ci === item.answer) lbl.classList.add('correct');
        if (ci === chosenIdx && chosenIdx !== item.answer) lbl.classList.add('chosen-wrong');
      });

      if (chosenIdx === item.answer) correct++;

      var ex = document.getElementById('explain' + qi);
      ex.innerHTML = (chosenIdx === item.answer ? '<b>Correct.</b> ' : '<b>Review:</b> ') + item.explain;
    });

    if (answered < QUESTIONS.length) {
      quizHint.textContent = 'Answer all ' + QUESTIONS.length + ' questions for an accurate score (' +
                             (QUESTIONS.length - answered) + ' left).';
    } else {
      quizHint.textContent = '';
    }

    var pct = correct / QUESTIONS.length;
    var passed = pct >= PASS_THRESHOLD;
    showResult(correct, QUESTIONS.length, passed);

    persistQuiz({
      score: correct,
      total: QUESTIONS.length,
      pct: Math.round(pct * 100),
      passed: passed,
      gradedAt: new Date().toISOString()
    });
    updateCertStatus();

    resultEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function showResult(correct, total, passed) {
    var pct = Math.round((correct / total) * 100);
    resultEl.classList.add('show');
    resultEl.classList.toggle('pass', passed);
    resultEl.classList.toggle('fail', !passed);

    resultTitle.textContent = passed ? 'Certified — nice work.' : 'Not yet — review and retake.';
    resultScore.innerHTML = 'You scored <b>' + correct + ' of ' + total + '</b> (' + pct +
                            '%). Passing is 80% (8 of 10).';

    if (passed) {
      resultMsg.textContent = 'You’re cleared for ride-alongs. Generate your certificate below, then complete a supervised beat before canvassing solo.';
      certBlock.style.display = 'block';
      var saved = loadQuiz();
      if (saved && saved.certName) {
        certName.value = saved.certName;
        renderCertLine(saved.certName, pct);
      }
    } else {
      resultMsg.textContent = 'Re-read the highlighted answers above (especially the no-discount rule and the 3-day right to cancel), then hit Grade again.';
      certBlock.style.display = 'none';
    }
  }

  function renderCertLine(name, pct) {
    if (!name || !name.trim()) {
      certPrint.innerHTML = '';
      return;
    }
    var dateStr = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
    certPrint.innerHTML = '<b>' + escapeHtml(name.trim()) + '</b> certified on NDF Beats D2D Care Plan Sales — ' +
                          pct + '% — ' + dateStr + '.';
    var saved = loadQuiz() || {};
    saved.certName = name.trim();
    saved.certDate = dateStr;
    persistQuiz(saved);
  }

  /* ---------------------------------------------------------------------- */
  /* Reset                                                                  */
  /* ---------------------------------------------------------------------- */
  function resetQuiz() {
    form.reset();
    QUESTIONS.forEach(function (item, qi) {
      var qEl = document.getElementById('q' + qi);
      qEl.classList.remove('graded');
      qEl.querySelectorAll('.choice').forEach(function (lbl) {
        lbl.classList.remove('correct', 'chosen-wrong');
      });
      document.getElementById('explain' + qi).innerHTML = '';
    });
    resultEl.classList.remove('show', 'pass', 'fail');
    certBlock.style.display = 'none';
    certPrint.innerHTML = '';
    quizHint.textContent = '';
    try { localStorage.removeItem(STORE_QUIZ); } catch (err) { /* storage unavailable */ }
    updateCertStatus();
    document.getElementById('m7').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  /* ---------------------------------------------------------------------- */
  /* Persistence                                                            */
  /* ---------------------------------------------------------------------- */
  function persistQuiz(obj) {
    try { localStorage.setItem(STORE_QUIZ, JSON.stringify(obj)); } catch (err) { /* ignore */ }
  }
  function loadQuiz() {
    try {
      var raw = localStorage.getItem(STORE_QUIZ);
      return raw ? JSON.parse(raw) : null;
    } catch (err) { return null; }
  }

  function updateCertStatus() {
    var saved = loadQuiz();
    if (!certStatus) return;
    if (saved && saved.passed) {
      certStatus.textContent = 'passed (' + saved.pct + '%)';
      certStatus.style.color = 'var(--ok)';
    } else if (saved && saved.gradedAt) {
      certStatus.textContent = 'attempted (' + saved.pct + '%)';
      certStatus.style.color = 'var(--bad)';
    } else {
      certStatus.textContent = 'not started';
      certStatus.style.color = '';
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Ride-along checklist persistence                                       */
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
  /* Scrollspy TOC                                                          */
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
    renderQuiz();
    loadChecklist();
    initScrollspy();
    updateCertStatus();

    form.addEventListener('submit', gradeQuiz);
    resetBtn.addEventListener('click', resetQuiz);
    certName.addEventListener('input', function () {
      var saved = loadQuiz();
      renderCertLine(certName.value, saved ? saved.pct : 0);
    });
    printBtn.addEventListener('click', function () {
      if (!certName.value.trim()) {
        certName.focus();
        return;
      }
      window.print();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
