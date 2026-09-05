/**
 * Each finding type in the reader's words.
 *
 * Its own module because two views name the same types — the findings list and
 * the trend grid — and a second copy is a second thing to update. A label that
 * drifted between the two would have the same type reading as two different
 * problems on one page.
 */
export const FINDING_LABEL: Record<string, string> = {
	missing_locale: "Missing language variant",
	hreflang_target_failed: "Declared variant is broken",
	hreflang_target_unreached: "Declared variant was never reached",
	no_hreflang: "No language variants declared",
	hreflang_family_inconsistent: "Language links that disagree",
	variant_diverged: "One variant broken, its siblings fine",
	content_untranslated: "Content that was never translated",
	content_structure_differs: "Variants that do not contain the same things",
	metadata_missing: "Pages missing a title or description",
	metadata_duplicated: "One title or description on several pages",
	canonical_missing: "Pages declaring no canonical URL",
	canonical_conflicting: "Canonical tags that disagree",
	canonical_target_broken: "Canonical pointing somewhere broken",
	noindex_present: "Pages asking not to be indexed",
	content_duplicated: "One page's content at several URLs",
	link_broken: "Links to a page that does not load",
	certificate_problem: "Certificate problems",
	security_header_contradiction:
		"Security headers the site disagrees with itself about",
	sitemap_url_failed: "Sitemap URLs that do not load",
	page_missing_from_sitemap: "Live pages the sitemap does not list",
	robots_blocks_indexable: "robots.txt blocks a page the sitemap submits",
	page_orphaned: "Pages the sitemap lists that nothing links to",
	link_external_broken: "Links to other sites that are gone",
	redirect_chain: "Redirects that go through several hops, or in circles",
	image_missing_dimensions: "Images that shift the layout as they load",
	image_legacy_format: "Images served in no modern format",
	image_oversized: "Images heavy enough to slow the page",
};
