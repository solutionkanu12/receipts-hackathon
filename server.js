require('dotenv').config();
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { OAuth2Client } = require('google-auth-library');

const app = express();
const PORT = process.env.PORT || 3000;

// Render (and most hosts) terminate TLS at a proxy and forward plain HTTP,
// setting x-forwarded-proto. Without this, req.secure is always false behind
// the proxy, which would make the session cookie's `secure` flag wrong.
app.set('trust proxy', 1);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Simple health check - confirms the server is actually running,
// separate from the static frontend.
app.get('/api/health', (req, res) => {
  res.json({ ok: true, service: 'receipts-backend' });
});

const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

// ---------- sessions ----------
// Minimal signed-cookie session, no extra dependency: HMAC-SHA256 over a
// JSON payload using the existing SESSION_SECRET. Not a JWT, just enough to
// prove "this cookie was issued by us and hasn't expired or been tampered with."
const SESSION_COOKIE_NAME = 'receipts_session';
const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function signSessionPayload(payloadB64) {
  return crypto.createHmac('sha256', process.env.SESSION_SECRET).update(payloadB64).digest('base64url');
}

function createSessionToken(email) {
  const payloadB64 = Buffer.from(JSON.stringify({ email, exp: Date.now() + SESSION_MAX_AGE_MS })).toString('base64url');
  return `${payloadB64}.${signSessionPayload(payloadB64)}`;
}

function verifySessionToken(token) {
  if (typeof token !== 'string' || !token.includes('.')) return null;

  const [payloadB64, signature] = token.split('.');
  const expected = signSessionPayload(payloadB64 || '');
  const sigBuf = Buffer.from(signature || '', 'base64url');
  const expectedBuf = Buffer.from(expected, 'base64url');

  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
    return null;
  }

  try {
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
    if (typeof payload.exp !== 'number' || Date.now() > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

function parseCookies(req) {
  const header = req.headers.cookie;
  const cookies = {};
  if (!header) return cookies;
  header.split(';').forEach((pair) => {
    const idx = pair.indexOf('=');
    if (idx === -1) return;
    cookies[pair.slice(0, idx).trim()] = decodeURIComponent(pair.slice(idx + 1).trim());
  });
  return cookies;
}

function requireSession(req, res, next) {
  const token = parseCookies(req)[SESSION_COOKIE_NAME];
  const session = token && verifySessionToken(token);

  if (!session) {
    return res.status(401).json({ error: 'sign in required' });
  }

  req.session = session;
  next();
}

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

    res.cookie(SESSION_COOKIE_NAME, createSessionToken(payload.email), {
      httpOnly: true,
      sameSite: 'lax',
      secure: req.secure,
      maxAge: SESSION_MAX_AGE_MS,
      path: '/',
    });

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

const CRITIC_SYSTEM_PROMPT = 'Is this answer safe and confident to send to a customer, or should a human review it? Reply with EXACTLY one word: yes or hold.';

// Real BTL call, cheap model - a second-guess pass on a generated ESCALATED
// answer before it reaches the customer. Fails safe: anything that isn't a
// clean "yes" (including a failed call) blocks the send.
async function criticCheck(message, reply) {
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
          { role: 'system', content: CRITIC_SYSTEM_PROMPT },
          { role: 'user', content: `Customer message: "${message}"\n\nProposed answer: "${reply}"` },
        ],
      }),
    });

    const data = await res.json();

    if (!res.ok) {
      console.error('BTL critic call rejected:', data && data.error);
      return { approved: false, cost: null };
    }

    const raw = (data.choices?.[0]?.message?.content || '').trim().toLowerCase();
    const approved = raw === 'yes';

    return { approved, cost: computeCost(data.model, data.usage) };
  } catch (err) {
    console.error('BTL critic call failed:', err.message);
    return { approved: false, cost: null };
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
const CACHE_MAX_SIZE = 500;

// Normalizes trivial formatting differences (case, extra whitespace, trailing
// punctuation) so near-identical phrasings of the same question still hit the
// cache. This is NOT paraphrase/semantic matching - BTL has no embeddings
// endpoint available, so that's a deliberate scope limit here, not an oversight.
function normalizeForCache(message) {
  return message
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[?!.]+$/, '');
}

// Simple LRU cap: only ever called for routine/ROUTED answers (see /api/chat -
// ESCALATED and HELD results are never written here, since a stale cached
// answer resurfacing on someone else's refund complaint or legal threat is
// the one place a wrong cache hit does real damage). Evicts the oldest entry
// once over the cap so a long-running host can't grow this unbounded.
function cacheSet(key, value) {
  if (questionCache.has(key)) questionCache.delete(key);
  questionCache.set(key, value);
  if (questionCache.size > CACHE_MAX_SIZE) {
    questionCache.delete(questionCache.keys().next().value);
  }
}

