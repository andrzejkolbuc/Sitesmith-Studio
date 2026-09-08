/**
 * How many regions a project may mask, and how long a selector may be.
 *
 * Its own module, with no imports, for the reason `visual-noise.ts` is one: two
 * places need these numbers and neither may hold a second copy. The *roles*
 * differ and should — `project.setMasks` refuses bad input, and
 * `parseMaskSelectors` tells the person typing what is wrong before they send
 * it — but a limit enforced at 50 and warned about at 40 is a form where the
 * button stays enabled and the request fails, or one that refuses input the
 * server would have taken.
 *
 * The numbers themselves are ours rather than the site's, and neither is
 * load-bearing. Fifty is far more masks than a page has volatile regions; 255
 * is longer than any selector a person writes by hand. They exist so that a
 * paste of the wrong thing into the textarea is refused as a mistake rather
 * than stored as configuration.
 */

/** How many selectors one project may mask. */
export const MAX_MASKS = 50;

/** How long a single selector may be, in characters. */
export const MAX_SELECTOR_LENGTH = 255;
