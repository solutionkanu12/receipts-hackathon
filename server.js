require('dotenv').config();
const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Simple health check - confirms the server is actually running,
// separate from the static frontend.
app.get('/api/health', (req, res) => {
  res.json({ ok: true, service: 'receipts-backend' });
});

const BTL_API_URL = 'https://api.badtheorylabs.com/v1/chat/completions';
const BTL_PRICING_URL = 'https://api.badtheorylabs.com/v1/account/pricing';
const BTL_MODEL = 'btl-2';
const ESCALATION_MODEL = 'gpt-5-5';
const ESCALATION_KEYWORDS = ['refund', 'cancel', 'complaint', 'lawyer', 'manager', 'angry', 'furious'];

const SYSTEM_PROMPT = 'You are a support assistant for a small online retailer. Return policy: unused items can be returned within 30 days with a receipt.';

const questionCache = new Map();
const pricingByModel = new Map();

// Some models are billed at an explicit per-token rate; others (shared_savings)
// only publish a benchmark price range, so we use the midpoint as the best
// available per-token estimate.
async function loadPricing() {
  const res = await fetch(BTL_PRICING_URL, {
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

  const isEscalated = ESCALATION_KEYWORDS.some((keyword) => normalized.includes(keyword));

  try {
    const btlRes = await fetch(BTL_API_URL, {
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

    const data = await btlRes.json();

    if (!btlRes.ok) {
      return res.status(btlRes.status).json({ error: data.error || data });
    }

    const reply = data.choices?.[0]?.message?.content;

    questionCache.set(normalized, { reply, escalated: isEscalated });

    res.json({
      reply,
      model: data.model,
      status: isEscalated ? 'ESCALATED' : 'ROUTED',
      usage: data.usage,
      cost: computeCost(data.model, data.usage),
    });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

loadPricing()
  .catch((err) => console.error('Failed to load BTL pricing:', err.message))
  .finally(() => {
    app.listen(PORT, () => {
      console.log(`Receipts server running on http://localhost:${PORT}`);
    });
  });
