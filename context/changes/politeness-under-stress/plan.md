# Plan — Politeness under stress

Rollout Phase 4. One risk, one layer, and one defect that the existing tests
were structurally unable to find.

## Approach

`crawler.test.ts` already covered the concurrency ceiling, the inter-request
delay, the request timeout, and the abort when every request fails. Those are
the clean shapes, and they all pass. The risk map is explicit that they are not
where the danger is: *intermittent failure never accumulates consecutively*.

So the fixture for this phase is adversarial by construction, and separate from
the detection fixture. Mixing them would mean a change to what a rule means
quietly altering the conditions under which politeness is judged. Every shape in
it is chosen for one property — none of them trips a threshold:

- **flapping** — a 500 to every other request, so a consecutive counter never
  fills;
- **slow** — responses well inside the timeout, so nothing ever aborts, but slow
  enough that a crawler pacing by completion would pile requests up;
- **cyclic** — pages linking to each other and to themselves.

## Progress

- [x] 2.1 A site failing steadily stops the crawl — ea1e20b
- [x] 2.2 The stop reason is stated in operator terms — ea1e20b
- [x] 2.3 A healthy 31-page site does not stop — ea1e20b
- [x] 2.4 A single failure on a small site does not stop — ea1e20b
- [x] 2.5 404s do not count as failures — ea1e20b
- [x] 2.6 The concurrency ceiling holds when responses are slow — ea1e20b
- [x] 2.7 A slow site finishes rather than hanging — ea1e20b
- [x] 2.8 A link cycle terminates without reaching the page ceiling — ea1e20b
- [x] 2.9 The page ceiling holds, within its concurrency overshoot — ea1e20b
- [x] 2.10 Mutation: disabling the rate check fails 2.1 and 2.2 — ea1e20b
- [x] 2.11 The existing crawler and run tests pass unchanged — ea1e20b
- [x] 2.12 `npm run test:all` green — 85 unit, 28 integration, 11 end-to-end — ea1e20b
- [x] 2.13 Type checking and linting pass — ea1e20b

## What this phase found

**One defect, and it is the one the risk map predicted.** The crawl had no
answer to a site failing steadily rather than in bursts. At a 500 every other
request the consecutive counter reached one, reset, reached one, reset — and the
crawl read every page of a site erroring half the time.

A failure-rate abort now runs alongside the burst one, applied only once enough
pages exist for a rate to mean anything.

**The threshold is worth recording as a process note.** The first choice was
0.5, and it did not fire: a site alternating success and failure lands near 48%
once the pages that worked are counted. The tempting fix was 0.49. That would
have been fitting the number to one fixture — the test would pass and the
constant would mean nothing. Reconsidered from the requirement instead: a
healthy origin serves approximately zero 5xx, so by the time a third of what we
ask for is erroring, our requests have no business being part of it. 0.3.

Two cases push deliberately in the other direction, because a rate check that
fires on a healthy site is worse than the problem it solves: a 31-page site with
no failures must not abort, and neither must a single failure on a small one.

## Known limits

**No overall time budget.** A run terminates — the frontier is bounded by the
seen set, the page ceiling is enforced, and every request has a timeout — but
its wall-clock duration is not bounded. At 2,000 pages, a 500ms delay and slow
responses, a run can take hours. This does not endanger the client, which is
what R2 is about: the delay still paces every request. It is a product question
about what an operator should be made to wait for, not a politeness defect, and
inventing a number here would be arbitrary.

**No response size cap.** `response.text()` will read a body of any size. A
hostile or misconfigured site could exhaust memory in our process. The risk is
to the crawler rather than to the client, so it sits outside R2, but it is the
obvious next hardening.

**The crawler has still never run against a real client site.** Everything here
is a fixture, however adversarial. Real sites fail in ways nobody predicts —
that is the point of R2 being rated medium likelihood rather than low, and no
amount of local fixture work discharges it.
