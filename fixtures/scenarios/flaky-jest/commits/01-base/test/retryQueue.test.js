'use strict';
const { planDeliveries, createRng } = require('../src/retryQueue');

describe('planDeliveries', () => {
  test('delivers every task exactly once', () => {
    const planned = planDeliveries(['a', 'b', 'c'], { random: createRng(jest.getSeed()) });
    expect([...planned].sort()).toEqual(['a', 'b', 'c']);
  });

  // Uses the run's Jest seed for jitter. Re-run with `jest --seed=<n>` to replay.
  test('delivers notifications in submission order', () => {
    const planned = planDeliveries(['order.created', 'order.paid'], { random: createRng(jest.getSeed()) });
    expect(planned).toEqual(['order.created', 'order.paid']);
  });
});
