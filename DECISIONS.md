# DECISIONS

## What I built

A small HTTP service that sits between callers and LLM providers and adds the four things
you need before you let a team point production traffic at an LLM: gateway-issued
**virtual keys** (callers never see a provider credential), **per-key spend caps in integer
micro-USD** that are enforced atomically and actually block, an **append-only usage ledger**
that answers "how much has key X spent, on what, when", and an **ordered fallback chain per
model** with classified retries, timeouts and a circuit breaker.

The public API is OpenAI's `POST /v1/chat/completions` shape, so any existing OpenAI SDK
works against it by changing `base_url` and the key. Primary provider is **Groq**, verified
end to end against a live key; an **Anthropic Messages** adapter and a free in-process
**mock** model are the other rungs of the chain. ~2,900 lines of TypeScript, 6 runtime
dependencies, no native modules, 38 automated tests plus a 25-check live endpoint battery.

---

## At a glance

| | |
|---|---|
| **Runtime** | Node 24, TypeScript, Fastify |
| **Datastore** | Postgres in production (`DATABASE_URL`), Node 24's built-in `node:sqlite` locally and in tests |
| **Providers** | Groq (live-verified) · Anthropic Messages (written, not live-tested) · in-process mock (free) |
| **Budget unit** | Integer micro-USD (1 USD = 1,000,000). No floats anywhere in the ledger |
| **Enforcement** | Two-phase `reserve → settle`, one conditional `UPDATE` as the compare-and-swap |
| **Over budget** | `402 Payment Required` (not 429 — see decision #6) |
| **Streaming** | Not supported. Rejected explicitly with a reason |
| **Dependencies** | `fastify`, `zod`, `pino`, `pg`, `openai`, `@anthropic-ai/sdk` |
| **Catalog integrity** | Boot-time reconciliation against each provider's own `GET /v1/models`; drift is logged and exposed at `/admin/stats` |
| **Boilerplate used** | None. Started from `npm init` |

---

## Moving parts

### Component map

```
                        ┌──────────────────────────────────────────────┐
   caller               │                 GATEWAY                      │
     │                  │                                              │
     │ POST /v1/chat/completions                                       │
     │ Authorization: Bearer sk-gw-…                                   │
     ├─────────────────►│  ① AUTH        auth.ts                       │
     │                  │     prefix lookup → SHA-256 → timing-safe cmp│
     │                  │            │                                 │
     │                  │  ② VALIDATE   schema.ts (zod, .strict)       │
     │                  │     resolve route: model → target chain      │
     │                  │            │                                 │
     │                  │  ③ ESTIMATE   tokens.ts + catalog.ts         │
     │                  │     est_in × 1.15 + max_tokens,              │
     │                  │     priced at the WORST target in the chain  │
     │                  │            │                                 │
     │                  │  ④ RESERVE  ── one conditional UPDATE ───────┼──► api_keys
     │                  │     store/{sqlite,postgres}.ts               │    reservations
     │◄─── 402 ─────────┤     zero rows back → refuse, log, stop       │
     │                  │            │ reserved                        │
     │                  │  ⑤ DISPATCH   dispatch.ts                    │
     │                  │     classify failure → retry / skip / abort  ├──► Groq
     │                  │     per-attempt timeout + chain deadline     │    Anthropic
     │                  │     circuit breaker per provider:model       │    mock (in-process)
     │                  │            │                                 │
     │                  │  ⑥ SETTLE  ── one transaction ───────────────┼──► api_keys
     │                  │     release reservation                      │    reservations
     │                  │     + add provider-reported cost             │    usage_events
     │                  │     + insert ledger row                      │
     │◄─── 200 ─────────┤  ⑦ RESPOND   OpenAI shape + `gateway` block  │
                        │                                              │
                        │  at boot:  catalog reconciliation ───────────┼──► provider
                        │            (does every catalogued model still │    GET /v1/models
                        │             exist? drift -> warn + /admin/stats)
                        │  background: reservation sweeper, every 30s   │
                        └──────────────────────────────────────────────┘
```

### Data model

Three tables. Each exists for one reason.

**`api_keys`** — the account. `budget_micros`, `spent_micros`, `reserved_micros` are integers.
`reserved_micros` is what makes concurrency safe: it is in-flight spend that other requests
can see *before* it settles. Without it, two simultaneous requests both read the same
`spent` and both pass. The row also holds `key_hash` (SHA-256) and `key_prefix` (a non-secret
indexed lookup handle).

**`reservations`** — one row per in-flight claim, with `state` and `expires_at`. This is the
table people are tempted to skip, using only the counter on `api_keys`. Skipping it means a
process that dies between reserve and settle leaks that headroom **permanently** — the key
silently loses spendable budget with no way to find out how much or why. With rows, a sweeper
reclaims orphans and the loss is bounded by the TTL.

**`usage_events`** — append-only ledger. Every request lands here including ones that never
reached a provider (`status: 'blocked'`), because "why was I refused" is an operational
question you will be asked. Indexed on `(key_id, created_at)`.

---

## Request lifecycle, traced end to end

Real values from a live run against Groq, not illustrative ones.

**1. Auth.** `Authorization: Bearer sk-gw-…` (also accepts `x-api-key`). The first 14
characters are a non-secret lookup prefix — indexed and unique — so key lookup is one indexed
read, not a scan of every key. The full key is SHA-256'd and compared with `timingSafeEqual`.
The hash is computed **even when the prefix misses**, so a wrong prefix and a wrong secret
take the same time and the lookup can't be probed. Only `key_id` and `key_prefix` ever reach
a log line.

**2. Validate.** `zod`, `.strict()` — unknown fields are rejected, not silently dropped. A
gateway that quietly ignores `tools` is worse than one that says it doesn't support them.
`stream: true` → 400 with a reason. `n > 1` → 400. The model name resolves to a **route**:
an ordered list of `(provider, model, price, context_window)` targets from
`config/models.json`.

**3. Fit check.** Estimated input + `max_tokens` is checked against the **smallest context
window in the chain**, not the first target's. Otherwise a request sized for a 128k primary
is accepted and then 400s on every fallback — burning the whole chain to reach a failure
that was visible up front.

**4. Reserve.** Estimate input tokens (~4 chars/token, ×1.15 safety), add the full
`max_tokens` as worst-case output, price it at the **most expensive target in the chain**,
and claim that headroom with one conditional `UPDATE`. Zero rows back → `402`, written to the
ledger as `blocked`, request stops. Nothing is dispatched.

> Worked example: `"count to five"` → estimated 16 input tokens → ×1.15 → 19. Plus
> `max_tokens: 64`. At $1.00/Mtok both ways that is **83 micro-USD reserved**. The request
> actually returned 16 in / 37 out = **53 micro-USD settled**. The 30 micro-USD gap is
> released. That gap is the design, not a bug — see Concurrency.

**5. Dispatch.** Walk the chain. Per-attempt `AbortController` timeout (30s), a hard deadline
over the entire walk (70s), full-jitter backoff, circuit breaker per `provider:model`.

**6. Settle.** One transaction: mark the reservation settled, release it, add the
**provider-reported** cost, insert the ledger row. The estimate is never billed — only what
the provider says it charged.

**7. Respond.** OpenAI-shaped body plus a namespaced `gateway` object and `x-gateway-*`
headers:

```json
"gateway": {
  "request_id": "…", "requested_model": "gateway-cheap",
  "served_provider": "groq", "served_model": "openai/gpt-oss-120b",
  "cost_micro_usd": 37, "reasoning_tokens": 30,
  "cache_hit": false, "fallback_used": false, "attempts": 1, "latency_ms": 664,
  "key_budget": { "budget_micro_usd": 50000, "spent_micro_usd": 37, "remaining_micro_usd": 49963 }
}
```

`served_model` is the model that **actually answered**, not the one requested. If a fallback
served it, the caller can see that in the body, not only in a header they may not read.

### What the caller gets when something goes wrong

| Situation | Status | Billed? | Logged? |
|---|---|---|---|
| Missing / bad virtual key | 401 | no | no (no key to attribute it to) |
| Key disabled | 403 | no | yes, `blocked` |
| Over budget | **402** | no | yes, `blocked` |
| Unknown model | 404 | no | no |
| Malformed request, `stream: true`, `n>1` | 400 | no | no |
| Provider says the request is malformed | 400 | no | yes, `error` |
| Whole chain failed | 502 + attempt trace | **no** | yes, `error` |
| Chain deadline exceeded | 504 + attempt trace | **no** | yes, `error` |
| Provider succeeded, ledger write failed | 200 | yes | to stdout at `fatal` for manual reconciliation |

---

## The most important decisions

### 1. Two-phase reserve → settle, instead of check-then-charge

- **Options.** (a) Check the balance, call the provider, add the cost afterwards.
  (b) Charge an estimate up front and refund the difference. (c) Reserve worst-case headroom
  atomically, then settle against the provider's reported usage.
- **Picked (c).** (a) is a TOCTOU race — N concurrent requests all read the same balance and
  all pass; it does not overspend by one request, it overspends by however many are in
  flight. (b) bills numbers that are wrong by construction and needs a refund path that can
  fail independently of the charge — two writes where one will do.
- **Tradeoff accepted.** A key can be refused while it still has real headroom, because the
  reservation assumes the maximum output the model might generate at the priciest model in
  the chain. Measured: a request that settles at 53 micro-USD reserves 83. A caller with
  $0.00008 left gets a 402 for a request that would have cost $0.00005. **I would rather
  refuse early than overspend** — refusing is visible, immediate and recoverable by raising
  the cap; overspending is silent and permanent.

### 2. Cost in integer micro-USD, priced from a versioned catalog

- **Options.** Cap on request count, on tokens, or on money.
- **Picked money**, as integer micro-USD. Request count is a bad proxy — one request can cost
  1000× another. Tokens are better but not comparable across models: measured on this
  deployment, one short request to `qwen/qwen3.6-27b` cost **596 micro-USD** while a similar
  one to `openai/gpt-oss-120b` cost **37** — a 16× spread on comparable token counts. Money
  is the only unit anyone actually has a budget in.
- **Integers, not floats.** `0.1 + 0.2 !== 0.3` has no place in a ledger, and budget
  comparisons must be exact. A useful identity falls out: a price quoted per 1M tokens means
  `cost_micros = tokens × usd_per_mtok` — the conversion factor cancels.
- **Prices live in `config/models.json`** with a `priced_at` date and source URLs, surfaced at
  `GET /v1/models`, so re-pricing is a reviewable data change rather than a code change.
- **Model IDs are verified against the provider's own `GET /v1/models`, not its docs.** Not
  theoretical: my first catalog came from Groq's published model page, which listed
  `llama-3.3-70b-versatile` and `llama-3.1-8b-instant`. Neither exists on the account — both
  return `model_not_found`. Details in the Fallback section, because of *how* I found out.
- **A model with no published per-token price is not in the catalog at all.**
  `groq/compound`, `groq/compound-mini` and `allam-2-7b` are available on the account and
  deliberately excluded. An unpriced model settles at zero cost, which quietly makes budgets
  unenforceable for any traffic routed to it. **Refusing to serve a model is a better failure
  than serving it for free.**
- **Tradeoff accepted.** That file is now a correctness dependency. If a provider re-prices
  and nobody updates it, every cost number is confidently wrong and nothing notices.

### 3. Mimic OpenAI's schema rather than invent one

- **Options.** A clean bespoke API; a transparent byte-for-byte proxy; OpenAI's shape
  re-implemented over a normalised internal model.
- **Picked the third.** Callers keep their existing SDK — change `base_url` and the key, no
  client rewrite. A bespoke API would be tidier and used by nobody. A transparent proxy can't
  be provider-agnostic, which kills fallback: you cannot fail over from Groq to Anthropic
  while forwarding raw bytes, because the two schemas genuinely differ (system prompt
  placement, message alternation rules, content blocks vs a string, `stop_reason` vocabulary).
- **Tradeoff accepted.** I inherit OpenAI's quirks — the string-or-array `content` union is
  handled explicitly — and I implement a **subset**. Tools, vision, logprobs, `n>1` and
  streaming are rejected loudly at the schema boundary rather than half-passed-through.

### 4. Non-streaming

- **Picked non-streaming.** This is a real constraint with two independent causes, not
  laziness:
  - **Budget settlement needs the provider's token counts**, which only exist once the
    response is complete. Streaming means either billing an estimate (wrong numbers in the
    ledger) or reconciling afterwards (a second write path that can fail).
  - **Streaming and fallback are in direct tension.** Once the first SSE frame is flushed you
    cannot fail over — the client already holds half an answer from a provider that then
    died. Honest streaming requires buffering until first token, which gives up most of the
    latency benefit anyway.
- **Tradeoff accepted.** Long completions have no time-to-first-token, so this gateway is the
  wrong choice behind a chat UI. The right fix is not "add streaming" — it is to add
  streaming as a **distinct mode that disables fallback for that request** and settles from
  the terminal usage chunk. Different guarantees, stated plainly, rather than pretending both
  work at once.

### 5. Postgres in production, SQLite locally, one store interface

- **Options.** SQLite on a mounted volume; Postgres everywhere; both behind an interface.
- **Picked both.** Render's free tier has ephemeral disk, so SQLite would silently lose the
  ledger on every deploy — unacceptable for the one table whose entire job is durability. But
  requiring a Postgres container to run tests is friction that makes people skip tests. So:
  `DATABASE_URL` set → Postgres; unset → SQLite file; tests use `:memory:`.
- **Tradeoff accepted.** Two SQL dialects to keep in sync (`MAX` vs `GREATEST`, `?` vs `$1`,
  BIGINT arriving as a string from `pg`), and the budget CAS — the single most
  correctness-critical statement in the codebase — is written twice while only one copy is
  tested. This is my "least confident" answer below.

### 6. 402, not 429, for over budget

Small decision, disproportionate consequences. `429 Too Many Requests` means "you are going
too fast, back off and retry" — and every well-behaved HTTP client and SDK **retries it
automatically**, often with backoff built in. A spend cap is not a pacing problem: retrying
will never succeed, so a 429 here generates a retry storm against a key that can never be
satisfied. `402 Payment Required` says the key is financially exhausted and needs a human to
raise the cap. The response body carries `budget_micro_usd`, `spent_micro_usd` and
`required_micro_usd` so the caller knows exactly how short they were.

---

## Why enforce budgets at the gateway rather than trusting callers?

Because a budget enforced by the spender is not a budget, it's a preference.

**The caller is the thing you're protecting yourself from.** Overspend rarely comes from
malice. It comes from a retry loop with no backoff, a `while` that doesn't terminate, a test
suite pointed at prod, a runaway agent, or a leaked key. In every one of those cases the
caller is *convinced* it is behaving correctly. Asking the buggy component to police itself
is asking the wrong component.

**Only the gateway knows the price.** The caller sees "I made one request." The gateway is
the only place that knows the request was 40k input tokens on a model that costs 16× the
alternative, that it fell back to a different model with different pricing, and what that
adds up to across every other caller sharing the key. Cost is a property of the provider
call, and the gateway is where that call happens.

**One enforcement point, not N.** Ten services means ten implementations of the same budget
logic, in different languages, drifting apart. The gateway is the chokepoint every request
already passes through — the natural home for an invariant. And any check you ship to the
client also ships *to the client*, where it can be edited out or skipped by the next service
that forgets to include it.

**Enforcement must be atomic with spending.** "Check the balance, then spend" is a race no
client-side check can win, because a client cannot hold a lock on shared state it does not
own. Only the component that owns the ledger can make the check and the charge a single
operation — which is exactly what the conditional `UPDATE` below does.

The deeper point: **budgets are a trust boundary, and trust boundaries belong at the
boundary.** Anything inside is advisory. A caller-side limit is a good idea for fast feedback
and a bad idea as a control.

---

## Concurrency: two requests on the same near-exhausted key

**Handled deliberately, and proven under real HTTP concurrency.**

### The race

```
req A: SELECT spent -> 990          req B: SELECT spent -> 990
req A: 990 + 20 <= 1000  ok         req B: 990 + 20 <= 1000  ok
req A: UPDATE spent = 1010          req B: UPDATE spent = 1030
```

Both read before either wrote. The cap is breached and **no individual line of code is
wrong.** Under load this doesn't overspend by one request — it overspends by however many are
in flight.

### The fix: make the check and the increment the same statement

```sql
UPDATE api_keys
   SET reserved_micros = reserved_micros + $1
 WHERE id = $2
   AND status = 'active'
   AND spent_micros + reserved_micros + $1 <= budget_micros
RETURNING *;
```

Zero rows back means "you lost, you're over budget" — the ordinary path, not an exception.
This is a compare-and-swap expressed in SQL, and it holds on both backends for different
reasons I had to go and confirm:

- **Postgres**, under `READ COMMITTED`: an `UPDATE` that meets a row already locked by a
  concurrent transaction blocks, and when that transaction commits it **re-evaluates the
  `WHERE` clause against the newly committed row version**. The loser's condition is now
  false, so it updates nothing. No `SELECT … FOR UPDATE` required.
- **SQLite**: `BEGIN IMMEDIATE` takes the write lock up front. Deliberately not `DEFERRED`,
  which upgrades mid-transaction and turns contention into `SQLITE_BUSY` errors instead of a
  queue.

### The third leg: reservations, not just a counter

`reserved_micros` is claimed before the provider call and released at settle, so concurrent
requests see each other's in-flight spend instead of a stale balance. Because a crash between
reserve and settle would strand that headroom forever, reservations are **rows with a TTL**
and a sweeper reclaims orphans every 30 seconds.

### The proof

`test/budget.test.ts` fires 40 concurrent requests at a key with room for a handful and
asserts the invariants that actually matter — not "exactly N succeed", which would just
encode whatever the code currently does:

```
spent <= budget                   (the cap held)
reserved == 0 afterwards          (nothing leaked)
spent == successes × known_cost   (the arithmetic is right)
```

Verified again against a running HTTP server with a real database:

| Scenario | Result |
|---|---|
| Fresh key, cap 1000 µUSD, **50 concurrent from cold** | 19 × `200`, 31 × `402`, **spent 950 / 1000**, reserved 0 |
| Exhausted key, **30 concurrent** | 30 × `402`, spent 424 / 500, reserved 0 |
| Sequential drain | blocked at request 9 after 8 successes |
| Raise the cap, retry | `200` — the block is a state, not a latch |

### What I knowingly did not solve

The reservation is worst-case, so a **burst** of concurrent requests can be refused while the
key still has room — each one holds a reservation much larger than it will end up using. In
the 50-concurrent run the key finished at 950 of 1000 spent, having refused 31 requests that
would each have cost ~50. Under high concurrency the key behaves as if its budget were
smaller than it is. That is correct but pessimistic, and it is the deliberate direction of
the error.

---

## Fallback policy

Each model name maps to an **ordered chain of targets**. The policy turns on classifying
*why* a provider failed, because the three cases want opposite responses:

| Failure | Examples | Action | Why |
|---|---|---|---|
| **caller** | 400, 413, 422 | **Abort the whole chain.** Return the provider's reason as a 400. | The request is malformed or too long. Every target rejects it identically. Walking the chain burns latency and money to reach the same answer and buries the real reason under a generic 502. Does **not** trip the breaker — the target is healthy, the request isn't. |
| **target** | 401, 403, 404 | **Skip to the next target.** No retry in place. | A wrong API key or a retired model ID will never succeed on retry, but the *next provider* may. Retrying here is pure waste. |
| **retryable** | 429, 5xx, timeout, socket | **Retry in place** with full-jitter backoff (honouring `Retry-After`), then fall through. | Transient. Worth one more attempt before giving up on an otherwise-good target. |

Around that:

- **Per-attempt timeout** (30s) **and a hard deadline for the whole walk** (70s), so a slow
  chain cannot hold a caller — or a budget reservation — open indefinitely.
- **Full jitter** on backoff: `random(0, min(base · 2ⁿ, cap))`, not a fixed delay. Fixed
  backoff makes every client that failed at the same instant retry at the same instant, which
  is how a recovering upstream gets knocked over a second time.
- **Circuit breaker per `provider:model`** — 5 consecutive failures opens it for 30s, then one
  probe. Without it, a hard-down provider costs *every* request its full timeout before the
  chain moves on: one broken upstream becomes latency for everyone. Verified: after 6 forced
  failures, `groq:openai/gpt-oss-20b` and `groq:openai/gpt-oss-120b` both report
  `state: "open"` at `GET /admin/stats` and are skipped.
- **Unconfigured providers are skipped, not attempted.** A missing credential is a deploy
  fact, not an upstream event, and must not count against the breaker.
- **The last rung is a free local mock.** For classification-shaped traffic a clearly marked
  degraded answer beats a 502. It is priced at zero, always labels itself in the response
  text, and `served_model: mock-echo` makes it impossible to mistake for a real answer.
- **Billing follows reality** — you are charged the price of the model that actually answered.
  Verified: a request routed to a $0.59/Mtok primary that fell through to a $0.075/Mtok
  fallback was billed at the fallback's price.
- **Everything failed → 502 with the full attempt trace** (provider, status, kind, latency per
  attempt) and **zero billed**. Verified: spend before 633 µUSD, after 633 µUSD.

### This policy was validated by an unplanned real failure

The first live call against Groq hit a **retired model ID**. The 404 classified as `target`,
the chain skipped to the next model without wasting a retry, and the caller got a correct
answer 618ms later with `fallback_used: true` and the right price for the model that actually
served.

That is exactly the intended behaviour — and it is also how I discovered the catalog was
wrong. The request returned `200`. If I had only checked the status code, a completely dead
primary route would have shipped. **Graceful degradation and silent breakage look identical
from the outside unless you instrument the difference.** That is why `fallback_used`,
`attempts` and `served_model` are in the response body and the ledger.

**And it is why the gateway now reconciles its catalog at boot.** For every provider the
catalog routes to, it fetches that provider's own `GET /v1/models` and reports any catalogued
model the provider no longer offers — logged as `CATALOG DRIFT` at `warn` and exposed at
`GET /admin/stats`. It is advisory, not fatal: an unreachable provider reports `unverified`
rather than `drift`, and a provider with no credential is never called at all, so a network
blip cannot stop a deploy. Verified by putting `llama-3.3-70b-versatile` back into the catalog
and watching boot report `status: "drift"`, `missing: ["llama-3.3-70b-versatile"]` — the exact
bug that started this, now caught before the first request.

`x-gateway-fail-providers: groq` forces a synthetic failure so the chain is demonstrable on
the live URL without waiting for a real outage. It is behind `ALLOW_FAULT_INJECTION` and can
only *cause* failures — it cannot bypass auth, budgets or logging.

---

## Cost estimation

**At settle time, cost is not estimated at all** — it is `tokens × price` using the
provider's own reported `usage`. The only estimate in the system is the pre-flight
reservation, and it exists solely to size the atomic claim.

That estimate is a heuristic on purpose: ~4 characters per token, +8 per message for chat
template overhead, ×1.15 safety factor. Shipping a real BPE tokenizer would mean one
tokenizer per model family, tens of MB of vocab in the image, and it would *still* be
approximate because each provider wraps its own chat template around the messages.

**What matters is the direction of the error, not its size.** Over-estimating refuses a
borderline request slightly early — annoying and recoverable. Under-estimating lets a request
slip past the cap — a real overspend. The heuristic rounds up at every step.

### Reasoning models break the naive assumption

`openai/gpt-oss-*` spend a large share of `completion_tokens` on reasoning tokens that are
**billed but never appear in `message.content`**. Measured on this deployment: a one-word
answer ("Paris") used 64 completion tokens of which **54 were reasoning**; "51" used 40 of
which 30 were reasoning.

Two consequences:

1. A low `max_tokens` is consumed entirely by reasoning and returns an **empty string you
   still pay for**, with `finish_reason: "length"`. That looks like success in every log and
   ledger row. The gateway now surfaces
   `usage.completion_tokens_details.reasoning_tokens` and attaches an explicit
   `gateway.warning` rather than handing back a silent `""`.
2. The reservation cannot predict the reasoning/answer split, so it reserves the full
   `max_tokens` and over-reserves for short answers. A per-model "expected reasoning ratio"
   in the catalog would tighten this; not built.

---

## Caching

Shipped: an **exact-match** response cache, opt-in via `CACHE_ENABLED`, keyed on
sha256(route, messages, max_tokens, temperature, top_p, stop), LRU with a TTL. Only requests
with `temperature: 0` are cached — above zero the caller has explicitly asked for sampling
variety and returning a byte-identical response would silently break that contract. A hit is
billed at zero but **still written to the ledger** with `cache_hit: true`, so "how many
requests did this key make" stays answerable and the saved spend is visible. An exhausted key
is refused *before* the cache lookup, so a spent-out key cannot keep serving free repeats.

Verified: miss = 33 µUSD / 787ms, then an identical request = 0 µUSD / 0ms; `temperature: 0.7`
correctly did not cache.

**Deliberately not semantic caching.** That needs an embedding model in the request path —
latency, its own cost, its own failure mode — and it can return a confidently wrong answer
when two prompts are near neighbours but not equivalent. Exact match can only ever fail to
hit. Its failure mode is "no saving"; semantic's failure mode is "wrong answer".

---

## What I deliberately did not build

- **Streaming.** Reasoned above. Rejected with an explanation, not silently ignored.
- **Rate limiting (RPM/TPM).** A genuine gap and the first thing I'd add: a spend cap does not
  stop someone burning their entire budget in ten seconds. It is a *different* control —
  pacing, not total — needing a sliding window in shared state. Named rather than hidden.
- **Semantic caching.** Above.
- **Key rotation, expiry, scopes.** Keys are create / disable / re-budget. Rotation is mostly
  UX around the same hash column.
- **Multi-tenancy, orgs, per-user sub-budgets.** Explicitly out of scope per the brief.
- **Tools / function calling / vision.** Rejected at the schema boundary rather than
  half-supported.
- **Request-level idempotency.** A client retrying a timed-out request pays twice. An
  `Idempotency-Key` header keyed to the ledger would fix it.
- **A polished frontend.** `/dashboard` is ~160 lines of plain HTML calling the same
  authenticated JSON endpoints as curl. No framework, no build step, no design time.
- **Auto-retry on the caller's behalf after a 402.** Being over budget is a human decision.

---

## The decision I'm least confident about

**Supporting two datastores behind one interface.**

**For.** Zero-setup local dev and tests — `npm test` needs nothing installed and runs in
memory — while production gets a durable Postgres that survives Render's ephemeral disk. The
interface is small and the divergence is ~40 lines. Being able to run the full suite in-memory
is *why* there are 32 tests; against a container I would have written far fewer.

**Against.** The single most correctness-critical statement in this codebase is written twice,
and **only one copy is tested.** The SQLite CAS is covered by a 40-way concurrency test and a
50-way live run. The Postgres CAS — the one that will actually run in production — is backed
by my reading of `READ COMMITTED` re-check semantics and nothing else. That is precisely the
wrong place to hold asymmetric confidence. A subtle dialect difference would surface as
silent overspend under load: the hardest possible failure to notice, because nothing errors.

There is a sharper version of the criticism: my justification is *developer convenience*, and
I traded *production* correctness assurance for it. Given a container in CI, the honest answer
is probably "Postgres everywhere, use testcontainers, eat the setup cost."

**What I did about it.** `test/postgres.test.ts` now exists and exercises the Postgres CAS
directly: 60 simultaneous reservations against a budget that affords exactly 10, asserting
`granted === floor(budget/amount)` rather than merely `spent <= budget`; 30 concurrent settles
asserting nothing is lost or double-counted; the orphan sweeper; and the disabled-key path. It
is gated on `DATABASE_URL` and **skips with a printed reason** when no database is present, so
`npm test` still needs nothing installed. `npm run test:pg` against any Postgres runs it.

I could not run it here — no Postgres and no Docker daemon on this machine — so the honest
status is: **the test is written and ready, the measurement has not been taken.** That is a
meaningful step up from "I would write it," and one `DATABASE_URL` away from being settled,
but it is not the same as green. Running it in CI against a real Postgres remains the first
thing I would do with more time.

---

## Where it breaks

1. **Postgres concurrency is untested.** Above. Highest-priority gap.
2. **Stale prices are still silent.** Model *IDs* are now reconciled at boot, so a retired
   model is caught before the first request. Prices are not — there is no per-token price in
   any provider's model listing, so if a provider re-prices, every cost figure is confidently
   wrong and nothing alerts. Catching that needs a diff against actual provider billing,
   which is on the one-more-week list.
3. **In-memory breaker and cache don't scale horizontally.** With N replicas each learns about
   an outage independently (up to N probes per cooldown) and the cache hit rate is roughly
   1/N of a shared one. **Budgets are unaffected** — those live in the database.
4. **Reasoning models bill for output you never see.** Handled with a warning, not solved.
5. **Token estimation is a heuristic.** Fine for reservations since settlement uses real
   numbers, but a pathological input (dense CJK, base64) under-estimates and could let one
   request finish slightly over cap.
6. **Reservation TTL is a blunt instrument.** A provider slower than the 120s TTL would have
   its reservation swept while still in flight, and settle would then add cost against
   already-released headroom. Bounded by the 70s request deadline so it cannot happen at
   current settings — but the two constants are coupled and nothing enforces the relationship.
7. **The ledger write is in the request path.** If the database is unreachable *after* a
   successful provider call, the caller still gets their completion — failing them would make
   them retry and pay twice — and the row is emitted to stdout at `fatal` for manual
   reconciliation. A deliberate choice, but "the logs are the write-ahead log" is not
   something I would want to rely on twice.
8. **Free-tier cold starts.** Render free spins down when idle; the first request after a
   pause is slow.
9. **No request-level idempotency.** A retried timeout is charged twice.
10. **`qwen/*` emits its chain-of-thought inline** in `content` inside `<think>` tags rather
    than as separate reasoning tokens. The gateway passes it through faithfully — filtering
    provider output is not a gateway's job — but callers should know, and it makes those
    routes disproportionately expensive per useful token.

## With one more week

1. **Run `test/postgres.test.ts` in CI** against a real Postgres. The test is written; it
   needs a `docker compose` service and one matrix entry. Day one — it is the gap above.
2. **Rate limits** — sliding-window RPM/TPM per key, enforced next to the budget CAS. The
   single most valuable thing still missing: a spend cap does not stop someone burning a
   month's budget in ten seconds.
3. **Async ledger writes** — batch inserts behind a bounded queue with a durable spill, taking
   the analytics write off the hot path while keeping the *budget* write synchronous. Spend
   must be transactional; the analytics row does not have to be.
4. **Idempotency keys.**
5. **Price reconciliation** — a job that diffs `models.json` against provider billing and
   pages on drift. The model-ID half of this now ships; the price half is harder because no
   provider exposes prices in its API.
6. **Prometheus metrics and a real load test.** I can reason about the concurrency and I have
   measured it to 50 in-flight requests; I have not measured it at 5,000.
7. **Streaming as a distinct mode**, explicitly without fallback.

---

## How this was verified

| Layer | What | Result |
|---|---|---|
| Static | `tsc --noEmit` | clean |
| Automated | 38 tests, `node:test`, no framework | 38/38 pass |
| Endpoints | 25-check live battery (auth, validation, status codes) | 25/25 pass |
| Provider | Real Groq completions across 3 routes | pass |
| Budget | Sequential drain, 30- and 50-way concurrency | cap held, nothing leaked |
| Fallback | Forced failure, whole-chain failure, breaker opening | pass, zero billed on failure |
| Catalog | Reconciliation against live Groq, plus injected drift | `ok` clean, `drift` correctly named |
| Ops | SIGTERM graceful shutdown, restart persistence | pass |
| Security | grep for `gsk_`, `sk-gw-`, `key_hash` in logs | 0 occurrences each |

Tests are concentrated where being wrong is expensive — budget arithmetic, the concurrency
invariant, fallback classification, auth — and absent where it isn't. They assert
**invariants, not implementation**: the concurrency test checks `spent <= budget` rather than
"8 requests succeed", so it holds for any correct implementation and fails for every
incorrect one, including ones I haven't thought of.

**Not verified:** the Postgres driver under concurrency — the test exists (`npm run test:pg`)
but there is no Postgres or Docker daemon on this machine to run it against; the Anthropic
adapter against a live Anthropic key (written against the documented API, no key available);
the Docker image build (same reason — Render builds it from the same Dockerfile).

`npm run verify` runs typecheck, the full suite and the production build in one command.

---

## Notes

- **Boilerplate:** none. Started from `npm init`.
- **Tests:** the brief says they're optional. I wrote them because the budget invariant is not
  something I would trust to code review, and because an in-memory store made them cheap.
  They assert invariants rather than implementation, so they keep their value under refactor.
- **Secrets:** never in the repo. `.env` is gitignored, `render.yaml` marks every credential
  `sync: false`, the Docker image contains none, provider keys are server-side only and read
  in exactly one file, and virtual keys are stored as SHA-256 with the plaintext returned
  exactly once at creation.
- **Comments:** the source is comment-free by choice. The reasoning lives here, where it can
  be read as an argument rather than as scattered annotations.
