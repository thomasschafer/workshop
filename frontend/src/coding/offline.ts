// Offline cache helpers for the Coding track.
//
// Splits `GET /api/coding/offline-bundle` into two IndexedDB stores:
// - `codingBundle`: UI-safe data (prompt, examples, hints, starters/drafts, session, approach/solution
//   gated in UI behind `step === "review"`).
// - `codingTests`: hidden tests & precomputed oracle cases, kept separate so UI code never reads them.

import type { VersionedFile } from "../api";
import { getRecord, listRecords, putRecord } from "../offline/db";
import { codingApi } from "./api";
import { revealed } from "./steps";
import type {
  Api,
  Case,
  Language,
  OfflineItem,
  OfflineLanguage,
  Opened,
  OpenedPart,
  OpenedTrack,
  OracleCase,
  Session,
} from "./types";

export interface CachedCodingProblem {
  key: string;
  label: string;
  track: OpenedTrack;
  skills: string[];
  source: string | null;
  minutes: number;
  /** Every part; UI must only show those the session has reached. */
  parts: OpenedPart[];
  api: Api | null;
  languages: OfflineLanguage[];
  emptyVersion: string;
  session: Session | null;
  previous_plan: string | null;
  /** Stored only for offline review; UI must only expose it when `session.step === "review"`. */
  solution: OfflineItem["solution"];
  oracleReady: boolean;
  updatedAt: number;
}

export interface CachedCodingTests {
  key: string;
  /** Each part's hidden tests. */
  tests: Case[][];
  oracleCases: OracleCase[];
  oracleReady: boolean;
  updatedAt: number;
}

export interface BundleSyncSummary {
  count: number;
  oraclesReady: number;
  oraclesTotal: number;
  oraclesComputing: boolean;
}

/** Whether a cached coding problem can run locally or is edit/review-only offline. */
export type OfflineCodingCapability = "runnable" | "edit_review";

export function offlineCapability(_problem: CachedCodingProblem): OfflineCodingCapability {
  // Phase 2 adds on-device WASM runners; until one is installed, cached coding problems support
  // understanding, planning, editing with Helix + Workshop keyboard, recall, review and finishing.
  return "edit_review";
}

/** Fetches the opt-in offline coding bundle and splits UI data from hidden tests in IndexedDB. */
export async function syncCodingBundle(): Promise<BundleSyncSummary> {
  const bundle = await codingApi.offlineBundle();
  const now = Date.now();
  let oraclesReady = 0;

  for (const item of bundle.items) {
    if (item.oracle_ready) oraclesReady++;
    const existing = await getRecord<CachedCodingProblem>("codingBundle", item.key);
    const languages: OfflineLanguage[] = item.languages.map((lang) => {
      const prevLang = existing?.languages.find((l) => l.id === lang.id);
      return {
        ...lang,
        code: lang.code ?? prevLang?.code ?? null,
      };
    });
    const uiRecord: CachedCodingProblem = {
      key: item.key,
      label: item.label,
      track: item.track,
      skills: item.skills,
      source: item.source,
      minutes: item.minutes,
      parts: item.parts,
      api: item.api,
      languages,
      emptyVersion: bundle.empty_version,
      session: item.session,
      previous_plan: item.previous_plan,
      solution: item.solution,
      oracleReady: item.oracle_ready,
      updatedAt: now,
    };
    const testsRecord: CachedCodingTests = {
      key: item.key,
      tests: item.tests,
      oracleCases: item.oracle_cases,
      oracleReady: item.oracle_ready,
      updatedAt: now,
    };
    await Promise.all([putRecord("codingBundle", uiRecord), putRecord("codingTests", testsRecord)]);
  }

  return {
    count: bundle.items.length,
    oraclesReady,
    oraclesTotal: bundle.items.length,
    oraclesComputing: bundle.oracles_computing,
  };
}

export async function getCachedCodingProblem(key: string): Promise<CachedCodingProblem | null> {
  return getRecord<CachedCodingProblem>("codingBundle", key);
}

export async function listCachedCodingProblems(): Promise<CachedCodingProblem[]> {
  return listRecords<CachedCodingProblem>("codingBundle");
}

/** Updates the cached session for a coding problem (null when finished). */
export async function updateCachedCodingSession(
  key: string,
  session: Session | null,
): Promise<void> {
  const existing = await getCachedCodingProblem(key);
  if (!existing) return;
  await putRecord("codingBundle", {
    ...existing,
    session,
    updatedAt: Date.now(),
  } satisfies CachedCodingProblem);
}

/** Updates the cached code draft for one language of a coding problem. */
export async function updateCachedCodingDraft(
  key: string,
  language: Language,
  code: VersionedFile,
): Promise<void> {
  const existing = await getCachedCodingProblem(key);
  if (!existing) return;
  const languages = existing.languages.map((lang) =>
    lang.id === language ? { ...lang, code } : lang,
  );
  await putRecord("codingBundle", {
    ...existing,
    languages,
    updatedAt: Date.now(),
  } satisfies CachedCodingProblem);
}

/**
 * Reconstructs an `Opened` coding problem from IndexedDB when offline.
 * Never leaks hidden tests; gates `solution` strictly behind `session.step === "review"`, and
 * later parts behind the session reaching them.
 */
export async function openCodingFromCache(
  key: string,
  solve = false,
): Promise<{ opened: Opened; createdSession: Session | null } | null> {
  const cached = await getCachedCodingProblem(key);
  if (!cached) return null;

  let session = cached.session;
  let createdSession: Session | null = null;
  if (!session || (solve && session.mode !== "solve")) {
    const now = Date.now();
    const firstLang = cached.languages[0]?.id ?? "python";
    const recall = !solve && cached.previous_plan !== null;
    session = {
      mode: recall ? "recall" : "solve",
      step: recall ? "plan" : "understand",
      language: firstLang,
      part: 0,
      plans: [],
      prediction: null,
      plan: "",
      passed: false,
      runs: 0,
      submissions: 0,
      hints: 0,
      no_twist: recall ? "Offline: recalling your approach without a tutor twist." : null,
      started_at: now,
      updated_at: now,
      version: 1,
    };
    createdSession = session;
    await updateCachedCodingSession(key, session);
  }

  const opened: Opened = {
    key: cached.key,
    label: cached.label,
    track: cached.track,
    skills: cached.skills,
    source: cached.source,
    minutes: cached.minutes,
    parts: cached.parts.slice(0, revealed(session, cached.parts.length)),
    part_count: cached.parts.length,
    api: cached.api,
    languages: cached.languages.map((lang) => ({
      id: lang.id,
      name: lang.name,
      editor_mode: lang.editor_mode,
      code: lang.code ?? {
        text: lang.starter,
        version: cached.emptyVersion,
        path: lang.file_path,
      },
      lsp: lang.lsp,
    })),
    session,
    previous_plan: cached.previous_plan,
    solution: session.step === "review" ? cached.solution : null,
    twist: null,
  };

  return { opened, createdSession };
}
