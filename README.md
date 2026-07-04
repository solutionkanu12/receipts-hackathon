# Receipts

The AI support bot that shows its work. Built on [BTL Runtime](https://www.badtheorylabs.com/runtime) for the BTL Runtime Hackathon (Jul 3–5, 2026).

Every reply comes with a live ledger entry showing which model answered, whether it was served free from cache, or escalated to a stronger model — and the real cost of that message.

## Why

AI support bots are a black box: you don't know what they cost per conversation, and one model answers everything, routine or sensitive. Receipts makes routing and cost visible, live, using BTL Runtime's multi-provider gateway and caching as the actual product feature, not background plumbing.

## Status

Built incrementally, verified at each step with real API calls — nothing in this repo is mocked.

- [x] Real BTL Runtime chat completions (`POST /api/chat`)
- [x] Duplicate-question cache detection (repeat questions cost $0, no second API call)
- [ ] Escalation routing to a stronger model for sensitive questions
- [ ] Real per-message cost from BTL's pricing data
- [ ] Live usage/savings panel (`GET /v1/usage/summary`)
- [ ] Google sign-in with server-side token verification
- [ ] Deployed to a public URL

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

Visit `http://localhost:3000`.

## Environment variables

| Variable | Required for |
|---|---|
| `BTL_API_KEY` | Any chat call |
| `SESSION_SECRET` | Signing session tokens (any random string) |
| `GOOGLE_CLIENT_ID` | Sign-in (added in a later step) |

## API routes

| Route | Does |
|---|---|
| `GET /api/health` | Health check |
| `POST /api/chat` | Sends `{message}`, returns `{reply, model, status, usage}` — routes to cache, default model, or an escalated model depending on the question |

## Author

Built by [solutionkanu12](https://github.com/solutionkanu12) — sole author and contributor.
