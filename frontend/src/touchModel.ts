// Which key a touch on Workshop's own keyboard presses. A finger doesn't land on the middle of a
// key: every touch goes to the nearest key, wherever on the keyboard it lands, so the gaps between
// keys and the edges beside them press keys too, as on a phone's keyboard. Each key can also sit a
// little off where it's drawn, by where this device's user has been seen to touch it.

/** A point, or the distance between two, in the page's pixels. */
export interface Point {
  readonly x: number;
  readonly y: number;
}

/** Where a key is drawn. */
export interface KeyBox {
  readonly id: string;
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

/**
 * How far from the middle of each key its user touches it, by the key's id, in columns: the
 * width of a letter key with its gap, so the same offsets suit the keyboard at any size.
 */
export type KeyOffsets = Readonly<Record<string, Point>>;

export const NO_OFFSETS: KeyOffsets = {};

/** No key moves further than this from where it's drawn, in columns, whatever is learnt. */
export const MAX_OFFSET = 1 / 3;

function clamp(value: number, limit: number): number {
  return Math.max(-limit, Math.min(limit, value));
}

export function clampOffset(offset: Point): Point {
  return { x: clamp(offset.x, MAX_OFFSET), y: clamp(offset.y, MAX_OFFSET) };
}

export function centreOf(box: KeyBox): Point {
  return { x: (box.left + box.right) / 2, y: (box.top + box.bottom) / 2 };
}

/** How far a point is from a box, zero inside it, squared. */
function squaredDistanceTo(box: KeyBox, point: Point, shift: Point): number {
  const dx = Math.max(box.left + shift.x - point.x, 0, point.x - (box.right + shift.x));
  const dy = Math.max(box.top + shift.y - point.y, 0, point.y - (box.bottom + shift.y));
  return dx * dx + dy * dy;
}

function squaredDistance(a: Point, b: Point): number {
  return (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
}

/**
 * The key nearest a touch: the one it's on, or failing that the one whose edge is closest, each
 * key taken to be where its user touches it rather than where it's drawn. `column` is a column's
 * width in pixels. Null only if there are no keys.
 */
export function nearestKey(
  boxes: readonly KeyBox[],
  point: Point,
  offsets: KeyOffsets,
  column: number,
): KeyBox | null {
  let best: { box: KeyBox; edge: number; centre: number } | null = null;
  for (const box of boxes) {
    const offset = offsets[box.id];
    const shift = offset ? { x: offset.x * column, y: offset.y * column } : { x: 0, y: 0 };
    const edge = squaredDistanceTo(box, point, shift);
    const middle = centreOf(box);
    const centre = squaredDistance(point, { x: middle.x + shift.x, y: middle.y + shift.y });
    // Keys moved towards each other can overlap, where the nearer middle wins.
    if (best === null || edge < best.edge || (edge === best.edge && centre < best.centre)) {
      best = { box, edge, centre };
    }
  }
  return best?.box ?? null;
}

/** Whether a touch is on a key as it's drawn, as the keyboard once needed it to be. */
export function onDrawnKey(box: KeyBox, point: Point): boolean {
  return point.x >= box.left && point.x <= box.right && point.y >= box.top && point.y <= box.bottom;
}

/** A touch that pressed a key: where it landed from the middle of the key as drawn, in columns. */
export interface LandedTouch {
  readonly id: string;
  readonly offset: Point;
}

/** How far a touch at `point` is from the middle of `box`, in columns. */
export function touchOffset(box: KeyBox, point: Point, column: number): Point {
  const middle = centreOf(box);
  return { x: (point.x - middle.x) / column, y: (point.y - middle.y) / column };
}

/** How much one touch moves a key's offset towards itself. */
export const LEARNING_RATE = 0.04;

/** Moves a key's offset a little towards where it was just touched. */
export function learn(offsets: KeyOffsets, touch: LandedTouch, rate = LEARNING_RATE): KeyOffsets {
  const old = offsets[touch.id] ?? { x: 0, y: 0 };
  const next = clampOffset({
    x: old.x + (touch.offset.x - old.x) * rate,
    y: old.y + (touch.offset.y - old.y) * rate,
  });
  return { ...offsets, [touch.id]: next };
}

/**
 * Learns where keys are touched from typing itself, where nothing says which key was meant. A
 * touch is taken to have meant the key it pressed, unless it's deleted straight away: then it
 * teaches nothing, or if the key pressed next is right beside it, that was the key it meant.
 */
export class TouchLearner {
  /** The last touch, not yet learnt from, in case the next key deletes it. */
  private pending: { readonly box: KeyBox; readonly point: Point } | null = null;
  /** A touch that was deleted, which the next key may show the meaning of. */
  private deleted: { readonly box: KeyBox; readonly point: Point } | null = null;

  constructor(
    private offsets: KeyOffsets,
    private readonly isDelete: (id: string) => boolean,
  ) {}

  get current(): KeyOffsets {
    return this.offsets;
  }

  /** Starts again from `offsets`, such as after they're measured or reset. */
  reset(offsets: KeyOffsets): void {
    this.offsets = offsets;
    this.pending = null;
    this.deleted = null;
  }

  /**
   * Takes a touch at `point` that pressed `box`, and returns the offsets if they changed.
   * Offsets only change a touch late, once the next key hasn't deleted it.
   */
  touched(box: KeyBox, point: Point, column: number): KeyOffsets | null {
    const before = this.offsets;
    if (this.isDelete(box.id)) {
      this.deleted = this.pending;
      this.pending = null;
      return null;
    }
    if (this.deleted) {
      const wrong = this.deleted.box;
      if (box.id !== wrong.id && adjacent(wrong, box, column)) {
        // What was deleted was a miss of this key.
        this.offsets = learn(this.offsets, {
          id: box.id,
          offset: touchOffset(box, this.deleted.point, column),
        });
      }
      this.deleted = null;
    } else if (this.pending) {
      this.offsets = learn(this.offsets, {
        id: this.pending.box.id,
        offset: touchOffset(this.pending.box, this.pending.point, column),
      });
    }
    this.pending = { box, point };
    return this.offsets === before ? null : this.offsets;
  }
}

/** Whether two keys are next to each other, in a row or in rows that touch. */
function adjacent(a: KeyBox, b: KeyBox, column: number): boolean {
  const gapX = Math.max(a.left - b.right, b.left - a.right, 0);
  const gapY = Math.max(a.top - b.bottom, b.top - a.bottom, 0);
  return gapX < column / 2 && gapY < column / 2;
}

// ---- Measuring ----

/** What a run of touches on known keys says about where its user touches them. */
export interface Measurement {
  readonly offsets: KeyOffsets;
  readonly touches: number;
  /** Touches that weren't on the key they meant as it's drawn: between keys, or on another. */
  readonly offDrawnKey: number;
  /** Touches that the nearest key, as drawn, wasn't the one meant. */
  readonly nearestWrong: number;
  /** As `nearestWrong`, with the keys where these offsets put them. */
  readonly nearestWrongWithOffsets: number;
  /** The average offset over every touch, in columns. */
  readonly average: Point;
}

/** A touch at `point` that meant the key `id`. */
export interface MeantTouch {
  readonly id: string;
  readonly point: Point;
}

/** Fewer touches than this on a key say too little about it, so it takes the average instead. */
const MIN_TOUCHES_PER_KEY = 3;

/**
 * Works out each key's offset from touches whose meaning is known. Keys touched too few times
 * to tell take the average of all touches, as fingers are mostly off the same way everywhere.
 */
export function measure(
  touches: readonly MeantTouch[],
  boxes: readonly KeyBox[],
  column: number,
): Measurement {
  const byId = new Map(boxes.map((box) => [box.id, box]));
  const sums = new Map<string, { x: number; y: number; n: number }>();
  const total = { x: 0, y: 0, n: 0 };
  let offDrawnKey = 0;
  let nearestWrong = 0;
  const known: { touch: MeantTouch; box: KeyBox }[] = [];
  for (const touch of touches) {
    const box = byId.get(touch.id);
    if (box === undefined)
      throw new Error(`a touch meant the key '${touch.id}', which isn't there`);
    known.push({ touch, box });
    const offset = touchOffset(box, touch.point, column);
    const sum = sums.get(touch.id) ?? { x: 0, y: 0, n: 0 };
    sum.x += offset.x;
    sum.y += offset.y;
    sum.n++;
    sums.set(touch.id, sum);
    total.x += offset.x;
    total.y += offset.y;
    total.n++;
    if (!onDrawnKey(box, touch.point)) offDrawnKey++;
    if (nearestKey(boxes, touch.point, NO_OFFSETS, column)?.id !== touch.id) nearestWrong++;
  }
  const average = total.n > 0 ? { x: total.x / total.n, y: total.y / total.n } : { x: 0, y: 0 };
  const offsets: Record<string, Point> = {};
  if (total.n > 0) {
    for (const box of boxes) {
      const sum = sums.get(box.id);
      offsets[box.id] = clampOffset(
        sum && sum.n >= MIN_TOUCHES_PER_KEY ? { x: sum.x / sum.n, y: sum.y / sum.n } : average,
      );
    }
  }
  const nearestWrongWithOffsets = known.filter(
    ({ touch }) => nearestKey(boxes, touch.point, offsets, column)?.id !== touch.id,
  ).length;
  return {
    offsets,
    touches: total.n,
    offDrawnKey,
    nearestWrong,
    nearestWrongWithOffsets,
    average,
  };
}

// ---- Keeping them ----

const STORAGE_KEY = "workshop:key-offsets";

function isPoint(value: unknown): value is Point {
  if (typeof value !== "object" || value === null) return false;
  const { x, y } = value as { x?: unknown; y?: unknown };
  return typeof x === "number" && Number.isFinite(x) && typeof y === "number" && Number.isFinite(y);
}

/** Reads offsets as stored, or null if that isn't what's there. */
export function parseOffsets(stored: string): KeyOffsets | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stored);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const offsets: Record<string, Point> = {};
  for (const [id, value] of Object.entries(parsed)) {
    if (!isPoint(value)) return null;
    offsets[id] = clampOffset(value);
  }
  return offsets;
}

/** The offsets kept on this device, which suit its screen and whoever holds it. */
export function loadOffsets(): KeyOffsets {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === null) return NO_OFFSETS;
    const offsets = parseOffsets(stored);
    if (offsets === null) console.warn("Ignoring the stored key offsets, which can't be read.");
    return offsets ?? NO_OFFSETS;
  } catch {
    return NO_OFFSETS;
  }
}

export function saveOffsets(offsets: KeyOffsets): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(offsets));
  } catch {
    // Storage can be full or disabled; the offsets still apply until the page reloads.
  }
}
