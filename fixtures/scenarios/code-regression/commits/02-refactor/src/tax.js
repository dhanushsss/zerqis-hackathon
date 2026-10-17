'use strict';

const RATES = Object.freeze({ CA: 0.0725, NY: 0.04, TX: 0.0625 });

function salesTax(amountCents, state) {
  const rate = Object.prototype.hasOwnProperty.call(RATES, state) ? RATES[state] : 0;
  return Math.round(amountCents * rate);
}

module.exports = { salesTax };
