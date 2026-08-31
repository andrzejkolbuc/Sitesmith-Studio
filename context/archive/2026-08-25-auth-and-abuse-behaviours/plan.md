# Plan — Auth and abuse behaviours

Rollout Phase 2. Four risks, three test layers, one guiding constraint: each
test had to be able to fail. Every group below was verified by mutation — the
defect it exists to catch was introduced deliberately, the failure observed, and
the code reverted.

## Approach

**R6 — password verification (unit, no database).** Expectations taken from the
digest contract, not from running the code. A hash-then-verify test proves only
that the function agrees with itself and would survive both halves being
replaced by `return true`, so the weight sits on values that do *not* round-trip:
foreign formats, corrupt digests, and a value written with parameters this build
no longer uses.

**R7 — enumeration (unit and integration).** Two tests on purpose. The unit test
proves `burnPasswordTime` costs what it should; the integration test proves
`authorize` still calls it. Deleting the call leaves the unit test green.

**R3 — tenant isolation (integration).** Generated from `appRouter` rather than
from a hand-maintained list, with a completeness check that fails while any
procedure is unclassified. The per-procedure assertion is deliberately blunt —
no fingerprint of the other tenant may appear anywhere in the outcome, thrown
messages included — because that holds for response shapes this test knows
nothing about.

**R5 — partial accounts (end-to-end).** Gated routes are read off the
filesystem, so a page added to the group is covered the moment it exists. The
fixed case is not the risk; the next page written by someone who never saw the
original failure is.

## Progress

### Password verification — R6

- [x] 6.1 Digest format contract, including the work factor — 2678b05
- [x] 6.2 Correct password verifies; wrong ones do not — 2678b05
- [x] 6.3 A digest written with different parameters still verifies — 2678b05
- [x] 6.4 Unicode-equivalent passwords interoperate — 2678b05
- [x] 6.5 Ten unusable stored values answer false rather than throw — 2678b05
- [x] 6.6 A digest demanding absurd memory fails closed — 2678b05
- [x] 6.7 A truncated key does not match on a prefix — 2678b05

### Enumeration — R7

- [x] 7.1 `burnPasswordTime` costs about what a verification costs — 2678b05
- [x] 7.2 Every failure mode returns one identical answer — 60cca44
- [x] 7.3 An account with no password set is indistinguishable — 60cca44
- [x] 7.4 Unknown and known addresses take comparable time in `authorize` — 60cca44
- [x] 7.5 Mutation: removing the burn call fails 7.4 (2ms against 25ms) — 60cca44

### Tenant isolation — R3

- [x] 3.1 Every procedure classified and exercised with foreign identifiers — 60cca44
- [x] 3.2 No fingerprint of the other tenant appears in any outcome — 60cca44
- [x] 3.3 A refused write leaves no row behind — 60cca44
- [x] 3.4 `create` stamps the caller's tenant, ignoring one supplied in input — 60cca44
- [x] 3.5 Completeness: unclassified procedures fail by name — 60cca44
- [x] 3.6 Mutation: dropping `tenantScope` from `byId` fails 3.2 — 60cca44
- [x] 3.7 Mutation: adding a procedure fails 3.5 naming `project.ping` — 60cca44

### Partial accounts — R5

- [x] 5.1 Every gated route derived from the filesystem, not listed — 4636bc5
- [x] 5.2 Each route explains itself and returns no 5xx — 4636bc5
- [x] 5.3 A partial account is not bounced back to sign in — 4636bc5
- [x] 5.4 Signing out from the notice actually ends the session — 4636bc5
- [x] 5.5 The route derivation is guarded against finding nothing — 4636bc5
- [x] 5.6 Mutation: disabling the tenant check fails all five behavioural tests — 4636bc5

### Whole suite

- [x] W.1 `npm run test:all` green — 62 unit, 28 integration, 11 end-to-end — 4636bc5
- [x] W.2 Type checking passes: `npm run typecheck` — 4636bc5
- [x] W.3 Linting passes: `npm run check` — 4636bc5
- [x] W.4 The unit bucket still needs no database — 4636bc5

## What this phase found

Four defects, three in shipped code.

**1. The stored digest chose the comparison length.** `verifyPassword` derived
the candidate key at the length of whatever key the digest carried, so a value
with a one-byte key was checked one byte deep and accepted roughly one password
in 256. `Buffer.from(hex)` reaches the same state quietly, stopping at the first
invalid pair rather than throwing. Reaching it needs a malformed digest in the
users table — a restored backup, a migration, a partial write — so it is defence
in depth rather than a live hole, and it is exactly the fail-closed property the
function documented and did not have. Fixed in 2678b05.

**2. A padded address could not sign in.** `z.string().email()` rejected the
value before the handler's `.trim()` could run, so an autofill that appended a
space produced "invalid credentials" for a correct password — and retyping the
password could never fix it, because the address is what identifies the row. The
schema now trims before validating. Fixed in 60cca44.

**3. The obvious way to reach `authorize` tests nothing.**
`providers[0].authorize` exists, is a function, and is Auth.js's placeholder:
`() => null`. The configured implementation lives on `options`. The first draft
of the integration file read the obvious property and passed every negative case
while asserting nothing at all — a whole file of false confidence. The lookup
now prefers `options.authorize` and refuses a zero-arity function.

**4. Four files each maintained their own ordered truncation.** Copy-pasted
`db.delete(...)` sequences that had already drifted: one file listed fewer
tables than another, so it left rows that made the next file's delete fail on a
foreign key. Replaced by `test/reset.ts`, which reads the table list from the
schema — a new table is covered the moment it is defined — and truncates with
`CASCADE` so ordering stops being a question. Its own guard has a test, verified
by mutation: weakening `endsWith` to `includes` is caught by the near-miss
cases.

## Known limits

**The timing assertions are bounded loosely and run on a shared machine.** They
catch the defence disappearing, which moves the ratio by an order of magnitude.
They would not catch a subtle timing difference introduced elsewhere, and they
are the tests most likely to flake on a heavily loaded CI runner. If they become
noisy the answer is to run them serially, not to widen the bounds until they
cannot fail.

**`startRun` refuses a foreign project with a plain `Error`,** which tRPC
reports as INTERNAL_SERVER_ERROR rather than NOT_FOUND. Isolation holds — the
refusal is real and no row is written — but the status code is wrong and a
legitimate client error is logged as a server fault. Left as found; it is a
behaviour change rather than a test.

**Nothing here tests the browser's own session handling** beyond sign-out
ending the session. Cookie flags, expiry, and the consequences of JWT sessions
being unrevokable are untested, and the last of those is a known design
tradeoff rather than a defect.
