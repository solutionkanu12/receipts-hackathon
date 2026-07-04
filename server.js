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

const SYSTEM_PROMPT = 'You are a support assistant for a small online retailer. Return policy: unused items can be returned within 30 days with a receipt.';

app.post('/api/chat', async (req, res) => {
  const { message } = req.body || {};

  if (typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ error: 'message is required' });
  }

  try {
    const btlRes = await fetch(BTL_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.BTL_API_KEY}`,
      },
      body: JSON.stringify({
        model: BTL_MODEL,
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

    res.json({
      reply: data.choices?.[0]?.message?.content,
      model: data.model,
      usage: data.usage,
    });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Receipts server running on http://localhost:${PORT}`);
});
