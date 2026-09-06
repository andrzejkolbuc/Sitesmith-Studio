/**
 * How much of a page has to differ before we will say it changed.
 *
 * Its own module, with no imports, because two places need the number and
 * neither may hold a second copy of it: the rule that decides whether to report
 * a page, and the section that decides whether to say a page differs. A finding
 * and a panel disagreeing about the same page reads as a bug in the product, and
 * the only way they cannot is if there is one number.
 *
 * **This threshold is ours, and it was measured rather than chosen.** Everything
 * else the visual check reports is the browser's own arithmetic; this is the one
 * place the product decides something, so it is derived from evidence and
 * carried in every finding's detail — the way `image_oversized` reports its
 * `thresholdBytes` — so a reader can disagree with it.
 *
 * The evidence, from `context/changes/visual-regression-baselines/proof.md`:
 * two runs of a real client site with **nothing deployed in between**, compared
 * with pixelmatch's anti-aliasing exclusion already applied, still differed by
 *
 *   - 1,831 pixels of 12,322,560 — 0.0149% — on the home page
 *   - 10 pixels of 9,008,640 — 0.0001% — on the second page
 *
 * scattered in regions no larger than 48×48 and invisible side by side. That is
 * our own rendering, not the client's site, and reporting it would put two
 * findings on an untouched site every time it was checked. The observed ceiling
 * of that noise is **0.015%**; this floor sits at roughly three times it, which
 * is enough headroom for a slower or busier machine and still far below any
 * difference a person would notice.
 *
 * What it costs, stated plainly: on a very tall page 0.05% is several thousand
 * pixels, so a small genuine change — a button's label, a swapped icon — can
 * fall under it and go unreported. That is the trade the no-false-positive
 * guardrail asks for, and it is the direction of error this product prefers:
 * silence about a small real change, never a confident report of a change that
 * did not happen.
 */
export const MIN_CHANGED_SHARE = 0.0005;
