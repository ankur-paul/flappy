/* ============================================================================
   server.js — serves the game and relays score emails through Brevo.

   The Brevo API key stays here, server side. The browser only ever sees
   POST /api/score-email.
   ========================================================================= */
'use strict';

require('dotenv').config();
const path = require('path');
const express = require('express');

const app = express();
const PORT = process.env.PORT || 3000;

const BREVO_API_KEY = process.env.BREVO_API_KEY;
const FROM_EMAIL = process.env.BREVO_FROM_EMAIL;
const FROM_NAME = process.env.BREVO_FROM_NAME || 'Flappy Feathers';

const BREVO_ENDPOINT = 'https://api.brevo.com/v3/smtp/email';

app.use(express.json({ limit: '16kb' }));
// Locally Express serves public/; on Vercel the CDN serves it and this is a no-op.
app.use(express.static(path.join(__dirname, 'public')));

/* ------------------------------------------------------------------ helpers */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/** Non-negative integer, or fallback. Never trust the client's numbers. */
function int(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

function formatTime(sec) {
  if (sec < 60) return sec.toFixed(1) + 's';
  const m = Math.floor(sec / 60);
  return m + ':' + String(Math.floor(sec % 60)).padStart(2, '0');
}

/* Simple in-memory throttle: this endpoint sends mail, so it should not be a
   free relay for anyone who finds the URL. */
const RATE_WINDOW_MS = 60 * 1000;
const RATE_MAX = 5;
const hits = new Map();

function rateLimited(ip) {
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((t) => now - t < RATE_WINDOW_MS);
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 5000) hits.clear(); // crude cap so the map cannot grow forever
  return recent.length > RATE_MAX;
}

/* ------------------------------------------------------------- email bodies */
function buildEmail(d) {
  const medal = d.medal ? d.medal[0].toUpperCase() + d.medal.slice(1) : 'None yet';
  const when = new Date(d.playedAt).toLocaleString('en-US', {
    dateStyle: 'medium', timeStyle: 'short'
  });

  const subject = d.newBest
    ? `🏆 ${d.playerName} set a new Flappy Feathers high score: ${d.score}`
    : `🐤 ${d.playerName} scored ${d.score} in Flappy Feathers`;

  const rows = [
    ['Player', d.playerName],
    ['Score this run', String(d.score)],
    ['High score', d.best + (d.newBest ? '  (new record!)' : '')],
    ['Time taken', d.timeText],
    ['Medal', medal],
    ['Coins collected', String(d.coins)],
    ['Best combo', '×' + d.bestCombo],
    ['Bird', d.bird],
    ['Played', when]
  ];

  const text =
    `${d.playerName} just finished a run of Flappy Feathers.\n\n` +
    rows.map(([k, v]) => `${k.padEnd(16)} ${v}`).join('\n') +
    `\n\n${d.newBest ? 'A brand new personal best — nicely flown!' : 'Fly again and beat it.'}\n`;

  const html = `<!doctype html>
<html><body style="margin:0;padding:24px;background:#f4f1ea;font-family:'Trebuchet MS',Verdana,sans-serif;color:#2b2140;">
  <table role="presentation" cellpadding="0" cellspacing="0" style="max-width:520px;margin:0 auto;background:#fff8ee;border-radius:16px;overflow:hidden;box-shadow:0 6px 18px rgba(0,0,0,.12);">
    <tr><td style="background:linear-gradient(90deg,#ffd45e,#f08a24);padding:22px 26px;">
      <div style="font-size:13px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:#7a4208;">Flappy Feathers</div>
      <div style="font-size:26px;font-weight:800;color:#5a2f04;margin-top:2px;">🐤 ${escapeHtml(d.playerName)} scored ${d.score}</div>
    </td></tr>
    ${d.newBest ? `<tr><td style="padding:14px 26px 0;"><div style="background:#f0679b;color:#fff;font-weight:800;font-size:14px;padding:9px 14px;border-radius:9px;text-align:center;">🏆 New high score!</div></td></tr>` : ''}
    <tr><td style="padding:18px 26px 26px;">
      <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="font-size:15px;">
        ${rows.map(([k, v]) => `<tr>
          <td style="padding:7px 0;color:#8a7fa8;font-weight:700;">${escapeHtml(k)}</td>
          <td style="padding:7px 0;text-align:right;font-weight:800;color:#4a3a6b;">${escapeHtml(v)}</td>
        </tr>`).join('')}
      </table>
      <p style="margin:20px 0 0;font-size:14px;color:#8a7fa8;text-align:center;">
        ${d.newBest ? 'A brand new personal best — nicely flown!' : 'Fly again and beat it.'}
      </p>
    </td></tr>
  </table>
</body></html>`;

  return { subject, text, html };
}

