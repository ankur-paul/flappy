/* ============================================================================
   Flappy Feathers — a cute, juicy flappy-bird game.
   Everything (art, sound, physics) is generated at runtime: no asset files.
   ========================================================================= */
(function () {
  'use strict';

  /* --------------------------------------------------------------- constants */
  const W = 480;              // logical canvas width
  const H = 720;              // logical canvas height
  const GROUND_H = 112;       // height of the scrolling ground strip
  const PLAY_H = H - GROUND_H; // playable sky height
  const PIPE_W = 68;
  const PIPE_SPACING = 208;   // horizontal distance between pipe centres
  const GRAVITY = 1750;
  const FLAP_V = -505;
  const MAX_FALL = 780;
  const BIRD_X = 148;
  const BIRD_R = 13;          // collision radius
  const TAU = Math.PI * 2;
  const DAY_LENGTH = 52;      // seconds for a full day→night→dawn cycle

  const STATE = { MENU: 0, READY: 1, PLAY: 2, DYING: 3, OVER: 4 };
  const MENU_BIRD_Y = 438;    // hero bird position on the title screen

  // game-over card geometry. Shared by drawOver() and the tap hit-test so the
  // drawn "Email score" button and its touch target can never drift apart.
  const OVER_H = 348;                          // card height
  const OVER_Y = (H - OVER_H) / 2 - 24;        // card top, once it has settled
  const MAIL_BTN = { x: -140, y: 296, w: 280, h: 42 };  // relative to card centre-top

  /* ------------------------------------------------------------------- utils */
  const rand = (a, b) => a + Math.random() * (b - a);
  const randInt = (a, b) => Math.floor(rand(a, b + 1));
  const pick = (arr) => arr[(Math.random() * arr.length) | 0];
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const ease = (t) => t * t * (3 - 2 * t);

  function hexToRgb(h) {
    const n = parseInt(h.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  function mixHex(a, b, t) {
    const A = hexToRgb(a), B = hexToRgb(b);
    return `rgb(${Math.round(lerp(A[0], B[0], t))},${Math.round(lerp(A[1], B[1], t))},${Math.round(lerp(A[2], B[2], t))})`;
  }
  function rgba(hex, a) {
    const c = hexToRgb(hex);
    return `rgba(${c[0]},${c[1]},${c[2]},${a})`;
  }
  function roundRect(ctx, x, y, w, h, r) {
    r = Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
  // 47.3s under a minute, then 1:07. Mirrored in score-email.js and server.js
  function formatRunTime(sec) {
    if (sec < 60) return sec.toFixed(1) + 's';
    return Math.floor(sec / 60) + ':' + String(Math.floor(sec % 60)).padStart(2, '0');
  }

  // deterministic pseudo-random for static scenery, so it never shimmers
  function hash(n) {
    const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
    return s - Math.floor(s);
  }

  /* --------------------------------------------------------------- persistence */
  const Store = {
    get(k, d) { try { const v = localStorage.getItem('ff_' + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('ff_' + k, JSON.stringify(v)); } catch (e) { /* private mode */ } }
  };

  /* --------------------------------------------------------------- sound (synth) */
  const Sfx = {
    ac: null, master: null, noise: null, muted: Store.get('mute', false),

    ensure() {
      if (this.ac) return true;
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return false;
      this.ac = new AC();
      this.master = this.ac.createGain();
      this.master.gain.value = 0.5;
      this.master.connect(this.ac.destination);
      // one shared noise buffer for whooshes and thuds
      const len = this.ac.sampleRate * 0.5;
      const buf = this.ac.createBuffer(1, len, this.ac.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
      this.noise = buf;
      return true;
    },
    resume() { if (this.ensure() && this.ac.state === 'suspended') this.ac.resume(); },

    tone(o) {
      if (this.muted || !this.ensure()) return;
      const ac = this.ac, t0 = ac.currentTime + (o.delay || 0);
      const osc = ac.createOscillator(), g = ac.createGain();
      osc.type = o.type || 'sine';
      osc.frequency.setValueAtTime(o.f, t0);
      if (o.f2) osc.frequency.exponentialRampToValueAtTime(Math.max(20, o.f2), t0 + o.dur);
      const vol = (o.vol == null ? 0.25 : o.vol);
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(vol, t0 + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + o.dur);
      osc.connect(g); g.connect(this.master);
      osc.start(t0); osc.stop(t0 + o.dur + 0.02);
    },
    hiss(o) {
      if (this.muted || !this.ensure()) return;
      const ac = this.ac, t0 = ac.currentTime + (o.delay || 0);
      const src = ac.createBufferSource(); src.buffer = this.noise;
      const bp = ac.createBiquadFilter();
      bp.type = o.filter || 'bandpass';
      bp.frequency.setValueAtTime(o.f, t0);
      if (o.f2) bp.frequency.exponentialRampToValueAtTime(Math.max(40, o.f2), t0 + o.dur);
      bp.Q.value = o.q || 1.1;
      const g = ac.createGain();
      g.gain.setValueAtTime(o.vol == null ? 0.2 : o.vol, t0);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + o.dur);
      src.connect(bp); bp.connect(g); g.connect(this.master);
      src.start(t0); src.stop(t0 + o.dur + 0.02);
    },

    flap() { this.hiss({ f: 1500, f2: 420, dur: 0.14, vol: 0.14, q: 0.8 }); this.tone({ f: 340, f2: 620, dur: 0.09, type: 'sine', vol: 0.1 }); },
    score() { this.tone({ f: 740, dur: 0.1, type: 'triangle', vol: 0.2 }); this.tone({ f: 1108, dur: 0.12, type: 'triangle', vol: 0.15, delay: 0.07 }); },
    coin(n) { const f = 880 * Math.pow(1.122, Math.min(n, 8)); this.tone({ f, dur: 0.07, type: 'square', vol: 0.1 }); this.tone({ f: f * 1.5, dur: 0.11, type: 'square', vol: 0.08, delay: 0.05 }); },
    power() { [0, 1, 2, 3].forEach(i => this.tone({ f: 523 * Math.pow(1.26, i), dur: 0.13, type: 'triangle', vol: 0.17, delay: i * 0.055 })); },
    golden() { [0, 1, 2, 3, 4].forEach(i => this.tone({ f: 660 * Math.pow(1.19, i), dur: 0.16, type: 'sine', vol: 0.15, delay: i * 0.045 })); },
    hit() { this.hiss({ f: 260, f2: 90, dur: 0.3, vol: 0.34, filter: 'lowpass', q: 0.6 }); this.tone({ f: 150, f2: 60, dur: 0.24, type: 'sawtooth', vol: 0.16 }); },
    die() { this.tone({ f: 500, f2: 110, dur: 0.55, type: 'triangle', vol: 0.2, delay: 0.1 }); },
    shield() { this.tone({ f: 300, f2: 900, dur: 0.22, type: 'sine', vol: 0.2 }); this.hiss({ f: 2200, f2: 700, dur: 0.25, vol: 0.12 }); },
    medal() { [0, 4, 7, 12].forEach((s, i) => this.tone({ f: 523 * Math.pow(2, s / 12), dur: 0.5, type: 'triangle', vol: 0.13, delay: i * 0.1 })); },
    blip() { this.tone({ f: 620, dur: 0.06, type: 'square', vol: 0.1 }); }
  };

  /* ------------------------------------------------------------------- skins */
  const SKINS = [
    { name: 'Sunny', unlock: 0, body: ['#FFE066', '#FFB300'], belly: '#FFF6D6', wing: '#FFB524', wingIn: '#FFE08A', line: '#B26A08', beak: '#FF8A3D', beakDark: '#D9571A', cheek: '#FF9BB0' },
    { name: 'Bluebell', unlock: 10, body: ['#9CDDFF', '#2E86DE'], belly: '#EDF8FF', wing: '#2B78C9', wingIn: '#8CCBF5', line: '#1B4E85', beak: '#FFAE42', beakDark: '#D9861A', cheek: '#FF9BB0' },
    { name: 'Minty', unlock: 20, body: ['#B9F5D0', '#2FBF71'], belly: '#F2FFF8', wing: '#23A25D', wingIn: '#93E8BA', line: '#166B3F', beak: '#FFB03A', beakDark: '#D98C18', cheek: '#FFA3B5' },
    { name: 'Rosie', unlock: 35, body: ['#FFC7DA', '#F0679B'], belly: '#FFF0F5', wing: '#E14A83', wingIn: '#FFA8C6', line: '#9E2D58', beak: '#FFAE42', beakDark: '#D9861A', cheek: '#E85C8A' },
    { name: 'Prism', unlock: 50, rainbow: true, body: ['#fff', '#888'], belly: '#FFFFFF', wing: '#dddddd', wingIn: '#ffffff', line: '#5B3A7A', beak: '#FF8A3D', beakDark: '#D9571A', cheek: '#FF9BB0' }
  ];

  /* ---------------------------------------------------------------- palettes */
  const SKIES = [
    { // 0 — bright day
      sky: ['#4FBDEF', '#93DFF7', '#E4F7FF'],
      hillFar: '#93D9A6', hillNear: '#5FBC7B', bush: '#46A263',
      grass: '#84DC68', grassDark: '#5EBE47', dirt: '#DAA45E', dirtDark: '#BC8545',
      cloud: '#FFFFFF', dark: 0.0, glow: '#FFF3C0'
    },
    { // 1 — sunset
      sky: ['#3B3E75', '#F07E5C', '#FFC97C'],
      hillFar: '#7A6E9E', hillNear: '#56507F', bush: '#463F66',
      grass: '#8E9A63', grassDark: '#6C784C', dirt: '#B78855', dirtDark: '#946B41',
      cloud: '#FFD7BE', dark: 0.3, glow: '#FF9E5E'
    },
    { // 2 — night
      sky: ['#070C22', '#141F49', '#2E3E73'],
      hillFar: '#1E2B56', hillNear: '#151E3E', bush: '#101832',
      grass: '#2E5A47', grassDark: '#224839', dirt: '#463A50', dirtDark: '#342B3E',
      cloud: '#9FB2DA', dark: 0.62, glow: '#BFD4FF'
    },
    { // 3 — dawn
      sky: ['#404582', '#F0949D', '#FFDCAB'],
      hillFar: '#7E7CAB', hillNear: '#5C5B92', bush: '#4A4874',
      grass: '#74A06A', grassDark: '#5A8253', dirt: '#C08F5C', dirtDark: '#9C7247',
      cloud: '#FFE5D8', dark: 0.24, glow: '#FFC48A'
    }
  ];

  function mixPalette(phase) {
    const f = ((phase % 1) + 1) % 1 * SKIES.length;
    const i = Math.floor(f), j = (i + 1) % SKIES.length, t = ease(f - i);
    const a = SKIES[i], b = SKIES[j];
    return {
      sky: [mixHex(a.sky[0], b.sky[0], t), mixHex(a.sky[1], b.sky[1], t), mixHex(a.sky[2], b.sky[2], t)],
      hillFar: mixHex(a.hillFar, b.hillFar, t),
      hillNear: mixHex(a.hillNear, b.hillNear, t),
      bush: mixHex(a.bush, b.bush, t),
      grass: mixHex(a.grass, b.grass, t),
      grassDark: mixHex(a.grassDark, b.grassDark, t),
      dirt: mixHex(a.dirt, b.dirt, t),
      dirtDark: mixHex(a.dirtDark, b.dirtDark, t),
      cloud: mixHex(a.cloud, b.cloud, t),
      glow: mixHex(a.glow, b.glow, t),
      dark: lerp(a.dark, b.dark, t)
    };
  }

  /* ------------------------------------------------------------------ canvas */
  const cv = document.getElementById('game');
  const stage = document.getElementById('stage');
  const ctx = cv.getContext('2d', { alpha: false });
  if (!ctx) { document.getElementById('fallback').style.display = 'block'; return; }

  let viewScale = 1;
  function resize() {
    const vw = window.innerWidth, vh = window.innerHeight;
    const pad = vw < 560 || vh < 700 ? 0 : 28;
    const s = Math.min((vw - pad) / W, (vh - pad) / H);
    viewScale = s;
    stage.style.width = Math.round(W * s) + 'px';
    stage.style.height = Math.round(H * s) + 'px';
    if (pad === 0) stage.style.borderRadius = '0';
    const dpr = clamp(window.devicePixelRatio || 1, 1, 2.5);
    cv.width = Math.max(1, Math.round(W * s * dpr));
    cv.height = Math.max(1, Math.round(H * s * dpr));
    const k = cv.width / W;
    ctx.setTransform(k, 0, 0, k, 0, 0);
    ctx.imageSmoothingQuality = 'high';
  }
  window.addEventListener('resize', resize);
  window.addEventListener('orientationchange', () => setTimeout(resize, 120));

  const FONT = (size, weight) => `${weight || 800} ${size}px "Baloo 2", "Trebuchet MS", Verdana, sans-serif`;

  function text(str, x, y, size, opt) {
    opt = opt || {};
    ctx.save();
    ctx.font = FONT(size, opt.weight);
    ctx.textAlign = opt.align || 'center';
    ctx.textBaseline = opt.baseline || 'alphabetic';
    ctx.lineJoin = 'round';
    ctx.miterLimit = 2;
    if (opt.shadow !== false) {
      ctx.save();
      ctx.globalAlpha = 0.25;
      ctx.fillStyle = '#000';
      ctx.fillText(str, x, y + Math.max(2, size * 0.07));
      ctx.restore();
    }
    if (opt.stroke !== null) {
      ctx.strokeStyle = opt.stroke || '#3A2A55';
      ctx.lineWidth = opt.lw == null ? Math.max(2, size * 0.17) : opt.lw;
      ctx.strokeText(str, x, y);
    }
    ctx.fillStyle = opt.fill || '#FFFFFF';
    ctx.fillText(str, x, y);
    ctx.restore();
  }

  /* ------------------------------------------------------------------- state */
  const G = {
    state: STATE.MENU,
    t: 0,              // wall-clock seconds since load (for menu animation)
    worldT: 0,         // advances only while flying — drives the day cycle
    score: 0,
    coins: 0,
    best: Store.get('best', 0),
    runs: Store.get('runs', 0),
    paused: false,
    shake: 0,
    flash: 0,
    flashColor: '#fff',
    timeScale: 1,
    speed: 168,
    gap: 178,
    wind: 0, windTarget: 0, windTimer: 0,
    scrollX: 0,        // ground / parallax scroll accumulator
    distance: 0,
    spawnX: 0,
    newBest: false,
    medal: null,
    skin: clamp(Store.get('skin', 0), 0, SKINS.length - 1),
    comboTimer: 0, combo: 0, bestCombo: 0,
    hintPulse: 0,
    runTime: 0,        // seconds of actual flying in this run (pauses excluded)
    overT: 0
  };

  const bird = {
    x: BIRD_X, y: PLAY_H * 0.45, vy: 0, rot: 0,
    wing: 0, wingSpeed: 9, scale: 1, targetScale: 1,
    blink: 0, blinkTimer: 2,
    alive: true, bounced: false,
    shield: false,
    fx: { ghost: 0, magnet: 0, shrink: 0, slow: 0 }
  };

  let pipes = [], coins = [], powerups = [], parts = [], toasts = [], decor = [], drops = [], fireflies = [];
  let weather = { kind: 'none', timer: 6, intensity: 0 };

  function skin() { return SKINS[G.skin]; }
  function unlockedSkins() { return SKINS.filter(s => s.unlock <= G.best).length; }

  /* ------------------------------------------------------------------- reset */
  function resetWorld(full) {
    pipes = []; coins = []; powerups = []; parts = []; toasts = []; drops = [];
    G.score = 0; G.coins = 0; G.speed = 168; G.gap = 178; G.combo = 0; G.comboTimer = 0;
    G.bestCombo = 0; G.newBest = false; G.medal = null; G.shake = 0; G.flash = 0;
    G.timeScale = 1; G.wind = 0; G.windTarget = 0; G.windTimer = 4; G.distance = 0;
    G.spawnX = W + 120; G.runTime = 0; G.overT = 0;
    bird.x = BIRD_X; bird.y = PLAY_H * 0.45; bird.vy = 0; bird.rot = 0;
    bird.alive = true; bird.bounced = false; bird.shield = false;
    bird.scale = 1; bird.targetScale = 1;
    bird.fx.ghost = bird.fx.magnet = bird.fx.shrink = bird.fx.slow = 0;
    if (full) { G.worldT = 0; decor = []; weather = { kind: 'none', timer: 6, intensity: 0 }; }
  }
  resetWorld(true);

  /* ------------------------------------------------------------------- spawns */
  function spawnPipe() {
    const gap = G.gap;
    const margin = 58;
    const gapY = rand(gap / 2 + margin, PLAY_H - gap / 2 - 46);
    const golden = G.score >= 4 && Math.random() < 0.07;
    const moving = !golden && G.score >= 20 && Math.random() < 0.45;
    const p = {
      x: G.spawnX, gapY, gap,
      type: golden ? 'gold' : 'normal',
      scored: false, minClear: 999, leaf: Math.random() < 0.45,
      seed: Math.random() * 100,
      swayAmp: moving ? rand(16, 38) : 0,
      swaySpd: rand(0.7, 1.35),
      swayPh: Math.random() * TAU
    };
    pipes.push(p);

    // ---- coins in the gap
    if (Math.random() < 0.6) {
      const n = pick([1, 1, 2, 3, 3]);
      for (let i = 0; i < n; i++) {
        const off = (i - (n - 1) / 2);
        coins.push({
          x: p.x + PIPE_W / 2 + off * 40,
          y: gapY + Math.sin(off * 1.1) * 18,
          t: Math.random() * TAU, taken: false, vx: 0, vy: 0, magnet: false
        });
      }
    }
    // ---- power-up every few pipes
    if (G.score > 1 && Math.random() < 0.22) {
      powerups.push({
        x: p.x + PIPE_W / 2 + rand(-10, 10), y: gapY + rand(-26, 26),
        kind: pick(['star', 'magnet', 'shrink', 'slow', 'shield']),
        t: Math.random() * TAU
      });
    }
    // ---- rare lucky feather
    else if (Math.random() < 0.06) {
      powerups.push({ x: p.x + PIPE_W / 2, y: gapY + rand(-30, 30), kind: 'feather', t: Math.random() * TAU });
    }
    G.spawnX += PIPE_SPACING;
  }

  function spawnDecor() {
    const pal = mixPalette(G.worldT / DAY_LENGTH);
    const night = pal.dark > 0.42;
    const r = Math.random();
    let kind;
    if (night) kind = r < 0.34 ? 'shootingstar' : r < 0.62 ? 'bats' : r < 0.82 ? 'ufo' : 'balloon';
    else kind = r < 0.4 ? 'balloon' : r < 0.66 ? 'flock' : r < 0.88 ? 'blimp' : 'ufo';

    if (kind === 'shootingstar') {
      decor.push({ kind, x: rand(W * 0.3, W + 60), y: rand(20, 180), vx: -rand(320, 480), vy: rand(90, 160), life: 1.6, max: 1.6 });
      return;
    }
    const y = kind === 'bats' || kind === 'flock' ? rand(60, 230) : rand(70, 300);
    decor.push({
      kind, x: W + 90, y,
      vx: -rand(16, 34), bob: Math.random() * TAU,
      hue: rand(0, 360), seed: Math.random() * 10,
      banner: kind === 'blimp' ? pick(['NICE FLYING!', 'KEEP GOING!', 'YOU GOT THIS', 'FLAP FLAP!', 'WOW ✨']) : null
    });
  }

  function spawnFireflies() {
    fireflies = [];
    for (let i = 0; i < 16; i++) {
      fireflies.push({ x: rand(0, W), y: rand(PLAY_H - 150, PLAY_H - 10), t: Math.random() * TAU, sp: rand(0.6, 1.6), r: rand(18, 46), bx: 0 });
    }
  }
  spawnFireflies();

  /* ---------------------------------------------------------------- particles */
  function puff(x, y, n, opt) {
    opt = opt || {};
    for (let i = 0; i < n; i++) {
      const a = opt.angle == null ? Math.random() * TAU : opt.angle + rand(-0.7, 0.7);
      const sp = rand(opt.spMin || 30, opt.spMax || 130);
      parts.push({
        kind: opt.kind || 'puff', x, y,
        vx: Math.cos(a) * sp + (opt.vx || 0), vy: Math.sin(a) * sp + (opt.vy || 0),
        life: opt.life || rand(0.3, 0.7), max: 0, size: opt.size || rand(3, 8),
        color: opt.color || '#fff', spin: rand(-8, 8), rot: Math.random() * TAU,
        grav: opt.grav == null ? 40 : opt.grav, drag: opt.drag == null ? 0.9 : opt.drag
      });
      const p = parts[parts.length - 1]; p.max = p.life;
    }
  }
  function toast(str, x, y, color, size) {
    toasts.push({ str, x, y, color: color || '#FFE066', life: 1.15, max: 1.15, size: size || 24 });
  }

  /* ------------------------------------------------------------- outside hooks */
  // Tiny event bus so add-ons (see score-email.js) can react to a run ending
  // without reaching into the game's internals.
  const listeners = { gameover: [], restart: [], emailrequest: [] };
  function emit(name, payload) {
    for (const fn of listeners[name]) { try { fn(payload); } catch (e) { console.error(e); } }
  }

  function startNewRun() {
    G.state = STATE.READY;
    resetWorld(false);
    emit('restart');
  }

  /* ------------------------------------------------------------------- input */
  // Is this logical-canvas point inside the game-over card's "Email score"
  // button? Only once the card has finished animating in.
  function mailBtnHit(lx, ly) {
    if (G.state !== STATE.OVER || G.overT <= 0.55) return false;
    const bx = W / 2 + MAIL_BTN.x, by = OVER_Y + MAIL_BTN.y;
    return lx >= bx && lx <= bx + MAIL_BTN.w && ly >= by && ly <= by + MAIL_BTN.h;
  }

  function requestEmail() {
    if (G.state !== STATE.OVER) return;
    Sfx.blip();
    emit('emailrequest', runSummary());
  }

  function flap() {
    Sfx.resume();
    if (G.paused) return;
    if (G.state === STATE.MENU) { startNewRun(); Sfx.blip(); return; }
    if (G.state === STATE.READY) { G.state = STATE.PLAY; doFlap(); return; }
    if (G.state === STATE.PLAY) { doFlap(); return; }
    if (G.state === STATE.OVER && G.overT > 0.55) { startNewRun(); Sfx.blip(); }
  }
  function doFlap() {
    bird.vy = FLAP_V;
    bird.wing = -1.15;
    Sfx.flap();
    puff(bird.x - 12 * bird.scale, bird.y + 8 * bird.scale, 4, {
      color: '#ffffff', size: rand(3, 6), life: 0.42, spMin: 20, spMax: 70, angle: Math.PI * 0.72, grav: 10
    });
  }

  const tapzone = document.getElementById('tapzone');
  function onPointer(e) {
    e.preventDefault();
    if (e.clientX != null) {
      const r = cv.getBoundingClientRect();
      const lx = (e.clientX - r.left) / viewScale, ly = (e.clientY - r.top) / viewScale;
      // tapping the bird on the title screen swaps costume — a little secret
      if (G.state === STATE.MENU && Math.hypot(lx - W / 2, ly - MENU_BIRD_Y) < 62) { cycleSkin(); return; }
      // the email button must swallow the tap, or the game would restart under it
      if (mailBtnHit(lx, ly)) { requestEmail(); return; }
    }
    flap();
  }
  tapzone.addEventListener('pointerdown', onPointer);
  tapzone.addEventListener('contextmenu', e => e.preventDefault());

  function cycleSkin() {
    const n = unlockedSkins();
    if (n <= 1) { toast('Reach 10 pts for a new bird!', W / 2, PLAY_H * 0.4, '#FFD9A0', 19); Sfx.blip(); return; }
    G.skin = (G.skin + 1) % n;
    Store.set('skin', G.skin);
    Sfx.power();
    puff(W / 2, PLAY_H * 0.56, 18, { color: skin().body[0], size: rand(3, 7), life: 0.6, grav: 20 });
    toast(skin().name + '!', W / 2, PLAY_H * 0.44, '#FFF3C4', 22);
  }

  const helpEl = document.getElementById('help');
  function toggleHelp(force) {
    const show = force == null ? helpEl.classList.contains('hidden') : force;
    helpEl.classList.toggle('hidden', !show);
    if (show && G.state === STATE.PLAY) G.paused = true;
  }
  document.getElementById('btn-help').addEventListener('click', () => toggleHelp());
  document.getElementById('btn-help-close').addEventListener('click', () => toggleHelp(false));

  const soundBtn = document.getElementById('btn-sound');
  function syncSoundBtn() {
    soundBtn.textContent = Sfx.muted ? '🔇' : '🔊';
    soundBtn.classList.toggle('off', Sfx.muted);
  }
  soundBtn.addEventListener('click', () => {
    Sfx.muted = !Sfx.muted; Store.set('mute', Sfx.muted); syncSoundBtn();
    if (!Sfx.muted) { Sfx.resume(); Sfx.blip(); }
  });
  syncSoundBtn();

  const pauseBtn = document.getElementById('btn-pause');
  function togglePause(force) {
    if (G.state !== STATE.PLAY) return;
    G.paused = force == null ? !G.paused : force;
    pauseBtn.textContent = G.paused ? '▶' : '⏸';
  }
  pauseBtn.addEventListener('click', () => togglePause());

  window.addEventListener('keydown', (e) => {
    // never hijack keys while someone is typing in an overlay form
    const ae = document.activeElement;
    if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' ||
               ae.tagName === 'BUTTON' || ae.tagName === 'SELECT' || ae.isContentEditable)) return;
    const k = e.key.toLowerCase();
    if (k === ' ' || k === 'arrowup' || k === 'w' || e.code === 'Space') {
      e.preventDefault();
      if (!helpEl.classList.contains('hidden')) { toggleHelp(false); return; }
      flap();
    } else if (k === 'p' || k === 'escape') {
      if (!helpEl.classList.contains('hidden')) { toggleHelp(false); return; }
      togglePause();
    } else if (k === 'm') {
      soundBtn.click();
    } else if (k === 'h') {
      toggleHelp();
    } else if (k === 'c') {
      if (G.state === STATE.MENU || G.state === STATE.OVER || G.state === STATE.READY) cycleSkin();
    } else if (k === 'r') {
      if (G.state === STATE.OVER || G.state === STATE.PLAY) startNewRun();
    } else if (k === 'e') {
      requestEmail();
    }
  });
  document.addEventListener('visibilitychange', () => { if (document.hidden) togglePause(true); });

  /* ------------------------------------------------------------------ pickups */
  const FX_META = {
    star: { icon: '⭐', dur: 6.5, label: 'GHOST MODE!', color: '#FFE066' },
    magnet: { icon: '🧲', dur: 9, label: 'MAGNET!', color: '#FF8A8A' },
    shrink: { icon: '🍬', dur: 9, label: 'TINY BIRD!', color: '#FFB3E6' },
    slow: { icon: '⏳', dur: 5.5, label: 'SLOW-MO!', color: '#AEE6FF' },
    shield: { icon: '🛡️', dur: 0, label: 'BUBBLE!', color: '#B6F2FF' },
    feather: { icon: '🪶', dur: 0, label: 'LUCKY FEATHER +3', color: '#FFF3C4' }
  };

  function applyPower(kind) {
    const m = FX_META[kind];
    if (kind === 'shield') bird.shield = true;
    else if (kind === 'feather') { G.score += 3; bird.shield = true; }
    else bird.fx[kind] = m.dur;
    if (kind === 'shrink') bird.targetScale = 0.62;
    toast(m.label, bird.x + 30, bird.y - 34, m.color, 22);
    G.flash = 0.28; G.flashColor = m.color;
    if (kind === 'shield' || kind === 'feather') Sfx.shield(); else Sfx.power();
    puff(bird.x, bird.y, 22, { color: m.color, size: rand(3, 8), life: 0.7, grav: -10, spMax: 180 });
  }

  /* ------------------------------------------------------------------- death */
  function die(cause) {
    if (!bird.alive) return;
    if (bird.shield) {
      bird.shield = false;
      bird.vy = FLAP_V * 0.8;
      G.shake = 10; G.flash = 0.3; G.flashColor = '#B6F2FF';
      Sfx.shield();
      toast('SAVED!', bird.x + 26, bird.y - 30, '#B6F2FF', 24);
      puff(bird.x, bird.y, 26, { color: '#CFF6FF', size: rand(3, 9), life: 0.6, grav: 0, spMax: 220 });
      // brief mercy window so you are not instantly re-hit inside a pipe
      bird.fx.ghost = Math.max(bird.fx.ghost, 1.0);
      return;
    }
    bird.alive = false;
    G.state = STATE.DYING;
    G.shake = 16; G.flash = 0.5; G.flashColor = '#fff';
    G.timeScale = 1;
    Sfx.hit(); Sfx.die();
    puff(bird.x, bird.y, 16, { color: skin().body[0], size: rand(4, 9), life: 0.9, grav: 260, spMax: 200 });
    puff(bird.x, bird.y, 7, { kind: 'feather', color: skin().belly, size: rand(6, 11), life: 1.6, grav: 90, drag: 0.94, spMax: 150 });
    if (cause === 'ground') bird.bounced = true;
  }

  function finishRun() {
    G.state = STATE.OVER;
    G.overT = 0;
    G.runs++; Store.set('runs', G.runs);
    const total = G.score;
    if (total > G.best) { G.best = total; G.newBest = true; Store.set('best', G.best); }
    G.medal = total >= 50 ? 'rainbow' : total >= 35 ? 'platinum' : total >= 20 ? 'gold' : total >= 10 ? 'silver' : total >= 5 ? 'bronze' : null;
    if (G.medal) setTimeout(() => Sfx.medal(), 260);
    emit('gameover', runSummary());
  }

  function runSummary() {
    return {
      score: G.score,
      best: G.best,
      newBest: G.newBest,
      seconds: Math.round(G.runTime * 10) / 10,
      coins: G.coins,
      bestCombo: Math.min(5, G.bestCombo || 1),
      medal: G.medal,
      bird: skin().name,
      runs: G.runs,
      playedAt: new Date().toISOString()
    };
  }

  window.Flappy = {
    on(name, fn) { if (listeners[name]) listeners[name].push(fn); },
    restart: startNewRun,
    requestEmail,
    summary: runSummary,
    isOver() { return G.state === STATE.OVER; }
  };

  /* ------------------------------------------------------------------ update */
  function update(dt) {
    G.t += dt;
    const flying = G.state === STATE.PLAY;
    // wall-clock stopwatch for the run: starts on the first flap, stops on the
    // crash (DYING), and does not tick while paused — update() is not called then
    if (flying) G.runTime += dt;
    const ts = flying && bird.fx.slow > 0 ? 0.45 : 1;
    G.timeScale = lerp(G.timeScale, ts, 1 - Math.pow(0.001, dt));
    const wdt = dt * (G.state === STATE.PLAY ? G.timeScale : 1);

    G.shake = Math.max(0, G.shake - dt * 42);
    G.flash = Math.max(0, G.flash - dt * 1.9);
    G.hintPulse += dt;

    /* ---- day cycle & scenery advance (also on the menu, so it feels alive) */
    const scenicMove = (G.state === STATE.MENU || G.state === STATE.READY) ? 0.55 : 1;
    G.worldT += wdt * scenicMove;
    const pal = mixPalette(G.worldT / DAY_LENGTH);
    const night = pal.dark > 0.42;

    /* ---- weather */
    weather.timer -= wdt;
    if (weather.timer <= 0) {
      if (weather.kind === 'none') {
        weather.kind = Math.random() < 0.45 ? (night ? 'snow' : 'rain') : 'none';
        weather.timer = rand(10, 18);
        if (weather.kind !== 'none') toast(weather.kind === 'rain' ? '🌧️ rain!' : '❄️ snow!', W / 2, 150, '#DCEEFF', 20);
      } else { weather.kind = 'none'; weather.timer = rand(12, 26); }
    }
    weather.intensity = lerp(weather.intensity, weather.kind === 'none' ? 0 : 1, 1 - Math.pow(0.15, dt));
    if (weather.intensity > 0.02) {
      const want = Math.round(weather.intensity * (weather.kind === 'snow' ? 70 : 110));
      while (drops.length < want) {
        drops.push({
          x: rand(-40, W + 40), y: rand(-H, 0),
          v: weather.kind === 'snow' ? rand(50, 95) : rand(520, 720),
          s: weather.kind === 'snow' ? rand(1.6, 3.4) : rand(7, 14),
          ph: Math.random() * TAU, snow: weather.kind === 'snow'
        });
      }
      while (drops.length > want + 20) drops.pop();
    }
    for (let i = drops.length - 1; i >= 0; i--) {
      const d = drops[i];
      d.y += d.v * wdt;
      d.x += (d.snow ? Math.sin(G.t * 1.4 + d.ph) * 26 : -70) * wdt + G.wind * wdt * 0.4;
      if (d.y > PLAY_H + 20) {
        if (!d.snow && Math.random() < 0.5) puff(d.x, PLAY_H + rand(-4, 10), 1, { color: '#CFEBFF', size: rand(1.5, 3), life: 0.3, grav: 120, spMax: 40, angle: -Math.PI / 2 });
        d.y = rand(-120, -10); d.x = rand(-40, W + 40);
      }
    }

    /* ---- decor */
    if (Math.random() < dt * 0.22 && decor.length < 4) spawnDecor();
    for (let i = decor.length - 1; i >= 0; i--) {
      const d = decor[i];
      if (d.kind === 'shootingstar') {
        d.x += d.vx * wdt; d.y += d.vy * wdt; d.life -= wdt;
        if (d.life <= 0) decor.splice(i, 1);
      } else {
        d.x += (d.vx - G.speed * 0.07 * (flying ? 1 : 0.3)) * wdt;
        d.bob += wdt;
        if (d.x < -140) decor.splice(i, 1);
      }
    }
    for (const f of fireflies) { f.t += wdt * f.sp; }

    /* ---- bird animation always runs */
    bird.wing = lerp(bird.wing, 0, 1 - Math.pow(0.0015, dt));
    bird.scale = lerp(bird.scale, bird.targetScale, 1 - Math.pow(0.002, dt));
    bird.blinkTimer -= dt;
    if (bird.blinkTimer <= 0) { bird.blink = 0.14; bird.blinkTimer = rand(2.2, 5.5); }
    bird.blink = Math.max(0, bird.blink - dt);

    /* ---- MENU / READY hover */
    if (G.state === STATE.MENU) {
      bird.x = W / 2; bird.y = MENU_BIRD_Y + Math.sin(G.t * 2.4) * 11;
      bird.rot = Math.sin(G.t * 2.4) * 0.11;
      bird.vy = 0;
      bird.scale = 1.5; // hero size on the title screen
      bird.wing = -0.55 + Math.sin(G.t * 7.5) * 0.55;
    } else if (G.state === STATE.READY) {
      bird.x = lerp(bird.x, BIRD_X, 1 - Math.pow(0.004, dt));
      bird.y = lerp(bird.y, PLAY_H * 0.45, 1 - Math.pow(0.02, dt)) + Math.sin(G.t * 5.2) * 0.9;
      bird.rot = Math.sin(G.t * 5.2) * 0.07;
    }

    /* ---- scrolling */
    if (G.state === STATE.PLAY || G.state === STATE.DYING || G.state === STATE.READY) {
      const sp = G.state === STATE.READY ? G.speed * 0.45 : G.speed;
      G.scrollX += sp * wdt;
      if (G.state === STATE.PLAY) G.distance += sp * wdt;
    } else {
      G.scrollX += 22 * dt;
    }

    /* ---- flying physics */
    if (G.state === STATE.PLAY || G.state === STATE.DYING) {
      bird.vy = Math.min(MAX_FALL, bird.vy + GRAVITY * wdt);
      bird.y += bird.vy * wdt;
      const target = clamp(bird.vy / 620, -0.55, 1.35);
      bird.rot = lerp(bird.rot, target, 1 - Math.pow(0.0006, dt));

      if (bird.y < 10) { bird.y = 10; bird.vy = Math.max(bird.vy, 30); }
      const floor = PLAY_H - 8 * bird.scale;
      if (bird.y > floor) {
        if (bird.alive) { bird.y = floor; die('ground'); }
        else {
          bird.y = floor;
          if (!bird.bounced && bird.vy > 120) { bird.vy *= -0.32; bird.bounced = true; puff(bird.x, floor + 6, 8, { color: '#EADFBF', size: rand(3, 7), life: 0.5, angle: -Math.PI / 2, grav: 300 }); }
          else { bird.vy = 0; bird.rot = lerp(bird.rot, 1.55, 1 - Math.pow(0.02, dt)); }
        }
      }
    }
    if (G.state === STATE.DYING) {
      G.dyingT = (G.dyingT || 0) + dt;
      if (G.dyingT > 0.95) { G.dyingT = 0; finishRun(); }
    } else G.dyingT = 0;
    if (G.state === STATE.OVER) G.overT = (G.overT || 0) + dt;

    if (G.state !== STATE.PLAY) { stepParticles(dt); return; }

    /* ---- effects countdown */
    for (const k in bird.fx) if (bird.fx[k] > 0) bird.fx[k] = Math.max(0, bird.fx[k] - dt);
    if (bird.fx.shrink <= 0) bird.targetScale = 1;
    if (bird.fx.ghost > 0 && Math.random() < dt * 40) {
      puff(bird.x - 14, bird.y + rand(-7, 7), 1, { kind: 'trail', color: `hsl(${(G.t * 260) % 360} 95% 68%)`, size: rand(4, 9), life: 0.5, grav: 0, spMax: 18 });
    }

    /* ---- difficulty & wind */
    G.speed = 168 + Math.min(G.score, 45) * 1.7;
    G.gap = Math.max(132, 178 - Math.min(G.score, 32) * 1.45);
    if (G.score >= 25) {
      G.windTimer -= wdt;
      if (G.windTimer <= 0) {
        G.windTarget = rand(-1, 1) > 0 ? rand(22, 58) : -rand(22, 58);
        G.windTimer = rand(5, 9);
      }
    }
    G.wind = lerp(G.wind, G.windTarget, 1 - Math.pow(0.25, dt));
    if (Math.abs(G.wind) > 12 && Math.random() < dt * 14) {
      puff(G.wind > 0 ? -10 : W + 10, rand(30, PLAY_H - 30), 1, {
        kind: 'wind', color: '#ffffff', size: rand(10, 26), life: 0.8, grav: 0, spMax: 0, vx: G.wind * 7, vy: 0, drag: 1
      });
    }

    /* ---- pipes */
    const dx = (G.speed + G.wind * 0.35) * wdt;
    G.spawnX -= dx;
    while (G.spawnX < W + PIPE_SPACING) spawnPipe();

    const br = BIRD_R * bird.scale;
    for (let i = pipes.length - 1; i >= 0; i--) {
      const p = pipes[i];
      p.x -= dx;
      const gy = p.gapY + (p.swayAmp ? Math.sin(G.worldT * p.swaySpd + p.swayPh) * p.swayAmp : 0);
      p.drawY = gy;
      const top = gy - p.gap / 2, bot = gy + p.gap / 2;

      // overlap in x? track how close we squeezed past
      if (bird.x + br > p.x && bird.x - br < p.x + PIPE_W) {
        p.minClear = Math.min(p.minClear, Math.min(bird.y - br - top, bot - (bird.y + br)));
        if (bird.fx.ghost <= 0) {
          if (circleRect(bird.x, bird.y, br, p.x, -220, PIPE_W, top + 220) ||
              circleRect(bird.x, bird.y, br, p.x, bot, PIPE_W, PLAY_H - bot + 40)) {
            die('pipe');
          }
        }
      }

      if (!p.scored && p.x + PIPE_W < bird.x - br) {
        p.scored = true;
        const pts = p.type === 'gold' ? 5 : 1;
        G.score += pts;
        if (p.type === 'gold') {
          Sfx.golden();
          toast('GOLDEN PIPE +5', W / 2, PLAY_H * 0.3, '#FFD75E', 26);
          G.flash = 0.3; G.flashColor = '#FFE9A3';
          puff(p.x + PIPE_W / 2, gy, 26, { color: '#FFD75E', size: rand(3, 8), life: 0.9, grav: 30, spMax: 200 });
        } else Sfx.score();

        if (p.minClear < 9 && bird.fx.ghost <= 0) {
          G.score++;
          toast(pick(['SO CLOSE! +1', 'NEAR MISS! +1', 'PHEW! +1']), bird.x + 20, bird.y - 40, '#FF9BB0', 20);
          G.shake = Math.max(G.shake, 5);
        }
        if (G.score === 15) toast('HALFWAY TO GOLD 🏅', W / 2, PLAY_H * 0.24, '#FFF3C4', 21);
        if (G.score === 25) toast('💨 WINDY UP HERE!', W / 2, PLAY_H * 0.24, '#DCEEFF', 22);
      }
      if (p.x < -PIPE_W - 30) pipes.splice(i, 1);
    }

    /* ---- coins */
    G.comboTimer = Math.max(0, G.comboTimer - dt);
    if (G.comboTimer === 0) G.combo = 0;
    for (let i = coins.length - 1; i >= 0; i--) {
      const c = coins[i];
      c.x -= dx; c.t += dt * 5;
      if (bird.fx.magnet > 0) {
        const d = Math.hypot(bird.x - c.x, bird.y - c.y);
        if (d < 170) {
          c.x += (bird.x - c.x) / d * 260 * wdt;
          c.y += (bird.y - c.y) / d * 260 * wdt;
          c.magnet = true;
        }
      }
      if (Math.hypot(bird.x - c.x, bird.y - c.y) < br + 13) {
        coins.splice(i, 1);
        G.combo++; G.comboTimer = 2.4;
        G.bestCombo = Math.max(G.bestCombo, G.combo);
        const mult = Math.min(5, G.combo);
        G.coins++; G.score += mult;
        Sfx.coin(G.combo);
        puff(c.x, c.y, 10, { color: '#FFD75E', size: rand(2, 6), life: 0.5, grav: 20, spMax: 150 });
        if (mult > 1) toast('×' + mult, c.x, c.y - 18, '#FFE066', 20 + mult * 2);
        continue;
      }
      if (c.x < -30) coins.splice(i, 1);
    }

    /* ---- power-ups */
    for (let i = powerups.length - 1; i >= 0; i--) {
      const u = powerups[i];
      u.x -= dx; u.t += dt * 2.4;
      if (Math.hypot(bird.x - u.x, bird.y - (u.y + Math.sin(u.t) * 7)) < br + 17) {
        applyPower(u.kind);
        powerups.splice(i, 1);
        continue;
      }
      if (u.x < -40) powerups.splice(i, 1);
    }

    stepParticles(dt);
  }

  function stepParticles(dt) {
    for (let i = parts.length - 1; i >= 0; i--) {
      const p = parts[i];
      p.life -= dt;
      if (p.life <= 0) { parts.splice(i, 1); continue; }
      p.x += p.vx * dt; p.y += p.vy * dt;
      p.vy += p.grav * dt;
      const d = Math.pow(p.drag, dt * 60);
      p.vx *= d; p.vy *= d;
      p.rot += p.spin * dt;
    }
    for (let i = toasts.length - 1; i >= 0; i--) {
      const t = toasts[i];
      t.life -= dt; t.y -= 36 * dt;
      if (t.life <= 0) toasts.splice(i, 1);
    }
  }

  function circleRect(cx, cy, r, rx, ry, rw, rh) {
    const nx = clamp(cx, rx, rx + rw), ny = clamp(cy, ry, ry + rh);
    const dx = cx - nx, dy = cy - ny;
    return dx * dx + dy * dy < r * r;
  }

  /* =========================================================== DRAWING ===== */

  function drawSky(pal) {
    const g = ctx.createLinearGradient(0, 0, 0, PLAY_H);
    g.addColorStop(0, pal.sky[0]);
    g.addColorStop(0.55, pal.sky[1]);
    g.addColorStop(1, pal.sky[2]);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, PLAY_H + 2);
  }

  function drawStars(pal) {
    const a = clamp((pal.dark - 0.18) / 0.45, 0, 1);
    if (a <= 0.01) return;
    ctx.save();
    for (let i = 0; i < 90; i++) {
      const x = hash(i * 1.7) * W;
      const y = hash(i * 3.3 + 9) * (PLAY_H * 0.72);
      const tw = 0.55 + 0.45 * Math.sin(G.t * (1.2 + hash(i) * 2.4) + i);
      const r = 0.7 + hash(i * 5.1) * 1.5;
      ctx.globalAlpha = a * tw * (0.5 + hash(i * 7.7) * 0.5);
      ctx.fillStyle = '#fff';
      ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fill();
      if (r > 1.8) {
        ctx.globalAlpha *= 0.5;
        ctx.fillRect(x - r * 3, y - 0.4, r * 6, 0.8);
        ctx.fillRect(x - 0.4, y - r * 3, 0.8, r * 6);
      }
    }
    ctx.restore();
  }

  function drawCelestial(pal) {
    const phase = ((G.worldT / DAY_LENGTH) % 1 + 1) % 1;
    // sun
    const u = (phase + 0.25) % 1;
    if (u < 0.5) {
      const p = u / 0.5;
      const x = lerp(-30, W + 30, p), y = 480 - Math.sin(p * Math.PI) * 415;
      const a = clamp(1 - pal.dark * 1.5, 0, 1);
      if (a > 0.02) {
        ctx.save(); ctx.globalAlpha = a;
        const gl = ctx.createRadialGradient(x, y, 6, x, y, 130);
        gl.addColorStop(0, rgba('#FFF6C9', 0.85));
        gl.addColorStop(0.35, rgba('#FFD98A', 0.28));
        gl.addColorStop(1, rgba('#FFC25E', 0));
        ctx.fillStyle = gl; ctx.beginPath(); ctx.arc(x, y, 130, 0, TAU); ctx.fill();
        ctx.fillStyle = '#FFF2B8'; ctx.beginPath(); ctx.arc(x, y, 30, 0, TAU); ctx.fill();
        ctx.fillStyle = '#FFFBE4'; ctx.beginPath(); ctx.arc(x - 6, y - 7, 20, 0, TAU); ctx.fill();
        ctx.restore();
      }
    }
    // moon
    const v = ((phase - 0.25) % 1 + 1) % 1;
    if (v < 0.5) {
      const p = v / 0.5;
      const x = lerp(-20, W + 20, p), y = 470 - Math.sin(p * Math.PI) * 390;
      const a = clamp(pal.dark * 1.9, 0, 1);
      if (a > 0.02) {
        ctx.save(); ctx.globalAlpha = a;
        const gl = ctx.createRadialGradient(x, y, 8, x, y, 110);
        gl.addColorStop(0, rgba('#DDE9FF', 0.5));
        gl.addColorStop(1, rgba('#9FB2DA', 0));
        ctx.fillStyle = gl; ctx.beginPath(); ctx.arc(x, y, 110, 0, TAU); ctx.fill();
        ctx.fillStyle = '#F4F7FF'; ctx.beginPath(); ctx.arc(x, y, 26, 0, TAU); ctx.fill();
        ctx.fillStyle = rgba('#C9D6F2', 0.75);
        ctx.beginPath(); ctx.arc(x + 8, y - 8, 5, 0, TAU); ctx.fill();
        ctx.beginPath(); ctx.arc(x - 7, y + 4, 7, 0, TAU); ctx.fill();
        ctx.beginPath(); ctx.arc(x + 3, y + 11, 3.5, 0, TAU); ctx.fill();
        ctx.restore();
      }
    }
  }

  function cloudShape(x, y, s) {
    ctx.beginPath();
    ctx.arc(x, y, 22 * s, 0, TAU);
    ctx.arc(x + 24 * s, y - 12 * s, 27 * s, 0, TAU);
    ctx.arc(x + 54 * s, y - 2 * s, 21 * s, 0, TAU);
    ctx.arc(x + 30 * s, y + 10 * s, 24 * s, 0, TAU);
    ctx.arc(x + 6 * s, y + 10 * s, 18 * s, 0, TAU);
    ctx.fill();
  }

  function drawClouds(pal) {
    const layers = [
      { n: 5, sp: 0.06, s: 1.25, y: 90, a: 0.55, sy: 11 },
      { n: 5, sp: 0.13, s: 0.85, y: 165, a: 0.8, sy: 23 },
      { n: 4, sp: 0.22, s: 0.55, y: 250, a: 0.5, sy: 37 }
    ];
    ctx.save();
    for (const L of layers) {
      const span = W + 240;
      for (let i = 0; i < L.n; i++) {
        const base = hash(i * 2.1 + L.sy) * span;
        let x = (base - G.scrollX * L.sp) % span;
        if (x < -180) x += span;
        const y = L.y + hash(i * 4.4 + L.sy) * 52 - 26;
        ctx.globalAlpha = L.a;
        ctx.fillStyle = pal.cloud;
        cloudShape(x, y, L.s);
        ctx.globalAlpha = L.a * 0.5;
        ctx.fillStyle = rgba('#FFFFFF', 0.5);
        cloudShape(x + 4 * L.s, y - 5 * L.s, L.s * 0.72);
      }
    }
    ctx.restore();
  }

  function drawHills(pal) {
    // far ridge
    ctx.fillStyle = pal.hillFar;
    ctx.beginPath();
    ctx.moveTo(0, PLAY_H);
    for (let x = 0; x <= W; x += 8) {
      const o = (x + G.scrollX * 0.1) * 0.011;
      const y = PLAY_H - 96 - Math.sin(o) * 32 - Math.sin(o * 2.3 + 1.1) * 16;
      ctx.lineTo(x, y);
    }
    ctx.lineTo(W, PLAY_H); ctx.closePath(); ctx.fill();

    // near ridge + tiny trees
    ctx.fillStyle = pal.hillNear;
    ctx.beginPath();
    ctx.moveTo(0, PLAY_H);
    for (let x = 0; x <= W; x += 8) {
      const o = (x + G.scrollX * 0.2) * 0.016;
      const y = PLAY_H - 52 - Math.sin(o) * 22 - Math.sin(o * 1.7 + 2.4) * 10;
      ctx.lineTo(x, y);
    }
    ctx.lineTo(W, PLAY_H); ctx.closePath(); ctx.fill();

    const span = W + 160;
    ctx.fillStyle = pal.bush;
    for (let i = 0; i < 12; i++) {
      let x = (hash(i * 3.7) * span - G.scrollX * 0.32) % span;
      if (x < -80) x += span;
      const h = 26 + hash(i * 6.1) * 26;
      const y = PLAY_H - 30;
      // little conifer
      ctx.beginPath();
      ctx.moveTo(x, y - h);
      ctx.lineTo(x + h * 0.36, y);
      ctx.lineTo(x - h * 0.36, y);
      ctx.closePath(); ctx.fill();
      ctx.beginPath();
      ctx.moveTo(x, y - h * 1.28);
      ctx.lineTo(x + h * 0.26, y - h * 0.48);
      ctx.lineTo(x - h * 0.26, y - h * 0.48);
      ctx.closePath(); ctx.fill();
    }
    // bushes hugging the ground line
    for (let i = 0; i < 14; i++) {
      let x = (hash(i * 9.3 + 3) * span - G.scrollX * 0.45) % span;
      if (x < -70) x += span;
      const s = 0.55 + hash(i * 2.9) * 0.7;
      ctx.fillStyle = pal.bush;
      ctx.beginPath();
      ctx.arc(x, PLAY_H - 4, 20 * s, Math.PI, TAU);
      ctx.arc(x + 20 * s, PLAY_H - 2, 15 * s, Math.PI, TAU);
      ctx.arc(x - 18 * s, PLAY_H - 2, 13 * s, Math.PI, TAU);
      ctx.fill();
    }
  }

  function drawFireflies(pal) {
    const a = clamp((pal.dark - 0.3) / 0.35, 0, 1);
    if (a <= 0.01) return;
    ctx.save();
    for (const f of fireflies) {
      const x = f.x + Math.cos(f.t) * f.r;
      const y = f.y + Math.sin(f.t * 1.6) * f.r * 0.5;
      const pulse = 0.35 + 0.65 * Math.max(0, Math.sin(f.t * 2.6));
      ctx.globalAlpha = a * pulse;
      const gl = ctx.createRadialGradient(x, y, 0, x, y, 11);
      gl.addColorStop(0, 'rgba(255,255,190,0.95)');
      gl.addColorStop(1, 'rgba(180,255,120,0)');
      ctx.fillStyle = gl;
      ctx.beginPath(); ctx.arc(x, y, 11, 0, TAU); ctx.fill();
    }
    ctx.restore();
  }

  function drawGround(pal) {
    const y = PLAY_H;
    // grass cap with a scalloped edge
    ctx.fillStyle = pal.grass;
    ctx.fillRect(0, y, W, 26);
    ctx.beginPath();
    const off = -(G.scrollX % 24);
    for (let x = off; x < W + 24; x += 24) { ctx.moveTo(x, y); ctx.arc(x + 12, y, 12, Math.PI, TAU); }
    ctx.fill();
    ctx.fillStyle = pal.grassDark;
    ctx.fillRect(0, y + 20, W, 8);
    // grass tufts
    ctx.save();
    ctx.strokeStyle = rgba('#FFFFFF', 0.13);
    ctx.lineWidth = 1.6; ctx.lineCap = 'round';
    const gspan = W + 90;
    for (let i = 0; i < 26; i++) {
      let x = (hash(i * 4.2) * gspan - G.scrollX) % gspan;
      if (x < -20) x += gspan;
      const sway = Math.sin(G.t * 1.8 + i) * 1.2;
      ctx.beginPath();
      ctx.moveTo(x, y + 19);
      ctx.quadraticCurveTo(x + 1.5, y + 12, x + 3.5 + sway, y + 5);
      ctx.stroke();
    }
    ctx.restore();
    // dirt
    const g = ctx.createLinearGradient(0, y + 26, 0, H);
    g.addColorStop(0, pal.dirt);
    g.addColorStop(1, pal.dirtDark);
    ctx.fillStyle = g;
    ctx.fillRect(0, y + 26, W, GROUND_H - 26);
    // dirt speckles + diagonal stripes for motion
    ctx.save();
    ctx.globalAlpha = 0.14;
    ctx.fillStyle = '#000';
    const span2 = 60;
    for (let x = -(G.scrollX % span2) - span2; x < W + span2; x += span2) {
      ctx.beginPath();
      ctx.moveTo(x, y + 26); ctx.lineTo(x + 22, y + 26);
      ctx.lineTo(x + 2, H); ctx.lineTo(x - 20, H);
      ctx.closePath(); ctx.fill();
    }
    ctx.restore();
    ctx.save();
    ctx.globalAlpha = 0.2;
    for (let i = 0; i < 34; i++) {
      let x = (hash(i * 8.1 + 5) * (W + 80) - G.scrollX * 1 % (W + 80));
      if (x < -20) x += W + 80;
      const yy = y + 34 + hash(i * 2.2) * (GROUND_H - 44);
      ctx.fillStyle = hash(i) > 0.5 ? '#fff' : '#000';
      ctx.beginPath(); ctx.ellipse(x, yy, 3 + hash(i * 3) * 3, 2, 0, 0, TAU); ctx.fill();
    }
    ctx.restore();
    // top shadow line
    ctx.fillStyle = 'rgba(0,0,0,0.12)';
    ctx.fillRect(0, y - 3, W, 3);
  }

  function drawDecor(pal) {
    for (const d of decor) {
      ctx.save();
      if (d.kind === 'shootingstar') {
        const a = clamp(d.life / d.max, 0, 1);
        ctx.globalAlpha = a * clamp(pal.dark * 1.8, 0, 1);
        const len = 90;
        const nx = d.vx, ny = d.vy, m = Math.hypot(nx, ny);
        const g = ctx.createLinearGradient(d.x, d.y, d.x - nx / m * len, d.y - ny / m * len);
        g.addColorStop(0, 'rgba(255,255,255,0.95)');
        g.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.strokeStyle = g; ctx.lineWidth = 3; ctx.lineCap = 'round';
        ctx.beginPath(); ctx.moveTo(d.x, d.y); ctx.lineTo(d.x - nx / m * len, d.y - ny / m * len); ctx.stroke();
        ctx.fillStyle = '#fff';
        ctx.beginPath(); ctx.arc(d.x, d.y, 2.6, 0, TAU); ctx.fill();
        ctx.restore(); continue;
      }
      const y = d.y + Math.sin(d.bob * 1.3) * 7;
      ctx.translate(d.x, y);
      if (d.kind === 'balloon') {
        ctx.rotate(Math.sin(d.bob) * 0.06);
        const c1 = `hsl(${d.hue} 78% 66%)`, c2 = `hsl(${(d.hue + 28) % 360} 72% 48%)`;
        ctx.strokeStyle = 'rgba(70,50,40,0.55)'; ctx.lineWidth = 1.6;
        ctx.beginPath(); ctx.moveTo(-9, 26); ctx.lineTo(-4, 40); ctx.moveTo(9, 26); ctx.lineTo(4, 40); ctx.stroke();
        const gg = ctx.createLinearGradient(-22, -30, 22, 26);
        gg.addColorStop(0, c1); gg.addColorStop(1, c2);
        ctx.fillStyle = gg;
        ctx.beginPath(); ctx.ellipse(0, 0, 22, 27, 0, 0, TAU); ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,0.3)';
        for (let i = -1; i <= 1; i++) { ctx.beginPath(); ctx.ellipse(i * 11, 0, 4, 26, 0, 0, TAU); ctx.fill(); }
        ctx.fillStyle = 'rgba(255,255,255,0.55)';
        ctx.beginPath(); ctx.ellipse(-8, -12, 5, 8, -0.4, 0, TAU); ctx.fill();
        ctx.fillStyle = '#8B5E3C';
        roundRect(ctx, -9, 39, 18, 13, 3); ctx.fill();
      } else if (d.kind === 'blimp') {
        ctx.fillStyle = '#F26B6B';
        ctx.beginPath(); ctx.ellipse(0, 0, 46, 21, 0, 0, TAU); ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,0.85)';
        ctx.beginPath(); ctx.ellipse(-8, -6, 30, 9, 0, 0, TAU); ctx.fill();
        ctx.fillStyle = '#C94F4F';
        ctx.beginPath(); ctx.moveTo(42, 0); ctx.lineTo(56, -12); ctx.lineTo(54, 6); ctx.closePath(); ctx.fill();
        ctx.fillStyle = '#4A3A6B';
        roundRect(ctx, -10, 19, 20, 9, 4); ctx.fill();
        if (d.banner) {
          ctx.fillStyle = 'rgba(255,255,255,0.9)';
          const bw = ctx.measureText ? 0 : 0;
          ctx.font = FONT(13, 700);
          const tw = ctx.measureText(d.banner).width + 16;
          roundRect(ctx, -tw - 52, -8, tw, 20, 6); ctx.fill();
          ctx.fillStyle = '#E0662F'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
          ctx.fillText(d.banner, -tw / 2 - 52, 3);
          ctx.strokeStyle = 'rgba(255,255,255,0.7)'; ctx.lineWidth = 1.4;
          ctx.beginPath(); ctx.moveTo(-46, 0); ctx.lineTo(-52, 2); ctx.stroke();
        }
      } else if (d.kind === 'ufo') {
        const bob = Math.sin(d.bob * 3) * 3;
        const gl = ctx.createRadialGradient(0, 22, 4, 0, 60, 60);
        gl.addColorStop(0, 'rgba(160,255,200,0.34)');
        gl.addColorStop(1, 'rgba(160,255,200,0)');
        ctx.fillStyle = gl;
        ctx.beginPath(); ctx.moveTo(-8, 12); ctx.lineTo(8, 12); ctx.lineTo(34, 78); ctx.lineTo(-34, 78); ctx.closePath(); ctx.fill();
        ctx.fillStyle = 'rgba(190,240,255,0.85)';
        ctx.beginPath(); ctx.ellipse(0, -8 + bob, 15, 13, 0, Math.PI, TAU); ctx.fill();
        const bg = ctx.createLinearGradient(0, -2 + bob, 0, 14 + bob);
        bg.addColorStop(0, '#C9D6F2'); bg.addColorStop(1, '#6C7BA8');
        ctx.fillStyle = bg;
        ctx.beginPath(); ctx.ellipse(0, 4 + bob, 34, 11, 0, 0, TAU); ctx.fill();
        for (let i = 0; i < 5; i++) {
          const a = (G.t * 2.4 + i * 1.256) % TAU;
          ctx.fillStyle = `hsl(${(i * 70 + G.t * 90) % 360} 90% 65%)`;
          ctx.beginPath(); ctx.arc(Math.cos(a) * 26, 7 + bob + Math.sin(a) * 3, 2.6, 0, TAU); ctx.fill();
        }
      } else { // flock / bats
        const isBat = d.kind === 'bats';
        ctx.fillStyle = isBat ? 'rgba(20,16,40,0.8)' : 'rgba(45,45,70,0.5)';
        for (let i = 0; i < 5; i++) {
          const ox = i * 20 - 40 + Math.sin(d.bob + i) * 4;
          const oy = Math.abs(i - 2) * 9 + Math.sin(d.bob * 3 + i * 0.7) * 3;
          const w = 7 + Math.sin(d.bob * 9 + i) * 3.5;
          ctx.beginPath();
          if (isBat) {
            ctx.moveTo(ox - 9, oy - w * 0.4); ctx.quadraticCurveTo(ox - 4, oy + 3, ox, oy - 1);
            ctx.quadraticCurveTo(ox + 4, oy + 3, ox + 9, oy - w * 0.4);
            ctx.quadraticCurveTo(ox + 4, oy + 6, ox, oy + 3);
            ctx.quadraticCurveTo(ox - 4, oy + 6, ox - 9, oy - w * 0.4);
          } else {
            ctx.moveTo(ox - 9, oy); ctx.quadraticCurveTo(ox, oy - w, ox, oy + 1);
            ctx.quadraticCurveTo(ox, oy - w, ox + 9, oy);
            ctx.quadraticCurveTo(ox, oy + 3, ox - 9, oy);
          }
          ctx.fill();
        }
      }
      ctx.restore();
    }
  }

  /* ------------------------------------------------------------------- pipes */
  function drawPipe(p, pal) {
    const gy = p.drawY == null ? p.gapY : p.drawY;
    const top = gy - p.gap / 2, bot = gy + p.gap / 2;
    const gold = p.type === 'gold';
    const c = gold
      ? { a: '#FFF0AE', b: '#FFD447', c: '#C98A12', cap: '#FFDE6B', capDark: '#B8790C', line: '#8A5A05' }
      : { a: '#A7EF7C', b: '#5FC24A', c: '#2E7D32', cap: '#78D95C', capDark: '#2A6E2D', line: '#245C26' };

    const body = (x, y, w, h) => {
      const g = ctx.createLinearGradient(x, 0, x + w, 0);
      g.addColorStop(0, c.c); g.addColorStop(0.16, c.a);
      g.addColorStop(0.42, c.b); g.addColorStop(0.82, c.c);
      g.addColorStop(1, c.line);
      ctx.fillStyle = g;
      ctx.fillRect(x, y, w, h);
      ctx.fillStyle = 'rgba(255,255,255,0.22)';
      ctx.fillRect(x + w * 0.2, y, 5, h);
    };
    const cap = (x, y, w, h) => {
      const g = ctx.createLinearGradient(x, 0, x + w, 0);
      g.addColorStop(0, c.capDark); g.addColorStop(0.15, c.a);
      g.addColorStop(0.45, c.cap); g.addColorStop(0.85, c.capDark);
      g.addColorStop(1, c.line);
      ctx.fillStyle = g;
      roundRect(ctx, x, y, w, h, 7); ctx.fill();
      ctx.strokeStyle = rgba('#000000', 0.18); ctx.lineWidth = 2;
      roundRect(ctx, x + 1, y + 1, w - 2, h - 2, 6); ctx.stroke();
    };

    const capH = 28, over = 7;
    // upper pipe
    body(p.x, -240, PIPE_W, top + 240 - capH + 2);
    cap(p.x - over, top - capH, PIPE_W + over * 2, capH);
    // lower pipe
    body(p.x, bot + capH - 2, PIPE_W, PLAY_H - bot - capH + 40);
    cap(p.x - over, bot, PIPE_W + over * 2, capH);

    // a cute leaf sprout on some pipes
    if (p.leaf && !gold) {
      ctx.save();
      ctx.translate(p.x + PIPE_W - 6, bot + 4);
      ctx.rotate(-0.5 + Math.sin(G.t * 1.6 + p.seed) * 0.12);
      ctx.fillStyle = '#7ED957';
      ctx.beginPath(); ctx.ellipse(11, -4, 13, 6, 0, 0, TAU); ctx.fill();
      ctx.strokeStyle = '#4C9A34'; ctx.lineWidth = 1.4;
      ctx.beginPath(); ctx.moveTo(0, -1); ctx.lineTo(22, -5); ctx.stroke();
      ctx.restore();
    }
    if (gold) {
      // sparkles around a golden pipe
      ctx.save();
      for (let i = 0; i < 5; i++) {
        const t = G.t * 1.6 + i * 1.4 + p.seed;
        const yy = top - 20 + ((t * 40) % (p.gap + 40));
        const xx = p.x + PIPE_W / 2 + Math.sin(t * 2.2) * 40;
        const a = 0.35 + 0.45 * Math.sin(t * 3);
        ctx.globalAlpha = Math.max(0, a);
        star(xx, yy, 4 + Math.sin(t * 4) * 2, '#FFF6C9');
      }
      ctx.restore();
      ctx.save();
      ctx.globalAlpha = 0.22 + Math.sin(G.t * 3 + p.seed) * 0.08;
      ctx.fillStyle = '#FFE9A3';
      ctx.fillRect(p.x - 4, top - 30, PIPE_W + 8, 30);
      ctx.fillRect(p.x - 4, bot, PIPE_W + 8, 30);
      ctx.restore();
    }
  }

  function star(x, y, r, color) {
    ctx.fillStyle = color;
    ctx.beginPath();
    for (let i = 0; i < 10; i++) {
      const rr = i % 2 ? r * 0.42 : r;
      const a = -Math.PI / 2 + i * Math.PI / 5;
      const px = x + Math.cos(a) * rr, py = y + Math.sin(a) * rr;
      i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
    }
    ctx.closePath(); ctx.fill();
  }

  function drawCoins() {
    for (const c of coins) {
      const w = Math.abs(Math.cos(c.t * 0.9));
      const y = c.y + Math.sin(c.t * 0.5) * 3;
      ctx.save();
      ctx.translate(c.x, y);
      const gl = ctx.createRadialGradient(0, 0, 2, 0, 0, 22);
      gl.addColorStop(0, 'rgba(255,225,130,0.42)');
      gl.addColorStop(1, 'rgba(255,205,80,0)');
      ctx.fillStyle = gl; ctx.beginPath(); ctx.arc(0, 0, 22, 0, TAU); ctx.fill();
      ctx.scale(Math.max(0.16, w), 1);
      const g = ctx.createLinearGradient(-12, -12, 12, 12);
      g.addColorStop(0, '#FFF2AE'); g.addColorStop(0.5, '#FFD447'); g.addColorStop(1, '#D9931A');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(0, 0, 12, 0, TAU); ctx.fill();
      ctx.strokeStyle = '#B8790C'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(0, 0, 12, 0, TAU); ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,0.75)';
      ctx.beginPath(); ctx.arc(-3.5, -4, 3, 0, TAU); ctx.fill();
      if (w > 0.55) {
        ctx.fillStyle = '#C98A12';
        ctx.font = FONT(13, 800); ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText('★', 0, 1);
      }
      ctx.restore();
    }
  }

  function drawPowerups() {
    for (const u of powerups) {
      const y = u.y + Math.sin(u.t) * 7;
      const m = FX_META[u.kind];
      ctx.save();
      ctx.translate(u.x, y);
      const pulse = 1 + Math.sin(u.t * 2.4) * 0.07;
      const gl = ctx.createRadialGradient(0, 0, 3, 0, 0, 34);
      gl.addColorStop(0, rgba(hexish(m.color), 0.5));
      gl.addColorStop(1, rgba(hexish(m.color), 0));
      ctx.fillStyle = gl; ctx.beginPath(); ctx.arc(0, 0, 34, 0, TAU); ctx.fill();
      ctx.rotate(Math.sin(u.t * 1.2) * 0.16);
      ctx.scale(pulse, pulse);
      // capsule
      ctx.fillStyle = 'rgba(255,255,255,0.94)';
      ctx.beginPath(); ctx.arc(0, 0, 17, 0, TAU); ctx.fill();
      ctx.strokeStyle = m.color; ctx.lineWidth = 3.5;
      ctx.beginPath(); ctx.arc(0, 0, 17, 0, TAU); ctx.stroke();
      ctx.font = FONT(19, 700); ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(m.icon, 0, 2);
      ctx.restore();
    }
  }
  function hexish(c) { return c[0] === '#' ? c : '#ffffff'; }

  /* -------------------------------------------------------------------- bird */
  function drawBird(b) {
    const sk = skin();
    let c1 = sk.body[0], c2 = sk.body[1], wing = sk.wing, wingIn = sk.wingIn, belly = sk.belly, line = sk.line;
    if (sk.rainbow) {
      const h = (G.t * 90) % 360;
      c1 = `hsl(${h} 95% 78%)`; c2 = `hsl(${(h + 40) % 360} 85% 52%)`;
      wing = `hsl(${(h + 25) % 360} 85% 52%)`; wingIn = `hsl(${(h + 55) % 360} 95% 80%)`;
      belly = `hsl(${(h + 180) % 360} 100% 95%)`;
      line = `hsl(${(h + 30) % 360} 70% 28%)`;
    }
    const ghosting = b.fx.ghost > 0;

    // ground shadow
    if (G.state !== STATE.MENU) {
      const gy = PLAY_H + 8;
      const k = clamp(1 - (gy - b.y) / 420, 0.08, 0.5);
      ctx.save();
      ctx.globalAlpha = k * 0.35;
      ctx.fillStyle = '#000';
      ctx.beginPath(); ctx.ellipse(b.x, gy, 20 * k * 1.6 * b.scale, 6 * k * 1.6, 0, 0, TAU); ctx.fill();
      ctx.restore();
    }

    ctx.save();
    ctx.translate(b.x, b.y);
    ctx.rotate(b.rot);
    ctx.scale(b.scale, b.scale);
    if (ghosting) ctx.globalAlpha = 0.62 + Math.sin(G.t * 12) * 0.14;

    const wingAng = b.wing * 1.05;   // -1.2 (up-stroke) .. 0 (down-stroke)
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    const OL = 2.2;

    // ---- tail: three pointed feathers
    ctx.fillStyle = c2;
    ctx.strokeStyle = line; ctx.lineWidth = OL;
    for (let i = -1; i <= 1; i++) {
      ctx.save();
      ctx.translate(-13, 1);
      ctx.rotate(i * 0.34 + Math.sin(G.t * 3 + i) * 0.03);
      ctx.beginPath();
      ctx.moveTo(0, -5);
      ctx.quadraticCurveTo(-13, -4, -21, 0);
      ctx.quadraticCurveTo(-13, 4, 0, 5);
      ctx.closePath();
      ctx.fill(); ctx.stroke();
      ctx.restore();
    }

    // ---- far wing, tucked behind the body
    ctx.save();
    ctx.translate(-3, 0);
    ctx.rotate(-wingAng * 0.55 + 0.4);
    ctx.fillStyle = mixHex(hexish(sk.line), hexish(sk.wing), 0.45);
    ctx.strokeStyle = line; ctx.lineWidth = OL;
    ctx.beginPath(); ctx.ellipse(-9, 4, 13, 7.5, 0.22, 0, TAU); ctx.fill(); ctx.stroke();
    ctx.restore();

    // ---- body
    const bg = ctx.createRadialGradient(-3, -8, 2, 1, 5, 27);
    bg.addColorStop(0, c1); bg.addColorStop(1, c2);
    ctx.fillStyle = bg;
    ctx.strokeStyle = line; ctx.lineWidth = 2.6;
    ctx.beginPath(); ctx.ellipse(0, 0, 20, 17.5, 0, 0, TAU);
    ctx.fill(); ctx.stroke();

    // ---- belly patch (clipped to the body so it never spills past the outline)
    ctx.save();
    ctx.beginPath(); ctx.ellipse(0, 0, 19, 16.5, 0, 0, TAU); ctx.clip();
    ctx.fillStyle = belly;
    ctx.beginPath(); ctx.ellipse(4, 9, 15, 12, 0, 0, TAU); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.28)';
    ctx.beginPath(); ctx.ellipse(-3, -11, 10, 5.5, -0.28, 0, TAU); ctx.fill();
    ctx.restore();

    // ---- feet
    const legK = Math.sin(G.t * 6) * 1.2;
    ctx.strokeStyle = sk.beakDark; ctx.lineWidth = 2.8;
    ctx.beginPath(); ctx.moveTo(-1, 15); ctx.lineTo(-3, 21 + legK); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(5, 15); ctx.lineTo(4, 21 - legK); ctx.stroke();
    ctx.strokeStyle = sk.beak; ctx.lineWidth = 2.4;
    ctx.beginPath(); ctx.moveTo(-7, 21.5 + legK); ctx.lineTo(0, 20.5 + legK); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, 20.5 - legK); ctx.lineTo(7, 21.5 - legK); ctx.stroke();

    // ---- near wing, hinged low on the shoulder so it never covers the eye
    ctx.save();
    ctx.translate(-1, 3);
    ctx.rotate(wingAng + 0.22);
    const wg = ctx.createLinearGradient(-6, -8, -12, 10);
    wg.addColorStop(0, wingIn); wg.addColorStop(0.55, wing);
    wg.addColorStop(1, mixHex(hexish(sk.wing), hexish(sk.line), 0.35));
    ctx.fillStyle = wg;
    ctx.strokeStyle = line; ctx.lineWidth = OL;
    ctx.beginPath();
    ctx.moveTo(6, -3);
    ctx.quadraticCurveTo(-6, -11, -19, -4);
    ctx.quadraticCurveTo(-22, 6, -9, 10);
    ctx.quadraticCurveTo(0, 11, 6, 4);
    ctx.closePath();
    ctx.fill(); ctx.stroke();
    // feather separations
    ctx.strokeStyle = rgba(hexish(sk.line), 0.42); ctx.lineWidth = 1.3;
    for (let i = 0; i < 2; i++) {
      ctx.beginPath();
      ctx.moveTo(-16 + i * 6, -3 + i * 1.5);
      ctx.quadraticCurveTo(-9 + i * 5, 3, -2 + i * 4, 5.5);
      ctx.stroke();
    }
    ctx.restore();

    // ---- cheek blush
    ctx.fillStyle = rgba(hexish(sk.cheek), 0.5);
    ctx.beginPath(); ctx.ellipse(6, 4, 5, 3.4, 0, 0, TAU); ctx.fill();

    // ---- beak (drawn before the eye so the eye reads on top)
    ctx.strokeStyle = line; ctx.lineWidth = 1.9;
    ctx.fillStyle = sk.beak;
    ctx.beginPath();
    ctx.moveTo(14, -5.5);
    ctx.quadraticCurveTo(33, -0.5, 14, 8);
    ctx.quadraticCurveTo(11.5, 1, 14, -5.5);
    ctx.closePath();
    ctx.fill(); ctx.stroke();
    ctx.fillStyle = sk.beakDark;
    ctx.beginPath();
    ctx.moveTo(13.4, 1.6);
    ctx.quadraticCurveTo(25, 1.2, 14, 8);
    ctx.quadraticCurveTo(12, 4.5, 13.4, 1.6);
    ctx.closePath(); ctx.fill();

    // ---- eye
    const ex = 7.5, ey = -6.5;
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = line; ctx.lineWidth = 1.7;
    ctx.beginPath(); ctx.arc(ex, ey, 6.6, 0, TAU); ctx.fill(); ctx.stroke();
    const look = clamp(b.vy / 900, -0.6, 0.9);
    ctx.fillStyle = '#2B2140';
    ctx.beginPath(); ctx.arc(ex + 1.6, ey + look * 2.4, 3.3, 0, TAU); ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.beginPath(); ctx.arc(ex + 0.3, ey - 1.8 + look, 1.4, 0, TAU); ctx.fill();
    if (b.blink > 0) {
      const k = 1 - Math.min(1, b.blink / 0.14);
      ctx.fillStyle = c1;
      ctx.strokeStyle = line; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.ellipse(ex, ey, 7, 7 * (1 - k) + 0.8, 0, 0, TAU);
      ctx.fill(); ctx.stroke();
    }
    // a tiny tuft on the head — the cute finishing touch
    ctx.strokeStyle = c2; ctx.lineWidth = 2.6;
    ctx.beginPath();
    ctx.moveTo(-2, -16.5);
    ctx.quadraticCurveTo(0, -24 + Math.sin(G.t * 5) * 1.5, 5, -23 + Math.sin(G.t * 5) * 1.5);
    ctx.stroke();

    ctx.restore();

    // bubble shield
    if (b.shield) {
      ctx.save();
      const r = 30 * b.scale + Math.sin(G.t * 4) * 1.6;
      const gl = ctx.createRadialGradient(b.x - 8, b.y - 10, 2, b.x, b.y, r);
      gl.addColorStop(0, 'rgba(255,255,255,0.42)');
      gl.addColorStop(0.7, 'rgba(150,230,255,0.10)');
      gl.addColorStop(1, 'rgba(120,210,255,0.36)');
      ctx.fillStyle = gl;
      ctx.beginPath(); ctx.arc(b.x, b.y, r, 0, TAU); ctx.fill();
      ctx.strokeStyle = 'rgba(190,245,255,0.8)'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(b.x, b.y, r, 0, TAU); ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,0.75)';
      ctx.beginPath(); ctx.ellipse(b.x - r * 0.4, b.y - r * 0.5, 5, 3, -0.6, 0, TAU); ctx.fill();
      ctx.restore();
    }
    // ghost ring
    if (ghosting) {
      ctx.save();
      ctx.globalAlpha = 0.5 + Math.sin(G.t * 9) * 0.2;
      ctx.strokeStyle = `hsl(${(G.t * 260) % 360} 95% 70%)`;
      ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(b.x, b.y, 26 * b.scale, 0, TAU); ctx.stroke();
      ctx.restore();
    }
  }

  /* --------------------------------------------------------------- particles */
  function drawParticles() {
    for (const p of parts) {
      const a = clamp(p.life / p.max, 0, 1);
      ctx.save();
      ctx.globalAlpha = a * (p.kind === 'wind' ? 0.3 : 0.9);
      if (p.kind === 'feather') {
        ctx.translate(p.x, p.y); ctx.rotate(p.rot);
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.moveTo(0, -p.size); ctx.quadraticCurveTo(p.size * 0.8, 0, 0, p.size);
        ctx.quadraticCurveTo(-p.size * 0.8, 0, 0, -p.size);
        ctx.fill();
      } else if (p.kind === 'wind') {
        ctx.strokeStyle = p.color; ctx.lineWidth = 2; ctx.lineCap = 'round';
        ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x - Math.sign(p.vx) * p.size, p.y); ctx.stroke();
      } else if (p.kind === 'trail') {
        ctx.fillStyle = p.color;
        ctx.beginPath(); ctx.arc(p.x, p.y, p.size * a, 0, TAU); ctx.fill();
      } else {
        ctx.fillStyle = p.color;
        ctx.beginPath(); ctx.arc(p.x, p.y, p.size * (0.4 + a * 0.6), 0, TAU); ctx.fill();
      }
      ctx.restore();
    }
  }

  function drawWeather() {
    if (weather.intensity < 0.02) return;
    ctx.save();
    for (const d of drops) {
      if (d.snow) {
        ctx.globalAlpha = 0.72 * weather.intensity;
        ctx.fillStyle = '#fff';
        ctx.beginPath(); ctx.arc(d.x, d.y, d.s, 0, TAU); ctx.fill();
      } else {
        ctx.globalAlpha = 0.34 * weather.intensity;
        ctx.strokeStyle = '#DCEEFF'; ctx.lineWidth = 1.6; ctx.lineCap = 'round';
        ctx.beginPath(); ctx.moveTo(d.x, d.y); ctx.lineTo(d.x + 3, d.y - d.s); ctx.stroke();
      }
    }
    ctx.restore();
  }

  /* --------------------------------------------------------------------- HUD */
  function drawEffectBars() {
    const list = [];
    for (const k of ['star', 'magnet', 'shrink', 'slow']) {
      const key = k === 'star' ? 'ghost' : k;
      if (bird.fx[key] > 0) list.push({ k, v: bird.fx[key] / FX_META[k].dur });
    }
    let y = 54;
    for (const it of list) {
      const m = FX_META[it.k];
      ctx.save();
      ctx.globalAlpha = it.v < 0.22 ? 0.5 + 0.5 * Math.abs(Math.sin(G.t * 10)) : 1;
      ctx.fillStyle = 'rgba(20,16,38,0.42)';
      roundRect(ctx, 12, y, 96, 22, 11); ctx.fill();
      ctx.fillStyle = m.color;
      roundRect(ctx, 14, y + 2, Math.max(4, 92 * it.v), 18, 9); ctx.fill();
      ctx.font = FONT(14, 700); ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      ctx.fillStyle = '#2B2140';
      ctx.fillText(m.icon + ' ' + Math.ceil(bird.fx[it.k === 'star' ? 'ghost' : it.k]) + 's', 20, y + 12);
      ctx.restore();
      y += 27;
    }
  }

  function drawHud() {
    if (G.state === STATE.PLAY || G.state === STATE.DYING) {
      const pop = G.state === STATE.PLAY ? 1 + Math.max(0, 0.18 - (G.t % 100 === 0 ? 0 : 0)) : 1;
      text(String(G.score), W / 2, 74, 56 * pop, { fill: '#FFFFFF', stroke: '#3A2A55', lw: 8 });
      // small stats row
      ctx.save();
      ctx.globalAlpha = 0.9;
      text('🪙 ' + G.coins, W - 16, 40, 20, { align: 'right', fill: '#FFE9A3', lw: 3.4 });
      ctx.restore();
      drawEffectBars();
      if (G.combo > 1 && G.comboTimer > 0) {
        const a = clamp(G.comboTimer / 2.4, 0, 1);
        ctx.save(); ctx.globalAlpha = 0.35 + a * 0.65;
        text('COMBO ×' + Math.min(5, G.combo), W / 2, 108, 22, { fill: '#FFE066', lw: 4 });
        ctx.restore();
      }
      if (Math.abs(G.wind) > 12) {
        ctx.save(); ctx.globalAlpha = 0.75;
        text(G.wind > 0 ? '💨 →' : '← 💨', W / 2, PLAY_H - 14, 20, { fill: '#EAF6FF', lw: 3.4 });
        ctx.restore();
      }
      if (bird.fx.slow > 0) {
        ctx.save();
        ctx.globalAlpha = 0.1 + 0.05 * Math.sin(G.t * 4);
        ctx.fillStyle = '#AEE6FF';
        ctx.fillRect(0, 0, W, H);
        ctx.restore();
      }
    }
  }

  function medalArt(x, y, r, kind) {
    const map = {
      bronze: ['#F0B27A', '#B9642B', '#8A4418'],
      silver: ['#F2F4F7', '#B6BDC9', '#7E8794'],
      gold: ['#FFF0A8', '#FFC93C', '#C58A0E'],
      platinum: ['#EAFBFF', '#9FE0F0', '#4E93A8'],
      rainbow: null
    };
    ctx.save();
    ctx.translate(x, y);
    // ribbon
    ctx.fillStyle = '#E4573D';
    ctx.beginPath(); ctx.moveTo(-r * 0.8, -r * 1.7); ctx.lineTo(-r * 0.1, -r * 0.5); ctx.lineTo(-r * 0.9, -r * 0.4); ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#C43F2C';
    ctx.beginPath(); ctx.moveTo(r * 0.8, -r * 1.7); ctx.lineTo(r * 0.1, -r * 0.5); ctx.lineTo(r * 0.9, -r * 0.4); ctx.closePath(); ctx.fill();

    if (kind === 'rainbow') {
      const g = ctx.createLinearGradient(-r, -r, r, r);
      for (let i = 0; i <= 6; i++) g.addColorStop(i / 6, `hsl(${(i * 60 + G.t * 60) % 360} 92% 62%)`);
      ctx.fillStyle = g;
    } else {
      const c = map[kind];
      const g = ctx.createRadialGradient(-r * 0.35, -r * 0.4, r * 0.15, 0, 0, r);
      g.addColorStop(0, c[0]); g.addColorStop(0.55, c[1]); g.addColorStop(1, c[2]);
      ctx.fillStyle = g;
    }
    ctx.beginPath(); ctx.arc(0, 0, r, 0, TAU); ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.2)'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(0, 0, r, 0, TAU); ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.45)';
    ctx.beginPath(); ctx.arc(0, 0, r * 0.72, Math.PI * 0.9, Math.PI * 1.7); ctx.stroke();
    ctx.font = FONT(r * 1.05, 800); ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.fillText('🐤', 0, 2);
    ctx.restore();
  }

  function drawMenu() {
    const bob = Math.sin(G.t * 2) * 5;
    // title card
    ctx.save();
    ctx.translate(W / 2, 142 + bob);
    ctx.rotate(Math.sin(G.t * 1.1) * 0.014);
    text('FLAPPY', 0, 0, 62, { fill: '#FFE066', stroke: '#8A4E12', lw: 11 });
    text('FEATHERS', 0, 52, 46, { fill: '#FFF8EE', stroke: '#8A4E12', lw: 9 });
    ctx.restore();

    // best score pill
    ctx.save();
    ctx.fillStyle = 'rgba(20,16,38,0.32)';
    roundRect(ctx, W / 2 - 92, 240, 184, 40, 14); ctx.fill();
    ctx.restore();
    text('BEST  ' + G.best, W / 2, 268, 24, { fill: '#FFE9A3', lw: 4.2 });

    // costume line sits above the hero bird
    text(skin().name + (unlockedSkins() < SKINS.length ? '  ·  ' + unlockedSkins() + '/' + SKINS.length + ' birds' : '  ·  all birds! 🎉'),
      W / 2, 348, 18, { fill: '#FFF8EE', lw: 3.2 });
    ctx.save(); ctx.globalAlpha = 0.85;
    text('🪶 tap the bird to change costume', W / 2, 372, 15, { fill: '#FFF3C4', lw: 2.8 });
    ctx.restore();

    const a = 0.55 + 0.45 * Math.sin(G.t * 3.2);
    ctx.save(); ctx.globalAlpha = a;
    text('TAP  ·  CLICK  ·  SPACE', W / 2, 522, 26, { fill: '#FFFFFF', lw: 5 });
    ctx.restore();
    text('to fly', W / 2, 550, 18, { fill: '#FFF3C4', lw: 3.2 });
  }

  function drawReady() {
    const a = 0.5 + 0.5 * Math.sin(G.t * 4.5);
    ctx.save(); ctx.globalAlpha = a;
    text('FLAP!', W / 2, PLAY_H * 0.3, 40, { fill: '#FFFFFF', lw: 7 });
    ctx.restore();
    // tap arrow hint
    ctx.save();
    ctx.globalAlpha = 0.7 + 0.3 * Math.sin(G.t * 4.5);
    ctx.translate(BIRD_X + 4, PLAY_H * 0.45 - 62 + Math.sin(G.t * 4.5) * 6);
    ctx.fillStyle = '#FFFFFF';
    ctx.beginPath(); ctx.moveTo(0, 14); ctx.lineTo(-11, 0); ctx.lineTo(11, 0); ctx.closePath(); ctx.fill();
    ctx.fillRect(-4, -16, 8, 17);
    ctx.restore();
    text(String(G.score), W / 2, 74, 56, { fill: '#FFFFFF', stroke: '#3A2A55', lw: 8 });
  }

  function drawOver() {
    const t = clamp(G.overT / 0.42, 0, 1);
    const e = 1 - Math.pow(1 - t, 3);
    ctx.save();
    ctx.globalAlpha = 0.55 * e;
    ctx.fillStyle = '#140F26';
    ctx.fillRect(0, 0, W, H);
    ctx.restore();

    const panelH = OVER_H;
    const y0 = lerp(-panelH, OVER_Y, e);
    ctx.save();
    ctx.translate(W / 2, y0);
    // card
    ctx.fillStyle = '#FFF8EE';
    roundRect(ctx, -164, 0, 328, panelH, 22); ctx.fill();
    ctx.fillStyle = 'rgba(0,0,0,0.10)';
    roundRect(ctx, -164, panelH - 10, 328, 10, 10); ctx.fill();
    ctx.strokeStyle = '#E8D9C2'; ctx.lineWidth = 3;
    roundRect(ctx, -164, 0, 328, panelH, 22); ctx.stroke();

    text('GAME OVER', 0, 46, 36, { fill: '#F07E3D', stroke: '#8A4E12', lw: 6.5 });

    // medal
    if (G.medal) {
      medalArt(-104, 134, 36, G.medal);
      ctx.font = FONT(14, 700); ctx.textAlign = 'center'; ctx.fillStyle = '#8A7FA8';
      ctx.fillText(G.medal.toUpperCase(), -104, 194);
    } else {
      ctx.save();
      ctx.globalAlpha = 0.5;
      ctx.strokeStyle = '#CFC4B4'; ctx.lineWidth = 3;
      ctx.setLineDash([6, 6]);
      ctx.beginPath(); ctx.arc(-104, 134, 36, 0, TAU); ctx.stroke();
      ctx.restore();
      ctx.font = FONT(12, 700); ctx.textAlign = 'center'; ctx.fillStyle = '#A99DBB';
      ctx.fillText('5 pts for', -104, 130); ctx.fillText('a medal', -104, 146);
    }

    // score / best / time
    ctx.textAlign = 'left';
    ctx.font = FONT(13, 700); ctx.fillStyle = '#9A8FB4';
    ctx.fillText('SCORE', -42, 94);
    ctx.font = FONT(44, 800); ctx.fillStyle = '#4A3A6B';
    ctx.fillText(String(G.score), -42, 134);
    ctx.font = FONT(13, 700); ctx.fillStyle = '#9A8FB4';
    ctx.fillText('BEST', -42, 160);
    ctx.font = FONT(26, 800); ctx.fillStyle = '#6B5E8A';
    ctx.fillText(String(G.best), -42, 184);
    ctx.font = FONT(13, 700); ctx.fillStyle = '#9A8FB4';
    ctx.fillText('TIME', -42, 210);
    ctx.font = FONT(26, 800); ctx.fillStyle = '#6B5E8A';
    ctx.fillText(formatRunTime(G.runTime), -42, 234);

    ctx.font = FONT(14, 700); ctx.fillStyle = '#9A8FB4'; ctx.textAlign = 'right';
    ctx.fillText('\ud83e\ude99 ' + G.coins + '   \u00d7' + Math.min(5, G.bestCombo || 1) + ' best combo', 150, 184);

    if (G.newBest) {
      ctx.save();
      ctx.translate(96, 66);
      ctx.rotate(-0.14 + Math.sin(G.t * 5) * 0.03);
      ctx.fillStyle = '#F0679B';
      roundRect(ctx, -52, -15, 104, 30, 8); ctx.fill();
      ctx.font = FONT(16, 800); ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillStyle = '#fff';
      ctx.fillText('NEW BEST!', 0, 1);
      ctx.restore();
    }

    // unlock hint
    const nextSkin = SKINS.find(s => s.unlock > G.best);
    ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
    ctx.font = FONT(13, 700); ctx.fillStyle = '#A99DBB';
    ctx.fillText(nextSkin ? `next bird "${nextSkin.name}" at ${nextSkin.unlock} pts` : 'every bird unlocked \u2728', 0, 274);

    // "Email score" button — only tappable once the card has settled, so the
    // dimming press-state doubles as the affordance that it is live yet
    const live = G.overT > 0.55;
    const b = MAIL_BTN;
    ctx.save();
    ctx.globalAlpha = live ? 1 : 0.45;
    ctx.fillStyle = '#E0912F';
    roundRect(ctx, b.x, b.y + 4, b.w, b.h, 12); ctx.fill();
    const grad = ctx.createLinearGradient(0, b.y, 0, b.y + b.h);
    grad.addColorStop(0, '#FFD45E'); grad.addColorStop(1, '#FFC93C');
    ctx.fillStyle = grad;
    roundRect(ctx, b.x, b.y, b.w, b.h, 12); ctx.fill();
    ctx.font = FONT(17, 800); ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillStyle = '#6B3C06';
    ctx.fillText('\ud83d\udce7  Email score', 0, b.y + b.h / 2 + 1);
    ctx.restore();
    ctx.textBaseline = 'alphabetic';

    ctx.restore();

    if (live) {
      const a2 = 0.55 + 0.45 * Math.sin(G.t * 4);
      ctx.save(); ctx.globalAlpha = a2;
      text('TAP ANYWHERE TO FLY AGAIN', W / 2, y0 + panelH + 46, 21, { fill: '#FFFFFF', lw: 4.5 });
      ctx.restore();
    }
  }

  function drawPaused() {
    ctx.save();
    ctx.fillStyle = 'rgba(20,16,38,0.55)';
    ctx.fillRect(0, 0, W, H);
    text('PAUSED', W / 2, H / 2 - 6, 44, { fill: '#FFF8EE', lw: 8 });
    text('press P to resume', W / 2, H / 2 + 30, 18, { fill: '#DCD2EE', lw: 3.2 });
    ctx.restore();
  }

  function drawToasts() {
    for (const t of toasts) {
      const a = clamp(t.life / t.max, 0, 1);
      ctx.save();
      ctx.globalAlpha = Math.min(1, a * 1.6);
      const s = t.size * (1 + (1 - a) * 0.14);
      text(t.str, clamp(t.x, 70, W - 70), t.y, s, { fill: t.color, lw: s * 0.16 });
      ctx.restore();
    }
  }

  /* ---------------------------------------------------------------- compose */
  function render() {
    const pal = mixPalette(G.worldT / DAY_LENGTH);

    ctx.save();
    if (G.shake > 0.3) {
      ctx.translate(rand(-G.shake, G.shake) * 0.5, rand(-G.shake, G.shake) * 0.5);
    }

    drawSky(pal);
    drawStars(pal);
    drawCelestial(pal);
    drawClouds(pal);
    drawDecor(pal);
    drawHills(pal);
    drawFireflies(pal);

    for (const p of pipes) drawPipe(p, pal);
    drawCoins();
    drawPowerups();
    drawParticles();
    drawBird(bird);
    drawGround(pal);
    drawWeather();

    // night veil — tints the whole world in one pass
    if (pal.dark > 0.01) {
      ctx.save();
      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = rgba('#0A1030', pal.dark * 0.42);
      ctx.fillRect(0, 0, W, H);
      ctx.restore();
    }
    // warm sunset wash
    ctx.restore();

    drawToasts();
    drawHud();

    if (G.state === STATE.MENU) drawMenu();
    else if (G.state === STATE.READY) drawReady();
    else if (G.state === STATE.OVER) drawOver();

    if (G.flash > 0.01) {
      ctx.save();
      ctx.globalAlpha = clamp(G.flash, 0, 0.8);
      ctx.fillStyle = G.flashColor;
      ctx.fillRect(0, 0, W, H);
      ctx.restore();
    }
    if (G.paused) drawPaused();

    // vignette to focus the eye
    ctx.save();
    const vg = ctx.createRadialGradient(W / 2, H * 0.45, H * 0.32, W / 2, H * 0.45, H * 0.78);
    vg.addColorStop(0, 'rgba(0,0,0,0)');
    vg.addColorStop(1, 'rgba(0,0,0,0.28)');
    ctx.fillStyle = vg;
    ctx.fillRect(0, 0, W, H);
    ctx.restore();
  }

  /* ------------------------------------------------------------------- loop */
  let last = performance.now(), acc = 0;
  const STEP = 1 / 120;
  function frame(now) {
    let dt = (now - last) / 1000;
    last = now;
    if (dt > 0.25) dt = 0.25;
    if (!G.paused && helpEl.classList.contains('hidden')) {
      acc += dt;
      let guard = 0;
      while (acc >= STEP && guard++ < 40) { update(STEP); acc -= STEP; }
    } else {
      G.t += dt; // keep menus/overlays animating
    }
    render();
    requestAnimationFrame(frame);
  }

  resize();
  // Baloo may still be loading; redraw once it lands so the title is not jumpy
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => render());
  requestAnimationFrame(frame);
})();
