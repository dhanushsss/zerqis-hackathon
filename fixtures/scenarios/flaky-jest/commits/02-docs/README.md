# checkout-service

Cart totals and outbound webhook delivery for the checkout flow.

```bash
npm ci
npm test
```

## Retry queue

`planDeliveries` spreads webhook deliveries with a base delay (`baseDelayMs`,
default 10 ms), a per-position step (`stepMs`, default 2 ms) and random jitter
(`jitterMs`, default 5 ms). Tune these per downstream service.
