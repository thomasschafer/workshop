import { useEffect, useRef, useState } from "preact/hooks";
import { api, type BenchInfo, type WhisperTranscript } from "../api";
import { AudioRecorder } from "../audio";
import { PushToTalk, speechSupported } from "../voice";
import { wordErrorRate } from "../wer";

interface Phrase {
  language: "Haskell" | "Python";
  text: string;
}

/** Realistic dictation, in both built-in languages. All invented. */
const PHRASES: Phrase[] = [
  { language: "Haskell", text: "replace the undefined with sum dot map read dot lines" },
  { language: "Haskell", text: "import qualified data dot map dot strict as M" },
  {
    language: "Haskell",
    text: "part one equals length dot filter open bracket greater than one hundred close bracket",
  },
  {
    language: "Haskell",
    text: "new line where solve seen open bracket x colon xs close bracket equals",
  },
  { language: "Haskell", text: "wrap that in show and put print dollar before it" },
  { language: "Python", text: "def part two of data colon" },
  { language: "Python", text: "return max of sum of map int of row dot split for row in rows" },
  { language: "Python", text: "counts equals counter of data dot split lines" },
];

/** Names a solution in each language would contain, for priming Whisper. */
const VOCABULARY: Record<Phrase["language"], string[]> = {
  Haskell: [
    "part1",
    "part2",
    "parse",
    "solve",
    "seen",
    "lines",
    "words",
    "foldr",
    "Data.Map.Strict",
  ],
  Python: ["part1", "part2", "data", "splitlines", "rows", "row", "Counter", "defaultdict"],
};

const prompt = (language: Phrase["language"]) =>
  `${language} code, dictated aloud with symbols said as words, like dot, colon and open bracket. Names in the code: ${VOCABULARY[language].join(", ")}.`;

interface Take {
  /** The browser's own recognition, run at the same time as recording. */
  browser: { text: string; error: string | null };
  whisper: WhisperTranscript[] | { error: string };
  keyboard: string;
}

type Phase = "ready" | "recording" | "transcribing" | "keyboard";

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const percent = (rate: number) => `${Math.round(rate * 100)}%`;
/** Progress through the phrases, kept on this device so the benchmark can be finished later. */
interface Progress {
  session: string;
  index: number;
  takes: Take[];
  /** The phrase recorded and transcribed, waiting for its keyboard dictation. */
  current: Omit<Take, "keyboard"> | null;
  keyboard: string;
}

const PROGRESS_KEY = "workshop:speech-bench";

function loadProgress(): Progress | null {
  try {
    const stored = localStorage.getItem(PROGRESS_KEY);
    const progress = stored ? (JSON.parse(stored) as Partial<Progress>) : null;
    if (
      progress === null ||
      typeof progress.session !== "string" ||
      typeof progress.index !== "number" ||
      !Array.isArray(progress.takes) ||
      progress.index >= PHRASES.length
    ) {
      return null;
    }
    return {
      session: progress.session,
      index: progress.index,
      takes: progress.takes,
      current: progress.current ?? null,
      keyboard: progress.keyboard ?? "",
    };
  } catch {
    return null;
  }
}

function saveProgress(progress: Progress | null): void {
  try {
    if (progress === null) localStorage.removeItem(PROGRESS_KEY);
    else localStorage.setItem(PROGRESS_KEY, JSON.stringify(progress));
  } catch {
    // Storage can be full or disabled; the benchmark still works, but can't be resumed.
  }
}

const newSession = () =>
  new Date()
    .toISOString()
    .replace(/[^0-9]/g, "")
    .slice(0, 14);

const engineName = (t: WhisperTranscript) =>
  `Whisper ${t.model}${t.prompted ? ", primed with the code's names" : ""}`;

/**
 * Compares speech recognition on the same phrases: the browser's own, the phone keyboard's, and
 * Whisper's on the server. Recordings and results are saved there.
 */
