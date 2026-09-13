/**
 * Mirror the 10x paper trail in `context/` into the Obsidian vault.
 *
 * The vault already holds a synthesised project overview and weekly changelogs
 * — narrative of what happened. It did not hold the documents that drove the
 * work, so the PRD, the roadmap and every change plan lived only in this repo.
 * That is fine until the repo moves, or until a foundation doc is rewritten in
 * place and the reasoning behind the previous version is gone. This copies them
 * out verbatim, so the vault survives both.
 *
 *   npm run vault:mirror            write the mirror (skips unchanged notes)
 *   npm run vault:mirror -- plan    list what would change, write nothing
 *   npm run vault:mirror -- check   verify the vault still matches this repo
 *
 * The vault directory comes from OBSIDIAN_VAULT_DIR, or `--vault=<path>`.
 *
 * Output is deterministic from the commit being mirrored: same HEAD in, same
 * bytes out. Re-running on an unchanged repo writes nothing at all, which is
 * what makes `check` meaningful in the first place — any drift it reports is
 * real, not a timestamp that moved because the script ran again.
 *
 * The only transform applied to mirrored text is heading demotion, so that one
 * note has one H1 and Obsidian's outline stays navigable. `check` reverses it
 * and compares byte for byte; nothing else about the source is touched. An
 * Obsidian vault is a folder of markdown and the app watches the filesystem, so
 * these are plain file writes — each one re-read and compared before the script
 * calls it written.
 *
 * The vault is downstream. Edits belong in `context/`; anything typed into a
 * mirrored note is overwritten on the next run. The hand-written notes — the
 * project overview and the changelog weeks — are never touched.
 */

import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

const PROJECT = "Sitesmith Studio";
const VAULT_FOLDER = `projects/${PROJECT}`;

/**
 * Foundation documents, in the order the 10x workflow produces them, each with
 * the one-line gloss the index uses. A doc absent from the repo is skipped.
 */
const FOUNDATION = [
	{
		file: "prd.md",
		title: "Product Requirements (PRD)",
		slug: "prd",
		blurb:
			"The holistic requirements document: vision, personas, success criteria, user stories, functional and non-functional requirements, business logic, access control, non-goals, open questions.",
	},
	{
		file: "roadmap.md",
		title: "Roadmap",
		slug: "roadmap",
		blurb:
			"The PRD turned into ordered vertical slices, foundations F-01/F-02 and slices S-01 to S-14, each ending in a real-site proof.",
	},
	{
		file: "shape-notes.md",
		title: "Shape Notes",
		slug: "shape-notes",
		blurb:
			"The discovery conversation that preceded the PRD: the raw shaping of the idea.",
	},
	{
		file: "tech-stack.md",
		title: "Tech Stack",
		slug: "tech-stack",
		blurb:
			"The starter and stack selection, scored against the four agent-friendliness gates.",
	},
	{
		file: "test-plan.md",
		title: "Test Plan",
		slug: "test-plan",
		blurb:
			"The phased test rollout: the risks R1 to R4 and the changes that discharge them.",
	},
	{
		file: "lessons.md",
		title: "Lessons",
		slug: "lessons",
		blurb:
			"Recurring rules and pitfalls, re-read at the start of every planning and implementation pass.",
	},
];

/**
 * Roadmap refs for changes whose `change.md` frontmatter does not record one.
 * Matched to the roadmap by slice title; the mirrored note says so in its
 * frontmatter rather than presenting the guess as something the repo asserted.
 */
const INFERRED_REFS = {
	"crawl-technical-checks": "S-04",
	"correlated-findings": "S-09",
	"quality-trend-history": "S-12",
	"run-history-and-comparison": "S-07",
	"browser-observed-checks": "S-06",
	"roles-invites-and-client-access": "S-10",
	"client-readable-report": "S-11",
	"visual-regression-baselines": "S-08",
};

