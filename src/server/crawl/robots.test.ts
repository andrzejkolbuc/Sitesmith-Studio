import { describe, expect, it } from "vitest";

import { evaluatePath, parseRobots } from "./robots";

/**
 * The robots.txt parser, against shapes taken from the specification.
 *
 * Every expectation below comes from RFC 9309 or from the documented behaviour
 * of the crawler the rule actually cares about, and each was written before the
 * parser was run against it. That ordering is the whole value: an expectation
 * adjusted to match the output is just the output written twice.
 *
 * Nothing here is sourced from what a site we happened to look at does. The
 * parser decides whether a client's page is blocked, and a rule built on a
 * misreading would report a defect the site never published.
 */

describe("parsing robots.txt", () => {
	it("keeps a group's rules with the agent it addresses", () => {
		const robots = parseRobots(
			["User-agent: googlebot", "Disallow: /private"].join("\n"),
		);

		expect(robots.groups).toHaveLength(1);
		expect(robots.groups[0]?.userAgents).toEqual(["googlebot"]);
		expect(robots.groups[0]?.rules[0]).toMatchObject({
			kind: "disallow",
			pattern: "/private",
			lineNumber: 2,
		});
	});

	it("treats consecutive user-agent lines as one group", () => {
		/**
		 * How a site says "these rules apply to all of these crawlers". Reading them
		 * as separate groups would give the second agent an empty group and let it
		 * fall through to the wildcard.
		 */
		const robots = parseRobots(
			["User-agent: googlebot", "User-agent: bingbot", "Disallow: /admin"].join(
				"\n",
			),
		);

		expect(robots.groups).toHaveLength(1);
		expect(robots.groups[0]?.userAgents).toEqual(["googlebot", "bingbot"]);
	});

	it("ignores comments and blank lines", () => {
		const robots = parseRobots(
			[
				"# nothing to see",
				"",
				"User-agent: *  # everyone",
				"Disallow: /tmp # temporary files",
			].join("\n"),
		);

		expect(robots.groups[0]?.rules[0]?.pattern).toBe("/tmp");
	});

	it("drops a rule that appears before any user-agent", () => {
		/**
		 * The specification has no notion of a global rule. Inventing one would
		 * apply a restriction the site never stated an audience for — and would
		 * make us report pages as blocked that no crawler was ever told to skip.
		 */
		const robots = parseRobots(
			["Disallow: /orphan", "User-agent: *", "Disallow: /real"].join("\n"),
		);

		expect(robots.groups).toHaveLength(1);
		expect(robots.groups[0]?.rules.map((r) => r.pattern)).toEqual(["/real"]);
	});

	it("carries an empty Disallow as no restriction at all", () => {
		/**
		 * `Disallow:` with nothing after it means "nothing is disallowed", which is
		 * the default. Keeping it as a rule with an empty pattern would match every
		 * path and block the entire site.
		 */
		const robots = parseRobots(["User-agent: *", "Disallow:"].join("\n"));

		expect(robots.groups[0]?.rules).toEqual([]);
		expect(evaluatePath(robots, "/anything", "googlebot").allowed).toBe(true);
	});

	it("collects sitemap declarations independently of any group", () => {
		/**
		 * A `Sitemap:` line belongs to the file rather than to whichever group it
		 * happens to sit inside, and may point at another origin entirely.
		 */
		const robots = parseRobots(
			[
				"Sitemap: https://cdn.example.com/sitemap.xml",
				"User-agent: *",
				"Disallow: /admin",
				"Sitemap: https://shop.test/sitemap-2.xml",
			].join("\n"),
		);

		expect(robots.sitemaps).toEqual([
			"https://cdn.example.com/sitemap.xml",
			"https://shop.test/sitemap-2.xml",
		]);
	});

	it("ignores directives it does not recognise", () => {
		const robots = parseRobots(
			["User-agent: *", "Request-rate: 1/10s", "Disallow: /x"].join("\n"),
		);

		expect(robots.groups[0]?.rules).toHaveLength(1);
	});
});

