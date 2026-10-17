'use strict';

/**
 * Sum line items (in integer cents) and apply a flat shipping fee below the
 * free-shipping threshold.
 */
function cartTotal(items, { shippingCents = 599, freeShippingOverCents = 5000 } = {}) {
  const subtotal = items.reduce((sum, item) => sum + item.priceCents * item.quantity, 0);
  const shipping = subtotal === 0 || subtotal >= freeShippingOverCents ? 0 : shippingCents;
  return { subtotal, shipping, total: subtotal + shipping };
}

module.exports = { cartTotal };
