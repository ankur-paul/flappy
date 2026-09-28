/* ============================================================================
   score-email.js — after a run ends, offer to email the result.

   The browser never sees the Brevo credentials: it POSTs the run summary to
   /api/score-email and the Express server in server.js talks to Brevo.
   ========================================================================= */
(function () {
  'use strict';

  const ENDPOINT = '/api/score-email';

  const panel = document.getElementById('mailpanel');
  const form = document.getElementById('mail-form');
  const nameEl = document.getElementById('mail-name');
  const toEl = document.getElementById('mail-to');
  const statusEl = document.getElementById('mail-status');
  const sendBtn = document.getElementById('mail-send');
  const skipBtn = document.getElementById('mail-skip');
  const statsEl = document.getElementById('mail-stats');
  const scoreEl = document.getElementById('mail-score');
  const bestEl = document.getElementById('mail-best');
  const timeEl = document.getElementById('mail-time');

  const Store = {
    get(k, d) { try { const v = localStorage.getItem('ff_' + k); return v === null ? d : v; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('ff_' + k, v); } catch (e) { /* private mode */ } }
  };

  let summary = null;
  let sending = false;

  /** 47.3s under a minute, then 1:07 */
  function formatTime(sec) {
    if (sec < 60) return sec.toFixed(1) + 's';
    const m = Math.floor(sec / 60);
    return m + ':' + String(Math.floor(sec % 60)).padStart(2, '0');
  }

  function setStatus(msg, kind) {
    statusEl.textContent = msg || '';
    statusEl.classList.toggle('is-error', kind === 'error');
    statusEl.classList.toggle('is-ok', kind === 'ok');
  }

  function open(data) {
    summary = data;
    scoreEl.textContent = String(data.score);
    bestEl.textContent = String(data.best);
    timeEl.textContent = formatTime(data.seconds);
    statsEl.classList.toggle('is-best', !!data.newBest);

    nameEl.value = Store.get('playerName', '');
    toEl.value = Store.get('playerEmail', '');
    nameEl.setAttribute('aria-invalid', 'false');
    toEl.setAttribute('aria-invalid', 'false');
    setStatus(data.newBest ? 'New high score — worth sharing!' : '');
    sendBtn.disabled = false;
    sendBtn.textContent = 'Send my score';
    sending = false;

    panel.classList.remove('hidden');
    // don't steal focus on touch devices, where it pops the keyboard over the game
    if (!matchMedia('(hover: none)').matches) (nameEl.value ? toEl : nameEl).focus();
  }

  function close() {
    panel.classList.add('hidden');
  }

  // The dialog is opt-in: the canvas GAME OVER card is left uncovered until the
  // player taps its "Email score" button (or presses E), which fires this.
  window.Flappy.on('emailrequest', (data) => {
    if (!panel.classList.contains('hidden')) return; // already up
    open(data);
  });
  window.Flappy.on('restart', close);

  // Escape backs out of the dialog rather than reaching the game's pause key
  window.addEventListener('keydown', (e) => {
    if (panel.classList.contains('hidden')) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
  }, true);

  // clear a validation complaint as soon as the field is being fixed
  for (const el of [nameEl, toEl]) {
    el.addEventListener('input', () => {
      if (el.getAttribute('aria-invalid') === 'true') {
        el.setAttribute('aria-invalid', 'false');
        if (statusEl.classList.contains('is-error')) setStatus('');
      }
    });
  }

  skipBtn.addEventListener('click', close);

  // tapping the dimmed backdrop (but not the card) goes back to the results
  panel.addEventListener('pointerdown', (e) => {
    if (e.target === panel) close();
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (sending || !summary) return;

    const playerName = nameEl.value.trim();
    const to = toEl.value.trim();
    const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(to);

    nameEl.setAttribute('aria-invalid', String(!playerName));
    toEl.setAttribute('aria-invalid', String(!emailOk));
    if (!playerName) { setStatus('Who should we say played?', 'error'); nameEl.focus(); return; }
    if (!emailOk) { setStatus('That email address looks off.', 'error'); toEl.focus(); return; }

    Store.set('playerName', playerName);
    Store.set('playerEmail', to);

    sending = true;
    sendBtn.disabled = true;
    sendBtn.textContent = 'Sending…';
    setStatus('Sending…');

    try {
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(Object.assign({ to, playerName }, summary))
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || 'Send failed (' + res.status + ')');

      setStatus('Sent to ' + to + ' ✅', 'ok');
      sendBtn.textContent = 'Sent!';
      setTimeout(close, 1400);
    } catch (err) {
      sending = false;
      sendBtn.disabled = false;
      sendBtn.textContent = 'Try again';
      setStatus(err.message, 'error');
    }
  });
})();
