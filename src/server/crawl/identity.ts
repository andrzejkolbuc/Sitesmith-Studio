import { evidenceRoles } from "./evidence";

/**
 * What makes two findings, in two different runs, the same problem.
 *
 * A finding row cannot answer this on its own: `id` is a fresh UUID per row and
 * `pageId` points at a page record scoped to one run, so neither survives a run
 * boundary. Comparing whole `detail` objects is worse than useless — a
 * certificate renewal changes `validTo`, one more page linking to the same dead
 * URL changes `linkedFrom`, and either would report a standing problem as fixed
 * and immediately re-broken.
 *
 * So identity is a projection, and the rule behind every case below is one
 * sentence:
 *
 *   **Identity is the invariant the site asserts. Population and observation
 *   are excluded.**
 *
 * The dead URL is identity; the pages that link to it are population. The
 * duplicated string is identity; the pages carrying it are population. The
 * certificate's problem is identity; the date it expires is observation. A
 * finding whose population grew is still the same finding, and the comparison
 * says so.
 *
 * Which way to fail is decided the same way it is decided everywhere else in
 * this directory: a field wrongly *included* makes a standing problem look
 * resolved, which is the lie that matters, so a doubtful field is left out.
 *
 * ## The stated limit
 *
 * Four family-level types have no identity available to them but `groupKey`:
 * `missing_locale`, `hreflang_family_inconsistent`, `content_structure_differs`,
 * and the `identical_to_siblings` half of `content_untranslated`. A family
 * finding is about the family, and the family's only name is that key.
 *
 * `groupKey` is the lexicographically smallest URL among the family members the
 * crawl actually reached (`variants.ts`). It is stable given the same member
 * set — and only then. A family that gains a member sorting before the current
 * key, or loses the member that *was* the key, gets a different key, and its
 * family-level findings will report as resolved and raised again even though
 * nothing about the underlying problem changed.
 *
 * This is a real limit and it is chosen rather than overlooked. The alternative
 * — keying on the member set itself — churns strictly more often, because every
 * membership change moves it while only some membership changes move the
 * minimum. It is recorded here so that a future reader meets it as a decision
 * rather than as a bug.
 */

/**
 * Separators that cannot occur inside the values being joined.
 *
 * Control characters rather than punctuation, because the parts are real site
 * content: `metadata_duplicated` keys on a page title, which contains spaces and
 * may contain any pipe, colon or slash somebody chose to type. A separator that
 * can appear inside a part lets two different findings produce one key, and two
 * unrelated problems reported as one is the failure this module exists to
 * prevent.
 *
 * Built with `fromCharCode` rather than written as escapes so that no control
 * character ever sits literally in this file.
 */
const PART = String.fromCharCode(0);
const MEMBER = String.fromCharCode(1);

/** Serialised so that two structurally equal keys compare equal as strings. */
const key = (
	type: string,
	...parts: Array<string | null | undefined>
): string => [type, ...parts.map((p) => p ?? "")].join(PART);

const text = (value: unknown): string =>
	typeof value === "string" ? value : "";

/**
 * A set of URLs, order-independent.
 *
 * Sorted rather than taken as given because the identity of a set-valued
 * finding must not depend on the order the rule happened to emit — and several
 * rules sort already, which would make the dependency invisible until one
 * stopped.
 */
const set = (value: unknown): string =>
	Array.isArray(value)
		? [...new Set(value.filter((v): v is string => typeof v === "string"))]
				.sort()
				.join(MEMBER)
		: "";

/**
 * The key a finding is matched on across runs.
 *
 * Structural rather than typed against the schema, for the reason `evidence.ts`
 * is: this answers a question about a finding's shape, not about a table, and
 * stays testable without one.
 */