export function SpeechBench() {
  const [info, setInfo] = useState<BenchInfo | null>(null);
  const [index, setIndex] = useState(0);
  const [phase, setPhase] = useState<Phase>("ready");
  const [takes, setTakes] = useState<Take[]>([]);
  const [current, setCurrent] = useState<Omit<Take, "keyboard"> | null>(null);
  const [keyboard, setKeyboard] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [session, setSession] = useState(newSession);
  /** Progress left unfinished last time, until the user chooses to carry on or start again. */
  const [unfinished, setUnfinished] = useState(loadProgress);
  const recording = useRef<{ audio: AudioRecorder; ptt: PushToTalk | null } | null>(null);

  useEffect(() => {
    api
      .bench()
      .then(setInfo)
      .catch((e: unknown) => setError(message(e)));
  }, []);

  // Kept as it changes, so leaving part way through loses nothing.
  useEffect(() => {
    if (unfinished !== null) return;
    if (index >= PHRASES.length) saveProgress(null);
    else if (takes.length > 0 || current !== null) {
      saveProgress({ session, index, takes, current, keyboard });
    }
  }, [unfinished, session, index, takes, current, keyboard]);

  const phrase = PHRASES[index];
  if (info === null) return error ? <p class="error-text">{error}</p> : null;

  if (unfinished !== null) {
    return (
      <div class="bench">
        <p>
          You stopped part way through last time, at phrase {unfinished.index + 1} of{" "}
          {PHRASES.length}.
        </p>
        <button
          type="button"
          class="pill primary wide"
          onClick={() => {
            setSession(unfinished.session);
            setIndex(unfinished.index);
            setTakes(unfinished.takes);
            setCurrent(unfinished.current);
            setKeyboard(unfinished.keyboard);
            setPhase(unfinished.current ? "keyboard" : "ready");
            setUnfinished(null);
          }}
        >
          Carry on
        </button>
        <button
          type="button"
          class="pill wide"
          onClick={() => {
            saveProgress(null);
            setUnfinished(null);
          }}
        >
          Start again
        </button>
      </div>
    );
  }

  const start = async (event: PointerEvent) => {
    event.preventDefault();
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    setError(null);
    try {
      const audio = await AudioRecorder.start();
      // Both at once, as Workshop would, which shows whether the phone allows it.
      let ptt: PushToTalk | null = null;
      if (speechSupported()) {
        ptt = new PushToTalk();
        ptt.start(() => {});
      }
      recording.current = { audio, ptt };
      setPhase("recording");
    } catch (e) {
      setError(`Couldn't record: ${message(e)}`);
    }
  };

  const stop = async () => {
    const taking = recording.current;
    if (!taking || !phrase) return;
    recording.current = null;
    setPhase("transcribing");
    const [heard, wav] = await Promise.all([
      taking.ptt?.stop() ?? Promise.resolve(null),
      taking.audio.stop(),
    ]);
    const browser = heard
      ? { text: heard.text, error: heard.error }
      : { text: "", error: "This browser has no speech recognition." };
    let whisper: Take["whisper"];
    try {
      whisper = await api.benchTranscribe(session, index, prompt(phrase.language), wav);
    } catch (e) {
      whisper = { error: message(e) };
    }
    setCurrent({ browser, whisper });
    setKeyboard("");
    setPhase("keyboard");
  };

  const next = async () => {
    if (!current || !phrase) return;
    const take = { ...current, keyboard };
    try {
      await api.benchResult({
        session: session,
        phrase: index,
        expected: phrase.text,
        language: phrase.language,
        userAgent: navigator.userAgent,
        ...take,
      });
    } catch (e) {
      setError(`Couldn't save the result: ${message(e)}`);
      return;
    }
    setTakes([...takes, take]);
    setCurrent(null);
    setIndex(index + 1);
    setPhase("ready");
  };

  if (!phrase) {
    return <Summary takes={takes} session={session} />;
  }

  return (
    <div class="bench">
      {/* Stays in view while scrolling down to the results and the keyboard's box. */}
      <div class="bench-prompt">
        <p class="muted small">
          Phrase {index + 1} of {PHRASES.length} · {phrase.language}
        </p>
        <p class="bench-phrase">{phrase.text}</p>
      </div>
      {!info.whisper_installed || info.models.length === 0 ? (
        <p class="error-text small">
          {info.whisper_installed
            ? `No Whisper models yet: put whisper.cpp's ggml-<name>.bin files in ${info.models_dir}.`
            : "Whisper isn't installed on the server, so only this device's recognition is compared."}
        </p>
      ) : null}
      {phase === "keyboard" && current ? (
        <>
          <Results expected={phrase.text} browser={current.browser} whisper={current.whisper} />
          <p class="small">
            Now dictate the same phrase with your keyboard's microphone, into this box:
          </p>
          <textarea
            class="bench-keyboard"
            value={keyboard}
            onInput={(e) => setKeyboard((e.target as HTMLTextAreaElement).value)}
            rows={3}
          />
          {keyboard ? (
            <p class="muted small">
              Keyboard: {percent(wordErrorRate(phrase.text, keyboard))} of words wrong
            </p>
          ) : null}
          <button type="button" class="pill primary wide" onClick={() => void next()}>
            {index + 1 < PHRASES.length ? "Save and next" : "Save and finish"}
          </button>
        </>
      ) : (
        <button
          type="button"
          class={`talk bench-talk ${phase === "recording" ? "listening" : ""}`}
          disabled={phase === "transcribing"}
          onPointerDown={(e) => void start(e)}
          onPointerUp={() => void stop()}
          onPointerCancel={() => void stop()}
          onContextMenu={(e) => e.preventDefault()}
        >
          {phase === "recording"
            ? "Release when done"
            : phase === "transcribing"
              ? "Transcribing…"
              : "Hold and read it aloud"}
        </button>
      )}
      {error ? <p class="error-text small">{error}</p> : null}
    </div>
  );
}

