import { useEffect, useState } from "preact/hooks";
import { api, type ConnectionSnapshot, connection, onNetworkOnline } from "../api";

/** How often to try the server again while it can't be reached. */
const RETRY_MS = 3000;

/** Whether the server can be reached, trying it again every few seconds while it can't. */
export function useConnection(): boolean {
  const [online, setOnline] = useState(connection.isOnline);
  useEffect(() => {
    // It may have changed between rendering and subscribing, which would otherwise be missed.
    setOnline(connection.isOnline);
    const stopSub = connection.subscribe(setOnline);
    const onBrowserOffline = () => connection.set(false);
    const stopBrowserOnline = onNetworkOnline(() => {
      if (!connection.isOnline) void api.ping().catch(() => {});
    });
    const onVisibility = () => {
      if (
        document.visibilityState === "visible" &&
        !connection.isOnline &&
        (typeof navigator === "undefined" || navigator.onLine !== false)
      ) {
        void api.ping().catch(() => {});
      }
    };
    window.addEventListener("offline", onBrowserOffline);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stopSub();
      stopBrowserOnline();
      window.removeEventListener("offline", onBrowserOffline);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);
  useEffect(() => {
    if (online) return;
    const timer = setInterval(() => {
      // Skip background probes when the tab is hidden or the OS already reports no network.
      if (document.visibilityState === "hidden") return;
      if (typeof navigator !== "undefined" && navigator.onLine === false) return;
      // Any answer marks the server as reachable again; failures just mean not yet.
      api.ping().catch(() => {});
    }, RETRY_MS);
    return () => clearInterval(timer);
  }, [online]);
  return online;
}

/** Detailed connection state (online, slow, last RTT), for diagnostics UI. */
export function useConnectionStatus(): ConnectionSnapshot {
  const [status, setStatus] = useState<ConnectionSnapshot>(() => connection.snapshot());
  useEffect(() => {
    setStatus(connection.snapshot());
    return connection.subscribeStatus(setStatus);
  }, []);
  return status;
}