export function findingIdentity(finding: {
	type: string;
	detail: Record<string, unknown>;
}): string {
	const { type, detail } = finding;

	switch (type) {
		/**
		 * The family and the language it is missing. Which members happen to exist,
		 * and which locales they currently cover, is the population — a family that
		 * gains a fifth page is still missing the same language.
		 */
		case "missing_locale":
			return key(type, text(detail.groupKey), text(detail.missingLocale));

		/**
		 * The declaration itself: who declared it, for which locale, pointing
		 * where. The status the target returned is how we observed the problem, not
		 * what the problem is — a sibling that moves from 500 to 404 is the same
		 * broken declaration.
		 */
		case "hreflang_target_failed":
		case "hreflang_target_unreached":
			return key(
				type,
				text(detail.declaredBy),
				text(detail.locale),
				text(detail.target),
			);

		case "no_hreflang":
			return key(type, text(detail.url));

		/** One family disagreeing with itself is one problem, whatever it lists. */
		case "hreflang_family_inconsistent":
			return key(type, text(detail.groupKey));

		/**
		 * The variant that broke. Not `groupKey`: a URL is a stabler name than a
		 * family whose key moves with its membership, and here one is available.
		 */
		case "variant_diverged":
			return key(type, text(detail.brokenUrl));

		/**
		 * Two shapes under one type, and the `kind` is part of the identity because
		 * they are genuinely different defects — an unrendered template expression
		 * is not an untranslated copy. Within each kind, the page or the family
		 * names it; the markers found and the locales involved are population.
		 */
		case "content_untranslated":
			return detail.kind === "identical_to_siblings"
				? key(type, "identical_to_siblings", text(detail.groupKey))
				: key(type, "placeholder_markers", text(detail.url));

		case "content_structure_differs":
			return key(type, text(detail.groupKey));

		/**
		 * The page. Not which fields are missing: a page that was missing a title
		 * and is now missing a title and a description has not had one problem
		 * fixed and another appear.
		 */
		case "metadata_missing":
			return key(type, text(detail.url));

		/**
		 * The page, and nothing about how many images were wrong on it.
		 *
		 * A template that forgot its dimensions forgot them for every image the
		 * page carries, so the count is the population — a page that gains a
		 * gallery is the same defect at a larger size, not a new one. Keying on the
		 * count would report the problem as resolved and immediately re-broken
		 * every time an editor added a picture.
		 */
		case "image_missing_dimensions":
		case "image_legacy_format":
		case "image_oversized":
			return key(type, text(detail.url));

		/**
		 * The duplicated string, in its field and its language. The pages carrying
		 * it are exactly the population — the whole point of the finding is that
		 * the set has more than one member, and a set that grows is the same
		 * duplicate spreading, not a new one.
		 */
		case "metadata_duplicated":
			return key(
				type,
				text(detail.field),
				text(detail.language),
				text(detail.value),
			);

		case "canonical_missing":
			return key(type, text(detail.url));

		/**
		 * The `kind` is identity here, unlike in `canonical_target_broken` below.
		 * Declaring two canonicals and declaring one that points down a chain are
		 * different defects with different fixes; a page that stops doing the first
		 * and starts doing the second has genuinely resolved one and raised
		 * another.
		 */
		case "canonical_conflicting":
			return key(type, text(detail.kind), text(detail.url));

		/**
		 * The `kind` is *not* identity here. `failed` and `unreached` are two ways
		 * of observing one broken canonical — the first saw a status, the second
		 * did not reach it at all — and letting the distinction move the key would
		 * report a fix every time the crawl's luck changed.
		 */
		case "canonical_target_broken":
			return key(type, text(detail.url), text(detail.canonical));

		case "noindex_present":
			return key(type, text(detail.url));

		/**
		 * The content itself, by digest. The URLs serving it are population, for the
		 * same reason `metadata_duplicated`'s are.
		 */
		case "content_duplicated":
			return key(type, text(detail.digest));

		/**
		 * The dead URL, and nothing else. Everything beside it in the detail is
		 * either how we observed the failure — status, fetch error, whether a second
		 * request confirmed it — or who currently points at it. This is the type the
		 * whole projection exists for: a dead footer link picks up a new linking
		 * page on every content edit.
		 */
		case "link_broken":
		case "link_external_broken":
			return key(type, text(detail.target));

		/**
		 * The certificate's problem and the host it belongs to. `validTo`,
		 * `daysRemaining` and the issuer chain are observations that move on their
		 * own: a certificate that still expires soon after a renewal is still the
		 * same finding, and one that has been fixed disappears rather than changing
		 * its dates.
		 */
		case "certificate_problem":
			return key(type, text(detail.kind), text(detail.origin));

		/**
		 * The header and the way the site contradicts itself about it. The value
		 * published and the pages affected are evidence and population.
		 */
		case "security_header_contradiction":
			return key(type, text(detail.kind), text(detail.header));

		/**
		 * The set of URLs, for the two corpus-level reconciliations that name one.
		 *
		 * These have no smaller invariant to key on: the finding *is* the set. A
		 * sitemap that gains one omitted page therefore reports as a different
		 * finding, which is correct — "seven pages are missing from your sitemap"
		 * and "eight pages are missing" are not the same statement, and there is no
		 * per-page finding underneath to track instead.
		 */
		case "page_missing_from_sitemap":
		case "page_orphaned":
			return key(type, set(detail.urls));

		/**
		 * The robots rule doing the blocking, in its user-agent group. Here there
		 * *is* a smaller invariant than the URL set — the rule is what the site
		 * asserted and what an editor changes — so the URLs it happens to catch are
		 * population.
		 */
		case "robots_blocks_indexable":
			return key(type, text(detail.rule), text(detail.userAgentGroup));

		/**
		 * The normalised URLs the sitemap submitted that did not load. Their
		 * statuses are observation; the set is the finding, as above.
		 */
		case "sitemap_url_failed":
			return key(
				type,
				set(
					Array.isArray(detail.entries)
						? (detail.entries as Array<Record<string, unknown>>).map((entry) =>
								text(entry.normalised),
							)
						: [],
				),
			);

		/**
		 * Where the chain starts. Not where it lands, and not the hops: a redirect
		 * chain that is re-pointed at a new destination but still goes through two
		 * hops is the same stale URL needing the same edit.
		 */
		case "redirect_chain":
			return key(type, text(detail.from));

		default: {
			/**
			 * A type added by a later slice and not mapped above.
			 *
			 * It falls back to the subject `evidenceRoles` already derives for every
			 * type, which has its own documented default — so a new rule gets
			 * workable identity rather than a gap, and never silently matches a
			 * finding of a different type.
			 *
			 * The cost is stated: for a set-valued subject this churns whenever the
			 * set changes, so a new type of that shape wants its own case here. It is
			 * the direction that reports too much movement rather than too little,
			 * and too little is the direction that lies.
			 */
			const { subject } = evidenceRoles({
				type,
				/**
				 * From the detail, because a stored finding has no `url` of its own —
				 * the column is `pageId`, scoped to one run. `evidenceRoles`' own
				 * default reads this field, so without it every unmapped finding would
				 * project to an empty subject and the key below would collapse to the
				 * type alone, silently merging every finding the new rule produces.
				 */
				url: text(detail.url),
				detail,
			});
			const projected = set(subject);

			/**
			 * A type whose subject is empty anyway — a corpus-level rule added later —
			 * falls back to its whole detail rather than to nothing. That churns
			 * whenever any field moves, which is the direction that over-reports
			 * movement instead of merging distinct problems into one.
			 */
			return key(
				type,
				projected === ""
					? JSON.stringify(
							Object.entries(detail).sort(([a], [b]) => a.localeCompare(b)),
						)
					: projected,
			);
		}
	}
}
