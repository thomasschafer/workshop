import { useEffect, useState } from "preact/hooks";
import { api, type ThemeChoice, type ThemeSettings, type ThemesState } from "../api";
import { applyThemeCss } from "../theme";

function encode(choice: ThemeChoice): string {
  return choice.kind === "named" ? `named:${choice.name}` : choice.kind;
}

function decode(value: string): ThemeChoice {
  if (value === "ghostty") return { kind: "ghostty" };
  if (value.startsWith("named:")) return { kind: "named", name: value.slice("named:".length) };
  return { kind: "default" };
}

/** Choosing terminal colour themes for light and dark mode. */
export function ThemeSection() {
  const [themes, setThemes] = useState<ThemesState | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .themes()
      .then(setThemes)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  const choose = async (next: ThemeSettings) => {
    setError(null);
    try {
      applyThemeCss((await api.setTheme(next)).css);
      setThemes((t) => (t ? { ...t, settings: next } : t));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  if (!themes) return error ? <p class="error-text">{error}</p> : null;

  const picker = (mode: "light" | "dark") => (
    <label class="theme-picker">
      {mode === "light" ? "Light mode" : "Dark mode"}
      <select
        value={encode(themes.settings[mode])}
        onChange={(e) =>
          void choose({ ...themes.settings, [mode]: decode((e.target as HTMLSelectElement).value) })
        }
      >
        <option value="default">Workshop's colours</option>
        {themes.ghostty ? (
          <option value="ghostty">
            Match Ghostty ({mode === "light" ? themes.ghostty[0] : themes.ghostty[1]})
          </option>
        ) : null}
        {themes.names.map((name) => (
          <option key={name} value={`named:${name}`}>
            {name}
          </option>
        ))}
      </select>
    </label>
  );

  return (
    <>
      {picker("dark")}
      {picker("light")}
      {themes.names.length === 0 ? (
        <p class="muted small">
          Install Ghostty, or put Ghostty or base16 theme files in Workshop's themes folder, to
          choose from terminal themes.
        </p>
      ) : null}
      {error ? <p class="error-text">{error}</p> : null}
    </>
  );
}
