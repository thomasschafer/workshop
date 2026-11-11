import { describe, expect, it } from "vitest";
import { HELIX_CASES } from "./helixCases";
import { LANGUAGES, type LanguageConfig } from "./languages";
import { harness, plain, print } from "./testing";

/** Adds a final line ending, as Helix's tests do unless they ask not to. */
function native(text: string): string {
  return text.endsWith("\n") ? text : `${text}\n`;
}

describe("Helix's own integration tests", () => {
  for (const [i, c] of HELIX_CASES.entries()) {
    it(`${c.from} #${i}: ${JSON.stringify(c.keys)}`, async () => {
      const input = c.native ? native(c.input) : c.input;
      const output = c.native ? native(c.output) : c.output;
      // `:lang` sets the file's language, which Workshop knows from the puzzle's language.
      let keys = c.keys;
      let language: LanguageConfig | undefined;
      const lang = /^:lang (\w+)<ret>/.exec(keys);
      if (lang) {
        language = LANGUAGES[lang[1] as string];
        if (language === undefined) throw new Error(`no language config for ${lang[1]}`);
        keys = keys.slice(lang[0].length);
      }
      const h = harness(input, language ? { language } : {});
      await h.keys(keys);
      const expected = print(output);
      expect(h.state()).toBe(plain(expected.text, expected.selection));
    });
  }
});
