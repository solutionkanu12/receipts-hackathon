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

// Real API routes (chat, usage, pricing, auth) get added here in
// later build steps. Nothing mocked lives in this file - if a route
// isn't wired to a real BTL/Google call yet, it doesn't exist yet.

app.listen(PORT, () => {
  console.log(`Receipts server running on http://localhost:${PORT}`);
});
