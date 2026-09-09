/**
 * Every finding type said again, for someone who does not run the site.
 *
 * A second vocabulary rather than a rewrite of the first. `FINDING_LABEL` and
 * the `Evidence` switch are written for the person who will fix the problem, and
 * they are right for that reader: "the canonical is itself not canonical" is the
 * shortest true sentence a developer can act on. Handed to a client contact it
 * is noise, and the sentence that follows it — a status code, a header name, a
 * count of differing pixels — is worse than noise, because it looks like it
 * matters and cannot be acted on.
 *
 * Two rules hold throughout.
 *
 * Say the consequence, not the mechanism. The reader wants to know what their
 * visitors or their search results experience; how the site expresses it is our
 * problem and their developer's, not theirs.
 *
 * Carry no addresses in the prose. Every sentence here is rendered beside the
 * pages it concerns, which the report lists in its own right. Inlining URLs
 * makes a sentence unreadable once it is on paper and cannot be hovered, and it
 * is the one place raw site data could smuggle jargon back into a register that
 * has been kept clear of it deliberately.
 *
 * Adding a detection rule fails `client-vocabulary.test.ts` until it is worded
 * here. That test is what makes two vocabularies safe to keep apart.
 */

/** Each finding type as a client contact would name it. */
export const CLIENT_LABEL: Record<string, string> = {
	missing_locale: "A page missing in one of your languages",
	hreflang_target_failed: "A language version that does not open",
	hreflang_target_unreached: "A language version we could not check",
	no_hreflang: "A page that does not point to its other languages",
	hreflang_family_inconsistent:
		"Language versions that disagree with each other",
	variant_diverged: "One language version broken while the others work",
	content_untranslated: "Content that was never translated",
	content_structure_differs: "Language versions missing parts the others have",
	metadata_missing: "Pages with nothing for search results to show",
	metadata_duplicated: "The same search wording on several pages",
	canonical_missing: "A page that does not say which address is its main one",
	canonical_conflicting: "A page naming more than one main address",
	canonical_target_broken: "A main address that does not open",
	noindex_present: "Pages asking to be hidden from search",
	content_duplicated: "The same content at several addresses",
	link_broken: "Links to one of your pages that does not open",
	certificate_problem: "A security certificate problem",
	security_header_contradiction:
		"Security settings the site applies inconsistently",
	sitemap_url_failed: "Submitted addresses that do not open",
	page_missing_from_sitemap: "Live pages not submitted to search engines",
	robots_blocks_indexable: "Pages both blocked from and submitted to search",
	page_orphaned: "Pages nothing on the site links to",
	link_external_broken: "Links to other sites that are gone",
	redirect_chain: "Addresses that bounce through several steps",
	image_missing_dimensions: "Images that make the page jump as it loads",
	image_legacy_format: "Images in older, heavier formats",
	image_oversized: "Images heavy enough to slow the page",
	console_error: "Pages where something fails as they load",
	visual_changed: "A page that no longer looks the same",
};

