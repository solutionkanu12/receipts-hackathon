# Receipts

The AI support bot that shows its work. Built on [BTL Runtime](https://www.badtheorylabs.com/runtime) for the BTL Runtime Hackathon (Jul 3–5, 2026).

**Live: https://receipts-hackathon.onrender.com** — sign in with Google and try it.

Every reply comes with a live ledger entry showing which model answered, whether it was served free from cache, or escalated to a stronger model — and the real cost of that message.

## Why

AI support bots are a black box: you don't know what they cost per conversation, and one model answers everything, routine or sensitive. Receipts makes routing and cost visible, live, using BTL Runtime's multi-provider gateway and caching as the actual product feature, not background plumbing.

## How this uses BTL Runtime

Every part of the ledger is a real BTL Runtime call, not a simulation. Routine questions are routed to `btl-2`; messages that hit an escalation keyword (refund, cancel, complaint, lawyer, manager, angry, furious) are routed to `gpt-5-5` instead — real multi-provider routing based on message content, both through BTL's gateway. The cost shown on every message is computed from BTL's own `GET /v1/account/pricing`, not a hardcoded estimate. And the stats row on the ledger panel — requests, cache hits, savings vs. list price, average latency — is pulled live from BTL's own `GET /v1/usage/summary`, the same cache-tier and savings-mechanism telemetry BTL tracks internally, surfaced directly in the product UI instead of staying backend plumbing.

## Status

Built incrementally, verified at each step with real API calls — nothing in this repo is mocked.

- [x] Real BTL Runtime chat completions (`POST /api/chat`)
- [x] Duplicate-question cache detection (repeat questions cost $0, no second API call)
- [x] Escalation routing to a stronger model for sensitive questions
- [x] Real per-message cost from BTL's pricing data
- [x] Live usage/savings panel (`GET /api/usage`, proxying `GET /v1/usage/summary`)
- [x] Google sign-in with server-side token verification (`POST /api/auth/verify`)
- [x] Deployed to a public URL (https://receipts-hackathon.onrender.com)

## Stack

- Node.js + Express backend
- Vanilla HTML/CSS/JS frontend (no framework)
- BTL Runtime (`api.badtheorylabs.com/v1`) — the only model provider called, per the hackathon's one rule
- Google Identity Services for sign-in

## Running locally

```
npm install
cp .env.example .env   # fill in BTL_API_KEY at minimum
npm start
```

Visit `http://localhost:$PORT` (defaults to 3000 if `PORT` isn't set).

Live deployment: https://receipts-hackathon.onrender.com

## Environment variables

| Variable | Required for |
|---|---|
| `BTL_API_KEY` | Any chat call, pricing, and usage summary |
| `GOOGLE_CLIENT_ID` | Sign-in (client-side button + server-side token verification) |
| `PORT` | Which port the server listens on (most hosting platforms set this automatically) |
| `SESSION_SECRET` | Reserved for future session-signing — not currently read by any code |

## API routes

| Route | Does |
|---|---|
| `GET /api/health` | Health check |
| `POST /api/chat` | Sends `{message}`, returns `{reply, model, status, usage, cost}` — routes to cache, default model, or an escalated model depending on the question |
| `GET /api/usage` | Proxies BTL's live usage/savings summary |
| `POST /api/auth/verify` | Verifies a Google ID token server-side, returns `{name, email, picture, verified}` or 401 |

## Author

Built by [solutionkanu12](https://github.com/solutionkanu12) — sole author and contributor.