/** Changes that exist to discharge a test-plan risk rather than ship a slice. */
const RISKS = {
	"detection-rule-confidence": {
		id: "R1",
		text: "a finding fires on something that is not a problem (false-positive fatigue)",
	},
	"politeness-under-stress": {
		id: "R2",
		text: "a check degrades the client site it is checking",
	},
	"auth-and-abuse-behaviours": {
		id: "R3",
		text: "a query forgets tenant scoping and one client sees another's data",
	},
	"testing-harness-and-commands": {
		id: "R4",
		text: "a user cannot complete sign in -> create project -> run",
	},
};

/** Reading order within a change note: identity, then research, then plan, then evidence. */
const FILE_ORDER = [
	"change.md",
	"frame.md",
	"research.md",
	"plan-brief.md",
	"plan.md",
	"proof.md",
	"HANDOFF.md",
	"verification.md",
	"reviews/impl-review.md",
];

function fail(message, hint) {
	console.error(`mirror: ${message}`);
	if (hint) console.error(`        ${hint}`);
	process.exit(1);
}

const read = (path) => readFileSync(path, "utf8").replace(/\r\n/g, "\n");

/** Splits leading YAML frontmatter off a note, returning the body alone. */
function stripFrontmatter(text) {
	const match = text.match(/^---\n[\s\S]*?\n---\n?([\s\S]*)$/);
	return match ? match[1] : text;
}

/** Parses the flat `key: value` pairs of a frontmatter block. Good enough for 10x's schema. */
function frontmatter(text) {
	const match = text.match(/^---\n([\s\S]*?)\n---/);
	if (!match) return {};
	const out = {};
	for (const line of match[1].split("\n")) {
		const pair = line.match(/^([A-Za-z_]+):\s*(.*)$/);
		if (pair) out[pair[1]] = pair[2].trim().replace(/^"(.*)"$/, "$1");
	}
	return out;
}

/**
 * Shifts every markdown heading by `levels`, leaving fenced code blocks alone —
 * a `# comment` inside a shell snippet is not a heading. Negative shifts undo a
 * previous demotion, which is how `check` recovers the original text.
 */
