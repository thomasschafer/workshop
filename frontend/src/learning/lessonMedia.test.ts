import { describe, expect, it } from "vitest";
import { sameLessonImages } from "./lessonMedia";
import type { DeckLessonImage } from "./types";

describe("sameLessonImages", () => {
  it("matches equal image maps across fresh JSON-parsed copies", () => {
    const first: Record<string, DeckLessonImage> = {
      "diagram.svg": { kind: "svg", svg: "<svg><rect /></svg>" },
      "photo.png": { kind: "png", data_url: "data:image/png;base64,AAAA" },
    };
    const cloned = JSON.parse(JSON.stringify(first)) as Record<string, DeckLessonImage>;
    expect(sameLessonImages(first, first)).toBe(true);
    expect(sameLessonImages(first, cloned)).toBe(true);
  });

  it("detects changed SVG or PNG content, kind changes, and added or removed keys", () => {
    const base: Record<string, DeckLessonImage> = {
      "diagram.svg": { kind: "svg", svg: "<svg><rect /></svg>" },
      "photo.png": { kind: "png", data_url: "data:image/png;base64,AAAA" },
    };
    expect(
      sameLessonImages(base, {
        ...base,
        "diagram.svg": { kind: "svg", svg: "<svg><circle /></svg>" },
      }),
    ).toBe(false);
    expect(
      sameLessonImages(base, {
        ...base,
        "photo.png": { kind: "png", data_url: "data:image/png;base64,BBBB" },
      }),
    ).toBe(false);
    expect(
      sameLessonImages(base, {
        ...base,
        "diagram.svg": { kind: "png", data_url: "data:image/png;base64,AAAA" },
      }),
    ).toBe(false);
    expect(
      sameLessonImages(base, {
        "diagram.svg": { kind: "svg", svg: "<svg><rect /></svg>" },
      }),
    ).toBe(false);
    const withProtoKey: Record<string, DeckLessonImage> = Object.fromEntries([
      ["toString", { kind: "svg", svg: "<svg/>" } satisfies DeckLessonImage],
    ]);
    expect(sameLessonImages(withProtoKey, { other: { kind: "svg", svg: "<svg/>" } })).toBe(false);
  });
});
