import { useEffect, useState } from "preact/hooks";

/** The time now, updated every `intervalMs` while `enabled`, such as for a countdown. */
export function useNow(intervalMs: number, enabled = true): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!enabled) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs, enabled]);
  return now;
}