function shiftHeadings(text, levels) {
	let fence = null;
	return text
		.split("\n")
		.map((line) => {
			const opener = line.match(/^\s*(```+|~~~+)/);
			if (opener) {
				if (fence && line.trim().startsWith(fence)) fence = null;
				else if (!fence) fence = opener[1].slice(0, 3);
				return line;
			}
			if (fence) return line;
			const heading = line.match(/^(#{1,6})(\s+.*)$/);
			if (!heading) return line;
			const depth = Math.min(6, Math.max(1, heading[1].length + levels));
			return "#".repeat(depth) + heading[2];
		})
		.join("\n");
}

/** Every change folder on both sides of the archive line, with its docs and identity. */
function collectChanges(repo) {
	const changes = [];
	for (const base of ["context/archive", "context/changes"]) {
		const baseDir = join(repo, base);
		if (!existsSync(baseDir)) continue;
		for (const entry of readdirSync(baseDir, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			const dir = join(baseDir, entry.name);

			const files = [];
			const walk = (at, prefix = "") => {
				for (const child of readdirSync(at, { withFileTypes: true })) {
					if (child.isDirectory())
						walk(join(at, child.name), `${prefix}${child.name}/`);
					else if (child.name.endsWith(".md")) files.push(prefix + child.name);
				}
			};
			walk(dir);
			if (files.length === 0) continue;

			const changeFile = join(dir, "change.md");
			const meta = existsSync(changeFile) ? frontmatter(read(changeFile)) : {};
			const id =
				meta.change_id || entry.name.replace(/^\d{4}-\d{2}-\d{2}-/, "");
			const risk = RISKS[id];
			const ref = meta.roadmap_ref || INFERRED_REFS[id] || null;

			changes.push({
				id,
				dir,
				source: `${base}/${entry.name}/`,
				archived: base === "context/archive",
				meta,
				ref,
				refInferred: !meta.roadmap_ref && Boolean(INFERRED_REFS[id]),
				risk: risk?.id ?? null,
				riskText: risk?.text ?? null,
				title:
					meta.title ||
					id.replace(/-/g, " ").replace(/^./, (c) => c.toUpperCase()),
				status: meta.status || "unknown",
				// Known docs first in workflow order, then anything new the workflow grows.
				files: FILE_ORDER.filter((f) => files.includes(f)).concat(
					files.filter((f) => !FILE_ORDER.includes(f)).sort(),
				),
			});
		}
	}
	return changes.sort((a, b) => noteNameFor(a).localeCompare(noteNameFor(b)));
}

/** `S-02 hreflang and variant parity` — ref first so the folder sorts into roadmap order. */
function noteNameFor(change) {
	const prefix = change.ref ?? change.risk;
	return `${prefix ? `${prefix} ` : ""}${change.id.replace(/-/g, " ")}`;
}

/** The roadmap's own "At a glance" table, which is the canonical slice list. */
function roadmapSlices(repo) {
	const path = join(repo, "context/foundation/roadmap.md");
	if (!existsSync(path)) return [];
	const section = read(path).split("## At a glance")[1]?.split("\n## ")[0];
	if (!section) return [];
	const slices = [];
	for (const line of section.split("\n")) {
		if (!line.trim().startsWith("|")) continue;
		const cells = line
			.split("|")
			.slice(1, -1)
			.map((c) => c.trim());
		if (cells.length < 6 || cells[0] === "ID" || /^-+$/.test(cells[0]))
			continue;
		slices.push({ id: cells[0], outcome: cells[2], status: cells[5] });
	}
	return slices;
}

const ROADMAP_STATUS = {
	done: "done",
	built: "built, not accepted",
	ready: "ready, not started",
	proposed: "proposed",
};

function foundationNote(doc, body, stamp) {
	return [
		"---",
		"type: doc-mirror",
		`doc: ${doc.slug}`,
		`project: ${PROJECT}`,
		"status: active",
		`source: context/foundation/${doc.file}`,
		`source_commit: ${stamp.commit}`,
		`source_commit_date: ${stamp.date}`,
		`created: ${stamp.date}`,
		`updated: ${stamp.date}`,
		`tags: ["sitesmith-studio", "10x", "foundation", "${doc.slug}"]`,
		`summary: "${doc.blurb.replace(/"/g, "'")}"`,
		"---",
		"",
		`# ${PROJECT} - ${doc.title}`,
		"",
		`> ${doc.blurb}`,
		">",
		`> Verbatim mirror of \`context/foundation/${doc.file}\` at commit \`${stamp.commit}\` (${stamp.date}).`,
		`> [[${PROJECT} - Docs|Docs index]] - [[${PROJECT}]]`,
		"",
		"---",
		"",
		shiftHeadings(body.trim(), 1),
		"",
	].join("\n");
}

function changeNote(change, stamp, sliceTitles) {
	const meta = change.meta;
	const archivedAt =
		meta.archived_at && meta.archived_at !== "null"
			? meta.archived_at.slice(0, 10)
			: null;

	const front = [
		"type: change-record",
		`project: ${PROJECT}`,
		`change_id: ${change.id}`,
		`title: "${change.title.replace(/"/g, "'")}"`,
		`status: ${change.status}`,
		meta.created ? `change_created: ${meta.created}` : null,
		archivedAt ? `change_archived: ${archivedAt}` : null,
		change.ref ? `roadmap_ref: ${change.ref}` : null,
		change.ref
			? `roadmap_ref_source: "${change.refInferred ? "inferred from roadmap title" : "frontmatter"}"`
			: null,
		change.risk ? `risk_ref: ${change.risk}` : null,
		meta.prd_refs ? `prd_refs: ${meta.prd_refs}` : null,
		`archived_in_repo: ${change.archived}`,
		`source: ${change.source}`,
		`source_commit: ${stamp.commit}`,
		`source_commit_date: ${stamp.date}`,
		`created: ${stamp.date}`,
		`updated: ${stamp.date}`,
		`tags: ["sitesmith-studio", "10x", "change"${change.ref ? `, "${change.ref.toLowerCase()}"` : ""}]`,
	].filter(Boolean);

	const crumbs = [
		`[[${PROJECT} - Docs|Docs index]]`,
		`[[${PROJECT}]]`,
		change.ref
			? `[[${PROJECT} - Roadmap|Roadmap]] (${change.ref}: ${sliceTitles.get(change.ref) ?? "?"})`
			: null,
		change.risk
			? `[[${PROJECT} - Test Plan|Test plan]] (${change.risk})`
			: null,
	]
		.filter(Boolean)
		.join(" - ");

	const lines = [
		"---",
		...front,
		"---",
		"",
		`# ${(change.ref ?? change.risk) ? `${change.ref ?? change.risk} - ` : ""}${change.title}`,
		"",
		`> Verbatim mirror of \`${change.source}\` at commit \`${stamp.commit}\` (${stamp.date}).`,
		`> Repo status: **${change.status}**, ${change.archived ? "closed out in `context/archive/`" : "still live in `context/changes/`"}.`,
		`> ${crumbs}`,
	];
	if (change.refInferred) {
		lines.push(
			">",
			`> Roadmap ref \`${change.ref}\` is inferred from the slice title - \`change.md\` records none.`,
		);
	}
	lines.push(
		"",
		`Source files mirrored below, in order: ${change.files.map((f) => `\`${f}\``).join(", ")}.`,
		"",
		"---",
		"",
		change.files
			.map(
				(file) =>
					`## ${file}\n\n${shiftHeadings(stripFrontmatter(read(join(change.dir, file))).trim(), 2)}`,
			)
			.join("\n\n---\n\n"),
		"",
	);
	return lines.join("\n");
}

