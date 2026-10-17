/** Wilson score interval (95%) for an observed failure proportion. */
export function wilson(failures: number, n: number, z = 1.96): { rate: number; low: number; high: number; n: number } {
  if (n <= 0) return { rate: 0, low: 0, high: 1, n: 0 };
  const p = failures / n;
  const denom = 1 + (z * z) / n;
  const center = (p + (z * z) / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return { rate: p, low: Math.max(0, center - half), high: Math.min(1, center + half), n };
}

export function pct(x: number): string {
  return `${Math.round(x * 100)}%`;
}
