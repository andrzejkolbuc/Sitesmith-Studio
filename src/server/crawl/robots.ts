/**
 * robots.txt, parsed.
 *
 * Written from scratch rather than reusing anything in `metadata.ts`, because
 * the two robots channels are not the same thing and treating them alike would
 * produce a rule wrong in both directions. `X-Robots-Tag` and
 * `<meta name="robots">` are *indexing* directives: page-level, comma-separated,
 * observable only after the page has been fetched. robots.txt is a *crawling*
 * directive: path-level, line-oriented groups of `Allow`/`Disallow` patterns,
 * and it governs whether the page is fetched at all. A page can be
 * robots.txt-blocked and still indexed from external links; a page can be
 * freely crawlable and carry `noindex`.
 *
 * What does carry over is the closed-vocabulary discipline. The set of
 * directives we recognise is fixed here; the set of crawler names is open,
 * because anybody can name a crawler and a site addressing one we have never
 * heard of is still addressing a crawler.
 *
 * Precedence follows RFC 9309: within the group that applies, the most specific
 * matching pattern wins, and `Allow` breaks a tie at equal length. That tie rule
 * is not decoration — it is how a site carves an exception out of a broad
 * `Disallow`, which is the commonest shape in the wild.
 */

/** The directives this parser understands. Anything else is ignored. */
const DIRECTIVES = new Set([
	"user-agent",
	"allow",
	"disallow",
	"sitemap",
	"crawl-delay",
]);

export type RobotsRule = {
	kind: "allow" | "disallow";
	/** The pattern as published, wildcards and all. */
	pattern: string;
	/** The source line, verbatim — a finding quotes this back. */
	line: string;
	/** 1-based, so a reader can go and look at it. */
	lineNumber: number;
	/**
	 * Whether this pattern can be judged against a stored URL at all.
	 *
	 * `normaliseUrl` drops the entire query string, so a rule like
	 * `Disallow: /*?sessionid=` cannot be evaluated against anything we recorded.
	 * Reporting it as "does not match" would be a claim about our normalisation
	 * rather than about the site, so it is carried as unevaluated instead.
	 */
	evaluable: boolean;
};

export type RobotsGroup = {
	/** Lowercased user-agent tokens this group addresses. */
	userAgents: string[];
	rules: RobotsRule[];
};

export type RobotsFile = {
	groups: RobotsGroup[];
	/**
	 * Every `Sitemap:` declaration, in order.
	 *
	 * Group-independent by specification — a `Sitemap:` line belongs to the file
	 * rather than to whichever group it happens to sit inside — and it may point
	 * at another origin entirely.
	 */
	sitemaps: string[];
};

export type RobotsVerdict = {
	/** Whether the path may be crawled by the agent asked about. */
	allowed: boolean;
	/** The rule that decided it; null when nothing matched and the default stood. */
	rule: RobotsRule | null;
	/** The user-agent token whose group was consulted, or null when none applied. */
	group: string | null;
	/**
	 * Patterns in the applicable group that could not be judged. Carried so a
	 * finding can say "we did not evaluate this" instead of implying it passed.
	 */
	notEvaluated: RobotsRule[];
};

/**
 * A robots.txt pattern as a regular expression.
 *
 * Two wildcards exist and only two: `*` for any run of characters and `$` to
 * anchor the end. Everything else is a literal, so it is escaped — a path
 * containing `.` or `+` is ordinary and must not be read as a pattern.
 */
function toMatcher(pattern: string): RegExp {
	const anchored = pattern.endsWith("$");
	const body = anchored ? pattern.slice(0, -1) : pattern;

	const escaped = body
		.split("*")
		.map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
		.join(".*");

	return new RegExp(`^${escaped}${anchored ? "$" : ""}`);
}

/**
 * Splits a robots.txt body into groups and sitemap declarations.
 *
 * Consecutive `User-agent` lines address one group, which is how a site says
 * "these rules apply to all of these crawlers". A rule appearing before any
 * `User-agent` belongs to nobody and is dropped — the specification has no
 * notion of a global rule, and inventing one would apply restrictions the site
 * never addressed to anyone.
 */