function indexNote(docs, changes, slices, stamp, changelogWeeks) {
	const byRef = new Map(changes.filter((c) => c.ref).map((c) => [c.ref, c]));
	const link = (change) => `[[${noteNameFor(change)}]]`;

	const lines = [
		"---",
		"type: moc",
		`project: ${PROJECT}`,
		"status: active",
		"source: context/",
		`source_commit: ${stamp.commit}`,
		`source_commit_date: ${stamp.date}`,
		`created: ${stamp.date}`,
		`updated: ${stamp.date}`,
		'tags: ["sitesmith-studio", "10x", "moc", "index"]',
		`summary: "Map of content for every 10x workflow document behind ${PROJECT} - shape notes, PRD, tech stack, roadmap, test plan, lessons, and all ${changes.length} change records."`,
		"---",
		"",
		`# ${PROJECT} - Docs`,
		"",
		`> The complete paper trail behind the project, mirrored verbatim from the repo's \`context/\` directory at commit \`${stamp.commit}\` (${stamp.date}).`,
		"> Narrative of what happened day by day lives in the changelog; this index holds the documents that drove it.",
		`> [[${PROJECT}|Project overview]]`,
		"",
		"## How the documents relate",
		"",
		"The 10x workflow produces a chain, each artefact the input to the next:",
		"",
		"```",
		"shape-notes  ->  PRD  ->  tech-stack  ->  roadmap",
		"                                            |",
		"                          per slice:  frame -> research -> plan-brief -> plan",
		"                                            |",
		"                             implement  ->  proof / impl-review  ->  archive",
		"```",
		"",
		"- **Foundation docs** are long-lived and rewritten in place; the mirror is a snapshot of one commit.",
		"- **Change records** are per-slice folders. A change carries its own `## Progress` section, which is the single source of execution state - so a mirrored plan shows how far that slice had got at the mirrored commit.",
		"- Closed changes move from `context/changes/` to `context/archive/`; the mirror records which side each was on.",
		"",
		"## Foundation",
		"",
		"| Doc | What it is | Lines | Repo source |",
		"| --- | --- | --: | --- |",
		// Plain wikilinks, no aliases: an alias inside a table cell needs a `\|`
		// escape, which reads badly and confuses every parser but Obsidian's own.
		...docs.map(
			(d) =>
				`| [[${PROJECT} - ${d.title}]] | ${d.blurb} | ${d.lines} | \`context/foundation/${d.file}\` |`,
		),
		"",
		"## Roadmap slices",
		"",
		"Status columns deliberately kept apart: **Roadmap** is what `roadmap.md` claims, **Change record** is the `status:` in that change's own `change.md`. Where they disagree, the change folder is the more recent of the two.",
		"",
		"| Slice | Outcome (user can ...) | Roadmap | Change record | Its status |",
		"| --- | --- | --- | --- | --- |",
		...slices.map((slice) => {
			const change = byRef.get(slice.id);
			return `| **${slice.id}** | ${slice.outcome} | ${ROADMAP_STATUS[slice.status] ?? slice.status} | ${change ? link(change) : "_no change folder_"} | ${change ? `\`${change.status}\`` : "-"} |`;
		}),
	];

	const risks = changes
		.filter((c) => c.risk)
		.sort((a, b) => a.risk.localeCompare(b.risk));
	if (risks.length > 0) {
		lines.push(
			"",
			"## Test-plan risks",
			"",
			`From [[${PROJECT} - Test Plan|the test plan]]'s phased rollout - these changes exist to discharge a named risk rather than to ship a roadmap slice.`,
			"",
			"| Risk | What it is | Change record | Its status |",
			"| --- | --- | --- | --- |",
			...risks.map(
				(r) =>
					`| **${r.risk}** | ${r.riskText} | ${link(r)} | \`${r.status}\` |`,
			),
		);
	}

	const others = changes.filter((c) => !c.ref && !c.risk);
	if (others.length > 0) {
		lines.push(
			"",
			"## Changes outside the roadmap",
			"",
			"| Change record | Title | Its status | Repo location |",
			"| --- | --- | --- | --- |",
			...others.map(
				(o) =>
					`| ${link(o)} | ${o.title} | \`${o.status}\` | ${o.archived ? "archived" : "`context/changes/`"} |`,
			),
		);
	}

	const chronological = [...changes].sort(
		(a, b) =>
			(a.meta.created || "9999").localeCompare(b.meta.created || "9999") ||
			noteNameFor(a).localeCompare(noteNameFor(b)),
	);
	lines.push(
		"",
		"## Every change, oldest first",
		"",
		"| Started | Closed | Change record | Files mirrored |",
		"| --- | --- | --- | --- |",
		...chronological.map((c) => {
			const archivedAt =
				c.meta.archived_at && c.meta.archived_at !== "null"
					? c.meta.archived_at.slice(0, 10)
					: c.archived
						? "archived"
						: "_open_";
			return `| ${c.meta.created || "-"} | ${archivedAt} | ${link(c)} | ${c.files.length} |`;
		}),
		"",
		"## Also in the vault",
		"",
		`- [[${PROJECT}]] - the synthesised project overview: standing decisions, conventions, roadmap state, updates log.`,
		...(changelogWeeks.length > 0
			? [
					`- Changelog, what happened day by day: ${changelogWeeks
						.map((w) => `[[${VAULT_FOLDER}/changelog/${w}|${w}]]`)
						.join(", ")}.`,
				]
			: []),
		"",
		"## Not mirrored",
		"",
		"- The `README.md` in each `context/` folder - 10x scaffolding describing the folders, not the project.",
		"- Everything outside `context/` - source code, tests, migrations. The repo stays the source of truth for those.",
		"",
		"---",
		"",
		`_Generated by \`scripts/mirror-context-to-vault.mjs\` from commit \`${stamp.commit}\`. Edits belong in \`context/\`; this note is overwritten on the next run._`,
		"",
	);
	return lines.join("\n");
}

