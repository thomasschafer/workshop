import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { loadLanguageBundle, registeredTreeSitterModes } from "../treesitter";
import { installNodeWasmLoader } from "../treesitter/nodeTestLoader";
import { harness } from "./testing";

interface OracleCase {
  readonly name: string;
  readonly input: string;
  readonly keys: string;
  readonly lang: string;
  readonly expected: {
    readonly text: string;
    /** Helix char (Unicode scalar value) offsets `[anchor, head]`. */
    readonly ranges: readonly (readonly [number, number])[];
    readonly primary: number;
    readonly mode: string;
  };
}

interface OracleFixture {
  readonly generatedFromHelixCommit: string;
  readonly generatedWith: string;
  readonly cases: readonly OracleCase[];
}

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = JSON.parse(readFileSync(join(HERE, "oracleCases.json"), "utf8")) as OracleFixture;

/**
 * Converts a Helix `char` offset (Unicode scalar value index) in `text` to a UTF-16 code-unit
 * offset used by JS strings and CodeMirror.
 */
function charOffsetToUtf16(text: string, charOffset: number): number {
  let chars = 0;
  let utf16 = 0;
  while (utf16 < text.length && chars < charOffset) {
    const cp = text.codePointAt(utf16);
    utf16 += cp !== undefined && cp > 0xffff ? 2 : 1;
    chars++;
  }
  if (chars !== charOffset) {
    throw new RangeError(`char offset ${charOffset} exceeds text length (${chars} chars)`);
  }
  return utf16;
}

const HELIX_MODES: Readonly<Record<string, string>> = {
  Normal: "normal",
  Select: "select",
  Insert: "insert",
};

beforeAll(async () => {
  installNodeWasmLoader();
  await Promise.all(registeredTreeSitterModes().map((mode) => loadLanguageBundle(mode)));
});

describe(`Helix tree-sitter oracle parity (${FIXTURE.generatedFromHelixCommit.slice(0, 10)})`, () => {
  for (const [i, c] of FIXTURE.cases.entries()) {
    it(`#${i} ${c.name} (${JSON.stringify(c.keys)})`, async () => {
      const h = harness(c.input, { lang: c.lang });
      try {
        await h.keys(c.keys);
        const actualText = h.host.state.doc.toString();
        expect(actualText).toBe(c.expected.text);

        const expectedRanges = c.expected.ranges.map(([a, b]) => [
          charOffsetToUtf16(c.expected.text, a),
          charOffsetToUtf16(c.expected.text, b),
        ]);
        const actualRanges = h.editor.selection.ranges.map((r) => [r.anchor, r.head]);
        expect(actualRanges).toEqual(expectedRanges);
        expect(h.editor.selection.primaryIndex).toBe(c.expected.primary);
        expect(h.mode()).toBe(HELIX_MODES[c.expected.mode] ?? c.expected.mode.toLowerCase());
      } finally {
        h.dispose();
      }
    });
  }
});