function Results({
  expected,
  browser,
  whisper,
}: {
  expected: string;
  browser: Take["browser"];
  whisper: Take["whisper"];
}) {
  return (
    <table class="bench-results">
      <tbody>
        <tr>
          <th>This browser</th>
          <td>{browser.error ?? (browser.text || "(nothing)")}</td>
          <td>{browser.error ? "" : percent(wordErrorRate(expected, browser.text))}</td>
        </tr>
        {"error" in whisper ? (
          <tr>
            <th>Whisper</th>
            <td colSpan={2} class="error-text">
              {whisper.error}
            </td>
          </tr>
        ) : (
          whisper.map((t) => (
            <tr key={`${t.model}-${t.prompted}`}>
              <th>{engineName(t)}</th>
              <td>{t.text}</td>
              <td>
                {percent(wordErrorRate(expected, t.text))}
                <span class="muted"> · {(warmMs(t) / 1000).toFixed(1)}s</span>
              </td>
            </tr>
          ))
        )}
      </tbody>
    </table>
  );
}

/** How long a Whisper kept running between utterances would take, without loading the model. */
function warmMs(t: WhisperTranscript): number {
  return t.total_ms !== null && t.load_ms !== null ? t.total_ms - t.load_ms : t.wall_ms;
}

function Summary({ takes, session }: { takes: Take[]; session: string }) {
  const rows = new Map<string, { errors: number[]; ms: number[] }>();
  const add = (name: string, rate: number, ms?: number) => {
    const row = rows.get(name) ?? { errors: [], ms: [] };
    row.errors.push(rate);
    if (ms !== undefined) row.ms.push(ms);
    rows.set(name, row);
  };
  takes.forEach((take, i) => {
    const expected = PHRASES[i]?.text ?? "";
    if (!take.browser.error) add("This browser", wordErrorRate(expected, take.browser.text));
    if (take.keyboard) add("Keyboard dictation", wordErrorRate(expected, take.keyboard));
    if (!("error" in take.whisper)) {
      for (const t of take.whisper) add(engineName(t), wordErrorRate(expected, t.text), warmMs(t));
    }
  });
  const average = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length;
  const ranked = [...rows].sort((a, b) => average(a[1].errors) - average(b[1].errors));
  return (
    <div class="bench">
      <p>Done. Fewest wrong words first:</p>
      <table class="bench-results">
        <tbody>
          {ranked.map(([name, row]) => (
            <tr key={name}>
              <th>{name}</th>
              <td>{percent(average(row.errors))} wrong</td>
              <td class="muted">
                {row.ms.length > 0 ? `${(average(row.ms) / 1000).toFixed(1)}s` : ""}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p class="muted small">Saved on the server, as session {session}, with the recordings.</p>
    </div>
  );
}
