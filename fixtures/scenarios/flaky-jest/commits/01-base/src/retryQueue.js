'use strict';

/**
 * Plans when each outbound webhook notification is delivered. Each task gets
 * a base delay, a small per-position step, and random jitter so that many
 * workers retrying at once do not stampede the downstream service.
 *
 * Returns tasks in the order they will actually be delivered.
 */
function planDeliveries(tasks, { baseDelayMs = 10, stepMs = 2, jitterMs = 5, random = Math.random } = {}) {
  return tasks
    .map((task, index) => ({ task, at: baseDelayMs + index * stepMs + random() * jitterMs }))
    .sort((a, b) => a.at - b.at)
    .map((entry) => entry.task);
}

/** Small deterministic PRNG (mulberry32) so a run can be replayed from its seed. */
function createRng(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

module.exports = { planDeliveries, createRng };
