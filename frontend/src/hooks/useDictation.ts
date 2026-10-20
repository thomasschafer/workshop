import { useEffect, useMemo, useState } from "preact/hooks";
import { prepareRecording, recordingSupported } from "../audio";
import { resolveDictation } from "../dictation";
import * as preferences from "../preferences";
import { speechSupported } from "../voice";

/** How what's said is heard: the choice made in Settings, and what this device and server allow. */
export function useDictation(serverDictation: boolean) {
  const [dictationChoice, setDictationChoice] = useState(() => preferences.dictation.get());
  const [serverSpeech, setServerSpeech] = useState(serverDictation);
  const hasSpeech = useMemo(speechSupported, []);
  const canRecord = useMemo(recordingSupported, []);
  const dictationSupport = {
    server: serverSpeech && canRecord,
    browser: hasSpeech,
  };
  const dictationMethod = resolveDictation(dictationChoice, dictationSupport);
  useEffect(() => {
    if (dictationMethod === "server") prepareRecording();
  }, [dictationMethod]);
  return {
    dictationChoice,
    setDictationChoice,
    setServerSpeech,
    hasSpeech,
    dictationSupport,
    dictationMethod,
  };
}
