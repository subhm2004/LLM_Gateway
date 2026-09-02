# llm-gateway

A minimal LLM gateway: virtual keys, per-key spend caps that actually block, a usage
ledger, and graceful fallback across providers. OpenAI-compatible API.

**Design rationale and trade-offs: [DECISIONS.md](DECISIONS.md). How AI was used:
[AI-LOG.md](AI-LOG.md).**

```
caller ──► auth ──► budget reserve ──► provider chain ──► settle + log ──► response
           sk-gw-*   atomic CAS         retry/fallback/    real token
                                        circuit breaker    usage
```

---

## Quick start (no credentials needed)

The gateway is fully runnable with zero provider keys — a free in-process `mock` model is
a first-class provider, and `mock-priced` carries a synthetic price so budget enforcement
is demonstrable end to end.

```bash
npm install
export ADMIN_TOKEN="$(openssl rand -base64 24)"
npm run dev
```

```bash
# 1. mint a virtual key with a $0.01 cap
curl -s -X POST localhost:8080/admin/keys \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"demo","budget_usd":0.01}' | jq -r .key
# -> sk-gw-…   (shown once; only a SHA-256 is stored)

# 2. use it
curl -s -X POST localhost:8080/v1/chat/completions \
  -H "Authorization: Bearer sk-gw-…" -H 'Content-Type: application/json' \
  -d '{"model":"mock-priced","messages":[{"role":"user","content":"hello"}]}' | jq

# 3. what has it spent?
curl -s localhost:8080/v1/usage -H "Authorization: Bearer sk-gw-…" | jq .key
```

Everything at once, including the budget-exhaustion and concurrency demos:

```bash
./scripts/smoke.sh http://localhost:8080 "$ADMIN_TOKEN"
```

Run the tests (38, no framework, nothing to install):

```bash
npm test            # full suite; the Postgres tests skip with a printed reason
npm run verify      # typecheck + tests + production build
npm run test:pg     # Postgres concurrency tests, needs DATABASE_URL
```

### With a real provider

```bash
export GROQ_API_KEY=gsk_...      # https://console.groq.com/keys — free tier
npm run dev
```

Then use `openai/gpt-oss-20b`, `openai/gpt-oss-120b`, `qwen/qwen3.6-27b`, or the aliases
`gateway-cheap` / `gateway-capable`. `GET /v1/models` lists every route with its fallback
chain and prices.

> **Gotcha worth knowing:** `openai/gpt-oss-*` are *reasoning* models. A large share of
> `completion_tokens` are reasoning tokens that are billed but never appear in
> `message.content` — observed 54 of 64 on a one-word answer. A low `max_tokens` is
> consumed entirely by reasoning and returns an **empty string that you still pay for**.
> The gateway surfaces `usage.completion_tokens_details.reasoning_tokens` and attaches an
> explicit `gateway.warning` rather than handing back a silent `""`.

Because the API is OpenAI-shaped, existing clients work unchanged:

```python
from openai import OpenAI
client = OpenAI(base_url="https://your-gateway.onrender.com/v1", api_key="sk-gw-…")
print(client.chat.completions.create(
    model="openai/gpt-oss-120b",
    messages=[{"role": "user", "content": "hi"}],
).choices[0].message.content)
```

---

## API

### Proxy

