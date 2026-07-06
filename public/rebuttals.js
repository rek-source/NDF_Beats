/* ============================================================================
 * NDF Beats — on-door objection/rebuttal script (OWNER: sales + frontend)
 *
 * Rep-facing cheat sheet rendered inside the door sheet by app.js. This is the
 * SINGLE SOURCE for in-app script copy; the long-form coaching version lives in
 * training.html — keep the two consistent when either changes.
 *
 * COMPLIANCE (California, NDF no-discounts policy):
 *   - NEVER script a labor discount, "member rate", % off, or fee waiver.
 *     Memberships sell PRIORITY + INCLUDED SERVICE, never money off.
 *   - The 3-business-day right to cancel is a selling point — say it out loud.
 *   - Two clear "no"s end the conversation. Log it and move on.
 *
 * Plain script (no modules) so index.html can ship it alongside app.js and the
 * fake-dom test harness can run it unmodified.
 * ==========================================================================*/

(function () {
  'use strict';

  var REBUTTALS = {
    // 30-second opener — what the rep says the moment the door opens.
    opener: {
      title: '30-second opener',
      script: 'Hi there — I\'m [Name] with Next Day Fix, the licensed contractor working here in [City]. ' +
              'I\'m not here to sell you a roof today. We run a yearly home-care membership: we inspect ' +
              'the whole home once a year, send you a photo report, and you go to the front of the line ' +
              'any time you need us. I\'ve got 30 seconds to explain it — fair?'
    },

    // Legal line the rep must say before any signature (CA home-solicitation).
    compliance: {
      title: 'Say before they sign',
      script: 'California gives you three business days to cancel for a full refund — it\'s written into ' +
              'your copy of the agreement, so there\'s zero risk trying it.'
    },

    // The accordion: label = what the homeowner says; say = the three-beat
    // response (acknowledge -> reframe -> ask); never = lines that are banned
    // (discount offers are a policy + CA compliance violation, not a style note).
    objections: [
      {
        key: 'price',
        label: '“It\'s too expensive.”',
        say: [
          'Totally fair to ask. Think of it as a yearly tune-up — the inspection alone catches the stuff that becomes a $3,000 repair if you miss it. On Preferred, the included labor hour usually covers itself the first visit.',
          'If budget\'s the question, Essential at fifteen a month still gets you the inspection and front-of-line scheduling. Which of those sounds closer to what you\'d want?'
        ],
        never: [
          '“I can knock some off for you.”',
          '“Let me get you a member rate.”',
          '“I\'ll waive the fee just this once.”'
        ]
      },
      {
        key: 'diy',
        label: '“I\'ll just do it myself — I\'m handy.”',
        say: [
          'Love that — half our members are handy. This isn\'t about whether you can, it\'s about your time and a priority spot when something\'s over your head or everyone\'s booked out three weeks.',
          'And the annual inspection is a licensed tech catching what hides — roof, slab, water lines. Good backup for a hands-on owner. Worth a look at the checklist?'
        ],
        never: [
          '“You probably shouldn\'t be doing that yourself.”',
          '“I\'ll discount it since you\'ll do most of the work.”'
        ]
      },
      {
        key: 'spouse',
        label: '“I need to talk to my spouse.”',
        say: [
          'Smart — it\'s a household decision. Good news: California gives you three business days to cancel for a full refund, so you can get your first inspection on the calendar today and still talk it over tonight with zero risk.',
          'Or if you\'d rather — what\'s the best time to swing back when you\'re both home?'
        ],
        never: [
          '“This price is only good right now.”',
          '“Just sign — they won\'t mind.”'
        ]
      },
      {
        key: 'not_interested',
        label: '“I\'m not interested.”',
        say: [
          'No problem at all — most folks say that before they hear it\'s just a yearly inspection and a front-of-line spot, no obligation between visits. Can I leave you the one-pager in case it\'s useful down the road?',
          'If it\'s still a no: “Appreciate your time — have a good one.” Log Not interested and move on. Never push past a second no.'
        ],
        never: [
          '“Just give me two more minutes.” (repeatedly)',
          'Anything after a clear second “no.” Respect it.'
        ]
      },
      {
        key: 'handyman',
        label: '“I already have a guy / a handyman.”',
        say: [
          'That\'s great — keep him. This isn\'t instead of your guy; it\'s the licensed-contractor layer: a yearly whole-home inspection with a photo report, and front-of-line priority for the jobs that need a license — roof, electrical, plumbing.',
          'A lot of members hand our report straight to their handyman as his to-do list. Want to see what the inspection covers?'
        ],
        never: [
          '“Your guy is probably unlicensed / cutting corners.” (never run down their person)',
          '“I\'ll beat whatever he charges.”'
        ]
      },
      {
        key: 'renter',
        label: '“I\'m renting / not the owner.”',
        say: [
          'Good to know — thanks for telling me straight. The membership is for the owner, so I won\'t take your time.',
          'If repairs here are slow, our property-management plan is built for exactly that — mind if I leave the one-pager for your landlord or manager?'
        ],
        never: [
          'Pitching the tenant on a plan they can\'t sign.',
          'Asking for the landlord\'s phone number if they hesitate — the one-pager is enough.'
        ]
      },
      {
        key: 'busy',
        label: '“This is a bad time — I\'m busy.”',
        say: [
          'Totally understand — I\'ll be quick or I\'ll come back. Ten seconds: yearly whole-home inspection, photo report, front-of-line priority when something breaks.',
          'When\'s a better time today or tomorrow to catch you for two minutes? I\'ll note it and come back.'
        ],
        never: [
          'Talking faster instead of offering to come back.',
          'Blocking the door or stepping forward when they start to close it.'
        ]
      }
    ]
  };

  // Expose for app.js (browser) and for the node --test fake-dom harness.
  if (typeof window !== 'undefined') window.BeatsRebuttals = REBUTTALS;
  if (typeof module !== 'undefined' && module.exports) module.exports = REBUTTALS;
})();
