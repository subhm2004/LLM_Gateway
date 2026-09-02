# AI-LOG

> **Honest summary up front:** AI wrote most of the code in this repo. I set the
> architecture, made the judgment calls, verified the parts where being wrong is expensive,
> and can defend every line. Where I let AI output stand unchanged, it is because I read it
> and agreed — not because I didn't look. The most useful thing I learned is in the first
> section: my own resilience design hid a real bug from me, and only a live call found it.

---

## Tools, and what each was used for

| Tool | Used for |
|---|---|
| **Claude Opus 5 (via Claude Code)** | Nearly all implementation — provider adapters, both store drivers, the dispatcher, routes, tests, Dockerfile, and first drafts of this document and DECISIONS.md. |
| **Web search / fetch** | Current Groq model IDs, context windows and per-token prices. Deliberately *not* from model memory. |
| **Groq's own `GET /v1/models`** | The eventual source of truth for model IDs and context windows, after the docs turned out to be wrong. |
| **Anthropic API reference (bundled skill)** | Exact Messages API bindings and the SDK error-class hierarchy, rather than guessing method names for a provider I couldn't test against. |
| **`node --test`, `tsc --noEmit`, curl** | Verification. Every claim in DECISIONS.md that says "verified" is backed by something in `test/` or `scripts/smoke.sh` that I actually ran and can re-run. |

Rough split: **~85% of lines AI-generated, ~15% hand-directed rewrites.** The 15% is
concentrated exactly where it should be — the budget CAS, cost arithmetic, auth, and the
fallback classification.

---

## Where the AI was wrong or misleading

### 1. The official docs listed models that don't exist — and my own fallback hid it

This is the one that matters.

I built the model catalog from Groq's published model documentation, fetched during the
build. It listed `llama-3.3-70b-versatile` and `llama-3.1-8b-instant` as current production
models, with context windows and prices. I cross-checked the **prices** against a second
source and felt appropriately careful.

Neither model exists on a real Groq key. Both return
`The model does not exist or you do not have access to it`. The account actually serves
`openai/gpt-oss-*`, `qwen/qwen3.6-27b`, `qwen/qwen3.8-27b` and `groq/compound`.

Two separate mistakes, and the second is the interesting one:

**I verified the prices but never the model IDs.** I treated "the docs say this model exists"
as a fact rather than a claim, because it was the boring part of the data. Prices felt
risky — numbers change, I know that — so I checked them. Identifiers felt stable. They
aren't; providers retire models.

**My own fallback design hid the bug from me.** The first live request returned a perfectly
good `200`, served by `openai/gpt-oss-20b`, in 618ms. The 404 classified as a `target`
failure, the chain skipped to the next model without wasting a retry, and the caller got a
correct answer. The resilience worked *exactly* as designed — and in working, it made a
completely dead primary route look like a healthy request. **If I had only checked that the
response was 200, I would have shipped it.**

What caught it was reading `gateway.fallback_used: true` on a request that had no business
falling back, and asking why. That field existed because I'd put it there for observability,
not because I expected to need it on day one.

**The fix, and the generalisation.** I rebuilt the catalog from
`GET https://api.groq.com/openai/v1/models` — the provider's own answer — and recorded that
provenance in the file itself (`models_verified_against`). The lesson I'd carry to any
resilient system: **graceful degradation and silent breakage are indistinguishable from
outside unless you deliberately instrument the difference.** A fallback that doesn't tell you
it fired is a bug-concealment device.

Then I stopped relying on my own diligence and made the machine do it. `src/reconcile.ts`
runs at boot: for every provider the catalog routes to, it fetches that provider's own model
list and reports anything the catalog references that the provider no longer offers. Drift is
logged at `warn` and exposed at `GET /admin/stats`. It is advisory rather than fatal — an
unreachable provider reports `unverified`, not `drift`, and a provider with no credential is
never called — because a network blip should not block a deploy.

