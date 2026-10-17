'use strict';

const RATES = { CA: 0.0725, NY: 0.04, TX: 0.0625 };

function salesTax(amountCents, state) {
  const rate = RATES[state] ?? 0;
  return Math.round(amountCents * rate);
}

module.exports = { salesTax };
