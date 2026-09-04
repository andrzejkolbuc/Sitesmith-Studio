/**
 * Which paths a project's crawl is allowed to request.
 *
 * One definition, used by the crawler while it runs and by the rules afterwards
 * when they ask whether a URL the site declared was in scope. Those were two
 * copies of the same predicate until a bug made it clear what that costs: a
 * predicate that decides what a crawl touches is not a thing to have two of.
 *
 * The two lists are deliberately not symmetric.
 *
 * **Inclusion is segment-aware.** An entry matches a path when it *is* that path
 * or continues it after a slash. It shipped as a bare `startsWith`, which reads
 * as obviously right and is wrong twice over: every pathname begins with `/`, so
 * listing the homepage listed the whole site — a real project configured as
 * `/, /company` crawled ninety-two pages of a live client site in six languages
 * before it was stopped — and `/company` matched `/company-profile`, which is
 * not inside `/company` but a different page whose name starts the same way.
 *
 * **Exclusion stays a broad `startsWith`**, so `/admin` also keeps out
 * `/administration`. That is over-matching and it is the safe direction: the
 * cost is a page we do not fetch. Narrowing it to match inclusion would make a
 * crawl begin requesting paths an operator had already said to stay out of, on
 * somebody else's server. When the two rules disagree, the one that requests
 * less wins.
 */

/** A trailing slash is punctuation, not scope. The root keeps its own. */
function withoutTrailingSlash(value: string): string {
	return value.length > 1 && value.endsWith("/")
		? value.replace(/\/+$/, "")
		: value;
}

/** Whether an include entry covers a path: the path itself, or below it. */
function covers(entry: string, path: string): boolean {
	const from = withoutTrailingSlash(entry);
	const target = withoutTrailingSlash(path);

	if (from === target) return true;

	/**
	 * The slash is the whole point. Without it `/company` swallows
	 * `/companywide`, and `/` swallows everything — which is how this was found.
	 */
	return target.startsWith(`${from === "/" ? "" : from}/`) && from !== "/";
}

export function inScopePath(
	path: string,
	includePaths: string[],
	excludePaths: string[],
): boolean {
	if (excludePaths.some((prefix) => path.startsWith(prefix))) return false;
	if (includePaths.length === 0) return true;

	return includePaths.some((entry) => covers(entry, path));
}