I tested it by putting `llama-3.3-70b-versatile` back into the catalog and restarting. Boot
reported `status: "drift"`, `missing: ["llama-3.3-70b-versatile"]`. **The bug that started
this section would now be caught before the first request.** Fixing the instance was the
minimum; closing the class was the actual job.

### 2. It would have invented the price table

Costs are the entire point of this service, so a wrong price is a wrong product. I set a rule
up front: **no price from model memory.** Model recall for provider pricing is plausible,
specific, confidently stated, and six months stale — the worst possible combination.

The first fetch of Groq's pricing page returned marketing copy with **no pricing data at
all** — precisely the kind of result that, skimmed, leads to "fine, I'll use the numbers I
remember."

I cross-checked two independent sources, then made the failure mode structural rather than
relying on my own future diligence: prices live in `config/models.json` with
`priced_at: "2026-09-02"` and a `pricing_sources` map of URLs, surfaced at `GET /v1/models`
so anyone can see how old the numbers are.

A second rule fell out of this while I was reconciling the real model list: **a model with no
published per-token price is not in the catalog at all.** `groq/compound` and `allam-2-7b`
are available on the account and deliberately excluded, because an unpriced model settles at
zero cost and quietly makes budgets unenforceable for anything routed to it. Refusing to
serve a model is a better failure than serving it for free.

### 3. Generated code that was internally inconsistent across two endpoints

`/v1/usage` returned `spent_micro_usd`. `/admin/usage` returned `spent_micros`. Both were
individually reasonable, both were generated in the same session, and neither is wrong on its
own — which is exactly why reading them separately didn't catch it. A test asserting on the
admin response did.

My first instinct was to fix the test. The right fix was to make the API consistent, so
`decorate()` now emits one naming convention (`*_micro_usd` / `*_usd`) and the internal
column names never leave the process.

This is the failure mode I now *expect* from AI-assisted work: not incorrect code, but
locally-sensible code that fails to cohere globally. Reviewing file by file cannot find it,
because every file is fine. Tests that cross a boundary can.

### 4. Two copies of the security-critical auth path

The virtual-key check — prefix lookup, SHA-256, timing-safe compare — was written twice:
once in `routes/chat.ts` and once in `routes/usage.ts`. Both correct, both generated in the
same session, neither flagged by any test because both worked.

I only caught it while grepping for `findKeyByPrefix` during a cleanup pass. It is a direct
violation of the rule I'd written for myself two sections below — *shrink the critical
surface until it fits in your head* — and I'd broken it without noticing, because
duplication reads as "fine" file by file. Now there is one `authenticateKey()` in `auth.ts`
and both routes call it.

The uncomfortable part: I'd stated the principle and still missed the instance. Principles
don't audit code; greps and tests do.

### 5. The code was right; the shape around it was the bottleneck

Once I had a real Postgres, the concurrency test failed on the first run — and **not on the
invariant.** It failed with `timeout exceeded when trying to connect`. The CAS was correct.
The transaction wrapping it was five network round trips (`connect`, `BEGIN`, `UPDATE`,
`INSERT`, `COMMIT`), and against a database ~250ms away with a pool of 10, sixty concurrent
reservations queued past the connection timeout.

I had reviewed that code carefully — it was on my short list of "things AI does not get to be
the last reader of" — and I had reviewed it for **correctness**, which it had. I never asked
how many round trips it cost, because on the in-memory SQLite I was testing against, round
trips are free. The test environment had quietly removed the dimension the bug lived in.

Collapsing each transaction into a single data-modifying CTE took reserve, settle and the
sweeper from four or five round trips to one. Same database, same tests: the failing test
went to 4.8s and passed; concurrent settles went 20.7s → 1.7s; the suite went 41.2s → 12.0s.

