/**
 * How much the code editor's text is scaled from its usual size, on this device, and the limits
 * of how far it can be pinched or stepped.
 */

/** How far each step in the settings changes the scale. */
export const CODE_SCALE_STEP = 0.1;

/**
 * iPhones zoom the page into any text field smaller than 16px when it's tapped, and don't zoom
 * back out, so there the code is never made smaller than its usual 16px. Only iOS Safari supports
 * -webkit-touch-callout, as in the stylesheet.
 */
const IOS = typeof CSS !== "undefined" && CSS.supports("-webkit-touch-callout", "none");

export interface ScaleRange {
  min: number;
  max: number;
}

export function codeScaleRange(ios: boolean): ScaleRange {
  // As small as the shape of a whole file, which is all that can be made out of the code there.
  return { min: ios ? 1 : 0.1, max: 2 };
}

export const CODE_SCALE_RANGE = codeScaleRange(IOS);

export function clampCodeScale(scale: number, range: ScaleRange = CODE_SCALE_RANGE): number {
  if (!Number.isFinite(scale)) throw new Error(`Code text scale isn't a number: ${scale}`);
  return Math.min(range.max, Math.max(range.min, scale));
}

/** The scale as it's kept: to the nearest percent, so pinching doesn't store long fractions. */
export function roundCodeScale(scale: number): number {
  return Math.round(scale * 100) / 100;
}

/**
 * The next step up or down from `scale`, from a scale between steps, as after pinching, to the
 * step beside it.
 */
export function stepCodeScale(
  scale: number,
  direction: 1 | -1,
  range: ScaleRange = CODE_SCALE_RANGE,
): number {
  // Tolerates the float error in a scale that's already on a step, such as 1.1 / 0.1.
  const steps = scale / CODE_SCALE_STEP;
  const next = direction === 1 ? Math.floor(steps + 1e-6) + 1 : Math.ceil(steps - 1e-6) - 1;
  return roundCodeScale(clampCodeScale(next * CODE_SCALE_STEP, range));
}

/** The scale after the fingers that started `startDistance` apart are `distance` apart. */
export function pinchedCodeScale(
  startScale: number,
  startDistance: number,
  distance: number,
  range: ScaleRange = CODE_SCALE_RANGE,
): number {
  if (startDistance <= 0) return startScale;
  return clampCodeScale(startScale * (distance / startDistance), range);
}