function text(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

function count(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function list(value: unknown): string[] {
	return Array.isArray(value)
		? value.filter((item): item is string => typeof item === "string")
		: [];
}

function these(n: number | null, one: string, many: string): string {
	if (n === null) return many;
	return `${n} ${n === 1 ? one : many}`;
}

/**
 * A language as the reader's own site names it.
 *
 * The code is the site's own assertion — it is what the page declares about
 * itself — so it is safe to repeat. Naming it "the German version" would be our
 * translation of their data, and wrong the first time a site uses a code we
 * guessed at.
 */
function language(value: unknown): string {
	return text(value) ?? "another language";
}

type ClientFinding = {
	type: string;
	detail: Record<string, unknown>;
};

/**
 * One sentence per finding, in the reader's terms.
 *
 * Never a fallback that prints the payload. The operator view can afford a
 * default case that shows raw data — its reader can decode it, and seeing the
 * shape of an unhandled finding is how the gap gets noticed. A client contact
 * can do neither, so an unworded type says only what is certain: that something
 * was found and their developer should look.
 */
export function clientSentence(finding: ClientFinding): string {
	const d = finding.detail;

	switch (finding.type) {
		case "missing_locale": {
			const present = list(d.presentLocales).length;
			return `This page is published in ${these(present || null, "language", "languages")} but not in ${language(d.missingLocale)}, so visitors reading that language reach nothing.`;
		}

		case "hreflang_target_failed":
			return `This page points visitors to its ${language(d.locale)} version, but that version does not open.`;

		case "hreflang_target_unreached":
			return `This page points to a ${language(d.locale)} version that we were not able to open during this check. That may be our limit rather than a fault on the site.`;

		case "no_hreflang":
			return "This page does not tell search engines that versions of it exist in other languages, so the wrong one can be shown to visitors.";

		case "hreflang_family_inconsistent":
			return "The language versions of this page do not agree about which pages are versions of each other, so search engines may show visitors the wrong one.";

		case "variant_diverged":
			return `The ${language(d.locale)} version of this page does not open, while its other language versions do.`;

		case "content_untranslated":
			return d.kind === "placeholder_markers"
				? "This page still shows placeholder text that was never replaced with real content."
				: "These pages are meant to be different languages but show identical content, so one of them was never translated.";

		case "content_structure_differs":
			return "Some language versions of this page are missing sections that the others have, so visitors do not all see the same information.";

		case "metadata_missing": {
			const fields = list(d.fields);
			const named = fields.length > 0 ? fields.join(" or ") : "wording";
			return `This page gives search engines no ${named}, so search results will show whatever they can find instead.`;
		}

		case "metadata_duplicated": {
			const pages = list(d.urls).length;
			return `${these(pages || null, "page uses", "pages use")} the same wording in search results, so visitors cannot tell them apart.`;
		}

		case "canonical_missing":
			return "This page does not tell search engines which web address is its main one, while other pages on the site do. Search engines then decide for themselves.";

		case "canonical_conflicting":
			return "This page names more than one main web address for itself, so search engines have to guess which to show.";

		case "canonical_target_broken":
			return "This page names a main web address that does not open, so search engines are pointed at nothing.";

		case "noindex_present":
			return "This page asks search engines not to list it, so it will not appear in search results at all.";

		case "content_duplicated": {
			const pages = list(d.urls).length;
			return `${these(pages || null, "web address shows", "web addresses show")} exactly the same content, which divides their value in search between them.`;
		}

		case "link_broken": {
			const from = list(d.linkedFrom).length;
			return `${these(from || null, "page links", "pages link")} to a page on this site that does not open, so visitors following it reach an error.`;
		}

		case "certificate_problem": {
			const days = count(d.daysRemaining);
			if (days !== null && days > 0) {
				return `The security certificate for this site expires in ${these(days, "day", "days")}. When it does, browsers will warn visitors before letting them in.`;
			}
			return "There is a problem with this site's security certificate, which can make browsers warn visitors before letting them in.";
		}

		case "security_header_contradiction":
			return "Different pages on this site apply different security settings, so the protection visitors get depends on which page they land on.";

		case "sitemap_url_failed": {
			const entries = Array.isArray(d.entries) ? d.entries.length : null;
			const verb = entries === 1 ? "does" : "do";
			return `The list of pages this site submits to search engines includes ${these(entries, "address", "addresses")} that ${verb} not open, so search engines are sent to missing pages.`;
		}

		case "page_missing_from_sitemap": {
			const pages = list(d.urls).length;
			return `${these(pages || null, "live page is", "live pages are")} missing from the list this site submits to search engines, so they may never be found.`;
		}

		case "robots_blocks_indexable": {
			const pages = list(d.urls).length;
			const same = pages === 1 ? "that same page" : "those same pages";
			return `This site both asks search engines to ignore ${these(pages || null, "page", "pages")} and submits ${same} to be listed. The two instructions contradict each other.`;
		}

		case "page_orphaned": {
			const pages = list(d.urls).length;
			return `${these(pages || null, "page is", "pages are")} submitted to search engines but nothing on the site links to them, so visitors cannot reach them by browsing.`;
		}

		case "link_external_broken": {
			const from = list(d.linkedFrom).length;
			return `${these(from || null, "page links", "pages link")} to another site that is no longer there, so visitors following it reach an error.`;
		}

		case "redirect_chain": {
			if (d.kind === "loop") {
				return "This address sends visitors round in a circle and never arrives anywhere.";
			}
			const hops = Array.isArray(d.hops) ? d.hops.length : null;
			return `This address passes visitors through ${these(hops, "step", "steps")} before arriving, which slows the page and can lose search value on the way.`;
		}

		case "image_missing_dimensions": {
			const images = count(d.count);
			return `${these(images, "image on this page reserves", "images on this page reserve")} no space before loading, so the page moves under the reader as they arrive.`;
		}

		case "image_legacy_format": {
			const images = count(d.count);
			const of = count(d.of);
			const scope =
				images !== null && of !== null
					? `${images} of ${of} images`
					: these(images, "image", "images");
			const verb = images === 1 ? "uses" : "use";
			return `${scope} on this page ${verb} older formats that take longer to download than they need to.`;
		}

		case "image_oversized": {
			const images = count(d.count);
			return `${these(images, "image on this page is", "images on this page are")} large enough to slow it noticeably, especially on a phone.`;
		}

		case "console_error":
			return "Something on this page fails while it loads, which can stop parts of the page working for visitors.";

		case "visual_changed": {
			const changed = count(d.changedPixels);
			const compared = count(d.comparedPixels);
			const share =
				changed !== null && compared !== null && compared > 0
					? ` About ${Math.max(1, Math.round((changed / compared) * 100))}% of it looks different.`
					: "";
			return `This page no longer looks the way it did when the reference picture was taken.${share}`;
		}

		default:
			return "Something was found on this page that needs a developer to look at it.";
	}
}
