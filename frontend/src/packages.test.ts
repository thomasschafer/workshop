import { describe, expect, it } from "vitest";
import type { PackageHints } from "./api";
import { findMissingModule, isUpToDate, spokenPackageName } from "./packages";

// As in languages/haskell.toml and languages/python.toml.
const haskell: PackageHints = {
  missing_module: ["Could not (?:find|load) module [‘'`]([A-Za-z0-9_.]+)[’'`]"],
  missing_package: ["member of the hidden package [‘'`]([A-Za-z0-9_.-]+?)-[0-9][0-9.]*[’'`]"],
};
const python: PackageHints = {
  missing_module: [
    "No module named '([A-Za-z0-9_.]+)'",
    'Import "([A-Za-z0-9_.]+)" could not be resolved',
  ],
  missing_package: [],
};

describe("findMissingModule", () => {
  it("finds a missing Haskell module", () => {
    const error = "Main.hs:4:1: error:\n    Could not find module ‘Data.HashMap.Strict’.";
    expect(findMissingModule(error, haskell)).toEqual({
      module: "Data.HashMap.Strict",
      package: null,
    });
  });

  it("takes the package from GHC when it names one", () => {
    const error =
      "Could not load module ‘Data.Map’.\nIt is a member of the hidden package ‘containers-0.7’.";
    expect(findMissingModule(error, haskell)).toEqual({
      module: "Data.Map",
      package: "containers",
    });
  });

  it("finds missing Python modules in run output and from Pyright", () => {
    expect(
      findMissingModule("ModuleNotFoundError: No module named 'numpy.linalg'", python),
    ).toEqual({ module: "numpy.linalg", package: null });
    expect(findMissingModule('Import "yaml" could not be resolved', python)).toEqual({
      module: "yaml",
      package: null,
    });
  });

  it("finds nothing in other errors", () => {
    expect(findMissingModule("Variable not in scope: foo", haskell)).toBeNull();
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
  const state = { manifest: "p.txt", text: "", problem: null, missing_programs: [] };
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
