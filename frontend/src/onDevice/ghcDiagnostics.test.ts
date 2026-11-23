import { describe, expect, it } from "vitest";
import { LOCAL_LSP_SOURCE, parseGhcDiagnostics } from "./ghcDiagnostics";

describe("parseGhcDiagnostics", () => {
  it("parses multi-error, typed hole, and -Wall warning spans cleanly", () => {
    const stderr = `/tmp/Main.hs:2:1-7: warning: [GHC-38417] [-Wmissing-signatures]
    Top-level binding with no type signature: helper1 :: Int -> Int
  |
2 | helper1 x = x + (1 :: Int)
  | ^^^^^^^

/tmp/Main.hs:4:8-13: error: [GHC-83865]
    • Couldn't match type ‘[Char]’ with ‘Int’
      Expected: Int
        Actual: String
  |
4 | bad1 = "nope"
  |        ^^^^^^

/tmp/Main.hs:(6,1)-(7,10): error: [GHC-88464]
    • Found hole: _ :: String
  |
6 | bad2 x =
7 |   _ + x
  |   ^

user error (load returned Failed)
libplayground001.so: panic! (the 'impossible' happened)
`;
    const { diagnostics, inferredSignatures } = parseGhcDiagnostics(stderr);
    expect(diagnostics).toHaveLength(3);

    expect(diagnostics[0]).toMatchObject({
      severity: 2,
      code: "GHC-38417",
      source: LOCAL_LSP_SOURCE,
      range: { start: { line: 1, character: 0 }, end: { line: 1, character: 7 } },
    });
    expect(diagnostics[0]?.message).toContain("helper1 :: Int -> Int");
    expect(diagnostics[0]?.message).not.toContain("^^^^^^^");
    expect(inferredSignatures.get("helper1")).toBe("Int -> Int");

    expect(diagnostics[1]).toMatchObject({
      severity: 1,
      code: "GHC-83865",
      range: { start: { line: 3, character: 7 }, end: { line: 3, character: 13 } },
    });
    expect(diagnostics[1]?.message).toContain("Couldn't match type");

    expect(diagnostics[2]).toMatchObject({
      severity: 1,
      code: "GHC-88464",
      range: { start: { line: 5, character: 0 }, end: { line: 6, character: 10 } },
    });
    expect(diagnostics[2]?.message).toContain("Found hole: _ :: String");
  });

  it("clamps EOF and trailing-column spans to the document bounds when sourceText is provided", () => {
    const source = "module Main where\nmain = putStrLn (";
    const stderr = `/tmp/Main.hs:3:1: error: [GHC-58481]
    parse error (possibly incorrect indentation or mismatched brackets)
`;
    const { diagnostics } = parseGhcDiagnostics(stderr, source);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.range).toEqual({
      start: { line: 1, character: 0 },
      end: { line: 1, character: 1 },
    });
  });
});