| | |
|---|---|
| `POST /v1/chat/completions` | OpenAI chat-completions shape. Auth: `Authorization: Bearer sk-gw-…`. Non-streaming ([why](DECISIONS.md#4-non-streaming)). |
| `GET /v1/models` | Routes, fallback chains, prices, and which providers are configured. |
| `GET /v1/usage` | Spend for **the calling key** — no key parameter, nothing to tamper with. |

Every response carries `x-gateway-*` headers (served provider/model, cost, cache status,
fallback flag, remaining budget) and a namespaced `gateway` object in the body:

```json
{
  "id": "chatcmpl-…", "object": "chat.completion",
  "model": "openai/gpt-oss-20b",
  "choices": [{ "index": 0, "message": {"role":"assistant","content":"…"}, "finish_reason": "stop" }],
  "usage": { "prompt_tokens": 80, "completion_tokens": 64, "total_tokens": 144 },
  "gateway": {
    "request_id": "…", "requested_model": "gateway-cheap",
    "served_provider": "groq", "served_model": "openai/gpt-oss-20b",
    "cost_micro_usd": 26, "cache_hit": false, "fallback_used": false,
    "attempts": 1, "latency_ms": 412,
    "key_budget": { "budget_micro_usd": 10000, "spent_micro_usd": 26, "remaining_micro_usd": 9974 }
  }
}
```

### Admin — `Authorization: Bearer $ADMIN_TOKEN`

| | |
|---|---|
| `POST /admin/keys` | Create a key. `{"name":"…","budget_usd":0.25}`. Returns the plaintext **once**. |
| `GET /admin/keys` | All keys with budget / spent / remaining. |
| `GET /admin/keys/:id` | One key plus its usage summary and per-model breakdown. |
| `PATCH /admin/keys/:id` | Raise the cap, rename, or `{"status":"disabled"}`. |
| `GET /admin/usage?key_id=…&since=…&limit=…` | Ledger for any key. |
| `GET /admin/stats` | Circuit-breaker state, cache hit rate, configured providers, catalog age, and boot-time catalog reconciliation. |
| `GET /dashboard` | Barebones spend table in a browser (~160 lines of plain HTML, no build). |

### Health

`GET /health` — liveness, does **not** touch the database (a liveness probe that depends
on Postgres restarts the app when Postgres blips).
`GET /ready` — readiness, does.

### Errors

OpenAI-shaped. `401` bad key · `402` **budget exhausted** · `403` disabled key or missing
admin token · `404` unknown model · `400` malformed request (or a provider rejecting it
as malformed) · `502` whole fallback chain failed, nothing billed · `504` deadline.

---

## Configuration

Everything comes from the environment; see [`.env.example`](.env.example). Nothing
sensitive is ever read from a file in the repo.

| Variable | Default | Notes |
|---|---|---|
| `ADMIN_TOKEN` | — | **Required.** ≥16 chars. Server refuses to boot without it. |
| `DATABASE_URL` | — | Postgres when set; SQLite file when not. |
| `GROQ_API_KEY` | — | Primary provider. |
| `ANTHROPIC_API_KEY` | — | Optional second provider (different schema — real cross-provider fallback). |
| `PROVIDER_TIMEOUT_MS` | `30000` | Per attempt. |
| `REQUEST_DEADLINE_MS` | `70000` | Whole chain incl. retries. Must exceed the above. |
| `MAX_RETRIES_PER_TARGET` | `1` | Retries of the *same* target on a retryable failure. |
| `BREAKER_FAILURE_THRESHOLD` / `_COOLDOWN_MS` | `5` / `30000` | Per `provider:model`. |
| `ESTIMATE_SAFETY_FACTOR` | `1.15` | Inflates the pre-flight token estimate. |
| `CACHE_ENABLED` | `false` | Exact-match, `temperature: 0` only. |
| `ALLOW_FAULT_INJECTION` | `false` | Enables `x-gateway-fail-providers` (see below). |

### Model catalog

[`config/models.json`](config/models.json) maps a caller-visible model name to an ordered
fallback chain with per-target prices. It carries a `priced_at` date and source URLs, and
is the **cost source of truth** — if it drifts from the provider's real prices, every
cost number the gateway reports is wrong. Model IDs in it are verified against
`GET /v1/models` on the provider, not against provider docs: Groq's published docs listed
Llama models that no longer exist on the account. A model with no published per-token
price is deliberately **not** listed, because an unpriced model would silently bill zero.

**The gateway re-checks this itself at boot.** For each provider the catalog routes to, it
fetches that provider's model list and warns about anything the catalog references that the
provider no longer offers, exposing the result at `GET /admin/stats`:

```json
"reconciliation": {
  "status": "drift",
  "providers": [{ "provider": "groq", "status": "drift", "missing": ["llama-3.3-70b-versatile"] }]
}
```

It is advisory, never fatal: an unreachable provider reports `unverified` rather than
`drift`, and a provider with no credential is never called, so a network blip cannot block a
deploy. Adding a provider is a config change:

```json
"my-route": {
  "description": "…",
  "targets": [
    { "provider": "groq", "model": "openai/gpt-oss-120b",
      "input_usd_per_mtok": 0.15, "output_usd_per_mtok": 0.60,
      "context_window": 131072, "default_max_tokens": 2048 },
    { "provider": "mock", "model": "mock-echo",
      "input_usd_per_mtok": 0, "output_usd_per_mtok": 0,
      "context_window": 131072, "default_max_tokens": 2048 }
  ]
}
```

`groq`, `openai` and `ollama` all share one OpenAI-compatible adapter (they differ only
in base URL, credential and one field name). `anthropic` has its own adapter because the
Messages API is a genuinely different schema.

---

## Deploying to Render

Free web service + free Neon Postgres, no card.

1. **Postgres** — create a free project at [neon.tech](https://neon.tech), copy the
   pooled connection string (ends `?sslmode=require`).
2. **Push** this repo to GitHub.
3. **Render** → New → Blueprint → pick the repo. It reads [`render.yaml`](render.yaml).
4. **Set the secrets** in the Render dashboard (they are `sync: false` in the blueprint,
   so they are never in git):
   - `ADMIN_TOKEN` — `openssl rand -base64 32`
   - `GROQ_API_KEY`
   - `DATABASE_URL` — the Neon string
   - optionally `ANTHROPIC_API_KEY`
5. Deploy. Tables are created on boot; there is no migration step.
6. Verify:
   ```bash
   ./scripts/smoke.sh https://your-service.onrender.com "$ADMIN_TOKEN"
   ```

> Render's free tier spins down when idle — the first request after a pause is slow.
> Free instances also have ephemeral disk, which is why production state lives in
> Postgres rather than SQLite.

---

## Demonstrating fallback on a live URL

With `ALLOW_FAULT_INJECTION=true`, a request header forces named providers to fail so the
chain can be exercised without waiting for a real outage:

```bash
curl -s -X POST "$BASE/v1/chat/completions" \
  -H "Authorization: Bearer sk-gw-…" -H 'Content-Type: application/json' \
  -H 'x-gateway-fail-providers: groq' \
  -d '{"model":"gateway-cheap","messages":[{"role":"user","content":"hi"}]}' \
  | jq '.gateway | {served_provider, fallback_used, attempts}'
# { "served_provider": "mock", "fallback_used": true, "attempts": 3 }
```

It can only *cause* failures — it cannot bypass auth, budgets or logging. Default off.

---

## Layout

```
src/
  server.ts        Fastify app, one error handler for the whole service
  routes/          chat · usage · admin · meta (health, models)
  auth.ts          key generation, SHA-256 + timing-safe compare
  dispatch.ts      fallback engine: classify → retry → walk chain → deadline
  breaker.ts       per-target circuit breaker
  catalog.ts       model routes + worst-case pricing for reservations
  pricing.ts       integer micro-USD arithmetic
  tokens.ts        pre-flight estimate (reservations only; billing uses real usage)
  cache.ts         optional exact-match response cache
  reconcile.ts     boot-time catalog-vs-provider drift check
  providers/       openai-compat (groq/openai/ollama) · anthropic · mock
  store/           interface + sqlite (node:sqlite) + postgres (pg)
config/models.json routes, fallback chains, prices
test/              38 tests: budget + concurrency, fallback, auth, ledger, cost math,
                   catalog drift, and Postgres CAS (skipped without DATABASE_URL)
scripts/smoke.sh   end-to-end verification against a running instance
```

Runtime dependencies: `fastify`, `zod`, `pino`, `pg`, `openai`, `@anthropic-ai/sdk`.
No native modules — SQLite is Node 24's built-in `node:sqlite`.