/* ------------------------------------------------------------------- route */
app.post('/api/score-email', async (req, res) => {
  if (!BREVO_API_KEY || !FROM_EMAIL) {
    return res.status(500).json({
      error: 'Email is not configured on the server (set BREVO_API_KEY and BREVO_FROM_EMAIL).'
    });
  }

  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  if (rateLimited(ip)) {
    return res.status(429).json({ error: 'Too many emails just now — try again in a minute.' });
  }

  const body = req.body || {};
  const to = String(body.to || '').trim();
  const playerName = String(body.playerName || '').trim().slice(0, 60);

  if (!EMAIL_RE.test(to) || to.length > 200) {
    return res.status(400).json({ error: 'That email address looks off.' });
  }
  if (!playerName) {
    return res.status(400).json({ error: 'Player name is required.' });
  }

  const seconds = Math.max(0, Math.min(86400, Number(body.seconds) || 0));
  const data = {
    playerName,
    score: int(body.score, 0),
    best: int(body.best, 0),
    newBest: body.newBest === true,
    seconds,
    timeText: formatTime(seconds),
    coins: int(body.coins, 0),
    bestCombo: int(body.bestCombo, 1),
    medal: ['bronze', 'silver', 'gold', 'platinum', 'rainbow'].includes(body.medal) ? body.medal : null,
    bird: String(body.bird || 'Flappy').slice(0, 40),
    playedAt: Number.isFinite(Date.parse(body.playedAt)) ? body.playedAt : new Date().toISOString()
  };

  const { subject, text, html } = buildEmail(data);

  try {
    const brevo = await fetch(BREVO_ENDPOINT, {
      method: 'POST',
      headers: {
        'api-key': BREVO_API_KEY,
        'Content-Type': 'application/json',
        accept: 'application/json'
      },
      body: JSON.stringify({
        sender: { email: FROM_EMAIL, name: FROM_NAME },
        to: [{ email: to, name: playerName }],
        subject,
        textContent: text,
        htmlContent: html
      })
    });

    // Brevo answers 201 Created with { messageId }
    if (brevo.ok) return res.json({ ok: true });

    // ...and reports problems as { code, message }
    const detail = await brevo.text();
    let message = `Brevo returned ${brevo.status}`;
    try {
      const parsed = JSON.parse(detail);
      if (parsed.message) message = parsed.message;
    } catch (e) { /* not JSON, keep the status message */ }
    console.error('Brevo error', brevo.status, detail);
    return res.status(502).json({ error: message });
  } catch (err) {
    console.error('Brevo request failed', err);
    return res.status(502).json({ error: 'Could not reach the email service.' });
  }
});

// Vercel imports the app as a serverless function; `npm start` runs it directly.
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`🐤 Flappy Feathers on http://localhost:${PORT}`);
    if (!BREVO_API_KEY || !FROM_EMAIL) {
      console.warn('   ⚠️  BREVO_API_KEY / BREVO_FROM_EMAIL missing — score emails will fail.');
    }
  });
}

module.exports = app;
