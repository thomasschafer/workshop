import { useEffect, useState } from "preact/hooks";
import { api, connection } from "../api";

/** How often to try the server again while it can't be reached. */
const RETRY_MS = 3000;

/** Whether the server can be reached, trying it again every few seconds while it can't. */
export function useConnection(): boolean {
  const [online, setOnline] = useState(connection.isOnline);
  useEffect(() => connection.subscribe(setOnline), []);
  useEffect(() => {
    if (online) return;
    const timer = setInterval(() => {
      // Any answer marks the server as reachable again; failures just mean not yet.
      api.ping().catch(() => {});
    }, RETRY_MS);
    return () => clearInterval(timer);
  }, [online]);
  return online;
}