describe("deciding whether a path is blocked", () => {
	it("allows a path nothing matches", () => {
		/** Silence in robots.txt is permission, which is the specified default. */
		const robots = parseRobots(
			["User-agent: *", "Disallow: /admin"].join("\n"),
		);

		expect(evaluatePath(robots, "/about", "googlebot").allowed).toBe(true);
	});

	it("blocks a path a Disallow prefix matches", () => {
		const robots = parseRobots(
			["User-agent: *", "Disallow: /admin"].join("\n"),
		);
		const verdict = evaluatePath(robots, "/admin/users", "googlebot");

		expect(verdict.allowed).toBe(false);
		expect(verdict.rule?.line).toBe("Disallow: /admin");
	});

	it("prefers a group naming the crawler over the wildcard group", () => {
		/**
		 * The case that reads backwards and matters most. Googlebot ignores the `*`
		 * group entirely once a `googlebot` group exists — so a site with a
		 * permissive wildcard and a blocking googlebot group is catastrophically
		 * blocked in the way that counts, and evaluating `*` would report nothing.
		 */
		const robots = parseRobots(
			[
				"User-agent: *",
				"Disallow:",
				"User-agent: googlebot",
				"Disallow: /",
			].join("\n"),
		);

		const verdict = evaluatePath(robots, "/anything", "googlebot");

		expect(verdict.allowed).toBe(false);
		expect(verdict.group).toBe("googlebot");
	});

	it("falls back to the wildcard group when no group names the crawler", () => {
		const robots = parseRobots(
			[
				"User-agent: bingbot",
				"Disallow: /",
				"User-agent: *",
				"Disallow: /admin",
			].join("\n"),
		);

		const verdict = evaluatePath(robots, "/about", "googlebot");

		expect(verdict.allowed).toBe(true);
		expect(verdict.group).toBe("*");
	});

	it("matches the user-agent case-insensitively", () => {
		const robots = parseRobots(
			["User-agent: GoogleBot", "Disallow: /x"].join("\n"),
		);

		expect(evaluatePath(robots, "/x", "googlebot").allowed).toBe(false);
	});

	it("lets the most specific pattern win", () => {
		const robots = parseRobots(
			["User-agent: *", "Disallow: /", "Allow: /public"].join("\n"),
		);

		expect(evaluatePath(robots, "/public/page", "googlebot").allowed).toBe(
			true,
		);
		expect(evaluatePath(robots, "/private/page", "googlebot").allowed).toBe(
			false,
		);
	});

	it("lets Allow win a tie at equal specificity", () => {
		/**
		 * RFC 9309's tie rule, and the reason it exists: it is how a site carves an
		 * exception out of a broad Disallow. Resolved the other way, a site would
		 * be reported as blocking the very page it just permitted.
		 */
		const robots = parseRobots(
			["User-agent: *", "Disallow: /docs", "Allow: /docs"].join("\n"),
		);

		expect(evaluatePath(robots, "/docs/intro", "googlebot").allowed).toBe(true);
	});

	it("expands a wildcard inside a pattern", () => {
		const robots = parseRobots(
			["User-agent: *", "Disallow: /*/private"].join("\n"),
		);

		expect(evaluatePath(robots, "/de/private", "googlebot").allowed).toBe(
			false,
		);
		expect(evaluatePath(robots, "/de/public", "googlebot").allowed).toBe(true);
	});

	it("anchors a pattern ending in $", () => {
		const robots = parseRobots(
			["User-agent: *", "Disallow: /*.pdf$"].join("\n"),
		);

		expect(evaluatePath(robots, "/files/report.pdf", "googlebot").allowed).toBe(
			false,
		);
		expect(
			evaluatePath(robots, "/files/report.pdf.html", "googlebot").allowed,
		).toBe(true);
	});

	it("treats an ordinary dot as a literal", () => {
		/**
		 * Only `*` and `$` are wildcards. A pattern read as a regular expression
		 * would make `.` match anything and block paths the site never named.
		 */
		const robots = parseRobots(["User-agent: *", "Disallow: /a.b"].join("\n"));

		expect(evaluatePath(robots, "/a.b", "googlebot").allowed).toBe(false);
		expect(evaluatePath(robots, "/axb", "googlebot").allowed).toBe(true);
	});

	it("reports a query-bearing pattern as not evaluated rather than not matching", () => {
		/**
		 * `normaliseUrl` drops the entire query string, so a rule like
		 * `Disallow: /*?sessionid=` cannot be judged against anything we recorded.
		 * Calling it "does not match" would be a claim about our normalisation
		 * rather than about the site — the exact failure `lessons.md` was written
		 * after.
		 */
		const robots = parseRobots(
			["User-agent: *", "Disallow: /*?sessionid="].join("\n"),
		);

		const verdict = evaluatePath(robots, "/cart", "googlebot");

		expect(verdict.allowed).toBe(true);
		expect(verdict.rule).toBeNull();
		expect(verdict.notEvaluated.map((r) => r.pattern)).toEqual([
			"/*?sessionid=",
		]);
	});

	it("allows everything when the file declares no groups", () => {
		expect(evaluatePath(parseRobots(""), "/x", "googlebot").allowed).toBe(true);
	});
});
