import { describe, expect, it } from "vitest";
import { encodeWav } from "./audio";
import { spokenWords, wordErrorRate } from "./wer";

describe("spokenWords", () => {
  it("reads symbols, dots and numbers as they're said", () => {
    expect(spokenWords("Replace the undefined with sum .map read.lines.")).toEqual(
      "replace the undefined with sum dot map read dot lines".split(" "),
    );
    expect(spokenWords("part1 = length . filter (> 100)")).toEqual(
      "part one equals length dot filter open bracket greater than one hundred close bracket".split(
        " ",
      ),
    );
  });

  it("drops sentence punctuation", () => {
    expect(spokenWords("Wrap that in show, and put print dollar before it.")).toEqual(
      "wrap that in show and put print dollar before it".split(" "),
    );
  });
});

describe("wordErrorRate", () => {
  it("is zero for the same words, however they're written", () => {
    expect(wordErrorRate("def part two of data colon", "Def part2 of data:")).toBe(0);
  });

  it("counts wrong, missing and extra words against what was meant", () => {
    expect(wordErrorRate("sum dot map read", "some dot map read")).toBe(0.25);
    expect(wordErrorRate("sum dot map read", "sum map read")).toBe(0.25);
    expect(wordErrorRate("sum dot map read", "sum dot map read dot")).toBe(0.25);
  });
});

describe("encodeWav", () => {
  it("writes a mono 16-bit WAV header and samples", () => {
    const wav = new DataView(encodeWav(new Float32Array([0, 1, -1]), 16_000));
    const text = (at: number) =>
      String.fromCharCode(...Array.from({ length: 4 }, (_, i) => wav.getUint8(at + i)));
    expect(text(0)).toBe("RIFF");
    expect(text(8)).toBe("WAVE");
    expect(wav.getUint32(24, true)).toBe(16_000);
    expect(wav.getUint32(40, true)).toBe(6);
    expect([wav.getInt16(44, true), wav.getInt16(46, true), wav.getInt16(48, true)]).toEqual([
      0, 32767, -32768,
    ]);
  });
});
