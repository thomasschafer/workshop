import { useEffect, useRef, useState } from "preact/hooks";
import { api, type PackagesResponse, type PackagesState, type Resolution } from "../api";

/** What this page asked for, while it's under way. */
export type PackagesActivity =
  | { kind: "install" }
  | { kind: "add"; package: string }
  | { kind: "remove"; package: string };

export interface Packages {
  /** Null until loaded, or when the language has no packages. */
  state: PackagesState | null;
  installing: boolean;
  /** When this page started installing, from `performance.now()`. */
  installingSince: number | null;
  /** What's being done, if this page started it. */
  activity: PackagesActivity | null;
  /** The installer's latest line of output, while installing. */
  progress: string | null;
  /** Why the last install failed. */
  error: string | null;
  lastInstall: PackagesResponse["last_install"];
  install: () => Promise<boolean>;
  add: (pkg: string) => Promise<boolean>;
  remove: (pkg: string) => Promise<boolean>;
  cancel: () => void;
  /** Saves an edited manifest, rejecting if it has a line that isn't a package name. */
  save: (text: string) => Promise<void>;
  /** The package that would provide a module, looked up once per module. */
  resolve: (module: string) => Promise<Resolution>;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** How often to check on an install, for its progress. */
const PROGRESS_MS = 1000;

/** The current language's packages: what's listed and installed, and installing them. */
export function usePackages(available: boolean): Packages {
  const [response, setResponse] = useState<PackagesResponse | null>(null);
  const [installingSince, setInstallingSince] = useState<number | null>(null);
  const [activity, setActivity] = useState<PackagesActivity | null>(null);
  const [error, setError] = useState<string | null>(null);
  const resolutions = useRef(new Map<string, Promise<Resolution>>());

  const refresh = () =>
    api
      .packages()
      .then(setResponse)
      .catch((e: unknown) => setError(message(e)));

  useEffect(() => {
    if (available) void refresh();
  }, [available]);

  // Follows an install's progress, including one started elsewhere, such as in another tab.
  const installing = installingSince !== null || response?.installing === true;
  useEffect(() => {
    if (!installing) return;
    const timer = setInterval(() => void refresh(), PROGRESS_MS);
    return () => clearInterval(timer);
  }, [installing]);

  const installWith = async (doing: PackagesActivity, request: () => Promise<PackagesResponse>) => {
    setInstallingSince(performance.now());
    setActivity(doing);
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
      setActivity(null);
    }
  };

  return {
    state: response?.state ?? null,
    installing,
    installingSince,
    activity,
    progress: installing ? (response?.progress ?? null) : null,
    error,
    lastInstall: response?.last_install ?? null,
    install: () => installWith({ kind: "install" }, api.installPackages),
    add: (pkg) => installWith({ kind: "add", package: pkg }, () => api.addPackage(pkg)),
    remove: (pkg) => installWith({ kind: "remove", package: pkg }, () => api.removePackage(pkg)),
    cancel: () => {
      api.cancelInstall().catch((e: unknown) => setError(message(e)));
    },
    save: async (text) => setResponse(await api.savePackages(text)),
    resolve: (module) => {
      let found = resolutions.current.get(module);
      if (found === undefined) {
        found = api.resolvePackage(module);
        // A failed lookup, such as when offline, is tried again next time.
        found.catch(() => resolutions.current.delete(module));
        resolutions.current.set(module, found);
      }
      return found;
    },
  };
}
