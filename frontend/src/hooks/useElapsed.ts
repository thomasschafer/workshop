import { useEffect, useState } from "preact/hooks";

/**
 * Seconds since `startedAt` (from `performance.now()`), updated while it's set, or null when
 * it isn't.
 */
export function useElapsed(startedAt: number | null): number | null {
  const [now, setNow] = useState(() => performance.now());
  useEffect(() => {
    if (startedAt === null) return;
    setNow(performance.now());
    const timer = setInterval(() => setNow(performance.now()), 100);
    return () => clearInterval(timer);
  }, [startedAt]);
  return startedAt === null ? null : Math.max(0, now - startedAt) / 1000;
}
