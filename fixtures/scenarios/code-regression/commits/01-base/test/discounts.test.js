'use strict';
const { applyDiscount, discountRate } = require('../src/discounts');

describe('discountRate', () => {
  test('no discount below $100', () => {
    expect(discountRate(9999)).toBe(0);
  });

  test('applies 10% at exactly the $100.00 threshold', () => {
    expect(discountRate(10000)).toBe(0.1);
  });

  test('applies 15% from $250', () => {
    expect(discountRate(25000)).toBe(0.15);
  });

  test('applies 20% from $500', () => {
    expect(discountRate(72000)).toBe(0.2);
  });
});

describe('applyDiscount', () => {
  test('returns the discounted total in cents', () => {
    expect(applyDiscount(30000)).toEqual({ rate: 0.15, discountCents: 4500, totalCents: 25500 });
  });
});
