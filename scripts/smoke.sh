#!/usr/bin/env bash
set -euo pipefail
BASE="${1:-http://localhost:8080}"
ADMIN="${2:-${ADMIN_TOKEN:?set ADMIN_TOKEN or pass as arg 2}}"
MODEL="${3:-mock-echo}"
DRAIN_MODEL="${4:-mock-priced}"
say() { printf '\n\033[1m== %s\033[0m\n' "$1"; }

say "health"
curl -fsS "$BASE/health"; echo

say "models"
curl -fsS "$BASE/v1/models" | jq -r '.data[] | "\(.id)  <- \(.gateway.fallback_chain | map(.provider+"/"+.model) | join(" -> "))"'

say "create a virtual key with a \$0.01 budget"
CREATED=$(curl -fsS -X POST "$BASE/admin/keys" \
  -H "Authorization: Bearer $ADMIN" -H 'Content-Type: application/json' \
  -d '{"name":"smoke test","budget_usd":0.01}')
KEY=$(echo "$CREATED" | jq -r .key)
KEY_ID=$(echo "$CREATED" | jq -r .id)
echo "key_id=$KEY_ID  key=${KEY:0:14}…"

say "chat completion via model '$MODEL'"
curl -fsS -X POST "$BASE/v1/chat/completions" \
  -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d "{\"model\":\"$MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"Reply with exactly: pong\"}],\"max_tokens\":512}" \
  | jq '{content: .choices[0].message.content, model, usage, gateway}'

say "unauthenticated request is refused"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/v1/chat/completions" \
  -H 'Content-Type: application/json' -d '{"model":"mock-echo","messages":[]}')
echo "HTTP $code (expect 401)"

say "forced provider failure -> fallback (needs ALLOW_FAULT_INJECTION=true)"
curl -s -X POST "$BASE/v1/chat/completions" \
  -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -H 'x-gateway-fail-providers: groq' \
  -d '{"model":"gateway-cheap","messages":[{"role":"user","content":"hi"}],"max_tokens":512}' \
  | jq '{served: .gateway.served_provider, fallback: .gateway.fallback_used, attempts: .gateway.attempts}'

say "own usage"
curl -fsS "$BASE/v1/usage" -H "Authorization: Bearer $KEY" \
  | jq '{spent_usd: .key.spent_usd, remaining_usd: .key.remaining_usd, requests: .usage.requests}'

say "drain a deliberately tiny budget until it blocks (model: $DRAIN_MODEL)"
TINY=$(curl -fsS -X POST "$BASE/admin/keys" \
  -H "Authorization: Bearer $ADMIN" -H 'Content-Type: application/json' \
  -d '{"name":"smoke drain","budget_usd":0.0005}')
TINY_KEY=$(echo "$TINY" | jq -r .key)
TINY_ID=$(echo "$TINY" | jq -r .id)
for i in $(seq 1 40); do
  st=$(curl -s -o /tmp/smoke_out -w '%{http_code}' -X POST "$BASE/v1/chat/completions" \
    -H "Authorization: Bearer $TINY_KEY" -H 'Content-Type: application/json' \
    -d "{\"model\":\"$DRAIN_MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"count to five\"}],\"max_tokens\":64}")
  if [ "$st" = "402" ]; then echo "blocked after $((i-1)) successful requests:"; jq -c .error /tmp/smoke_out; break; fi
  [ "$i" = "40" ] && echo "note: budget not exhausted in 40 requests"
done

say "20 concurrent requests on the now-exhausted key must all be refused cleanly"
for i in $(seq 1 20); do
  curl -s -o /dev/null -w '%{http_code}\n' -X POST "$BASE/v1/chat/completions" \
    -H "Authorization: Bearer $TINY_KEY" -H 'Content-Type: application/json' \
    -d "{\"model\":\"$DRAIN_MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}" &
done | sort | uniq -c
wait

say "drained key: spend must not exceed its cap"
curl -fsS "$BASE/admin/usage?key_id=$TINY_ID" -H "Authorization: Bearer $ADMIN" \
  | jq '{budget_micro_usd: .key.budget_micro_usd, spent_micro_usd: .key.spent_micro_usd, reserved_micro_usd: .key.reserved_micro_usd, ok: .usage.ok_requests, blocked: .usage.blocked_requests}'
curl -fsS "$BASE/admin/usage?key_id=$TINY_ID" -H "Authorization: Bearer $ADMIN" \
  | jq -e '.key.spent_micro_usd <= .key.budget_micro_usd and .key.reserved_micro_usd == 0' >/dev/null \
  && echo "OK — never overspent, no reservation leaked"

say "final spend for the main key (admin view)"
curl -fsS "$BASE/admin/usage?key_id=$KEY_ID" -H "Authorization: Bearer $ADMIN" \
  | jq '{spent_usd: .key.spent_usd, budget_usd: .key.budget_usd, usage: {requests: .usage.requests, ok: .usage.ok_requests, blocked: .usage.blocked_requests}, by_model}'

say "spend never exceeded the cap"
curl -fsS "$BASE/admin/usage?key_id=$KEY_ID" -H "Authorization: Bearer $ADMIN" \
  | jq -e '.key.spent_micro_usd <= .key.budget_micro_usd' >/dev/null && echo "OK — invariant holds"
