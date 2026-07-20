// src/training/questions.js  (owner: training)
// SERVER-SIDE question bank for the certification quiz (finding #10).
// The answer key NEVER ships to the client: attempts serve {id, q, choices}
// only, grading happens on the server, and results reveal which questions were
// missed (by topic) — not the key.
//
// Content is grounded in the live curriculum (training.html), the Home Care
// Membership agreement, and NDF's California no-discount policy.

export const CURRICULUM_VERSION = '2026-07b';

/** Questions served per attempt (drawn from the larger bank). */
export const QUIZ_SIZE = 10;

/** Pass threshold (fraction correct). */
export const PASS_THRESHOLD = 0.8;

/** Max attempts per rep per rolling 24h (retakes are not unlimited). */
export const MAX_ATTEMPTS_PER_DAY = 3;

export const QUESTION_BANK = Object.freeze([
  {
    id: 'q_discount',
    topic: 'No-discount policy',
    q: 'A homeowner says the $69/mo Total Home plan is too expensive. What is the correct move?',
    choices: [
      'Offer them a one-time 15% discount to close the sale',
      'Step down to the Preferred or Essential plan and reframe the value — never discount labor',
      'Tell them the price is only good today',
      'Waive the annual fee for the first year',
    ],
    answer: 1,
  },
  {
    id: 'q_what_buying',
    topic: 'What the membership is',
    q: 'Which best describes what a Care Plan member is actually buying?',
    choices: [
      'A discounted "member rate" on all NDF labor',
      'Home insurance that covers repairs',
      'Priority scheduling plus included services (annual inspection, included labor hours, priority response)',
      'A coupon book for future jobs',
    ],
    answer: 2,
  },
  {
    id: 'q_cancel_window',
    topic: 'CA 3-day right to cancel',
    q: 'Under California law, when may a homeowner cancel a home-solicitation contract for a full refund?',
    choices: [
      'Before midnight of the third business day after signing',
      'Within 24 hours of signing',
      'Only with a doctor’s note',
      'They cannot cancel once signed',
    ],
    answer: 0,
  },
  {
    id: 'q_cancel_stated',
    topic: 'CA 3-day right to cancel',
    q: 'You should state the 3-day right to cancel:',
    choices: [
      'Only if the homeowner asks about it',
      'Never — it talks people out of buying',
      'Out loud to every homeowner before they sign',
      'Only on the Total Home plan',
    ],
    answer: 2,
  },
  {
    id: 'q_five_steps',
    topic: 'Door approach',
    q: 'What is the correct order of the 5-step door approach?',
    choices: [
      'Value pitch → Approach → Book → Trial close → Pattern interrupt',
      'Approach → Pattern interrupt → Value pitch → Trial close → Book & sign',
      'Trial close → Value pitch → Approach → Book → Pattern interrupt',
      'Pattern interrupt → Book → Approach → Value pitch → Trial close',
    ],
    answer: 1,
  },
  {
    id: 'q_anchor_tier',
    topic: 'Plan anchoring',
    q: 'Which tier should you anchor on and most often recommend?',
    choices: [
      'Essential ($15/mo)',
      'Preferred ($30/mo)',
      'Total Home ($69/mo)',
      'Whichever is cheapest',
    ],
    answer: 1,
  },
  {
    id: 'q_no_soliciting',
    topic: 'Compliance at the door',
    q: 'You see a "No Soliciting" sign on the door. What do you do?',
    choices: [
      'Knock anyway — the beat list didn’t flag it',
      'Do not knock; log the door as Refused and move on',
      'Knock once softly to be polite',
      'Leave a flyer and knock',
    ],
    answer: 1,
  },
  {
    id: 'q_annual_framing',
    topic: 'No-discount policy',
    q: 'How is the annual pre-pay option correctly framed?',
    choices: [
      'As a discount on NDF’s labor rate',
      'As a member rate that beats non-members',
      'As a billing choice on the membership — "locks in the best rate," same great service, one simple payment',
      'As a waived service fee',
    ],
    answer: 2,
  },
  {
    id: 'q_two_nos',
    topic: 'Respecting a no',
    q: 'A homeowner gives you a clear "no" twice. What is the right action?',
    choices: [
      'Push for two more minutes',
      'Offer a discount to change their mind',
      'Thank them, leave, and log the disposition (e.g., Not interested)',
      'Come back later the same day',
    ],
    answer: 2,
  },
  {
    id: 'q_sale_complete',
    topic: 'Completing the sale',
    q: 'A sale is not complete until you have:',
    choices: [
      'Collected payment in cash',
      'Opened the agreement, booked the first inspection visit, and stated the 3-day cancel aloud',
      'Taken a photo of the home',
      'Gotten a verbal yes',
    ],
    answer: 1,
  },
  {
    id: 'q_auto_renew',
    topic: 'Auto-renewal disclosure (CA ARL)',
    q: 'The membership renews automatically each term. Before taking a card, California law requires you to:',
    choices: [
      'Say nothing — renewal terms are in the fine print',
      'Clearly disclose the recurring charge and get the homeowner’s affirmative consent (they tick the auto-renew box themselves)',
      'Only mention it for annual plans',
      'Get verbal consent later by phone',
    ],
    answer: 1,
  },
  {
    id: 'q_refund_truth',
    topic: 'The guarantee, stated honestly',
    q: 'A homeowner asks: "What if I change my mind?" The accurate answer is:',
    choices: [
      '"All sales are final once you sign."',
      '"Full refund any time, forever, no questions."',
      '"Full refund if you cancel within 3 business days; after that you can cancel any time and unused time is refunded pro-rata."',
      '"You can only cancel at renewal."',
    ],
    answer: 2,
  },
  {
    id: 'q_renter',
    topic: 'Who can sign',
    q: 'The person at the door says they rent the home. What do you do?',
    choices: [
      'Sign them up anyway — money is money',
      'Ask them to sign on the owner’s behalf',
      'Politely wrap up: only the property owner (or someone authorized to sign for the property) can hold a membership; log the disposition',
      'Offer a renter’s discount',
    ],
    answer: 2,
  },
  {
    id: 'q_dnc_list',
    topic: 'Compliance at the door',
    q: 'Your beat app marks a door as do-not-solicit, but you see no sign on the house. You should:',
    choices: [
      'Knock — no sign means it’s fine',
      'Skip the door: a do-not-solicit flag from ANY source is honored, list or sign',
      'Knock but keep it under a minute',
      'Leave a handout in the mailbox',
    ],
    answer: 1,
  },
  {
    id: 'q_welcome_service',
    topic: 'Welcome-service framing',
    q: 'How do you correctly describe the free welcome service (e.g., gutter cleaning) for new members?',
    choices: [
      'As a percentage discount on their first bill',
      'As an included sign-today bonus — more included service, never a price cut',
      'As a rebate they claim by mail',
      'As a price match against competitors',
    ],
    answer: 1,
  },
  {
    id: 'q_card_handling',
    topic: 'Payment handling',
    q: 'Taking payment at the door, the correct card handling is:',
    choices: [
      'Write the card number down and enter it at the office',
      'Text the card number to your manager',
      'Let the homeowner enter their card into the secure payment form themselves (or send them the payment link) — card numbers are never written down or stored by you',
      'Photograph the card front and back',
    ],
    answer: 2,
  },
  // Onboarding 2026-07-20 (curriculum 2026-07b): field safety + app usage,
  // grounded in training modules 07 (Field Ops & Safety) and 08 (Using the App).
  {
    id: 'q_walkin_log',
    topic: 'Using the app — walk-ins',
    q: 'You stop in a nice neighborhood that was not in any beat and knock a few doors. How do you record them?',
    choices: [
      'Write them on paper and hope you remember',
      'Tap "＋ Log a door", type the address, use your location, and log the disposition',
      'Skip logging — only pre-loaded doors count',
      'Text the addresses to your manager',
    ],
    answer: 1,
  },
  {
    id: 'q_offline',
    topic: 'Using the app — offline',
    q: 'You lose cell signal mid-beat. What should you do?',
    choices: [
      'Stop knocking until signal returns',
      'Keep knocking and logging — the app queues everything and syncs when you are back online',
      'Restart the app to force a connection',
      'Log the doors twice to be safe',
    ],
    answer: 1,
  },
  {
    id: 'q_dog_safety',
    topic: 'Field safety',
    q: 'A loose, aggressive dog is in the yard of your next door. The right move is:',
    choices: [
      'Knock quickly before it reaches you',
      'Do not engage — skip the door, log it, and move on',
      'Try to calm the dog',
      'Wait in the yard for the owner',
    ],
    answer: 1,
  },
  {
    id: 'q_end_of_day',
    topic: 'Using the app — sync',
    q: 'Before you finish for the day you should:',
    choices: [
      'Close the app immediately',
      'Confirm there are no pending/unsynced knocks (the app shows a pending count), then report your numbers',
      'Delete the day’s knocks',
      'Nothing — it all handles itself',
    ],
    answer: 1,
  },
]);

/** Public (client-safe) shape: id, topic, question, choices — NO answer. */
export function publicQuestion(q) {
  return { id: q.id, topic: q.topic, q: q.q, choices: q.choices };
}

export function questionById(id) {
  return QUESTION_BANK.find((q) => q.id === id) ?? null;
}
