require('dotenv').config();
const express = require('express');
const path = require('path');
const { OAuth2Client } = require('google-auth-library');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed' || err instanceof SyntaxError) {
    return res.status(400).json({ error: 'malformed JSON in request body' });
  }
  next(err);
});
app.use(express.static(path.join(__dirname, 'public')));

// Simple health check - confirms the server is actually running,
// separate from the static frontend.
app.get('/api/health', (req, res) => {
  res.json({ ok: true, service: 'receipts-backend' });
});

const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

const UPSTREAM_TIMEOUT_MS = 20000;

// Bounds any upstream call so a hung network request can never hang this
// server forever - critical at boot too, since loadPricing() gates app.listen().
function withTimeout(promise, ms, timeoutMessage) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error(timeoutMessage), { name: 'TimeoutError' })), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function fetchWithTimeout(url, options = {}, timeoutMs = UPSTREAM_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

app.post('/api/auth/verify', async (req, res) => {
  const { credential } = req.body || {};

  if (typeof credential !== 'string' || !credential) {
    return res.status(401).json({ error: 'credential is required' });
  }

  try {
    const ticket = await withTimeout(
      googleClient.verifyIdToken({ idToken: credential, audience: process.env.GOOGLE_CLIENT_ID }),
      UPSTREAM_TIMEOUT_MS,
      'Google verification timed out'
    );
    const payload = ticket.getPayload();

    res.json({
      name: payload.name,
      email: payload.email,
      picture: payload.picture,
      verified: true,
    });
  } catch (err) {
    console.error('Google token verification failed:', err.message);
    res.status(401).json({ error: 'invalid or expired credential' });
  }
});

const BTL_API_URL = 'https://api.badtheorylabs.com/v1/chat/completions';
const BTL_PRICING_URL = 'https://api.badtheorylabs.com/v1/account/pricing';
const BTL_USAGE_URL = 'https://api.badtheorylabs.com/v1/usage/summary';
const BTL_MODEL = 'btl-2';
const ESCALATION_MODEL = 'gpt-5-5';

const SYSTEM_PROMPT = 'You are a support assistant for a small online retailer. Return policy: unused items can be returned within 30 days with a receipt.';

const CLASSIFY_SYSTEM_PROMPT = 'Classify a customer support message. Reply with EXACTLY one word: routine, sensitive, or hold. routine = normal questions (orders, returns policy, shipping). sensitive = refunds, cancellations, complaints, or an upset/legal tone. hold = must not be auto-answered by a bot: threats, legal action, self-harm, or anything unsafe to answer without a human. Output only the single word.';

// Real BTL call, cheap model - the routing decision itself, replacing keyword matching.
// Fails safe (toward the more careful "sensitive" path), never fail-cheap: any
// unparseable output or upstream failure defaults to "sensitive", not "routine".
async function classify(message) {
  try {
    const res = await fetchWithTimeout(BTL_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.BTL_API_KEY}`,
      },
      body: JSON.stringify({
        model: BTL_MODEL,
        messages: [
          { role: 'system', content: CLASSIFY_SYSTEM_PROMPT },
          { role: 'user', content: message },
        ],
      }),
    });

    const data = await res.json();

    if (!res.ok) {
      console.error('BTL classification call rejected:', data && data.error);
      return { classification: 'sensitive', cost: null };
    }

    const raw = (data.choices?.[0]?.message?.content || '').trim().toLowerCase();
    const classification = ['routine', 'sensitive', 'hold'].includes(raw) ? raw : 'sensitive';

    return { classification, cost: computeCost(data.model, data.usage) };
  } catch (err) {
    console.error('BTL classification call failed:', err.message);
    return { classification: 'sensitive', cost: null };
  }
}

// Display-only heuristic for which reason label to show on a HELD receipt.
// The real hold decision already came from classify() above - this just
// picks a human-readable reason for the message the model already flagged.
const SELF_HARM_WORDS = ['suicide', 'kill myself', 'hurt myself', 'self-harm', 'self harm', 'end my life', 'want to die'];
const LEGAL_THREAT_WORDS = ['lawyer', 'attorney', 'sue', 'lawsuit', 'legal action', 'threat', 'kill you', 'hurt you'];

function heldReasonLabel(message) {
  const lower = message.toLowerCase();
  if (SELF_HARM_WORDS.some((w) => lower.includes(w))) return 'distress';
  if (LEGAL_THREAT_WORDS.some((w) => lower.includes(w))) return 'legal / threat';
  return 'low confidence';
}

const questionCache = new Map();
const pricingByModel = new Map();

// Some models are billed at an explicit per-token rate; others (shared_savings)
// only publish a benchmark price range, so we use the midpoint as the best
// available per-token estimate.
async function loadPricing() {
  const res = await fetchWithTimeout(BTL_PRICING_URL, {
    headers: { Authorization: `Bearer ${process.env.BTL_API_KEY}` },
  });
  const data = await res.json();

  for (const entry of data.data || []) {
    const explicit = entry.pricing;
    const benchmark = entry.benchmark_pricing;

    let inputPerMtok;
    let outputPerMtok;

    if (explicit?.pricing_model === 'explicit_sell_rates') {
      inputPerMtok = explicit.input_per_mtok;
      outputPerMtok = explicit.output_per_mtok;
    } else if (benchmark) {
      inputPerMtok = (benchmark.input_per_mtok_min + benchmark.input_per_mtok_max) / 2;
      outputPerMtok = (benchmark.output_per_mtok_min + benchmark.output_per_mtok_max) / 2;
    }

    if (inputPerMtok != null && outputPerMtok != null) {
      pricingByModel.set(entry.id, { inputPerMtok, outputPerMtok });
    }
  }
}

function computeCost(model, usage) {
  const price = pricingByModel.get(model);
  if (!price || !usage) return null;

  const inputCost = (usage.prompt_tokens / 1e6) * price.inputPerMtok;
  const outputCost = (usage.completion_tokens / 1e6) * price.outputPerMtok;
  return inputCost + outputCost;
}

app.post('/api/chat', async (req, res) => {
  const { message } = req.body || {};

  if (typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ error: 'message is required' });
  }

  const normalized = message.trim().toLowerCase();

  // Cache check runs first, before any classification call - a cache hit can
  // only ever be a previously routine/sensitive answer (hold results are
  // never written to this cache below), so no re-classification is needed.
  if (questionCache.has(normalized)) {
    const cached = questionCache.get(normalized);
    return res.json({
      reply: cached.reply,
      model: 'cache',
      status: cached.escalated ? 'CACHE_HIT_ESCALATED' : 'CACHE_HIT',
      usage: null,
      cost: 0,
    });
  }

  const { classification, cost: routingCost } = await classify(message);

  if (classification === 'hold') {
    return res.json({
      reply: 'This needs a human — flagged, not auto-answered.',
      model: '—',
      status: 'HELD',
      usage: null,
      cost: 0,
      routingCost,
      reason: heldReasonLabel(message),
    });
  }

  const isEscalated = classification === 'sensitive';

  let btlRes;
  try {
    btlRes = await fetchWithTimeout(BTL_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.BTL_API_KEY}`,
      },
      body: JSON.stringify({
        model: isEscalated ? ESCALATION_MODEL : BTL_MODEL,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: message },
        ],
      }),
    });
  } catch (err) {
    console.error('BTL chat request failed:', err.message);
    const timedOut = err.name === 'AbortError';
    return res.status(timedOut ? 504 : 502).json({
      error: timedOut
        ? 'the model took too long to respond, please try again'
        : 'could not reach the model right now, please try again',
    });
  }

  let data;
  try {
    data = await btlRes.json();
  } catch (err) {
    console.error('BTL chat response was not valid JSON:', err.message);
    return res.status(502).json({ error: 'got an unreadable response from the model, please try again' });
  }

  if (!btlRes.ok) {
    return res.status(btlRes.status).json({ error: (data && data.error) || 'the model rejected the request' });
  }

  const reply = data.choices?.[0]?.message?.content;

  questionCache.set(normalized, { reply, escalated: isEscalated });

  res.json({
    reply,
    model: data.model,
    status: isEscalated ? 'ESCALATED' : 'ROUTED',
    usage: data.usage,
    cost: computeCost(data.model, data.usage),
    routingCost,
  });
});

app.get('/api/usage', async (req, res) => {
  let usageRes;
  try {
    usageRes = await fetchWithTimeout(BTL_USAGE_URL, {
      headers: { Authorization: `Bearer ${process.env.BTL_API_KEY}` },
    });
  } catch (err) {
    console.error('BTL usage request failed:', err.message);
    const timedOut = err.name === 'AbortError';
    return res.status(timedOut ? 504 : 502).json({
      error: timedOut
        ? 'usage summary took too long to respond, please try again'
        : 'could not reach the usage summary right now, please try again',
    });
  }

  let data;
  try {
    data = await usageRes.json();
  } catch (err) {
    console.error('BTL usage response was not valid JSON:', err.message);
    return res.status(502).json({ error: 'got an unreadable response from the usage summary, please try again' });
  }

  if (!usageRes.ok) {
    return res.status(usageRes.status).json({ error: (data && data.error) || 'the usage summary request failed' });
  }

  res.json(data);
});

loadPricing()
  .catch((err) => console.error('Failed to load BTL pricing:', err.message))
  .finally(() => {
    app.listen(PORT, () => {
      console.log(`Receipts server listening on port ${PORT}`);
    });
  });
