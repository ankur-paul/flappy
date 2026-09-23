# 🐤 Flappy Feathers

A cute flappy-bird game — all art, sound and physics generated at runtime, no asset files.
When a run ends you can email the result (player name, score, high score and the time
the run took) via **Brevo**.

## Running it

```bash
npm install
cp .env.example .env    # then fill in your Brevo details
npm start               # http://localhost:3000
```

The game itself is plain static files, so `index.html` still works when opened directly —
only the score email needs the server.

## Email setup (Brevo)

Brevo's free tier is around 300 emails/day, needs no credit card and no domain of your
own, and will send to any recipient — which matters here, because players type in their
own address.

1. Create a v3 API key: <https://app.brevo.com/settings/keys/api>
2. Verify the address you want to send *from* (a single sender is enough; you don't need
   a whole domain): <https://app.brevo.com/senders/list>. Brevo rejects mail from an
   unverified sender.
3. Put both in `.env`:

   ```
   BREVO_API_KEY=xkeysib-xxxxxxxx
   BREVO_FROM_EMAIL=scores@yourdomain.com
   BREVO_FROM_NAME=Flappy Feathers
   ```

The API key is only ever read by `server.js`. The browser talks to `POST /api/score-email`
and never sees a credential. `.env` is gitignored — keep it that way.

### Swapping providers

Everything provider-specific lives in the `fetch` inside the `/api/score-email` handler
plus the three `BREVO_*` variables. Mailjet, Resend, Postmark and friends all take the
same shape — a JSON body with sender, recipient, subject and the two bodies — so a swap
is a dozen lines.

## How the score email works

| File | Role |
| --- | --- |
| `game.js` | Times each run and exposes `window.Flappy` (`on('gameover'\|'restart')`, `restart()`, `summary()`, `isOver()`) |
| `score-email.js` | Shows the overlay on game over, validates input, POSTs the summary |
| `index.html` / `styles.css` | The `#mailpanel` overlay markup and styling |
| `server.js` | Validates, rate-limits, and relays to `api.brevo.com/v3/smtp/email` |

**Timing.** The stopwatch starts on the flap that begins a run and stops the moment the
bird crashes — the death animation is not counted, and it does not tick while paused or
while the help panel is open.

**The overlay is opt-in.** The canvas GAME OVER card is never covered. It shows score,
high score, time and medal, and carries an "Email score" button; the dialog only opens
when that button is tapped (or **E** is pressed). Tapping anywhere else flies again, so
rapid retries are still a single tap and the dialog never gets in the way.

Closing the dialog — "Back to results", the backdrop, or **Esc** — always returns to the
results card rather than restarting; replaying is done from the card. Name and recipient
are remembered in `localStorage`, so later sends are one tap.

The button's rectangle lives in `MAIL_BTN` (`game.js`), shared by `drawOver()` and the
`mailBtnHit()` tap test so the drawn button and its touch target cannot drift apart.

### `POST /api/score-email`

```jsonc
{ "to": "you@example.com", "playerName": "Ankur", "score": 23, "best": 41,
  "newBest": false, "seconds": 67.4, "coins": 9, "bestCombo": 3,
  "medal": "gold", "bird": "Sunny", "playedAt": "2026-09-22T10:00:00.000Z" }
```

Replies `{"ok":true}`, or `{"error":"..."}` with status 400 (bad input), 429 (more than
5 sends a minute from one IP), 500 (server not configured) or 502 (Brevo refused).
Every field is re-validated server side and HTML-escaped before it reaches the email.

> ⚠️ The rate limit is in-memory, so it resets on restart and is per-process. An endpoint
> that emails arbitrary user-supplied addresses is the exact pattern providers shut
> accounts down for. Before putting this anywhere public, put a real limiter and some form
> of auth in front of it — or restrict it to a single fixed recipient.