export function parseRobots(body: string): RobotsFile {
	const groups: RobotsGroup[] = [];
	const sitemaps: string[] = [];

	let current: RobotsGroup | null = null;
	/** Whether the last line was a `User-agent`, so consecutive ones group. */
	let accumulatingAgents = false;

	const lines = body.split(/\r?\n/);

	for (const [index, raw] of lines.entries()) {
		// A `#` starts a comment anywhere on the line.
		const line = (raw.split("#")[0] ?? "").trim();
		if (line === "") continue;

		const separator = line.indexOf(":");
		if (separator === -1) continue;

		const directive = line.slice(0, separator).trim().toLowerCase();
		const value = line.slice(separator + 1).trim();

		if (!DIRECTIVES.has(directive)) continue;

		if (directive === "sitemap") {
			if (value !== "") sitemaps.push(value);
			continue;
		}

		if (directive === "user-agent") {
			if (value === "") continue;
			if (current && accumulatingAgents) {
				current.userAgents.push(value.toLowerCase());
			} else {
				current = { userAgents: [value.toLowerCase()], rules: [] };
				groups.push(current);
				accumulatingAgents = true;
			}
			continue;
		}

		accumulatingAgents = false;

		// `Crawl-delay` is recognised so it cannot be mistaken for a path rule.
		if (directive === "crawl-delay") continue;

		/**
		 * A rule outside any group addresses no crawler. Dropping it is the
		 * conservative reading: the alternative invents a restriction the site
		 * never stated an audience for.
		 */
		if (!current) continue;

		/**
		 * An empty `Disallow` means "nothing is disallowed", which is the default
		 * anyway — so it imposes nothing and is not carried. An empty `Allow` is
		 * the same shape.
		 */
		if (value === "") continue;

		current.rules.push({
			kind: directive === "allow" ? "allow" : "disallow",
			pattern: value,
			line: raw.trim(),
			lineNumber: index + 1,
			evaluable: !value.includes("?"),
		});
	}

	return { groups, sitemaps };
}

/**
 * The group that addresses a given crawler.
 *
 * Longest match wins, and `*` is only ever the fallback. That ordering is what
 * makes a `googlebot` group override a permissive `*` rather than adding to it —
 * a crawler that finds a group naming it ignores the wildcard group entirely.
 */
function groupFor(
	robots: RobotsFile,
	userAgent: string,
): { group: RobotsGroup; token: string } | null {
	const agent = userAgent.toLowerCase();

	let best: { group: RobotsGroup; token: string } | null = null;
	let fallback: { group: RobotsGroup; token: string } | null = null;

	for (const group of robots.groups) {
		for (const token of group.userAgents) {
			if (token === "*") {
				fallback ??= { group, token };
				continue;
			}
			if (!agent.startsWith(token)) continue;
			if (!best || token.length > best.token.length) {
				best = { group, token };
			}
		}
	}

	return best ?? fallback;
}

/**
 * Whether `path` may be crawled, per this file, by this agent.
 *
 * `path` is a URL path — no origin, no query string, because the crawl does not
 * keep one. The default when nothing matches is allowed, which is the
 * specification's default and the right one: silence in robots.txt is
 * permission.
 */
export function evaluatePath(
	robots: RobotsFile,
	path: string,
	userAgent: string,
): RobotsVerdict {
	const applicable = groupFor(robots, userAgent);

	if (!applicable) {
		return { allowed: true, rule: null, group: null, notEvaluated: [] };
	}

	const notEvaluated = applicable.group.rules.filter((rule) => !rule.evaluable);

	let winner: RobotsRule | null = null;

	for (const rule of applicable.group.rules) {
		if (!rule.evaluable) continue;
		if (!toMatcher(rule.pattern).test(path)) continue;

		if (winner === null) {
			winner = rule;
			continue;
		}

		/**
		 * Most specific wins, measured by pattern length, and `Allow` takes a tie.
		 * The tie rule is how a site carves an exception out of a broad `Disallow`,
		 * which is the commonest shape there is — without it, `Disallow: /admin`
		 * beside `Allow: /admin` would block the very page the site just permitted.
		 */
		if (rule.pattern.length > winner.pattern.length) {
			winner = rule;
		} else if (
			rule.pattern.length === winner.pattern.length &&
			rule.kind === "allow"
		) {
			winner = rule;
		}
	}

	return {
		allowed: winner === null || winner.kind === "allow",
		rule: winner,
		group: applicable.token,
		notEvaluated,
	};
}