The lesson is narrower than "test against production-like infrastructure," which everyone
already says. It is: **an easier test environment does not just make tests pass more often,
it deletes whole categories of bug from view.** SQLite in memory cannot express "this is slow
because it talks to the network too many times," so no amount of local testing was ever going
to surface it. Two other things fell out of the same session — TLS certificate verification
was silently disabled with `rejectUnauthorized: false` when Neon presents a perfectly valid
chain, and the `sslmode` handling relied on `pg` URL-parsing behaviour its own maintainers
have deprecated. Both were invisible until something real was on the other end of the socket.

### 6. A plausible toolchain assumption that was simply false

The plan was to run TypeScript directly on Node 24 via `--experimental-strip-types`. That
mode cannot handle TypeScript parameter properties (`constructor(private readonly x: T)`),
which the generated code used everywhere, because stripping types can't emit the assignments
those imply. Not a subtle bug — the entire test suite failed to load. Fixed with
`--experimental-transform-types`.

A smaller sibling of the same thing bit me later: when stripping comments from the codebase I
first used TypeScript's own scanner, which **silently stops emitting comment tokens after it
hits a template literal** like `` `sk-gw-${secret}` ``. Files without template literals came
out clean; files with them were half-processed, and the tool reported success. I only noticed
because a grep afterwards still found comments. I replaced it with a hand-written state
machine that tracks strings, template literals with nested `${}`, and regex literals.

Both are the same lesson: "this should work" from a model is a hypothesis, and the cheapest
way to test a hypothesis is to run it and check the output — not to reason about whether it
sounds right.

---

## Where I overrode the AI

### SHA-256 for virtual keys, not bcrypt

The reflexive, textbook-correct advice — which the model offered — is "never store a secret
without a slow KDF." I overrode it.

bcrypt and argon2 exist to make **brute force against low-entropy human passwords**
expensive. A virtual key here is 256 bits of CSPRNG output, base64url-encoded. There is no
dictionary to run and no feasible search space. Adding ~100ms of KDF to *every proxied
request* would buy no real security at a very real latency cost, on the hot path of a service
whose entire job is to sit in front of something slow without making it slower.

If keys were ever user-chosen, this flips immediately. Because the reasoning is
non-obvious and the default advice points the other way, it's written up in DECISIONS.md so
the next person doesn't "fix" it.

### Reserve at the most expensive target in the chain, not the first

The natural implementation — and my first draft — prices the reservation against the target
you are about to call. It is wrong: a fallback can land on a *pricier* model than the primary,
so you would reserve the cheap price and settle the expensive one, finishing over budget.

One function in `catalog.ts` (`worstCaseTarget`) fixes it, at the cost of refusing slightly
early. I would rather be pessimistic than wrong, and the direction of that error is a
deliberate, documented choice rather than an accident.

### 402, not 429, for over budget

`429 Too Many Requests` means "you're going too fast, back off and retry" — and every
well-behaved HTTP client and SDK **retries it automatically**. A spend cap is not a pacing
problem: the retry can never succeed, so a 429 here manufactures a retry storm against a key
that is permanently unsatisfiable. `402 Payment Required` says a human needs to raise the cap.
The brief offered "429/402" as equally acceptable; they are not, and the difference is
entirely in how clients behave.

### Rejecting the brief's `GET /usage?key=...` shape

Secrets in query strings leak — access logs, proxy logs, browser history, `Referer` headers.
So `/v1/usage` authenticates with the key in a header and returns **that key's** usage; there
is no parameter to tamper with and no path to read someone else's spend. Admins use
`/admin/usage?key_id=`, which takes an opaque id rather than a secret.

Deviating from a spec needs a reason. This one had one, and I'd rather explain the deviation
on a call than explain why keys ended up in an nginx log.

### Making the mock provider stop over-claiming

The generated mock returned text saying *"Every upstream provider in this route failed, so
the gateway served its local fallback model."* That reads well and is sometimes a lie — the
mock can be requested directly, in which case nothing failed. A provider cannot know why it
was reached. I rewrote it to describe only what it knows and leave the fallback question to
`gateway.fallback_used`, which is the field that actually knows the answer.

Small, but it's the same discipline as the catalog: don't let a component assert something
outside its own knowledge.

