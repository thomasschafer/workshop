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

describe("undo", () => {
  it("undoes a key bound to several commands as one step, moves and all", async () => {
    const { keymapsWithConfig } = await import("./keymap");
    const { keymaps } = keymapsWithConfig({
      normal: {
        "A-up": [
          "ensure_selections_forward",
          "extend_to_line_bounds",
          "extend_char_right",
          "extend_char_left",
          "delete_selection",
          "move_line_up",
          "add_newline_above",
          "move_line_up",
          "replace_with_yanked",
        ],
      },
    });
    const h = harness("x = 1\n#[i|]#mport sys\ny = 2\n", { keymaps });
    await h.keys("<A-up>");
    expect(h.state()).toBe("#[import sys\n|]#x = 1\ny = 2\n");
    await h.keys("u");
    expect(h.host.state.doc.toString()).toBe("x = 1\nimport sys\ny = 2\n");
  });
});
