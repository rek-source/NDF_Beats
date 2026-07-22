// src/routes/serializers.js — shared /api response shapes.

/**
 * Public shape of a sale row for /api responses. Money is exposed as both the
 * authoritative integer `amount_cents` and a derived `amount_usd`; internal
 * columns (knock_id, rep_id, target_id, client_uuid) are deliberately omitted.
 * Used by both sale entry points — POST /api/sales and the manual walk-in sale
 * inside POST /api/knocks/manual — so they can't drift apart.
 * @param {{id?:string, package?:string, amount_cents:number,
 *          agreement_url?:string, sold_at?:string}} s
 */
export function shapeSale(s) {
  return {
    id: s.id,
    package: s.package,
    amount_usd: Math.round(s.amount_cents) / 100,
    amount_cents: s.amount_cents,
    agreement_url: s.agreement_url,
    sold_at: s.sold_at,
  };
}
