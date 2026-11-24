import { useEffect, useMemo } from "preact/hooks";
import { api, type UiState } from "../api";
import { patchCachedBootstrapState } from "../offline/bootstrap";
import { LatestSaver } from "../saver";

/** Remembers where the user is, so a reload reopens the same view. */
export function useUiStateSaver({ puzzle, tab, discuss_model }: UiState): LatestSaver<UiState> {
  const stateSaver = useMemo(
    () =>
      new LatestSaver<UiState>(
        (state, keepalive) => api.saveState(state, keepalive),
        500,
        () => {},
        { pauseWhileOffline: true },
      ),
    [],
  );
  useEffect(() => {
    const state: UiState = { puzzle, tab, discuss_model };
    patchCachedBootstrapState(state);
    stateSaver.schedule(state);
  }, [puzzle, tab, discuss_model, stateSaver]);
  return stateSaver;
}
