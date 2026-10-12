import { useEffect, useState } from "preact/hooks";
import { api, type PackagesResponse, type PackagesState } from "../api";

export interface Packages {
  /** Null until loaded, or when the language has no packages. */
  state: PackagesState | null;
  installing: boolean;
  /** When this page started installing, from `performance.now()`. */
  installingSince: number | null;
  /** Why the last install failed. */
  error: string | null;
  install: () => Promise<boolean>;
  add: (pkg: string) => Promise<boolean>;
  /** Saves an edited manifest, rejecting if it has a line that isn't a package name. */
  save: (text: string) => Promise<void>;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The current language's packages: what's listed and installed, and installing them. */
export function usePackages(available: boolean): Packages {
  const [response, setResponse] = useState<PackagesResponse | null>(null);
  const [installingSince, setInstallingSince] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = () =>
    api
      .packages()
      .then(setResponse)
      .catch((e: unknown) => setError(message(e)));

  useEffect(() => {
    if (available) void refresh();
  }, [available]);

  // Started elsewhere, such as in another tab: check back until it's done.
  const installingElsewhere = response?.installing === true && installingSince === null;
  useEffect(() => {
    if (!installingElsewhere) return;
    const timer = setInterval(() => void refresh(), 2000);
    return () => clearInterval(timer);
  }, [installingElsewhere]);

  const installWith = async (request: () => Promise<PackagesResponse>) => {
    setInstallingSince(performance.now());
    setError(null);
    try {
      setResponse(await request());
      return true;
    } catch (e) {
      setError(message(e));
      await refresh();
      return false;
    } finally {
      setInstallingSince(null);
    }
  };

  return {
    state: response?.state ?? null,
    installing: installingSince !== null || response?.installing === true,
    installingSince,
    error,
    install: () => installWith(api.installPackages),
    add: (pkg) => installWith(() => api.addPackage(pkg)),
    save: async (text) => setResponse(await api.savePackages(text)),
  };
}
