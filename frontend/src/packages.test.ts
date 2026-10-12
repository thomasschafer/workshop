import { describe, expect, it } from "vitest";
import type { PackageHints } from "./api";
import { findMissingPackage, isUpToDate, spokenPackageName } from "./packages";

// As in languages/haskell.toml and languages/python.toml.
const haskell: PackageHints = {
  missing_module: ["Could not (?:find|load) module [‘'`]([A-Za-z0-9_.]+)[’'`]"],
  providers: {
    "Data.Graph": "containers",
    "Data.Graph.Inductive": "fgl",
    "Data.HashMap": "unordered-containers",
  },
  package_named_after_module: false,
};
const python: PackageHints = {
  missing_module: [
    "No module named '([A-Za-z0-9_.]+)'",
    'Import "([A-Za-z0-9_.]+)" could not be resolved',
  ],
  providers: { yaml: "pyyaml" },
  package_named_after_module: true,
};

describe("findMissingPackage", () => {
  it("finds the package for a missing Haskell module", () => {
    const error = "Main.hs:4:1: error:\n    Could not find module ‘Data.HashMap.Strict’.";
    expect(findMissingPackage(error, haskell)).toEqual({
      module: "Data.HashMap.Strict",
      package: "unordered-containers",
    });
  });

  it("prefers the most specific provider", () => {
    expect(
      findMissingPackage("Could not load module ‘Data.Graph.Inductive.Graph’", haskell),
    ).toEqual({ module: "Data.Graph.Inductive.Graph", package: "fgl" });
  });

  it("doesn't take a module for one that merely shares its start", () => {
    expect(findMissingPackage("Could not find module ‘Data.Graphs’", haskell)).toEqual({
      module: "Data.Graphs",
      package: null,
    });
  });

  it("names Python packages after their module, with exceptions", () => {
    expect(
      findMissingPackage("ModuleNotFoundError: No module named 'numpy.linalg'", python),
    ).toEqual({ module: "numpy.linalg", package: "numpy" });
    expect(findMissingPackage('Import "yaml" could not be resolved', python)).toEqual({
      module: "yaml",
      package: "pyyaml",
    });
  });

  it("finds nothing in other errors", () => {
    expect(findMissingPackage("Variable not in scope: foo", haskell)).toBeNull();
  });
});

describe("spokenPackageName", () => {
  it("joins spoken words with hyphens", () => {
    expect(spokenPackageName("Unordered Containers")).toBe("unordered-containers");
    expect(spokenPackageName("numpy")).toBe("numpy");
  });

  it("refuses anything that isn't a package name", () => {
    expect(spokenPackageName("")).toBeNull();
    expect(spokenPackageName("--index-url")).toBeNull();
  });
});

describe("isUpToDate", () => {
  const state = { manifest: "p.txt", text: "", problem: null };
  it("needs everything listed installed", () => {
    expect(isUpToDate({ ...state, packages: ["a", "b"], installed: ["a", "b"] })).toBe(true);
    expect(isUpToDate({ ...state, packages: ["a", "b"], installed: ["a"] })).toBe(false);
    expect(isUpToDate({ ...state, packages: ["a"], installed: null })).toBe(false);
  });

  it("needs nothing installed for an empty list, but a valid one", () => {
    expect(isUpToDate({ ...state, packages: [], installed: null })).toBe(true);
    expect(isUpToDate({ ...state, packages: [], installed: null, problem: "line 1" })).toBe(false);
  });
});
