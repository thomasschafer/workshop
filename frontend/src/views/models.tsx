import { useState } from "preact/hooks";
import { api, type ModelSettings, type ModelsState, type ProviderOption } from "../api";
import { errorMessage } from "../errors";

interface Props {
  models: ModelsState;
  onModels: (models: ModelsState) => void;
  /** Whether to show its own heading, which isn't wanted inside another section. */
  heading?: boolean;
}

/**
 * Choosing the model CLI and model for editing, the CLI for discussion, and the model for the
 * grader, which marks work.
 */
export function ModelsSection({ models, onModels, heading = true }: Props) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { settings, providers, grader } = models;

  const choose = async (next: ModelSettings) => {
    setSaving(true);
    setError(null);
    try {
      onModels(await api.setModels(next));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const editing = providers.filter((p) => p.edit_models.length > 0);
  const discussing = providers.filter((p) => p.discuss_models.length > 0);
  const editProvider = providers.find((p) => p.id === settings.edit.provider);
  const graderProvider = grader ? providers.find((p) => p.id === grader.provider) : undefined;
  const unavailable = providers.filter((p) => p.unavailable !== null);

  const providerChips = (
    options: ProviderOption[],
    selected: string,
    onPick: (provider: ProviderOption) => void,
  ) =>
    options.map((p) => (
      <button
        type="button"
        key={p.id}
        class={`chip ${p.id === selected ? "selected" : ""}`}
        disabled={saving || p.unavailable !== null}
        onClick={() => p.id !== selected && onPick(p)}
      >
        {p.name}
      </button>
    ));

  return (
    <div class="models">
      {heading ? <h2>Models</h2> : null}
      <p class="label">Editing</p>
      <div class="snippets">
        {providerChips(editing, settings.edit.provider, (p) =>
          choose({ ...settings, edit: { provider: p.id, model: p.edit_models[0] ?? "" } }),
        )}
      </div>
      {editProvider ? (
        <div class="snippets">
          {editProvider.edit_models.map((model) => (
            <button
              type="button"
              key={model}
              class={`chip ${model === settings.edit.model ? "selected" : ""}`}
              disabled={saving}
              onClick={() =>
                model !== settings.edit.model &&
                choose({ ...settings, edit: { provider: editProvider.id, model } })
              }
            >
              {model}
            </button>
          ))}
        </div>
      ) : null}
      <p class="label">Discussing</p>
      <div class="snippets">
        {providerChips(discussing, settings.discuss_provider, (p) =>
          choose({ ...settings, discuss_provider: p.id }),
        )}
      </div>
      <p class="label">Grading</p>
      <div class="snippets">
        <button
          type="button"
          class={`chip ${grader === null ? "selected" : ""}`}
          disabled={saving}
          onClick={() => grader !== null && choose({ ...settings, grader: { kind: "discussion" } })}
        >
          As discussing
        </button>
        {providerChips(discussing, grader?.provider ?? "", (p) =>
          choose({
            ...settings,
            grader: { kind: "model", provider: p.id, model: p.discuss_models[0] ?? "" },
          }),
        )}
      </div>
      {grader && graderProvider ? (
        <div class="snippets">
          {[
            ...(graderProvider.discuss_models.includes(grader.model) ? [] : [grader.model]),
            ...graderProvider.discuss_models,
          ].map((model) => (
            <button
              type="button"
              key={model}
              class={`chip ${model === grader.model ? "selected" : ""}`}
              disabled={saving}
              onClick={() =>
                model !== grader.model &&
                choose({
                  ...settings,
                  grader: { kind: "model", provider: graderProvider.id, model },
                })
              }
            >
              {model}
            </button>
          ))}
        </div>
      ) : null}
      <p class="muted small">
        Changes apply straight away. After each edit, its card shows the model that made it and how
        long it took.
      </p>
      {unavailable.map((p) => (
        <p key={p.id} class="muted small">
          {p.name} isn't available: {p.unavailable}
        </p>
      ))}
      {error ? <p class="error-text">{error}</p> : null}
    </div>
  );
}
