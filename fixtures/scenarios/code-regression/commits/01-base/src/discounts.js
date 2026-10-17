'use strict';

// Volume discount tiers. An order qualifies for a tier when its subtotal is at
// least `minCents`.
const TIERS = [
  { minCents: 50000, rate: 0.2 },
  { minCents: 25000, rate: 0.15 },
  { minCents: 10000, rate: 0.1 },
];

function discountRate(subtotalCents) {
  for (const tier of TIERS) {
    if (subtotalCents >= tier.minCents) return tier.rate;
  }
  return 0;
}

function applyDiscount(subtotalCents) {
  const rate = discountRate(subtotalCents);
  const discountCents = Math.floor(subtotalCents * rate);
  return { rate, discountCents, totalCents: subtotalCents - discountCents };
}

module.exports = { TIERS, discountRate, applyDiscount };
