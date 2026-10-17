'use strict';
const { salesTax } = require('../src/tax');

describe('salesTax', () => {
  test('uses the state rate', () => {
    expect(salesTax(10000, 'CA')).toBe(725);
  });

  test('unknown states are untaxed', () => {
    expect(salesTax(10000, 'OR')).toBe(0);
  });
});
