import { describe, expect, it } from "vitest";
import {
  extractLocalSymbols,
  parseImports,
  provideCompletions,
  provideHover,
  provideSignatureHelp,
} from "./haskellIntel";

describe("haskellIntel", () => {
  const sample = `module Main where
import qualified Data.Map.Strict as M
import Aoc (gridSize)

solve :: String -> Int
solve = gridSize

helper x = x + 1

main :: IO ()
main = print (M.insertWith (+) 'a' 1 M.empty)
`;

  const helperFile = `module Aoc where

gridSize :: String -> Int
gridSize = length
`;

  it("parses qualified, aliased, and selective imports", () => {
    const imports = parseImports(sample);
    expect(imports).toHaveLength(2);
    expect(imports[0]).toMatchObject({
      module: "Data.Map.Strict",
      qualified: true,
      alias: "M",
    });
    expect(imports[1]?.module).toBe("Aoc");
    expect(imports[1]?.only?.has("gridSize")).toBe(true);
  });

  it("provides hover for qualified imports, helpers, local signatures, and GHC-inferred types", () => {
    const inferred = new Map([["helper", "Int -> Int"]]);

    const qualifiedHover = provideHover(sample, 10, 18, helperFile, inferred);
    expect(qualifiedHover?.contents.value).toContain("insertWith ::");

    const helperHover = provideHover(sample, 5, 10, helperFile, inferred);
    expect(helperHover?.contents.value).toContain("gridSize :: String -> Int");

    const inferredHover = provideHover(sample, 7, 2, helperFile, inferred);
    expect(inferredHover?.contents.value).toContain("helper :: Int -> Int");
  });

  it("provides import-aware qualified completions and signature help", () => {
    const inferred = new Map<string, string>();
    const completions = provideCompletions(`${sample}x = M.ins`, 11, 9, helperFile, inferred);
    expect(completions.map((c) => c.label)).toContain("insert");
    expect(completions.map((c) => c.label)).toContain("insertWith");
    expect(completions.map((c) => c.label)).not.toContain("map");

    const sig = provideSignatureHelp(`${sample}y = M.insertWith `, 11, 17, helperFile, inferred);
    expect(sig?.signatures[0]?.label).toContain("insertWith ::");
  });

  it("extracts multi-line local signatures and type declarations", () => {
    const syms = extractLocalSymbols(
      `data Grid = Grid Int Int\nstep ::\n  Int ->\n  Int\nstep = id\n`,
      "Main",
    );
    expect(syms.find((s) => s.name === "Grid")?.kind).toBe(7);
    expect(syms.find((s) => s.name === "step")?.signature).toBe("Int -> Int");
  });
});
