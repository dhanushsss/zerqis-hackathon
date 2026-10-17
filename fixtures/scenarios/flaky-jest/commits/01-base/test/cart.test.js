'use strict';
const { cartTotal } = require('../src/cart');

describe('cartTotal', () => {
  test('sums line items and adds shipping under the threshold', () => {
    const result = cartTotal([{ priceCents: 1200, quantity: 2 }]);
    expect(result).toEqual({ subtotal: 2400, shipping: 599, total: 2999 });
  });

  test('ships free at or above the threshold', () => {
    const result = cartTotal([{ priceCents: 2500, quantity: 2 }]);
    expect(result.shipping).toBe(0);
  });

  test('empty carts have no shipping fee', () => {
    expect(cartTotal([]).total).toBe(0);
  });
});
