import { useEffect, useState } from "preact/hooks";
import {
  api,
  type SyntaxThemeChoice,
  type ThemeChoice,
  type ThemeSettings,
  type ThemesState,
} from "../api";
import { errorMessage } from "../errors";
import { applySyntaxTheme, applyThemeCss } from "../theme";

function encode(choice: ThemeChoice): string {
  return choice.kind === "named" ? `named:${choice.name}` : choice.kind;
}

function decode(value: string): ThemeChoice {
  if (value === "ghostty") return { kind: "ghostty" };
  if (value.startsWith("named:")) return { kind: "named", name: value.slice("named:".length) };
  return { kind: "default" };
}

function encodeSyntax(choice: SyntaxThemeChoice): string {
  return choice.kind === "named" ? `named:${choice.name}` : choice.kind;
}

function decodeSyntax(value: string): SyntaxThemeChoice {
  if (value === "helix") return { kind: "helix" };
  if (value.startsWith("named:")) return { kind: "named", name: value.slice("named:".length) };
  return { kind: "default" };
}

/** Choosing terminal colour themes and Helix syntax themes for light and dark mode. */
export function ThemeSection() {
  const [themes, setThemes] = useState<ThemesState | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .themes()
      .then(setThemes)
      .catch((e: unknown) => setError(errorMessage(e)));
  }, []);

  const choose = async (next: ThemeSettings) => {
    setError(null);
    try {
      const applied = await api.setTheme(next);
      applyThemeCss(applied.css);
      applySyntaxTheme(applied.syntax_theme);
      setThemes((t) => (t ? { ...t, settings: next, helix: { ...t.helix, error: null } } : t));
    } catch (e) {
      setError(errorMessage(e));
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
        <option value="default">Default</option>
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

  const syntaxPicker = (mode: "light" | "dark") => {
    const current = themes.settings.syntax[mode];
    const hasConfigured = themes.helix.config !== null;
    const configuredName = themes.helix.config
      ? mode === "light"
        ? themes.helix.config[0]
        : themes.helix.config[1]
      : null;
    const showMissingNamed = current.kind === "named" && !themes.helix.names.includes(current.name);

    return (
      <label class="theme-picker">
        {mode === "light" ? "Code colours (light)" : "Code colours (dark)"}
        <select
          value={encodeSyntax(current)}
          onChange={(e) =>
            void choose({
              ...themes.settings,
              syntax: {
                ...themes.settings.syntax,
                [mode]: decodeSyntax((e.target as HTMLSelectElement).value),
              },
            })
          }
        >
          <option value="default">Default</option>
          {hasConfigured || current.kind === "helix" ? (
            <option value="helix">
              {configuredName ? `Match Helix (${configuredName})` : "Match Helix"}
            </option>
          ) : null}
          {showMissingNamed ? (
            <option value={`named:${current.name}`}>{current.name}</option>
          ) : null}
          {themes.helix.names.map((name) => (
            <option key={name} value={`named:${name}`}>
              {name}
            </option>
          ))}
        </select>
      </label>
    );
  };

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
      {syntaxPicker("dark")}
      {syntaxPicker("light")}
      {themes.helix.names.length === 0 && !themes.helix.config && !themes.helix.error ? (
        <p class="muted small">
          Install Helix, or put Helix theme files in its themes folder, to use a Helix theme for
          code colours.
        </p>
      ) : null}
      {themes.helix.error ? <p class="error-text">{themes.helix.error}</p> : null}
      {error ? <p class="error-text">{error}</p> : null}
    </>
  );
}
