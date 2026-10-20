import { useEffect, useMemo } from "preact/hooks";
import { api, type UiState } from "../api";
import { LatestSaver } from "../saver";

/** Remembers where the user is, so a reload reopens the same view. */
export function useUiStateSaver({ puzzle, tab, discuss_model }: UiState): LatestSaver<UiState> {
  const stateSaver = useMemo(
    () =>
      new LatestSaver<UiState>(
        (state, keepalive) => api.saveState(state, keepalive),
        500,
        () => {},
      ),
    [],
  );
  useEffect(() => {
    stateSaver.schedule({ puzzle, tab, discuss_model });
  }, [puzzle, tab, discuss_model, stateSaver]);
  return stateSaver;
}
