import { useState } from "preact/hooks";
import { errorMessage } from "../errors";
import { packApi } from "./api";
import type { PackShown } from "./types";

const KINDS = [
  ["", "Not sure"],
  ["card", "Card"],
  ["mental-maths", "Mental maths"],
  ["probability", "Probability"],
  ["coding", "Coding problem"],
  ["reading", "Code to read"],
  ["design", "Design prompt"],
] as const;

/** Adding a question to a pack as a draft, which the author can make into an item with a check. */
export function ImportForm({ packs, onImported }: { packs: PackShown[]; onImported: () => void }) {
  const editable = packs.filter((p) => p.editable);
  const [pack, setPack] = useState(editable[0]?.id ?? "");
  const [text, setText] = useState("");
  const [source, setSource] = useState("");
  const [skills, setSkills] = useState<string[]>([]);
  const [kind, setKind] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const chosen = editable.find((p) => p.id === pack);

  if (!chosen) {
    return (
      <p class="muted">
        The sample pack is built in, so questions can't be added to it. List a pack of your own
        under [learning] in your config to add to it.
      </p>
    );
  }
  const submit = (event: Event) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    packApi
      .import({ pack, text, source: source.trim() || null, skills, kind: kind || null })
      .then(
        ({ draft, commit }) => {
          setSaid(
            `Added as ${draft.path}${commit ? `, in commit ${commit}` : ""}. The author can make it an item.`,
          );
          setText("");
          setSource("");
          setSkills([]);
          onImported();
        },
        (e: unknown) => setError(errorMessage(e)),
      )
      .finally(() => setBusy(false));
  };
  return (
    <form class="learn-form pack-import" onSubmit={submit}>
      {editable.length > 1 ? (
        <label>
          Pack
          <select value={pack} onChange={(event) => setPack(event.currentTarget.value)}>
            {editable.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <label for="import-text">The question</label>
      <textarea
        id="import-text"
        class="written"
        rows={5}
        value={text}
        onInput={(event) => setText(event.currentTarget.value)}
      />
      <label>
        Where it's from (optional)
        <input
          type="text"
          value={source}
          onInput={(event) => setSource(event.currentTarget.value)}
        />
      </label>
      <label>
        What it should become
        <select value={kind} onChange={(event) => setKind(event.currentTarget.value)}>
          {KINDS.map(([id, name]) => (
            <option key={id} value={id}>
              {name}
            </option>
          ))}
        </select>
      </label>
      <fieldset class="pack-skills">
        <legend>Skills</legend>
        {chosen.skills.map((skill) => (
          <label key={skill.id} class="pack-skill">
            <input
              type="checkbox"
              checked={skills.includes(skill.id)}
              onChange={(event) =>
                setSkills((now) =>
                  event.currentTarget.checked
                    ? [...now, skill.id]
                    : now.filter((s) => s !== skill.id),
                )
              }
            />
            {skill.name}
          </label>
        ))}
      </fieldset>
      {error ? (
        <p class="error-text" role="alert">
          {error}
        </p>
      ) : null}
      {said ? (
        <p class="muted" role="status">
          {said}
        </p>
      ) : null}
      <button
        type="submit"
        class="pill primary"
        disabled={busy || !text.trim() || skills.length === 0}
      >
        Add as a draft
      </button>
    </form>
  );
}
