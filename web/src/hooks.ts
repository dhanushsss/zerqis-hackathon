import { useCallback, useEffect, useRef, useState } from 'react';

export interface AsyncState<T> {
  data: T | null;
  error: Error | null;
  loading: boolean;
  reload: () => void;
}

/** Fetches on mount and when deps change; optionally polls while `pollMs(data)` returns a number. */
export function useApi<T>(fn: () => Promise<T>, deps: unknown[], pollMs?: (data: T | null) => number | null): AsyncState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const pollRef = useRef(pollMs);
  pollRef.current = pollMs;

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const run = async (first: boolean) => {
      if (first) setLoading(true);
      try {
        const d = await fnRef.current();
        if (cancelled) return;
        setData(d);
        setError(null);
        const next = pollRef.current?.(d);
        if (next) timer = setTimeout(() => run(false), next);
      } catch (e) {
        if (!cancelled) setError(e as Error);
      } finally {
        if (!cancelled && first) setLoading(false);
      }
    };
    run(true);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, error, loading, reload };
}
