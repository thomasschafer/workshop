import { useEffect, useState } from "preact/hooks";
import { errorMessage } from "../errors";
import { ProgramsInstall } from "../views/install";
import { codingApi } from "./api";
import type { Language, Toolchain } from "./types";

/**
 * Offers to install a language's programs for the Coding track with mise, when any of them,
 * its language server included, isn't installed. Says nothing once they all are.
 */
export function ToolchainOffer({
  language,
  onInstalled,
}: {
  language: Language;
  /** Called once an install has succeeded, such as to connect to the language server. */
  onInstalled: () => void;
}) {
  const [state, setState] = useState<Toolchain | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () => {
    codingApi
      .toolchain(language)
      .then((toolchain) => {
        setState(toolchain);
        setError(null);
      })
      .catch((e: unknown) => setError(errorMessage(e)));
  };
  useEffect(load, [language]);

  if (error !== null) return <p class="coding-toolchain error-text small">{error}</p>;
  if (state === null) return null;
  const failed = state.install.last_install?.succeeded === false;
  if (
    state.missing.length === 0 &&
    state.missing_language_server === null &&
    state.problem === null &&
    !state.install.installing &&
    !failed
  ) {
    return null;
  }
  return (
    <section class="coding-toolchain" aria-label={`Installing ${state.name}`}>
      <ProgramsInstall
        name={state.name}
        needs={state}
        miseInstalled={state.mise_installed}
        problem={state.problem}
        install={state.install}
        scope="the Coding track"
        onInstall={async () => {
          setState(await codingApi.installToolchain(language));
          onInstalled();
        }}
        onCancel={() => {
          codingApi.cancelToolchainInstall(language).catch(() => {});
        }}
        onRefresh={load}
      />
    </section>
  );
}
