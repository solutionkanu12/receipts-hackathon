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
const BTL_MODEL = 'btl-2';
const ESCALATION_MODEL = 'gpt-5-5';
const ESCALATION_KEYWORDS = ['refund', 'cancel', 'complaint', 'lawyer', 'manager', 'angry', 'furious'];

const SYSTEM_PROMPT = 'You are a support assistant for a small online retailer. Return policy: unused items can be returned within 30 days with a receipt.';

const questionCache = new Map();

app.post('/api/chat', async (req, res) => {
  const { message } = req.body || {};

  if (typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ error: 'message is required' });
  }

  const normalized = message.trim().toLowerCase();
  const isEscalated = ESCALATION_KEYWORDS.some((keyword) => normalized.includes(keyword));

  if (!isEscalated && questionCache.has(normalized)) {
    return res.json({
      reply: questionCache.get(normalized),
      model: 'cache',
      status: 'CACHE_HIT',
      usage: null,
    });
  }

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

    if (!isEscalated) {
      questionCache.set(normalized, reply);
    }

    res.json({
      reply,
      model: data.model,
      status: isEscalated ? 'ESCALATED' : 'ROUTED',
      usage: data.usage,
    });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Receipts server running on http://localhost:${PORT}`);
});
