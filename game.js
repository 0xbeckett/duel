/* RALLY — a two-thumb, phone-flat-on-the-table deflect duel.
 * Vanilla Canvas + Web Audio. No engine, no build step. One file.
 *
 * Layout: portrait canvas. P1 defends the BOTTOM edge, P2 the TOP edge.
 * The puck ricochets off the side walls and both paddles, speeding up every
 * volley. Miss it and the other player scores. First to N goals wins a round;
 * take the majority of a best-of series to win the match. Everything persists
 * to localStorage so a refresh or an accidental close never loses the game.
 */
(() => {
  'use strict';

  // ---------------------------------------------------------------- constants
  const SAVE_KEY = 'rally.save.v1';
  const SPEEDS = {
    chill:  { base: 0.42, volley: 1.035, max: 1.35, dash: 1.16 },
    normal: { base: 0.52, volley: 1.045, max: 1.70, dash: 1.20 },
    fast:   { base: 0.64, volley: 1.055, max: 2.05, dash: 1.24 },
  };
  const DASH_COOLDOWN = 1.5;   // seconds
  const DASH_DURATION = 0.16;  // seconds of lunge
  const DASH_REACH = 0.075;    // fraction of height the paddle lunges inward
  const ENGLISH = 0.55;        // how much off-center hits curve the puck sideways
  const PADDLE_VX_TRANSFER = 0.22;
  const FIXED_DT = 1 / 120;    // physics tick
  const TRAIL_LEN = 14;

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ------------------------------------------------------------------ helpers
  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const $ = (id) => document.getElementById(id);

  // -------------------------------------------------------------- persistence
  const DEFAULT_SETTINGS = {
    name1: '', name2: '', sound: true, speed: 'normal', goals: 5, series: 3,
  };
  const DEFAULT_STATS = { life1: 0, life2: 0 };

  function loadSave() {
    try {
      const raw = localStorage.getItem(SAVE_KEY);
      if (!raw) return { settings: { ...DEFAULT_SETTINGS }, stats: { ...DEFAULT_STATS }, match: null };
      const p = JSON.parse(raw);
      return {
        settings: { ...DEFAULT_SETTINGS, ...(p.settings || {}) },
        stats: { ...DEFAULT_STATS, ...(p.stats || {}) },
        match: p.match || null,
      };
    } catch {
      return { settings: { ...DEFAULT_SETTINGS }, stats: { ...DEFAULT_STATS }, match: null };
    }
  }
  let save = loadSave();

  function persist() {
    try { localStorage.setItem(SAVE_KEY, JSON.stringify(save)); } catch { /* quota / private mode */ }
  }

  // ---------------------------------------------------------------- audio
  const Audio = (() => {
    let ctx = null, master = null;
    function ensure() {
      if (ctx) return;
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = 0.32;
      master.connect(ctx.destination);
    }
    function resume() { ensure(); if (ctx && ctx.state === 'suspended') ctx.resume(); }
    function tone(freq, dur, type = 'sine', vol = 1, glideTo = null) {
      if (!save.settings.sound) return;
      ensure(); if (!ctx) return;
      const t = ctx.currentTime;
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = type;
      o.frequency.setValueAtTime(freq, t);
      if (glideTo) o.frequency.exponentialRampToValueAtTime(Math.max(1, glideTo), t + dur);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(vol, t + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g); g.connect(master);
      o.start(t); o.stop(t + dur + 0.02);
    }
    return {
      resume,
      paddle(speed01) { tone(320 + speed01 * 520, 0.09, 'triangle', 0.9); },
      wall() { tone(180, 0.06, 'sine', 0.5); },
      dash() { tone(140, 0.14, 'sawtooth', 0.55, 520); },
      goal() { tone(660, 0.5, 'sawtooth', 0.8, 90); },
      count() { tone(520, 0.12, 'square', 0.5); },
      go() { tone(880, 0.22, 'square', 0.7); },
      win() {
        [523, 659, 784, 1047].forEach((f, i) =>
          setTimeout(() => tone(f, 0.32, 'triangle', 0.8), i * 130));
      },
    };
  })();

  function haptic(ms) {
    if (navigator.vibrate) { try { navigator.vibrate(ms); } catch { /* noop */ } }
  }

  // ------------------------------------------------------------- canvas setup
  const canvas = $('game');
  const ctx = canvas.getContext('2d');
  let W = 0, H = 0, DPR = 1;
  const geo = {};

  function computeGeometry() {
    const s = W; // scale references to width for consistent feel
    geo.wall = Math.max(10, W * 0.035);
    geo.left = geo.wall;
    geo.right = W - geo.wall;
    geo.puckR = clamp(W * 0.030, 9, 26);
    geo.padHalf = clamp(W * 0.115, 44, 220);
    geo.padR = clamp(H * 0.0135, 7, 18);
    geo.padInset = H * 0.085;
    geo.padY1 = H - geo.padInset;      // bottom paddle rest line
    geo.padY2 = geo.padInset;          // top paddle rest line
    geo.dash = H * DASH_REACH;
    geo.minPadX = geo.left + geo.padHalf;
    geo.maxPadX = geo.right - geo.padHalf;
    void s;
  }

  function resize() {
    DPR = Math.min(window.devicePixelRatio || 1, 3);
    W = window.innerWidth;
    H = window.innerHeight;
    canvas.width = Math.round(W * DPR);
    canvas.height = Math.round(H * DPR);
    canvas.style.width = W + 'px';
    canvas.style.height = H + 'px';
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    computeGeometry();
    // keep paddles/puck inside the new bounds
    if (G.puck) {
      G.padX1 = clamp(G.padX1, geo.minPadX, geo.maxPadX);
      G.padX2 = clamp(G.padX2, geo.minPadX, geo.maxPadX);
    }
  }

  // ------------------------------------------------------------- game state
  const G = {
    phase: 'home',            // home | countdown | playing | goal | roundover | win | paused
    prevPhase: null,
    roundScore: { p1: 0, p2: 0 },
    seriesScore: { p1: 0, p2: 0 },
    round: 1,
    serveTo: 1,               // which player receives the serve (2 = up toward top)
    speedMul: 1,              // current volley multiplier
    puck: null,               // {x,y,vx,vy}
    padX1: 0, padX2: 0,
    padVX1: 0, padVX2: 0,
    padPrevX1: 0, padPrevX2: 0,
    lunge1: 0, lunge2: 0,     // 0..1 dash lunge progress (eased inward offset)
    dashT1: 0, dashT2: 0,     // remaining dash active time
    cool1: 0, cool2: 0,       // dash cooldown remaining
    trail: [],
    particles: [],
    confetti: [],
    shake: 0,
    flash: 0, flashColor: '#fff',
    countT: 0, countN: 0,
    goalT: 0,
    winner: 0,
    saveTimer: 0,
  };

  const SP = () => SPEEDS[save.settings.speed] || SPEEDS.normal;
  const nameOf = (p) => (p === 1 ? (save.settings.name1 || 'Player 1') : (save.settings.name2 || 'Player 2'));
  const colorOf = (p) => (p === 1 ? '#34d399' : '#a78bfa');
  const roundsToWin = () => Math.ceil(save.settings.series / 2);

  // ------------------------------------------------------------- match flow
  function baseSpeed() { return SP().base * H; }

  function centerPuck() {
    G.puck = { x: W / 2, y: H / 2, vx: 0, vy: 0 };
    G.trail.length = 0;
    G.speedMul = 1;
  }

  function serve() {
    // send the puck toward whoever is receiving (serveTo); slight random angle
    const dir = G.serveTo === 2 ? -1 : 1;          // toward top = up = negative y
    const ang = (Math.random() - 0.5) * 0.5;       // spread
    const sp = baseSpeed();
    G.puck.vx = Math.sin(ang) * sp;
    G.puck.vy = dir * Math.cos(ang) * sp;
    G.speedMul = 1;
  }

  function startCountdown(n = 3) {
    setPhase('countdown');
    G.countN = n;
    G.countT = 0;
    Audio.count();
    updateCountdownText(n);
  }

  function newMatch() {
    G.roundScore = { p1: 0, p2: 0 };
    G.seriesScore = { p1: 0, p2: 0 };
    G.round = 1;
    G.serveTo = Math.random() < 0.5 ? 1 : 2;
    G.padX1 = G.padX2 = W / 2;
    G.padPrevX1 = G.padPrevX2 = W / 2;
    G.cool1 = G.cool2 = 0;
    G.lunge1 = G.lunge2 = 0;
    centerPuck();
    G.winner = 0;
    hideAllOverlays();
    $('hud').classList.remove('hidden');
    syncHud();
    startCountdown(3);
    saveMatch(); // after phase is 'countdown' so the snapshot is resumable
  }

  function nextRound() {
    G.round++;
    G.roundScore = { p1: 0, p2: 0 };
    // loser of the last round serves-receives first
    G.serveTo = G.winner === 1 ? 2 : 1;
    G.padX1 = G.padX2 = W / 2;
    centerPuck();
    hideAllOverlays();
    $('hud').classList.remove('hidden');
    syncHud();
    startCountdown(3);
    saveMatch(); // after phase is 'countdown' so the snapshot is resumable
  }

  function onGoal(scorer) {
    const key = scorer === 1 ? 'p1' : 'p2';
    G.roundScore[key]++;
    const gx = G.puck.x;
    const gy = scorer === 1 ? 0 : H; // puck exited the loser's edge
    burst(gx, gy, colorOf(scorer), 34);
    G.shake = Math.min(1, G.shake + 0.9);
    G.flash = 1; G.flashColor = colorOf(scorer);
    Audio.goal();
    haptic([30, 40, 60]);
    syncHud();

    if (G.roundScore[key] >= save.settings.goals) {
      onRoundWin(scorer);
    } else {
      // brief pause, then serve to the player who just conceded
      G.serveTo = scorer === 1 ? 2 : 1;
      setPhase('goal');
      G.goalT = 0.9;
      centerPuck();
      saveMatch();
    }
  }

  function onRoundWin(winner) {
    const key = winner === 1 ? 'p1' : 'p2';
    G.seriesScore[key]++;
    G.winner = winner;
    if (G.seriesScore[key] >= roundsToWin()) {
      onSeriesWin(winner);
    } else {
      setPhase('roundover');
      renderRoundOverCards();
      saveMatch();
    }
  }

  function onSeriesWin(winner) {
    G.winner = winner;
    if (winner === 1) save.stats.life1++; else save.stats.life2++;
    setPhase('win');
    save.match = null; // series complete — nothing to resume
    persist();
    spawnConfetti(colorOf(winner));
    Audio.win();
    haptic([40, 60, 40, 60, 120]);
    renderWinCards();
  }

  // ------------------------------------------------------------- phase helper
  function setPhase(p) {
    G.prevPhase = G.phase;
    G.phase = p;
    if (p === 'countdown' || p === 'playing') $('hud').classList.remove('hidden');
    $('countdown').classList.toggle('hidden', p !== 'countdown');
    $('pause').classList.toggle('hidden', p !== 'paused');
    $('roundover').classList.toggle('hidden', p !== 'roundover');
    $('win').classList.toggle('hidden', p !== 'win');
  }

  // ------------------------------------------------------------- save/restore
  function saveMatch() {
    if (G.phase === 'home' || G.phase === 'win') { if (G.phase === 'home') save.match = null; persist(); return; }
    save.match = {
      phase: G.phase === 'paused' ? (G.prevPhase || 'playing') : G.phase,
      roundScore: { ...G.roundScore },
      seriesScore: { ...G.seriesScore },
      round: G.round,
      serveTo: G.serveTo,
      speedMul: G.speedMul,
      puck: G.puck ? { x: G.puck.x / W, y: G.puck.y / H, vx: G.puck.vx / H, vy: G.puck.vy / H } : null,
      padX1: G.padX1 / W, padX2: G.padX2 / W,
    };
    persist();
  }

  function hasResumable() {
    return !!(save.match && ['playing', 'countdown', 'goal', 'roundover'].includes(save.match.phase));
  }

  function restoreMatch() {
    const m = save.match;
    if (!m) return false;
    G.roundScore = { ...m.roundScore };
    G.seriesScore = { ...m.seriesScore };
    G.round = m.round || 1;
    G.serveTo = m.serveTo || 1;
    G.speedMul = m.speedMul || 1;
    G.padX1 = clamp((m.padX1 ?? 0.5) * W, geo.minPadX, geo.maxPadX);
    G.padX2 = clamp((m.padX2 ?? 0.5) * W, geo.minPadX, geo.maxPadX);
    G.padPrevX1 = G.padX1; G.padPrevX2 = G.padX2;
    G.cool1 = G.cool2 = 0;
    if (m.puck) {
      G.puck = { x: m.puck.x * W, y: m.puck.y * H, vx: m.puck.vx * H, vy: m.puck.vy * H };
    } else {
      centerPuck();
    }
    G.trail.length = 0;
    hideAllOverlays();
    $('hud').classList.remove('hidden');
    syncHud();

    if (m.phase === 'roundover') {
      setPhase('roundover');
      renderRoundOverCards();
    } else {
      // ease back in with a fresh countdown, then continue with the saved puck
      G.resumeServe = !m.puck || (Math.hypot(m.puck.vx, m.puck.vy) < 0.02);
      startCountdown(3);
    }
    return true;
  }

  // ------------------------------------------------------------- input
  const pointers = new Map(); // pointerId -> {side, downX, downY, downT, moved}

  function sideForY(y) { return y < H / 2 ? 2 : 1; } // top half controls P2

  function onPointerDown(e) {
    Audio.resume();
    if (G.phase !== 'playing' && G.phase !== 'countdown' && G.phase !== 'goal') return;
    const y = e.clientY;
    const side = sideForY(y);
    pointers.set(e.pointerId, { side, downX: e.clientX, downY: y, downT: perfNow(), moved: false });
    applyPointer(side, e.clientX);
  }
  function onPointerMove(e) {
    const p = pointers.get(e.pointerId);
    if (!p) return;
    if (Math.hypot(e.clientX - p.downX, e.clientY - p.downY) > 10) p.moved = true;
    applyPointer(p.side, e.clientX);
  }
  function onPointerUp(e) {
    const p = pointers.get(e.pointerId);
    if (!p) return;
    pointers.delete(e.pointerId);
    // a quick, still tap = dash
    const dt = perfNow() - p.downT;
    if (!p.moved && dt < 220) tryDash(p.side);
  }

  function applyPointer(side, clientX) {
    const x = clamp(clientX, geo.minPadX, geo.maxPadX);
    if (side === 1) G.targetX1 = x; else G.targetX2 = x;
  }

  function tryDash(side) {
    if (side === 1 && G.cool1 <= 0) {
      G.cool1 = DASH_COOLDOWN; G.dashT1 = DASH_DURATION; Audio.dash(); haptic(15);
    } else if (side === 2 && G.cool2 <= 0) {
      G.cool2 = DASH_COOLDOWN; G.dashT2 = DASH_DURATION; Audio.dash(); haptic(15);
    }
  }

  let _perfBase = null;
  function perfNow() {
    // performance.now avoids the Date.* restriction and is monotonic
    if (_perfBase === null) _perfBase = performance.now();
    return performance.now();
  }

  // ------------------------------------------------------------- physics
  function paddleLine(side) {
    // returns {y, x} of the paddle center, accounting for the dash lunge inward
    if (side === 1) {
      const y = geo.padY1 - G.lunge1 * geo.dash;
      return { x: G.padX1, y };
    }
    const y = geo.padY2 + G.lunge2 * geo.dash;
    return { x: G.padX2, y };
  }

  function collidePaddle(side) {
    const P = G.puck;
    const { x: px, y: py } = paddleLine(side);
    // closest point on the horizontal capsule segment to the puck
    const half = geo.padHalf;
    const cx = clamp(P.x, px - half, px + half);
    const cy = py;
    let dx = P.x - cx, dy = P.y - cy;
    let dist = Math.hypot(dx, dy);
    const minDist = geo.puckR + geo.padR;
    if (dist > minDist) return false;

    let nx, ny;
    if (dist < 0.0001) { nx = 0; ny = side === 1 ? -1 : 1; dist = 0.0001; }
    else { nx = dx / dist; ny = dy / dist; }

    const vDotN = P.vx * nx + P.vy * ny;
    if (vDotN >= 0) return false; // moving away already — no double-hit

    // reflect
    P.vx -= 2 * vDotN * nx;
    P.vy -= 2 * vDotN * ny;
    // depenetrate
    P.x = cx + nx * minDist;
    P.y = cy + ny * minDist;

    // english from where it struck the paddle + paddle motion
    const off = clamp((P.x - px) / half, -1, 1);
    const padVX = side === 1 ? G.padVX1 : G.padVX2;
    const dashing = side === 1 ? G.dashT1 > 0 : G.dashT2 > 0;

    let sp = Math.hypot(P.vx, P.vy);
    sp *= SP().volley;                       // volley speed-up
    if (dashing) sp *= SP().dash;            // dash adds extra pace
    sp = Math.min(sp, SP().max * H);
    G.speedMul = sp / baseSpeed();

    // recompose direction with english, force it off the goal
    let ang = Math.atan2(P.vy, P.vx);
    // add curve from off-center hit + paddle sweep
    let vx = Math.cos(ang) * sp + off * ENGLISH * sp + padVX * PADDLE_VX_TRANSFER;
    let vy = Math.sin(ang) * sp;
    // make sure it heads away from this player's goal
    if (side === 1) vy = -Math.abs(vy); else vy = Math.abs(vy);
    // clamp so rallies don't get stuck near-horizontal
    const nsp = Math.hypot(vx, vy) || 1;
    const minVY = sp * 0.34;
    if (Math.abs(vy) < minVY) {
      vy = (side === 1 ? -1 : 1) * minVY;
      const rem = Math.sqrt(Math.max(0, sp * sp - vy * vy));
      vx = Math.sign(vx || 1) * rem;
    } else {
      vx *= sp / nsp; vy *= sp / nsp;
    }
    P.vx = vx; P.vy = vy;

    // juice
    burst(cx, cy, colorOf(side), 10 + Math.floor(G.speedMul * 6));
    G.shake = Math.min(1, G.shake + 0.18 + G.speedMul * 0.06);
    Audio.paddle(clamp(G.speedMul / 2, 0, 1));
    haptic(dashing ? 22 : 10);
    return true;
  }

  function stepPhysics(h) {
    // paddle tracking (snappy/direct) + velocity for spin transfer
    if (G.targetX1 != null) G.padX1 = G.targetX1;
    if (G.targetX2 != null) G.padX2 = G.targetX2;
    G.padX1 = clamp(G.padX1, geo.minPadX, geo.maxPadX);
    G.padX2 = clamp(G.padX2, geo.minPadX, geo.maxPadX);
    G.padVX1 = (G.padX1 - G.padPrevX1) / h;
    G.padVX2 = (G.padX2 - G.padPrevX2) / h;
    G.padPrevX1 = G.padX1; G.padPrevX2 = G.padX2;

    // dash / cooldown timers
    if (G.cool1 > 0) G.cool1 = Math.max(0, G.cool1 - h);
    if (G.cool2 > 0) G.cool2 = Math.max(0, G.cool2 - h);
    if (G.dashT1 > 0) G.dashT1 = Math.max(0, G.dashT1 - h);
    if (G.dashT2 > 0) G.dashT2 = Math.max(0, G.dashT2 - h);
    // lunge eases out to full during dash, then retracts
    const tgt1 = G.dashT1 > 0 ? 1 : 0;
    const tgt2 = G.dashT2 > 0 ? 1 : 0;
    G.lunge1 = lerp(G.lunge1, tgt1, 1 - Math.pow(0.0008, h));
    G.lunge2 = lerp(G.lunge2, tgt2, 1 - Math.pow(0.0008, h));

    if (G.phase !== 'playing') return;

    const P = G.puck;
    const speed = Math.hypot(P.vx, P.vy);
    const maxStep = geo.puckR * 0.5;
    const steps = Math.max(1, Math.ceil((speed * h) / maxStep));
    const hh = h / steps;

    for (let i = 0; i < steps; i++) {
      P.x += P.vx * hh;
      P.y += P.vy * hh;

      // side walls
      if (P.x < geo.left + geo.puckR) { P.x = geo.left + geo.puckR; P.vx = Math.abs(P.vx); Audio.wall(); wallSpark(P.x, P.y); }
      else if (P.x > geo.right - geo.puckR) { P.x = geo.right - geo.puckR; P.vx = -Math.abs(P.vx); Audio.wall(); wallSpark(P.x, P.y); }

      // paddles (check the one whose goal the puck is heading toward)
      if (P.vy > 0) collidePaddle(1); else if (P.vy < 0) collidePaddle(2);

      // goals
      if (P.y < -geo.puckR) { onGoal(1); return; }        // crossed top edge -> P1 scores
      if (P.y > H + geo.puckR) { onGoal(2); return; }     // crossed bottom edge -> P2 scores
    }

    // trail
    G.trail.push({ x: P.x, y: P.y });
    if (G.trail.length > TRAIL_LEN) G.trail.shift();
  }

  // ------------------------------------------------------------- particles
  function burst(x, y, color, n) {
    if (reduceMotion) n = Math.min(n, 6);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = (0.5 + Math.random()) * (H * 0.14);
      G.particles.push({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 1, r: 1.5 + Math.random() * 2.5, color });
    }
  }
  function wallSpark(x, y) {
    if (reduceMotion) return;
    for (let i = 0; i < 4; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = (0.3 + Math.random()) * (H * 0.08);
      G.particles.push({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 0.7, r: 1 + Math.random() * 1.5, color: '#a1a1aa' });
    }
  }
  function spawnConfetti(color) {
    if (reduceMotion) return;
    const cols = [color, '#fafafa', '#34d399', '#a78bfa'];
    for (let i = 0; i < 160; i++) {
      G.confetti.push({
        x: Math.random() * W, y: -20 - Math.random() * H * 0.5,
        vx: (Math.random() - 0.5) * W * 0.15, vy: (0.4 + Math.random()) * H * 0.25,
        rot: Math.random() * Math.PI, vr: (Math.random() - 0.5) * 10,
        w: 5 + Math.random() * 6, h: 8 + Math.random() * 8,
        color: cols[(Math.random() * cols.length) | 0], life: 1,
      });
    }
  }

  function updateEffects(dt) {
    G.shake = Math.max(0, G.shake - dt * 3.2);
    G.flash = Math.max(0, G.flash - dt * 3);
    for (let i = G.particles.length - 1; i >= 0; i--) {
      const p = G.particles[i];
      p.x += p.vx * dt; p.y += p.vy * dt;
      p.vx *= 0.92; p.vy *= 0.92;
      p.life -= dt * 1.8;
      if (p.life <= 0) G.particles.splice(i, 1);
    }
    for (let i = G.confetti.length - 1; i >= 0; i--) {
      const c = G.confetti[i];
      c.x += c.vx * dt; c.y += c.vy * dt;
      c.vy += H * 0.35 * dt; c.rot += c.vr * dt;
      if (c.y > H + 40) G.confetti.splice(i, 1);
    }
  }

  // ------------------------------------------------------------- render
  function draw() {
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    // screen shake
    let sx = 0, sy = 0;
    if (G.shake > 0 && !reduceMotion) {
      const m = G.shake * 14;
      sx = (Math.random() - 0.5) * m;
      sy = (Math.random() - 0.5) * m;
      ctx.translate(sx, sy);
    }

    // background
    ctx.clearRect(-20, -20, W + 40, H + 40);
    const bg = ctx.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, Math.max(W, H) * 0.7);
    bg.addColorStop(0, '#131316');
    bg.addColorStop(1, '#09090b');
    ctx.fillStyle = bg;
    ctx.fillRect(-20, -20, W + 40, H + 40);

    // on the menu, keep the canvas a clean gradient — no arena clutter behind text
    if (G.phase === 'home') { if (sx || sy) ctx.translate(-sx, -sy); return; }

    // center line
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.lineWidth = 2;
    ctx.setLineDash([2, 12]);
    ctx.beginPath(); ctx.moveTo(geo.left, H / 2); ctx.lineTo(geo.right, H / 2); ctx.stroke();
    ctx.setLineDash([]);
    // center circle
    ctx.beginPath(); ctx.arc(W / 2, H / 2, W * 0.16, 0, Math.PI * 2); ctx.stroke();
    ctx.restore();

    // side walls glow
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.10)';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(geo.left, 0); ctx.lineTo(geo.left, H);
    ctx.moveTo(geo.right, 0); ctx.lineTo(geo.right, H); ctx.stroke();
    ctx.restore();

    // goal glow lines
    drawGoalGlow(0, '#a78bfa');   // top = P2
    drawGoalGlow(H, '#34d399');   // bottom = P1

    // trail
    for (let i = 0; i < G.trail.length; i++) {
      const t = G.trail[i];
      const a = (i / G.trail.length) * 0.35;
      ctx.beginPath();
      ctx.fillStyle = `rgba(250,250,250,${a})`;
      ctx.arc(t.x, t.y, geo.puckR * (0.3 + 0.7 * (i / G.trail.length)), 0, Math.PI * 2);
      ctx.fill();
    }

    // puck
    if (G.puck) {
      ctx.save();
      ctx.shadowColor = 'rgba(255,255,255,0.9)';
      ctx.shadowBlur = 22;
      ctx.fillStyle = '#fafafa';
      ctx.beginPath(); ctx.arc(G.puck.x, G.puck.y, geo.puckR, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }

    // paddles
    drawPaddle(1);
    drawPaddle(2);

    // particles
    for (const p of G.particles) {
      ctx.globalAlpha = clamp(p.life, 0, 1);
      ctx.fillStyle = p.color;
      ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = 1;

    // confetti
    for (const c of G.confetti) {
      ctx.save();
      ctx.translate(c.x, c.y); ctx.rotate(c.rot);
      ctx.fillStyle = c.color;
      ctx.fillRect(-c.w / 2, -c.h / 2, c.w, c.h);
      ctx.restore();
    }

    // flash
    if (G.flash > 0) {
      ctx.globalAlpha = G.flash * 0.5;
      ctx.fillStyle = G.flashColor;
      ctx.fillRect(-20, -20, W + 40, H + 40);
      ctx.globalAlpha = 1;
    }

    // undo shake translate
    if (sx || sy) ctx.translate(-sx, -sy);
  }

  function drawGoalGlow(y, color) {
    ctx.save();
    const g = ctx.createLinearGradient(0, y, 0, y === 0 ? geo.padY2 : geo.padY1);
    g.addColorStop(0, hexA(color, 0.18));
    g.addColorStop(1, hexA(color, 0));
    ctx.fillStyle = g;
    if (y === 0) ctx.fillRect(geo.left, 0, geo.right - geo.left, geo.padY2);
    else ctx.fillRect(geo.left, geo.padY1, geo.right - geo.left, H - geo.padY1);
    ctx.restore();
  }

  function drawPaddle(side) {
    const { x, y } = paddleLine(side);
    const color = colorOf(side);
    const cool = side === 1 ? G.cool1 : G.cool2;
    const ready = cool <= 0;
    const half = geo.padHalf, r = geo.padR;
    ctx.save();
    ctx.shadowColor = color;
    ctx.shadowBlur = ready ? 24 : 10;
    ctx.fillStyle = color;
    ctx.globalAlpha = ready ? 1 : 0.55;
    roundRect(x - half, y - r, half * 2, r * 2, r);
    ctx.fill();
    ctx.restore();

    // dash cooldown pip below the paddle (toward the player's edge)
    const pipY = side === 1 ? y + r + 12 : y - r - 12;
    const frac = ready ? 1 : 1 - cool / DASH_COOLDOWN;
    ctx.save();
    ctx.globalAlpha = 0.9;
    ctx.fillStyle = ready ? color : 'rgba(255,255,255,0.18)';
    const pw = 34, ph = 3;
    roundRect(x - pw / 2, pipY, pw * frac, ph, ph / 2);
    ctx.fill();
    if (!ready) {
      ctx.fillStyle = 'rgba(255,255,255,0.10)';
      roundRect(x - pw / 2, pipY, pw, ph, ph / 2); ctx.fill();
      ctx.fillStyle = color;
      roundRect(x - pw / 2, pipY, pw * frac, ph, ph / 2); ctx.fill();
    }
    ctx.restore();
  }

  function roundRect(x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
  function hexA(hex, a) {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  }

  // ------------------------------------------------------------- loop
  let last = 0, acc = 0;
  function frame(now) {
    if (!last) last = now;
    let dt = (now - last) / 1000;
    last = now;
    dt = Math.min(dt, 0.05); // avoid spiral of death after a tab switch

    // countdown
    if (G.phase === 'countdown') {
      G.countT += dt;
      if (G.countT >= 0.8) {
        G.countT = 0; G.countN--;
        if (G.countN > 0) { Audio.count(); updateCountdownText(G.countN); }
        else if (G.countN === 0) { Audio.go(); updateCountdownText('GO'); }
        else {
          // begin play
          if (!G.resumeServe && G.puck && Math.hypot(G.puck.vx, G.puck.vy) > 0.02) {
            // keep the restored puck velocity
          } else {
            serve();
          }
          G.resumeServe = false;
          setPhase('playing');
          saveMatch();
        }
      }
    } else if (G.phase === 'goal') {
      G.goalT -= dt;
      if (G.goalT <= 0) startCountdown(3);
    }

    // physics (fixed step)
    if (G.phase === 'playing' || G.phase === 'countdown' || G.phase === 'goal') {
      acc += dt;
      let guard = 0;
      while (acc >= FIXED_DT && guard < 240) { stepPhysics(FIXED_DT); acc -= FIXED_DT; guard++; }
      if (guard >= 240) acc = 0;
    }

    updateEffects(dt);
    draw();

    // throttled autosave of live state
    if (G.phase === 'playing') {
      G.saveTimer += dt;
      if (G.saveTimer > 1.2) { G.saveTimer = 0; saveMatch(); }
    }

    requestAnimationFrame(frame);
  }

  // ------------------------------------------------------------- HUD / DOM
  function updateCountdownText(v) {
    document.querySelectorAll('#countdown .cd-num').forEach((el) => { el.textContent = v; });
  }

  function pips(container, won, total) {
    container.innerHTML = '';
    for (let i = 0; i < total; i++) {
      const d = document.createElement('span');
      d.className = 'h-1.5 w-4 rounded-full';
      d.style.background = i < won ? 'currentColor' : 'rgba(255,255,255,0.14)';
      container.appendChild(d);
    }
  }

  function syncHud() {
    $('hudScore1').textContent = G.roundScore.p1;
    $('hudScore2').textContent = G.roundScore.p2;
    $('hudName1').textContent = nameOf(1);
    $('hudName2').textContent = nameOf(2);
    const total = roundsToWin();
    const c1 = $('hudPips1'); c1.style.color = colorOf(1); pips(c1, G.seriesScore.p1, total);
    const c2 = $('hudPips2'); c2.style.color = colorOf(2); pips(c2, G.seriesScore.p2, total);
  }

  function renderRoundOverCards() {
    const w = G.winner;
    const html = `
      <div class="text-center">
        <p class="text-xs uppercase tracking-[0.2em] text-zinc-500">Round ${G.round}</p>
        <h2 class="mt-2 text-3xl font-extrabold" style="color:${colorOf(w)}">${escapeHtml(nameOf(w))} wins the round</h2>
        <p class="mt-3 font-mono text-lg text-zinc-400 tabular-nums">
          series <span style="color:var(--p1)">${G.seriesScore.p1}</span>–<span style="color:var(--p2)">${G.seriesScore.p2}</span>
          <span class="text-zinc-600"> · first to ${roundsToWin()}</span>
        </p>
      </div>`;
    document.querySelectorAll('#roundover .ro-card').forEach((el) => { el.innerHTML = html; });
  }

  function renderWinCards() {
    const w = G.winner;
    const life = w === 1 ? save.stats.life1 : save.stats.life2;
    const html = `
      <div class="text-center">
        <p class="text-xs uppercase tracking-[0.2em] text-zinc-500">Match won</p>
        <h2 class="mt-2 text-4xl font-extrabold" style="color:${colorOf(w)}">${escapeHtml(nameOf(w))}</h2>
        <p class="mt-2 text-lg font-semibold text-zinc-300">takes the series ${Math.max(G.seriesScore.p1, G.seriesScore.p2)}–${Math.min(G.seriesScore.p1, G.seriesScore.p2)}</p>
        <p class="mt-3 font-mono text-sm text-zinc-500 tabular-nums">${escapeHtml(nameOf(w))} lifetime: ${life}</p>
      </div>`;
    document.querySelectorAll('#win .win-card').forEach((el) => { el.innerHTML = html; });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function hideAllOverlays() {
    ['home', 'pause', 'countdown', 'roundover', 'win'].forEach((id) => $(id).classList.add('hidden'));
  }

  // ------------------------------------------------------------- menu wiring
  function showHome() {
    setPhase('home');
    hideAllOverlays();
    $('hud').classList.add('hidden');
    $('home').classList.remove('hidden');
    refreshHome();
  }

  function refreshHome() {
    $('name1').value = save.settings.name1;
    $('name2').value = save.settings.name2;
    $('life1').textContent = save.stats.life1;
    $('life2').textContent = save.stats.life2;
    $('goalsVal').textContent = save.settings.goals;
    $('seriesVal').textContent = save.settings.series;
    syncSpeedSeg();
    syncSoundToggle();

    const resumable = hasResumable();
    $('resumeBtn').classList.toggle('hidden', !resumable);
    $('resumeBtn').classList.toggle('flex', resumable);
    $('newGameBtn').classList.toggle('hidden', !resumable);
    $('newGameBtn').classList.toggle('flex', resumable);
    $('playLabel').textContent = resumable ? 'New match' : 'New match';
  }

  function syncSpeedSeg() {
    document.querySelectorAll('#speedSeg [data-speed]').forEach((b) => {
      const on = b.dataset.speed === save.settings.speed;
      b.classList.toggle('bg-emerald-400', on);
      b.classList.toggle('text-emerald-950', on);
      b.classList.toggle('text-zinc-400', !on);
    });
  }
  function syncSoundToggle() {
    const t = $('soundToggle');
    const on = save.settings.sound;
    t.setAttribute('aria-checked', String(on));
    t.classList.toggle('bg-emerald-400', on);
    t.classList.toggle('bg-zinc-700', !on);
    t.querySelector('span').classList.toggle('translate-x-5', on);
    t.querySelector('span').classList.toggle('translate-x-0.5', !on);
  }

  function wire() {
    // input on canvas
    canvas.addEventListener('pointerdown', onPointerDown, { passive: false });
    canvas.addEventListener('pointermove', onPointerMove, { passive: false });
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerUp);
    // block gestures that would scroll/zoom
    ['touchstart', 'touchmove', 'gesturestart'].forEach((ev) =>
      document.addEventListener(ev, (e) => { if (e.cancelable) e.preventDefault(); }, { passive: false }));
    document.addEventListener('dblclick', (e) => e.preventDefault());

    // names
    $('name1').addEventListener('input', (e) => { save.settings.name1 = e.target.value.trim(); persist(); syncHud(); });
    $('name2').addEventListener('input', (e) => { save.settings.name2 = e.target.value.trim(); persist(); syncHud(); });

    // primary
    $('playBtn').addEventListener('click', () => { Audio.resume(); newMatch(); });
    $('resumeBtn').addEventListener('click', () => { Audio.resume(); restoreMatch(); });
    $('newGameBtn').addEventListener('click', () => { save.match = null; persist(); refreshHome(); });

    // settings
    $('settingsToggle').addEventListener('click', () => {
      const p = $('settingsPanel');
      p.classList.toggle('hidden');
    });
    $('soundToggle').addEventListener('click', () => { save.settings.sound = !save.settings.sound; persist(); syncSoundToggle(); if (save.settings.sound) Audio.count(); });
    document.querySelectorAll('#speedSeg [data-speed]').forEach((b) =>
      b.addEventListener('click', () => { save.settings.speed = b.dataset.speed; persist(); syncSpeedSeg(); }));
    document.querySelectorAll('[data-step]').forEach((b) =>
      b.addEventListener('click', () => {
        const dir = parseInt(b.dataset.dir, 10);
        if (b.dataset.step === 'goals') save.settings.goals = clamp(save.settings.goals + dir, 1, 15);
        else save.settings.series = clamp(save.settings.series + dir, 1, 9);
        persist(); refreshHome();
      }));
    $('wipeBtn').addEventListener('click', () => {
      if (!confirm('Erase all saved data — names, settings, scores, and lifetime wins?')) return;
      localStorage.removeItem(SAVE_KEY);
      save = loadSave();
      refreshHome();
      syncHud();
    });

    // pause
    $('pauseBtn').addEventListener('click', () => {
      if (G.phase === 'playing' || G.phase === 'countdown' || G.phase === 'goal') { setPhase('paused'); saveMatch(); }
    });
    $('resumePlayBtn').addEventListener('click', () => {
      // restart with a fresh countdown from wherever we were
      G.resumeServe = !(G.puck && Math.hypot(G.puck.vx, G.puck.vy) > 0.02);
      startCountdown(3);
    });
    $('quitBtn').addEventListener('click', () => { saveMatch(); showHome(); });

    // round / win
    $('nextRoundBtn').addEventListener('click', () => nextRound());
    $('rematchBtn').addEventListener('click', () => { Audio.resume(); newMatch(); });
    $('winHomeBtn').addEventListener('click', () => showHome());

    // lifecycle saves
    window.addEventListener('visibilitychange', () => { if (document.hidden) saveMatch(); });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && (G.phase === 'playing')) { setPhase('paused'); saveMatch(); }
    });
    window.addEventListener('pagehide', saveMatch);
    window.addEventListener('resize', resize);
    window.addEventListener('orientationchange', () => setTimeout(resize, 120));
  }

  // ------------------------------------------------------------- boot
  function boot() {
    resize();
    wire();
    G.padX1 = G.padX2 = G.padPrevX1 = G.padPrevX2 = W / 2;
    G.targetX1 = W / 2; G.targetX2 = W / 2;
    centerPuck();
    if (window.lucide) lucide.createIcons();
    showHome();

    // Test hook (only when ?test=1) — lets the headless suite drive the puck
    // into a paddle at extreme speed and assert it can't tunnel through.
    if (location.search.includes('test=1')) {
      window.__rally = {
        G, geo, SP, stepPhysics, FIXED_DT,
        dims: () => ({ W, H }),
        // place the puck just off the bottom paddle heading straight down at `mul`x
        // the max speed, aligned with the paddle, then run `secs` of physics.
        // Returns the min y-distance the puck kept from crossing the bottom edge.
        tunnelProbe(mul, secs) {
          G.phase = 'playing';
          G.padX1 = W / 2; G.padPrevX1 = W / 2;
          const sp = SP().max * H * mul;
          G.puck = { x: W / 2, y: geo.padY1 - geo.puckR - 4, vx: 0, vy: sp };
          G.speedMul = 999;
          const steps = Math.ceil(secs / FIXED_DT);
          for (let i = 0; i < steps; i++) {
            stepPhysics(FIXED_DT);
            // a goal (tunnel) flips phase out of 'playing' and recenters the puck
            if (G.phase !== 'playing') return { crossed: true, finalVY: 0 };
          }
          return { crossed: false, finalVY: G.puck.vy };
        },
      };
    }

    requestAnimationFrame(frame);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