/** Builds every note this repo should produce, keyed by its path inside the vault. */
function buildNotes(repo, vault, stamp) {
	const notes = new Map();

	const docs = [];
	for (const doc of FOUNDATION) {
		const path = join(repo, "context/foundation", doc.file);
		if (!existsSync(path)) continue;
		const body = stripFrontmatter(read(path)).trim();
		docs.push({ ...doc, lines: body.split("\n").length });
		notes.set(
			`${VAULT_FOLDER}/foundation/${PROJECT} - ${doc.title}.md`,
			foundationNote(doc, body, stamp),
		);
	}

	const slices = roadmapSlices(repo);
	const sliceTitles = new Map();
	// The roadmap's slice headings carry the titles the breadcrumbs quote.
	const roadmapPath = join(repo, "context/foundation/roadmap.md");
	if (existsSync(roadmapPath)) {
		for (const line of read(roadmapPath).split("\n")) {
			const heading = line.match(/^### ([SF]-\d{2}): (.+)$/);
			if (heading) sliceTitles.set(heading[1], heading[2].trim());
		}
	}

	const changes = collectChanges(repo);
	for (const change of changes) {
		notes.set(
			`${VAULT_FOLDER}/changes/${noteNameFor(change)}.md`,
			changeNote(change, stamp, sliceTitles),
		);
	}

	const changelogDir = join(vault, VAULT_FOLDER, "changelog");
	const weeks = existsSync(changelogDir)
		? readdirSync(changelogDir)
				.filter((f) => f.endsWith(".md"))
				.map((f) => f.slice(0, -3))
				.sort()
		: [];

	notes.set(
		`${VAULT_FOLDER}/${PROJECT} - Docs.md`,
		indexNote(docs, changes, slices, stamp, weeks),
	);
	return { notes, docs, changes };
}

/** Writes a note and reads it back, because a write that did not land is not a write. */
function writeVerified(vault, relative, content) {
	const absolute = join(vault, relative);
	mkdirSync(dirname(absolute), { recursive: true });
	writeFileSync(absolute, content);
	if (read(absolute) !== content.replace(/\r\n/g, "\n")) {
		fail(
			`wrote "${relative}" but reading it back gave something else.`,
			"The vault may be syncing; retry.",
		);
	}
}

/** Mirror notes in the vault that this repo no longer produces — a renamed or deleted change. */
function staleNotes(vault, expected) {
	const stale = [];
	for (const folder of ["foundation", "changes"]) {
		const dir = join(vault, VAULT_FOLDER, folder);
		if (!existsSync(dir)) continue;
		for (const file of readdirSync(dir)) {
			if (!file.endsWith(".md")) continue;
			const relative = `${VAULT_FOLDER}/${folder}/${file}`;
			if (!expected.has(relative)) stale.push(relative);
		}
	}
	return stale;
}

function resolveVault() {
	const flag = process.argv.find((a) => a.startsWith("--vault="));
	const vault = flag
		? flag.slice("--vault=".length)
		: process.env.OBSIDIAN_VAULT_DIR;
	if (!vault) {
		fail(
			"no vault directory.",
			"Set OBSIDIAN_VAULT_DIR, or pass --vault=C:/path/to/Obsidian/Andrzej",
		);
	}
	if (!existsSync(vault)) fail(`vault directory "${vault}" does not exist.`);
	return vault;
}

/** The commit being mirrored. Everything the script writes is stamped with it. */
function commitStamp(repo) {
	try {
		const run = (args) =>
			execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
		return {
			commit: run(["rev-parse", "--short", "HEAD"]),
			date: run(["log", "-1", "--format=%ad", "--date=format:%Y-%m-%d"]),
		};
	} catch {
		fail(
			"could not read the current commit.",
			"This script must run inside the git repository.",
		);
	}
}

const repo = process.cwd();
if (!existsSync(join(repo, "context"))) {
	fail("no `context/` directory here.", "Run this from the repository root.");
}

const vault = resolveVault();
const stamp = commitStamp(repo);
const { notes, docs, changes } = buildNotes(repo, vault, stamp);
const command =
	process.argv[2] && !process.argv[2].startsWith("--")
		? process.argv[2]
		: "write";

switch (command) {
	case "write": {
		let written = 0;
		let unchanged = 0;
		for (const [relative, content] of notes) {
			const absolute = join(vault, relative);
			if (existsSync(absolute) && read(absolute) === content) {
				unchanged++;
				continue;
			}
			writeVerified(vault, relative, content);
			console.log(`wrote      ${relative}`);
			written++;
		}
		console.log(
			`\n${docs.length} foundation, ${changes.length} changes, 1 index — ${written} written, ${unchanged} unchanged.`,
		);
		for (const note of staleNotes(vault, notes)) {
			console.log(
				`stale      ${note} (no longer produced by this repo; delete by hand)`,
			);
		}
		break;
	}

	case "plan": {
		let changed = 0;
		for (const [relative, content] of notes) {
			const absolute = join(vault, relative);
			const state = !existsSync(absolute)
				? "new"
				: read(absolute) === content
					? null
					: "changed";
			if (state) {
				console.log(`${state.padEnd(10)} ${relative}`);
				changed++;
			}
		}
		console.log(`\n${changed} of ${notes.size} notes would be written.`);
		for (const note of staleNotes(vault, notes))
			console.log(`stale      ${note}`);
		break;
	}

	case "check": {
		// Reverse the heading demotion and compare to the repo, so `check` proves
		// the mirror is still the source rather than merely that files exist.
		let intact = 0;
		const problems = [];

		for (const doc of docs) {
			const relative = `${VAULT_FOLDER}/foundation/${PROJECT} - ${doc.title}.md`;
			const absolute = join(vault, relative);
			if (!existsSync(absolute)) {
				problems.push(`missing    ${relative}`);
				continue;
			}
			const body = stripFrontmatter(read(absolute))
				.split("\n---\n\n")
				.slice(1)
				.join("\n---\n\n")
				.trim();
			const source = stripFrontmatter(
				read(join(repo, "context/foundation", doc.file)),
			).trim();
			if (shiftHeadings(body, -1) === source) intact++;
			else problems.push(`drifted    ${relative}`);
		}

		for (const change of changes) {
			const relative = `${VAULT_FOLDER}/changes/${noteNameFor(change)}.md`;
			const absolute = join(vault, relative);
			if (!existsSync(absolute)) {
				problems.push(`missing    ${relative}`);
				continue;
			}
			const sections = read(absolute)
				.split(/\n## (?=[\w./-]+\.md\n)/)
				.slice(1);
			if (sections.length !== change.files.length) {
				problems.push(
					`drifted    ${relative} (${sections.length} sections, ${change.files.length} files)`,
				);
				continue;
			}
			const ok = sections.every((section, i) => {
				const body = section
					.replace(/^[\w./-]+\.md\n/, "")
					.replace(/\n---\n*$/, "")
					.trim();
				const source = stripFrontmatter(
					read(join(change.dir, change.files[i])),
				).trim();
				return shiftHeadings(body, -2) === source;
			});
			if (ok) intact++;
			else problems.push(`drifted    ${relative}`);
		}

		for (const problem of problems) console.log(problem);
		console.log(
			`\n${intact} mirrors match the repo, ${problems.length} do not.`,
		);
		if (problems.length > 0) {
			console.log(
				"Run `npm run vault:mirror` to bring the vault back in line.",
			);
			process.exit(1);
		}
		break;
	}

	default:
		fail(`unknown command "${command}".`, "Use write, plan or check.");
}