---

## Staying in control of code I didn't type

The working rule: **AI can write anything; AI cannot be the last reader of anything that
touches money, credentials, or the provider call.** Four concrete practices.

### 1. Shrink the critical surface until it fits in your head

All budget enforcement is one SQL statement. Not a module, not a service class — one
statement, six lines, in two files:

```sql
UPDATE api_keys SET reserved_micros = reserved_micros + $1
 WHERE id = $2 AND status = 'active'
   AND spent_micros + reserved_micros + $1 <= budget_micros
RETURNING *;
```

I can say what every clause does, why zero rows returned is the ordinary path rather than an
error, and why this is safe without `SELECT … FOR UPDATE`. If enforcement were spread across
a service with three helpers and an interface, I would be reviewing *structure* and would
have missed the race entirely.

### 2. Test invariants, not implementation

The concurrency test does not assert "8 requests succeed" — that would just encode whatever
the code currently does and pass forever afterwards. It asserts:

```
spent <= budget
reserved == 0 afterwards
spent == successes × known_cost
```

Those hold for any correct implementation and fail for every incorrect one, including ones I
haven't thought of. Same discipline in the fallback tests: the caller-error test asserts the
second provider was **never invoked** (`stub.calls === 0`), which is the actual policy, not
the code path that currently implements it.

### 3. Fix the class, not the instance

When the retired-model bug surfaced, the minimum fix was "update the catalog." I did that and
then asked what would stop it recurring, which produced `src/reconcile.ts` and six tests for
it. Same pattern with the duplicated auth path: the fix was not "delete one copy" but "make
there be one function so a third copy can't appear."

This matters more with AI-generated code than with hand-written code, because generation is
cheap. It is trivially easy to accept a fix for the symptom and move on, and the symptom is
usually the part you understand least.

### 4. Verify secret handling by grepping, not by trusting

Provider keys are read in exactly one file (`config.ts`) and only ever passed into an SDK
constructor. Virtual keys are hashed at the boundary; the plaintext is returned once at
creation and never persisted. `logger.ts` redacts `authorization`, `x-api-key` and
`*.key_hash`, and no call site logs a raw key — everything logs `key_id` / `key_prefix`.

There's a test asserting the admin list response contains neither `key_hash` nor any
plaintext key, plus a log scan after every live run:

```
occurrences of 'gsk_' in server log:        0
occurrences of plaintext 'sk-gw-':          0
occurrences of 'key_hash':                  0
```

"I checked once" is not a control and does not survive the next refactor. A test is.

### 5. Read the *provider's* answer, not the model's summary of it

After the Llama incident this became a rule: for anything the gateway depends on
factually — model IDs, context windows, token accounting — go to the provider's API and read
the JSON. That is how I found the reasoning-token behaviour (`completion_tokens_details`),
the real context windows (including `qwen/qwen3.8-27b`'s odd 131,042 rather than the usual
131,072), and which models the account can actually reach.

### Where I was less rigorous — stated plainly

- The **Anthropic adapter** is written against the documented API and has **never run against
  a live Anthropic key** — I only have Groq. It is in the repo because a genuinely different
  schema is what makes the fallback chain a real translation layer rather than a loop over
  identical clients, but it is untested code and DECISIONS.md says so.
- The **Postgres driver's CAS** was my stated "least confident" decision while it was
  untested. It is now measured against a real Neon instance — 60 simultaneous reservations
  asserting `granted === floor(budget/amount)` exactly, concurrent settles, the orphan
  sweeper — plus 40 concurrent HTTP requests end to end on Postgres with a live Groq key
  (7 admitted, 33 refused, spent 371 of a 500 cap, nothing leaked). Running it is what found
  the round-trip bug above. What remains is a process gap, not a correctness unknown: neither
  suite runs in CI, so nothing stops the two copies of the CAS drifting on the next change.
- The **Docker image has not been built** — no Docker daemon available locally. The compiled
  output runs, which retires most of the risk, but the image itself is unverified.

