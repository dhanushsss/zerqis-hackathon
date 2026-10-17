'use strict';

// Volume discount tiers, highest first. An order qualifies for a tier when its
// subtotal exceeds `minCents`.
const TIERS = [
  { minCents: 50000, rate: 0.2 },
  { minCents: 25000, rate: 0.15 },
  { minCents: 10000, rate: 0.1 },
];

function discountRate(subtotalCents) {
  const tier = TIERS.find((t) => subtotalCents > t.minCents);
  return tier ? tier.rate : 0;
}

function roundCents(value) {
  return Math.floor(value);
}

function applyDiscount(subtotalCents) {
  const rate = discountRate(subtotalCents);
  const discountCents = roundCents(subtotalCents * rate);
  return { rate, discountCents, totalCents: subtotalCents - discountCents };
}

module.exports = { TIERS, discountRate, applyDiscount };
