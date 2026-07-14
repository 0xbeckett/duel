# RALLY

A two-player, one-phone deflect duel. Lay the phone **flat on the table** between
you and your opponent, sitting across from each other, and defend your end. The
puck ricochets between the two goal lines, speeding up on every volley — miss it
and the other side scores. First to *N* goals takes the round; win the majority of
a best-of series to take the match.

The screen is a mirrored split: the **top** player's HUD is rotated 180° so it
reads right-side-up from their seat, the **bottom** player's faces the other way.
Both play at once, one thumb each.

- **P1 (emerald)** defends the **bottom** edge.
- **P2 (violet)** defends the **top** edge.

## Controls

- **Drag** your thumb along your end to slide your paddle and return the puck.
  The paddle tracks your thumb exactly — no lag. Off-center hits put curve on the
  puck; sweeping the paddle as you hit adds side-spin.
- **Tap** (a quick tap on your half, no drag) to **dash** — a short forward lunge
  that returns the puck harder. It has a ~1.5s cooldown, shown as a small pip by
  your paddle.
- **Pause** with the button in the middle of the arena.

## Everything is saved

State persists to `localStorage`, so a refresh or an accidental close never loses
a game:

- An **in-progress match** resumes exactly — score, serve, series, paddle and puck
  positions. Refresh mid-rally and you'll see a **Resume match** button.
- The **best-of series** score and a **lifetime win tally** per side.
- **Player names**, **sound**, **speed**, goals-per-round, and series length.
- **Reset series** clears the current match/series but keeps names, settings, and
  lifetime stats. **Erase all saved data** (in Settings) wipes everything.

## Run it locally

It's a plain static site — no build step, no server code. Serve the repo root over
HTTP and open it on a phone (or use your browser's device emulator, portrait):

```bash
# any static server works, e.g.
python3 -m http.server 8000
# then open http://localhost:8000
```

Opening `index.html` over `http(s)` "just works" on mobile — canvas game, Tailwind
(CDN) for the menu chrome, Web Audio for SFX (generated tones, no asset files),
lucide for icons. Viewport is locked (no scroll/zoom), and haptics fire via
`navigator.vibrate` where supported.

## Tests

A headless Playwright suite covers the rules that matter — no-tunnel physics at up
to 6× max speed, scoring, save/resume fidelity, the win flow + lifetime tally, and
that reset preserves preferences:

```bash
node test/smoke.mjs     # asserts game logic + persistence
node test/shots.mjs     # writes menu/gameplay screenshots to test/
```

## Files

- `index.html` — chrome, overlays (menu, pause, round/win), and the canvas.
- `game.js` — the whole game: state machine, fixed-step physics with swept
  collision, Web Audio SFX, particles/juice, and localStorage persistence.