---

## Something I had to learn from scratch

**Why a conditional `UPDATE` is safe under concurrency without an explicit lock.**

I knew the check-then-act race in the abstract. What I did not know was whether folding the
check into the `WHERE` clause actually *closes* it or merely narrows the window. That
distinction is the entire foundation of the budget design — if it only narrows the window,
the whole thing is theatre.

The answer turned out to be a specific, non-obvious guarantee. Under `READ COMMITTED`, when
Postgres finds a row already locked by a concurrent `UPDATE`, it waits for that transaction to
commit and then **re-evaluates the `WHERE` clause against the newly committed row version**
rather than proceeding with the snapshot it started from. That re-check is the whole reason
the CAS works: by the time the loser acquires the lock, its condition is false, so it updates
nothing and returns zero rows. I had previously assumed read-modify-write always required an
explicit lock.

Then the SQLite half, which is a different mechanism for the same guarantee: `BEGIN IMMEDIATE`
takes the write lock up front, whereas `DEFERRED` upgrades mid-transaction and turns
contention into `SQLITE_BUSY` errors instead of a queue — a worse failure that looks like a
flaky database rather than a design mistake.

**How I got up to speed:** read the Postgres concurrency-control documentation on the re-check
behaviour, found the SQLite equivalent, then wrote the 40-way concurrency test specifically to
check my understanding rather than assume it — and later a 50-way run against a live HTTP
server with a real database (19 succeeded, 31 refused, 950 of a 1000 cap spent, nothing
leaked). The test passing on SQLite still does not prove the Postgres path, which is exactly
why that remains my least-confident decision rather than a solved problem.

**What I got wrong on the way:** my first mental model was "reserve = decrement the balance,
refund later." That is a two-write design with a refund path that can fail independently of
the charge. Splitting it into a `reserved_micros` column *plus* a `reservations` table with a
TTL and a sweeper is strictly better: the in-flight claim is visible to concurrent requests,
and a crash between reserve and settle becomes recoverable instead of permanently eating
budget.

**The other thing I only learned by running it:** `openai/gpt-oss-*` are reasoning models, and
reasoning tokens are billed as output tokens while never appearing in `message.content`. My
first live call used `max_tokens: 16` and got back a **billed empty string** — all 16 tokens
went to reasoning. On a one-word answer ("Paris") the split was 54 reasoning tokens to 10
content tokens. For a gateway this is not trivia: it is a silent-failure mode that looks like
a successful request in every log line and every ledger row. The gateway now surfaces
`reasoning_tokens` and attaches an explicit warning when content is empty. No amount of
reading documentation would have surfaced this; one real call did.

---

## What I'd do differently

- **Verify identifiers with the same suspicion as numbers.** I was careful about prices and
  careless about model IDs, and the model IDs were what broke.
- **Instrument the difference between "degraded" and "broken" before relying on
  degradation.** I got this right by accident — `fallback_used` was there for observability
  and ended up being the only reason I caught a dead route.
- **Make a live call earlier.** I built the whole gateway against a mock provider and tested
  against the real one late. The mock was the right call for the test suite; it was the wrong
  call for validating my assumptions about the world.
- **Get the real infrastructure in front of the code sooner.** Every genuine bug in this
  build — the retired model IDs, the reasoning-token empty response, the connection round
  trips, the disabled TLS verification — was found by pointing the code at something real,
  and none of them were findable any other way. I did the mock-backed work first because it
  was frictionless, and frictionless is exactly what made it blind.
- **Grep for duplication of anything security-critical before the end.** I found the doubled
  auth path late and by accident; a five-second grep on day one would have found it.

---

> **Before submitting:** the sections above describe what actually happened during this
> build. Read them against your own recollection and rewrite anything that doesn't sound like
> you — especially "Something I had to learn from scratch," which should be *your* gap, not
> whichever one the transcript happens to show. You will be asked to defend this on a call,
> and the fastest way to fail that call is to defend a sentence you didn't write.