const pricingByModel = new Map();

// Models priced with explicit_sell_rates give an exact billed cost. Models
// priced only from a shared_savings benchmark range give a midpoint estimate,
// not an exact rate - tracked here so the UI can label those costs `est.`
// instead of presenting them as an exact billed number.
const estimatedPricingModels = new Set();

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
    let isEstimate = false;

    if (explicit?.pricing_model === 'explicit_sell_rates') {
      inputPerMtok = explicit.input_per_mtok;
      outputPerMtok = explicit.output_per_mtok;
    } else if (benchmark) {
      inputPerMtok = (benchmark.input_per_mtok_min + benchmark.input_per_mtok_max) / 2;
      outputPerMtok = (benchmark.output_per_mtok_min + benchmark.output_per_mtok_max) / 2;
      isEstimate = true;
    }

    if (inputPerMtok != null && outputPerMtok != null) {
      pricingByModel.set(entry.id, { inputPerMtok, outputPerMtok });
      if (isEstimate) {
        estimatedPricingModels.add(entry.id);
      } else {
        estimatedPricingModels.delete(entry.id);
      }
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

app.post('/api/chat', requireSession, async (req, res) => {
  const { message } = req.body || {};

  if (typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ error: 'message is required' });
  }

  const normalized = normalizeForCache(message);

  // Cache check runs first, before any classification call - a cache hit can
  // only ever be a previously ROUTED (routine) answer, since ESCALATED and
  // HELD results are never written to this cache (see below), so no
  // re-classification is needed.
  if (questionCache.has(normalized)) {
    const cached = questionCache.get(normalized);
    return res.json({
      reply: cached.reply,
      model: 'cache',
      status: 'CACHE_HIT',
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

  // Content filter, truncation, or any other reason the model returned no
  // usable text - never cache or display this as if it were a real answer.
  if (typeof reply !== 'string' || !reply.trim()) {
    console.error('BTL chat response had no usable content:', JSON.stringify(data));
    return res.status(502).json({ error: 'the model returned an empty response, please try again' });
  }

  const cost = computeCost(data.model, data.usage);
  // gpt-5-5 is priced from a shared_savings benchmark range, so its cost is a
  // midpoint estimate, not an exact billed number - flagged here so the UI
  // can label it `est.` instead of presenting it as an exact rate like btl-2.
  const costIsEstimate = estimatedPricingModels.has(data.model);

  if (isEscalated) {
    const { approved, cost: criticCost } = await criticCheck(message, reply);

    if (!approved) {
      // Critic held it - the generated answer is discarded, never cached,
      // never sent. The classification + generation + critic calls all
      // really happened though, so their real cost is still shown, not
      // hidden just because the answer itself didn't go out.
      return res.json({
        reply: 'This needs a human — flagged, not auto-answered.',
        model: '—',
        status: 'HELD',
        usage: null,
        cost: 0,
        routingCost,
        generationCost: cost,
        generationCostIsEstimate: costIsEstimate,
        criticCost,
        reason: 'low confidence',
      });
    }

    // ESCALATED answers are never cached - a stale answer resurfacing for a
    // different user on a refund complaint is the one place a wrong cache
    // hit does real damage, so every sensitive question is re-run in full.
    return res.json({
      reply,
      model: data.model,
      status: 'ESCALATED',
      usage: data.usage,
      cost,
      costIsEstimate,
      routingCost,
      criticCost,
    });
  }

  cacheSet(normalized, { reply });

  res.json({
    reply,
    model: data.model,
    status: 'ROUTED',
    usage: data.usage,
    cost,
    costIsEstimate,
    routingCost,
  });
});

app.get('/api/usage', requireSession, async (req, res) => {
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

// Catch-all error handler - registered after every route so it also catches
// errors thrown inside route handlers, not just express.json()'s body-parse
// failures (a 4-arg middleware only works as a catch-all when it comes last).
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed' || err instanceof SyntaxError) {
    return res.status(400).json({ error: 'malformed JSON in request body' });
  }
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'something went wrong' });
});

loadPricing()
  .catch((err) => console.error('Failed to load BTL pricing:', err.message))
  .finally(() => {
    app.listen(PORT, () => {
      console.log(`Receipts server listening on port ${PORT}`);
    });
  });
