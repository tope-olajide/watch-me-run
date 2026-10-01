# WatchMe Run

**A live 3D endless runner: the player's actions shape an Orbis-generated world that is generated
while they play.** Reactor's `reactor/visko-orbis-stable` streams the landscape behind the runner in
real time, and the Orbis Director steers it from what the run is doing — near misses, hits, speed,
distance, pickups, the weather, the deal the run was taken under. You can also run inside a picture of
your own, and the model grows the world out of it.

The runner is deterministic — lanes, obstacles, jumping, sliding, damage and score all run locally at
full frame rate — because a game cannot wait on a model's latency to decide whether a jump cleared a
block. What Orbis generates is everything around it: the world behind the road, its weather, its
light, and the way all of that answers the player while they are still playing.

The runners and their animation clips live in `models/` at the repository root, and the game loads
them from there. The legacy `cave-runner` game in `reference/` is inspiration only — nothing under
`src/`, `server/` or `tools/` reads it — so the folder can be deleted. The design and implementation
plan is in [`doc/watchme-run-orbis-plan.md`](doc/watchme-run-orbis-plan.md).

## Quick start

```bash
npm install
cp .env.example .env      # then set REACTOR_API_KEY=rk_...
npm run dev               # http://localhost:5173
```

Both dev commands serve the token route, so pick either one:

| Command | URL | Notes |
| --- | --- | --- |
| `npm run dev` | http://localhost:5173 | Vite dev server with a token middleware — use this locally |
| `npm run dev:netlify` | http://localhost:8888 | Netlify dev; the same route through the function |

`REACTOR_API_KEY` is server-only — never give it a `VITE_` prefix and never commit it.

Prefer `npm run dev` for local play. On some Windows setups the `netlify dev` function
sandbox cannot make outbound connections and its token route answers `500` even though the
same function works in production; the game stays playable and says so in the world chip.

## The world is generated, live, and the run is what steers it

Orbis is not a backdrop this game was rendered against. `reactor/visko-orbis-stable` **generates the
world while it is being played**, and the game's own events are the thing it is asked to answer — so
the landscape behind the runner is different every second, every run and every world, and none of it
exists before Start is pressed.

**One uninterrupted generation, for as long as the visit lasts.** One session is created for the world
a run asks for and kept for the whole visit: the menu stages the run, the world is asked for at Start,
and it stays warm for 60 s after a run ends so going straight back in skips the wait. The model streams in
chunks — a chunk of frames every 1.5–2 s, forever — and the game never waits on one: the runner, the
road and the content field are local and run at full frame rate over whatever frame is on screen, so a
late chunk is a world catching up rather than a game stuttering. There is no seam to loop and no length
to run out of, which is the point: an endless runner has no fixed ending to pre-render, and the tenth
kilometre of a run has to look like it was generated for that kilometre.

**The gameplay is the prompt.** `src/orbis/orbis-director.ts` turns what the run is doing into asks —
near misses, hits, a tier crossing, a pickup, a gap threaded between two obstacles, the best line
beaten, the deal the run was taken under, the weather arriving — and each world has written answers for
each of them (`src/orbis/prompts.ts`): the desert's ruins pulse, the city's neon flares, the forest's
plants brighten. At most one ask is spent per chunk, on a 1.8 s cooldown — with one sanctioned
exception: an ask that may not be dropped waits at most 3.2 s for the next boundary and then goes out
mid-chunk, where it is the newest prompt in force, and the journal says so (`deadline`). The events the
*player* caused claim the next slot ahead of the world's own chatter, because a pickup or a hit is not
news that may be dropped. The measured effect on that queue is in *The world's own weather*: the storm arrives at
302 m and the world answers it at **325 m**.

**The weather is the shortest path from play to picture.** Every world carries a hazard on its own
schedule (`src/game/hazards.ts`), and it is the clearest case of the loop: the run announces it, Orbis
is asked to make it real in the picture — *a wall of sand sweeps across the horizon*, *every light in
the city fails at once from the horizon towards the camera*, *thick fog rolls across the ground and
swallows everything past the nearest trees* — and the same hazard changes the rules of the run in the
same seconds: the storm shoves the runner a whole lane, the blackout takes the light, the fog takes the
planning distance. The player is watching the thing that is happening to them.

**Your own picture becomes the world.** The landscape is optional and it is the player's: a photo, a
drawing, a screenshot — anything — is measured, cover-cropped so its horizon lands on the game's own
44% line, encoded as a 1280×720 JPEG with a seed derived from its pixels, and handed to the model as
the session's starting image (`upload → measure → crop → reset → setImage → start`, and the file is
kept so the next visit reproduces it exactly). Every prompt for that world is then written against it
— *the exact landscape supplied as the starting frame… the same terrain, the same colours, the same
light… carried forward* — and generation grows a moving world out of the picture for the whole run. It
is the part of the game that could not exist any other way: nobody has ever seen that picture in
motion, and what the run needs is not the picture but the place inside it.

## How the world is wired

One Orbis session, one `<video>`, one prompt channel — mounted above the interface and below
everything else, for the whole visit:

```text
App
├── WorldLayer (lazy)          src/orbis/WorldLayer.tsx   the only Reactor session
│   ├── .world-video           the generated frames
│   └── .world-local           per-world gradient, and the menu's whole backdrop
├── MenuExperience             picks a world and a runner — asks Orbis for nothing
├── WorldLoader                asks for the world, names the wait, hands over to the run
└── RunExperience (lazy)       deterministic runner + Orbis Director
```

The interface talks to that layer through `src/orbis/world-bus.ts` — a tiny store with commands
(`world.select`, `world.showWorld`, `world.sendPrompt`, `world.sendAudio`, `world.setPaused`,
`world.selectLandscape`) and a snapshot (`useWorld()`). The layer is lazy, so the menu paints first.
The road grade reads the world's tone from `src/orbis/world-palette.ts`, which samples the live frames.

### The menu stages the run

The menu is the staging surface: which world, which runner, which landscape — and nothing is
generating behind it until the player commits to a run. It used to open a session behind itself so
there would be a world to dive into, and it was paying for it: a session is billed whenever it is
ready, so the menu was buying frames nobody was playing. Pressing Start opens `src/WorldLoader`,
which asks Orbis for the world and waits for it on screen.

That wait is the one real cost of the arrangement, so it is a surface rather than a disabled button.
The loader names the step Orbis is on — connecting, generating, pinning a landscape, arming — from the
session's own snapshot, counts the seconds, and falls back to a playable local-world run at 55 s
(20 s once Orbis has reported an error, since a busy account is not something waiting fixes). The
world keeps being retried behind the run, so a late arrival still lands mid-run.

A world that a run has warmed stays warm for **60 s** after it ends (`IDLE_SESSION_CAP_MS`) and is
hidden with `html[data-surface="menu"]` the whole time: a player who goes straight back into another
run skips the loading screen entirely, and one who does not is not paying for a menu. Measured cold
starts on this stack run 20–40 s, so a grace shorter than that would cost more than it saves.

The bus is also the single source of truth for the two things that outlive one surface: which world
and which **landscape** are selected, and what Orbis reports about the session (`state`: started,
running, paused, chunk, has_image, resolution, audio_enabled, audio_prompt). The model's snapshot is
read rather than assumed because every command has a precondition, and a refused one arrives as a
`command_error` broadcast instead of a throw — pausing an already-paused session looks like a broken
world while being nothing of the sort.

The content field in `src/game/pattern-field.ts` owns what the runner meets and what it collects.
Coins are placed **after** the obstacles of a shape, in a lane the required move leaves the runner
in, and never in a lane a wall will cross within an escape window — a coin is a reward for a move,
not a lure into a lane you then have to leave at speed.

The gap between chunks is sized by what the last one asked for: a pattern a runner could ignore is
followed more closely, since waiting for the next decision after nothing happened is dead air. That
is decided from the content itself (`isDemanding` — a wall cannot be passed in place, and a row that
blocks two lanes leaves only one) rather than from where the player happens to be running, and it is
floored so a pacing change can never become a row that a lane change does not fit inside.

Tokens pay more the deeper you get — `coinValueAt` takes one from **25 points at the line to 75** once
a world's content peaks — and the HUD shows it beside the count (`TOKENS 27 ×2.4`). Coin *density* is
deliberately flat instead: density is what the fairness checks measure, so the reward curve is a value
curve, which leaves every coin-placement rule intact.

Each world climbs on its own schedule, reaching the `×3.0` ceiling where its own content peaks: ~680 m
in the desert, ~497 m in the city, ~745 m in the forest. Verified in the running game in all three
worlds, not just the model — score is 12 pts/second plus token value, so differencing `score − 12 ×
elapsed` against the token count gives what a token actually paid mid-run: **45.0 → 75.0 pts/token** in
the city and **31.0 → 75.5** in the forest, both landing on the declared 75.

The curve is drawn as well as numbered, because `×2.4` says what a token is worth but not that it is
climbing or how much run is left. Under the token count sits a ramp filling from the line to that
world's ceiling, notched at the quarters where the value steps into a new tier; beside it, the points
the token just picked up (`+73`), which is the number the scoring code used rather than a second copy
of it. Crossing a quarter announces itself — `VALUE UP · 63 PTS` — so the reward has a moment a player
can feel instead of a decimal quietly changing.

Four kinds of prompt reach the model, and the interface names them instead of leaving it to be
guessed from the text (`src/orbis/prompt-journal.ts`): `world-morph` keeps the background world
matching the selected world, `launch` is the run's opening dive, `exit-opening` hands the world back
to its wide shot, and `run-event` is one gameplay event from the run's director. They are gated so
they cannot fight: `run-event` belongs to a *channel* that closes the instant the player presses
Exit (synchronously at the click, not a render later), the launch dive is protected by a 2.4 s quiet
window, and the morph is a standing state that is never re-issued while a run owns the world — all
three of those were bugs that only showed up once every ask was journaled with its reason.

The world the model generates is **landscape only**. The runner is the local 3D game's, so the
prompts never name a subject — no "runner", no "character", no "person" — and they say so out loud:
*"The path and the landscape are completely empty: no people, no runners, no characters and no
creatures anywhere in the frame."* Leaving that implicit is not enough: a video model renders what a
prompt names, and naming a runner put a second runner in the frames that the player could neither
dodge nor collide with. Gameplay state still reaches the model, but as what the *world* does ("the
world is being driven into chaos") rather than as what a figure is doing ("the runner is reckless"),
and the camera is described by its own motion instead of as "locked behind the runner".

`npm run check:prompts` builds every prompt the app can send — each world, each event, each player
style — and fails if one names a subject or drops the emptiness clause, so this cannot quietly come
back.

The world also has to keep its **sky on top and its ground at the bottom**. The game camera's horizon
sits about 44% down the frame and the road ribbon fades into the video at about 50%, so the 44–50%
band is the only place the two layers actually meet. A generated camera that rises or tilts up drops
its own horizon through that band, fills it with sky, and leaves the road hanging in the air — the
player reads it as running in the sky. Every prompt therefore carries a horizon hold, and the
horizon is asked for in the *upper third* rather than at 44%: ground covering too far up hides under
the ribbon, while sky over the fade band is the visible failure, so the margin is the point. Reveals
are banned by name ("a giant tree becomes visible" is a shot a camera earns by tilting up) — anything
that arrives now arrives ahead on the horizon line with the camera staying put.

Holding the *line* is not the same as holding the *picture*, and Neon Pursuit is where that gap
showed: "a neon city at night" is, to a model, mostly night, and the city opened on an expanse of dark
sky with its skyline far down the frame — the buildings only arrived once the run had gone far enough
for a distance event to push them there, so the player's first minutes of the city were a sky with no
city in it. The city therefore carries a composition clause of its own (`environmentFraming` in
`src/orbis/prompts.ts`), on the opening and the launch alike: street level, the skyline already filling
the frame edge to edge immediately above the horizon line, the visible sky a narrow band above the
buildings. It asks for no camera move — the one thing this paragraph exists to forbid — and the near
ground stays as empty as every other world's, because that band still belongs to the game's road. It is
a request like the rest of them, so the horizon lock remains the thing that keeps the promise.

Prompts are a request, though, and a measured one is kept: `src/orbis/world-align.ts` reads the real
frames and holds the generated horizon to that line. It finds the generated skyline as the sharpest
*darkening* step between rows — every live capture from all three worlds shows the same shape, a
bright atmosphere band above a hard cliff, with darker ground below — and it only ever *raises* the
horizon, because sky under the road is the failure and a misread frame must not be able to cause it.
The decision runs on the median of the last three measurements, since a single bad frame once carried
a 7% lurch into a live city run.

Which measurement to trust was settled by auditing eight live profiles (brightness *and* frame-to-frame
change, per row) rather than by guessing thresholds. Sorting them by step size splits them cleanly with
nothing in between — real skylines at steps of 44, 52 and 56, non-skylines at 18, 25, 26, 36 and 38,
where the "skyline" is really a broad decline across three adjacent rows (60/63/69%, 50/54/56%,
44/46/48%) and in one case a frame that barely changes at all between frames. **Contrast against the
runner-up does not separate them** — the weak group reaches 3.60 while a real skyline sits at 1.57 — so
size is the gate and contrast is only a floor. Replayed through the shipped rule, all three real
skylines are accepted (the desert needs a 7.0% shift; the city and forest already sit above the line and
are left alone) and all five ambiguous captures are refused.

The cost is real and worth stating: shifting the video needs material to move into, so the video is
rendered 17% larger than its frame (`--world-overscan`), capping the correction at 8.5% of the frame
height either way. That ceiling is sized to the genuine need (7.0%) rather than to the largest number
any measurement has asked for: sizing it to 20%+ would buy a 1.4x zoom on the strength of measurements
the gates now refuse, and would let a wrong one move the world by 20%.

### Starting a run

Starting is two beats: `src/WorldLoader` asks for the world and waits until it is armed, then the dive
plays over live frames — they push in and brighten, the interface blurs away, the world's name passes
through frame, and the runner arrives inside the chunks that were already on their way. The session
keeps streaming through the whole transition, and the moment it begins the world layer is sent a
*launch* prompt so the chunks landing next belong to the run rather than to the menu's establishing
wide.

The dive is a phase machine in `src/App.tsx` (`menu → loading → entering → run → exiting → menu`)
plus CSS keyed off `html[data-entering]` / `html[data-exiting]` / `html[data-surface]`;
`prefers-reduced-motion` gets the arrival without the ride. The run chunk is prefetched 800 ms after
the menu appears so a lazy load cannot land in the middle of the dive. The loading screen is held for
at least 900 ms (`LOADING_MIN_MS`) so a world that is already warm renders as a screen rather than a
flash.

*Armed* means the session is ready, started, nothing is still being pinned into it, **and its first
frames have reached the screen** — and, the same idea one layer down, **the runner's model is in
hand**. That last clause is not pedantry: `started` is the model's word for
its loop being on, and the loader used to hand the run over on it alone — measured on a cold desert
start, the loading screen left before the first frame had painted. The runner's model is a couple
of megabytes behind a lazy chunk, and the run renders it through a suspense boundary whose fallback
used to be a capsule — the delivery shape the collision mathematics is built around — on screen for as
long as the fetch took, in a game that has no capsule in it. The fallback is empty now, which removes
the stand-in but leaves the gap where the runner goes, so the loading screen fetches the model
(`preloadCharacter` in `src/game/RunnerCharacter.tsx`) and waits for it, naming the runner as warming
until it is really there. It cannot wedge the run: a failed fetch resolves rather than holding, and the
budgets above still open the run on their own. The wait for them is bounded
at `LOADING_FRAMES_MS` (8 s), because the promise this screen has to keep is that a run always starts:
a session that generates and never paints — autoplay blocked, a transport that stalled after the start
— opens the run on the local backdrop instead, the same fallback as the timeout, with Orbis still
trying underneath. The measured cost is about four seconds on a cold start (25 s → 29 s, then 37 s on
a later run) in exchange for a dive that plays over real frames.

Each world also brings its own beat: selecting a card swaps the launch prompt and paints that world's
weather over the live frames for the length of the dive, with a line of copy and an ambience readout
(`intro` in `src/game/worlds.ts`) — sand haze lifting off the ridge, rain sheeting through the neon,
pollen drifting under the canopy. It is atmosphere only: nothing in it asks the player to act.

A run opens with the momentum of that dive: `LAUNCH_BOOST` in `src/game/RunnerScene.tsx` adds a
surge (≈11.6) that decays over 1.8 s into the normal ramp (≈8.4, then climbing). It is part of the
run's speed rather than a cosmetic effect, so the world's scale, the camera's field of view, the
road scroll, and the approaching obstacles all read as one launch — and the controls are unchanged.

What the launch does not do is hand the player straight to the content: the field opens on empty road.
`START_CLEARANCE` in `src/game/pattern-field.ts` is where the first chunk is laid — ~32 m past the
runner, two escape windows, because the launch surge covers those metres faster than any later ones.
The field used to start nine metres out, which at the launch's pace is under a second, and a `pair` or
a wall landing there asks for a lane change the player has not been given the time to read: the first
thing a fresh run — and a retry, which is the same remount — could teach was that it was unfair. One
constant covers both starts. Measured live: the first hazard row is 27–29 m ahead on the first
sampled frame of a fresh run, and the same again after the defeat card's *Run again*, with three pips
back on the HUD. The opening
band of the reward curve is quieter as a result — it is where a run is read, not where it is paid —
while what a token is worth at the line is untouched.

Leaving mirrors arriving: the run pulls back out, the menu reassembles with its own entrance, the
world is handed back to its wide establishing shot, and it keeps streaming the whole way.

Design notes that matter if you touch this code:

- The SDK's video view renders its own wrapper `div`; the wrapper is what carries the size
  (`.world-video`), because the inner `<video>` is a percentage of it.
- Its callbacks are recreated every render, so effects and bus commands reach the SDK through a
  ref. An effect that depends on those identities re-runs forever and re-issues `start()`.
- `generation_complete` means "a chunk finished", not "generation stopped".
- Sizing the road ribbon is a colour-grade problem: see `src/game/road-grade.ts`.
- The dive owns the world layer's transform while it plays and hands it back to the run at the end,
  which is why it finishes just above the resting scale instead of at a full push-in.

### What the menu shows, and what the run screen keeps

The menu is one screen and nothing on it is a scroll away. Its topbar carries the wordmark
(`Watch.Me.Run`, the dots in the world's accent), the world chip, the sound control, the best-line
mark's switch (off by default; see the ghost notes), and one button — **How to play** — and the
controls, the terms, the scoring, the weather and what happens to an uploaded picture live behind that
button in a modal that Escape closes. The mark's switch is in the pause overlay too, from the same
component, and drops its label below 780 px so four controls still fit a phone's top bar. Below it: the worlds and the
deals, the stage with the runner on it, and the picture upload, in three columns; the run button sits
in a dock pinned to the bottom of the viewport with what the run will be. The instructions used to be a
line under the picture and the sound a panel under that, which is two controls the player had to
scroll to reach on a laptop; `.start-dock` is z-indexed above the backdrop for the same reason the
button is at the bottom at all, because an overlay that paints over it swallows its clicks. Below
1080 px the one-screen rule is dropped deliberately: the layout goes back to scrolling with a sticky
run button, rather than shrinking a fixed-height grid until something falls off it.

The run screen is the game, not the machinery. On screen while running: the score, the tokens (with
the run's ramp), the distance, the hits left, the combo, whatever powerup is running, and the world's
weather while it is here — the numbers a decision can be made from — plus a callout when a pickup
spends itself, and the Exit and Pause buttons in the header. Hidden, with `display:none` and still mounted: the deal's name and terms, the pressure bar,
the ghost race, the flow meter, the token ramp, the world chip, and the world-answer feed — kept in
the DOM for the game's own diagnostics, which read the internals a player no longer has to look at.

**A pause holds the whole page, not just the simulation.** `RunnerScene` stops the scene clock and
remembers where it stopped (`clock.stop()` plus the held `elapsedTime`, restored on resume), zeroes
`speedRef` and publishes `0` as the world motion, so the road scroll, the roadside and the world
layer's parallax all stop with the runner. `RunExperience` sets `document.documentElement`'s
`data-paused`, and `html[data-paused="true"] *` pauses **every** CSS animation on the page — the
world layer's slow breathe and the screen-space weather included — because those are motion the player
reads as the world still running behind the pause card. The keyboard handler returns early while
paused, so a lane key pressed under the card cannot move a runner that is not being drawn. Measured on
a real pause: two frames 1.2 s apart byte-identical, and `--run-speed` reading `0.000`.

**The wall obstacle is scenery in both worlds, not a rectangle.** The desert's is a standing remnant —
an eight-sided column with a chipped cap and a block fallen at its foot, flat-shaded stone — because a
tall flat rectangle standing in the sand reads as a bug in the world rather than as part of it. The
city's is a lit barrier: a dark plinth and panel between two neon edge strips and a bar across the top,
which keeps the silhouette the avenue already reads as a wall and gives the player something lit to
see it by. The city's jumpable obstacle got the same treatment, one lit bar on its face. Read out of
real captured frames as pixel shares: the desert run is **94% warm, 0% cyan**, the city run **27%
cyan, 1% warm**.

## Three worlds, three tempos

The worlds differ in how they *play*, not only in how they look. Each one has its own speed ramp,
how soon its content peaks, and how tightly its obstacles are spaced, and the two trade against each
other on purpose:

| | desert | city | forest |
| --- | --- | --- | --- |
| Speed ramp | 8.6 → 17.0 m/s over 320 m | 7.4 → 14.0 m/s over 260 m | 7.8 → 15.2 m/s over 520 m |
| Content peaks at | 820 m | 520 m | 700 m |
| Gap scale | 1.08 | 0.78 | 0.96 |
| Obstacle kinds | block-heavy | gate-heavy | balanced |
| Reads as | open road, quick and sparse | crowded from the start, but slower | a long climb that keeps tightening |

Those live in `environmentPace` and `environmentRecipe` in `src/game/pattern-field.ts`, so the
simulator that measures fairness reads the same numbers the game runs on. `--run-speed` and the
camera's field of view are normalised against each world's own range, so "flat out" means the same
thing in a slow world as a fast one instead of quietly telling city players they are crawling.

Measured over 60 runs of 1500 m per world: the city is the densest per 100 m (3.9 decision rows,
14.5 coins) and still the most forgiving moment to moment (its tightest row gives you 1.07 s), while
the desert has the fewest rows (3.6) and the tightest read (0.87 s) because it arrives fastest. No row
in any world arrives closer than 0.87 s — a lane change costs 0.5 s even by the most generous
model — and all three show zero unavoidable rows, zero windows under 0.35 s and zero coins that bait
you into a wall. Verified in-game in every world, not just the desert: a 40 s pass in each reaches the
desert's 17.0 m/s and the city's 14.0 (the forest is still climbing at 14.2, because its ramp is
520 m long), collects tokens throughout, and logs no errors or warnings.

## The runners

Three rigs with one animation set each — **Amy**, **James** and **Mousey**, one GLB apiece:

| Runner | File | Rig | Payload | Built from |
| --- | --- | --- | --- | --- |
| Amy | `models/characters/amy.glb` | 65 bones | 2.0 MB | `amy.fbx` 28.7 MB |
| James | `models/characters/james.glb` | 65 bones | 3.4 MB | `james.fbx` 54.4 MB |
| Mousey | `models/characters/mousey.glb` | 57 bones | 1.5 MB | `mousey.fbx` 29.6 MB |

Every runner carries the same five clips — idle (a dance, 12.8–22 s), run, jump, slide and stumble —
inside that one file, named `idle`, `run`, `jump`, `slide` and `stumble`. The clips are retargeted
onto that runner's own skeleton, so a clip only ever plays on the rig it was exported for: every one
of the 15 clips binds its whole track set to its rig (53/53 tracks for Amy and James, 47/47 for
Mousey, checked with three's own `PropertyBinding` lookup). They are the same motions the legacy set
used, and each clip keeps its source file's own length right through the conversion — the FBX and the
GLB agree to the millisecond on all 15. Running is 0.633 s on every runner, which is the value the
cycle is tuned against in `RunnerCharacter.tsx`, so that tuning was left exactly as it was; jumping
and sliding are trimmed a little differently per runner (0.767–0.933 s and 1.167–1.533 s), and since
both play once and clamp, their length only decides how long the pose holds before the next
crossfade.

Two files carry the wiring: `src/game/character-catalog.ts` (ids and labels) and
`src/game/RunnerCharacter.tsx` (the `?url` import, the mixer, the crossfades). Only the selected
runner's file is fetched — the menu pulls it when the card is picked and the run reuses it from
cache — so a visit downloads 2–3.4 MB of character, not all three.

**The runner is normalised in its own space.** Every rig is authored at its own scale, so the model is
measured and scaled to a 2.35 m runner with its feet at zero. The measurement is a walk down the
model's children multiplying local matrices, cached by `model.uuid` (`normalisedSize`), rather than
`Box3.setFromObject`: that reads *world* space, and on a remount — which is what "Run again" is — the
previous attempt's group is still attached when the new one measures, so the runner was being
normalised against an already-scaled copy of itself and came back visibly enormous. Measured: the
same scale `0.01595` and the same foot height before and after a retry, drift `0` on both.

**Two rigs, one model.** A run is shot from behind — the camera sits above and behind the player, and
the runner faces away down the road — so `RunnerCharacter` turns the model 180° by default. The menu
has the opposite job: it is the one screen where the player is choosing a character, so the preview
passes `facing="camera"` and the runner turns to look back at them. The models are authored facing
+Z, so that flag is the whole difference between a back and a face.

The preview camera is also why the menu once showed a headless dancer. R3F calls
`camera.lookAt(0, 0, 0)` on any `camera` prop that does not carry a `rotation`, and the runner's
origin is its feet: the frame was centred on the ground under the character, so the body filled the
upper half of it and the head sat above the top edge. The camera now sits at chest height with an
explicit `rotation` — which is also what tells R3F to leave the aim alone — and a 32° lens 5 m back
holds the 2.35 m model with room above the head for a raised arm. Measured on two captures of the
stage 0.4 s apart: the runner's movement now spans 10%→90% of the stage frame, where the old rig put
all of it in the top half with the bottom 40% empty.

**The FBX sources stay in `models/`** as the source of truth but are kept out of git — 122 MB of FBX
against 6.9 MB of GLB, so only the GLBs are committed (`.gitignore` carries the `models/**/*.fbx`
rule) — and `tools/fbx-to-glb.mjs` rebuilds the GLBs from them: 4096² textures are cut to 1024 (colour)
and 512 (normal, specular), a vertex per face corner is welded down to one per vertex
(73,692 → 13,835 for Amy), and the FBX's `MeshPhongMaterial` becomes a physical one that keeps its
gloss rather than approximating it: shininess 20 becomes roughness 0.30, and the specular colour and
map ride through as `KHR_materials_specular` instead of being inverted into a roughness map. That is
122 MB of source down to 6.9 MB of runtime assets, and `dist/` down to 9.0 MB — 12 MB with the
roadside's cooked props aboard too. Re-run the tool after
changing anything in `models/` — a fresh clone cannot, since it has the GLBs and not the sources.
`tools/fidelity-check.html` renders the FBX and the GLB side by side in the game's own light and
measures the difference: mean 0.8–1.4 of 255, at most
3.4% of pixels differing by more than 8, and neighbour-pixel detail within a few percent either way —
the residue being the texture downscale, not the material.

### The roadside props are bought, and cooked the same way

The scenery that defines each world comes from asset packs rather than from geometry the game draws
itself. They live in `models/` with their own `license.txt`, and all three are **CC-BY-4.0**, which
means the author has to be credited wherever the work is shown — in this file, and in the game's own
menu:

| pack | what the roadside takes from it | author | source |
| --- | --- | --- | --- |
| Low poly trees, flowers and grass | the five `tree-stylized-*` trees — the whole forest | Márcio Meireles | [Sketchfab](https://sketchfab.com/3d-models/low-poly-trees-flowers-and-grass-442904f26b87407d98871b50b49c4169) |
| Desert \| Rock \| (FIXED) Pack | all fifteen boulders — the desert's stones and outcrops, and the forest's | Erroratten | [Sketchfab](https://sketchfab.com/3d-models/desert-rock-fixed-pack-00c4468f1bca48509d7d2bd66b564cbc) |
| LOWPOLY CITY STREET PACK BUILDINGS STYLIZED | thirteen buildings — the houses and shopfronts at the kerb, the tall narrow blocks in the skyline, a bin and a bench | haykel-shaba | [Sketchfab](https://sketchfab.com/3d-models/lowpoly-city-street-pack-buildings-stylized-8e1ba8a437c4460eaaa643953eaf79d0) |

The packs are *scenes*, not props: 107 MB of glTF with 2048² textures beside them, where a tree is a
trunk mesh and a canopy mesh somewhere down a hierarchy and a city is a street diorama. What the
roadside needs out of them is a handful of objects, so `tools/cook-props.mjs` (driving
`tools/cook-props.html`, because texture decoding needs a browser) cooks them down: it picks the
objects a world asks for, bakes each one's parts into its own space so a prop is one object rather
than a node tree, normalises it to a metre tall with its base at zero — the convention
`roadside-props` authors its own shapes to, so a model and a hand-built prop are interchangeable to
the layout — and cuts every texture to 256². Five trees come out at 982 KB, fifteen boulders at
1.28 MB and thirteen city buildings at 664 KB: 2.9 MB of props out of 107 MB of sources.

Two of the packs' extensions had to be handled by hand: `rocks` is
`KHR_materials_pbrSpecularGlossiness`, which three dropped (its diffuse maps would have gone missing
without being wired up explicitly), and `city` is `KHR_materials_unlit`, which would come back as flat
unlit pictures pasted over a graded world. The cooker therefore builds every material from the glTF
JSON rather than from what the loader hands back. The source scenes stay out of git — `.gitignore`
carries them and the `license.txt` files deliberately do not — and re-running the cooker rebuilds the
props from whatever is in `models/`.

## Controls

| Input | Action |
| --- | --- |
| `←` / `→` or `A` / `D` | Change lane |
| `↑` / `W` | Jump |
| `↓` / `S` | Slide |
| `Space` | Pause / resume |
| **Pause** button, top left of the run | Pause / resume — the same toggle as the key |

The same table is in the game, behind **How to play** in the menu's topbar — with the scoring, the
terms you can run under, the weather, and what happens to a picture you upload — so the player can
read it without leaving the screen the run starts from. `Space` holds the whole page, not just the
runner — the scene clock, the road's scroll and every CSS animation stop with it (see *What the menu
shows, and what the run screen keeps*, above).

**Pause is on the screen too**, beside Exit, because a touch device has no Space bar and a run that
cannot be stopped is a run that has to be finished. It is one toggle shared with the key (not a second
pause path), it stays visible while the run is paused — the header sits above the overlay — so on a
phone the same button is the way back into the run, and it is hidden on the run-over card, where the
card's own actions are the only thing left to press.

## Sound

Three files in `sounds/` are the game's own sound, sitting beside the world's: a music bed (`bgm.mp3`),
a token pickup (`koiroylers-get-coin-351945.mp3`) and a powerup pickup (`level-up.mp3`), wired in
`src/game/audio.ts` and mixed by hand — the bed at 0.45, the token at 0.75 and the powerup at 0.85,
because a run takes tokens by the dozen and a powerup is the event that changes what the next pattern
costs.

The bed is a **96 kbps encode of the 256 kbps download it came from**: 1.39 MB instead of 3.72 MB, the
same 1:56 at 48 kHz joint stereo, which is the difference between the soundtrack costing a third of
the game's audio weight and a tenth of it. The source stays on disk and out of git (the
`.gitignore` carries the rule) the way the FBX rigs and the 107 MB model scenes do, with the command
that reproduces the encode written beside the rule. Nothing in the game reads the source.

**The soundtrack starts on the first gesture and does not stop.** A browser will not start audio
without one, and the menu deliberately asks Orbis for nothing — so by the time a run begins, the click
on Start is 20–40 s of loading screen behind it and no longer counts as a gesture. `installAudioUnlock`
(called from `src/main.tsx`) therefore arms the track on the first `pointerdown` or `keydown` anywhere
in the page, and removes itself once the music has actually started; a refusal leaves it armed, because
a policy that rejects this click may accept the next one. From there it runs through the menu, the dive
and the run as one continuous track — a run does not restart it, and muting does not stop it either,
so unmuting needs no second gesture.

**Every change of level is a fade, not a jump.** The element is never *set* to a level, it is moved to
one: 1.6 s on the way in, because the track has to arrive under a player who is reading the menu
rather than land on top of them, and 320 ms for mute, unmute and the slider, where a long ramp would
read as the control being broken. The ramp is driven from `requestAnimationFrame`, so it is tied to the
tab's own clock — a backgrounded tab stops fading rather than racing to the end of a timer — and a ramp
already in flight is abandoned rather than queued, which is what lets a fade-in be caught mid-way by a
mute and fade out from wherever it had got to. The pickup is not faded: it is a one-shot a few hundred
milliseconds long and its level is decided when it plays.

**The pickups are heard as they are scored.** `playCoin` fires from the same `onToken` callback that
pays the token and fills the HUD, so the sound cannot drift from the token it belongs to; it plays
through a pool of four voices rather than one element, because restarting a single element cuts the
previous pickup short and a run can take two tokens inside a second. `playPickup` is the same idea one
event over — it fires from the `powerup_collected` event the HUD's chip is drawn from — and it is a
*different file* rather than a pitch-shifted coin on purpose: a shield, a magnet and a double change
what the run is about to cost, and that has to be audibly not a token.

**What the settings move, and what they do not.** One mute switch and one slider, in the menu and in
the pause overlay, are the *same* control (`src/game/SoundSettings.tsx` reading one store in
`src/game/audio.ts`) rather than two that agree by convention — the two surfaces cannot disagree about
how loud the game is. Both persist under `watchme-run:sound` and are validated on read, so a stale or
hand-edited value cannot open the page at 400%. What they move is the game's own sounds; Orbis's
generated soundtrack belongs to the world and is left alone, which is what the panel's own label says
out loud. The track keeps playing while the game is paused: it is the game's, not the world's, so a
pause does not have to sound like the end of the run.

Verified headlessly under Chrome's real autoplay policy, with every control driven by a real gesture:
no music element exists before the first interaction; one real click starts it and its level
**climbs** — measured at 0.171 then 0.270 as the ramp ran, against a target of 0.270 (`0.6 × 0.45`),
rather than appearing at the target — and it loads `bgm.mp3` and reports its duration as 116.16 s,
which is the encode and not the source; mute catches it mid-ramp and takes it the same way down
(0.219 → 0.114 → 0 over about 320 ms), and an unmute returns it (0.047 → 0.152 → 0.270); a mute
260 ms into a *fresh* fade-in fades out from exactly there rather than jumping; both mute and volume
persist, the slider surviving a reload at the value it was set to; and the pause overlay carries the
same panel at the same value. The audio is now 1.5 MB in total, where the source track alone was
3.7 MB.

**One bug the fades hid.** The ramp clamps its progress now: an animation frame's timestamp is the
frame's *own* start time, which can precede the `performance.now()` that scheduled the fade, so the
first callback can compute a progress a hair below zero — invisible on the way down, but on the way
*up from silence* it asks for a negative `volume`, which `HTMLMediaElement.volume` refuses with an
`IndexSizeError`. Verified by driving the real toggle from silence: the level climbs 0.000 → 0.076 →
0.140 → 0.245 → 0.270 with no exception.

## Stakes, and what the world is answering

The run used to be unloseable. `damage` accumulated (`dangerLevel` was exactly `damage / 3`), the combo
reset on a hit, and then you carried on: a run could not end, so the escalation the game was modelling
was decorative, and a score was a receipt rather than a target.

**Three hits end it** (`MAX_DAMAGE` in `src/game/run-state.ts`). The third sets the run over, the
simulation winds the world down rather than stopping it — `speed` damps to zero, so the roadside, the
world layer's parallax and the runner's cycle all slow on their own curves — and the defeat pose holds
instead of a runner jogging on the spot behind its own game-over card. `run_ended` is published as the
run's last event; the director still ignores it on purpose, because a run that is over has nobody left
to steer for, and the hit that ended it already went to the world as `damage_taken`.

**Run again is a remount, not a reload.** `RunnerScene` keys the simulation on `attempt`, so a restart
re-initialises every ref the run owns — state, obstacles, coins, timers — while the canvas, the world
layer and the session stay exactly where they were. Measured: the card appears, "Run again" clears it,
the HUD is back at 0 m with three pips, and `data-surface` never leaves `run` — no loading screen, no
new session, no re-priming the world.

**The record is per world** (`src/game/records.ts`), because the three worlds are not comparable —
different paces, different obstacle recipes, different token curves (`difficultyMeters`), so one global
best would be the desert's by construction and would quietly tell a player their forest runs do not
count. It is `localStorage`, read validated and written best-effort, and it appears on the world card
that picks it. A first run *sets* the record rather than beating one: saying "new best" over the only
score on the board is the kind of small lie that makes a number meaningless. Measured with a seeded
record of 4,321: the card reads "Best here is 4,321 over 1234m", a 484-point run does not overwrite it,
and the menu chip shows it.

**What the HUD was not showing.** The vitals row carries the three things the simulation computed and
the interface hid: the hits left, the combo, and the pressure. `combo` is the one that matters most —
it decides the world's posture (`playerStyle`, which is what makes the prompts change their posture
too), and it was invisible, so the game's whole premise was legible only to someone who read the
source. The pressure bar is `dangerLevel` read back as what the world is doing about it, and it is
named for the hazard that world advertises on its menu card (*Sandstorm*, *Blackout*, *Fog*) — the
cheapest possible way to make the promise and the meter the same thing. Measured live: `×5` combo at
`0.67` pressure on the second hit, all three pips spent at the end.

**The card says what the world answered, not what was asked of it.** `dir.deliver` now hands the cause
(a `PromptCause`: the event, and the run state it was read from) back to the sender, and `RunExperience`
turns it into a feed — *NEAR MISS ×2* → *the world leans in* — with the prompt itself kept underneath,
clamped, as the evidence. The cause travels through the director rather than being guessed at in the
interface because the director is what decides whether an ask is *spent*: an event held for a chunk and
replaced by a newer one never reached the world, and reporting it as a cause would be a lie about what
the player is looking at. The menu's opening shot and the run's launch carry no cause, for the same
reason — they are not answers to anything the player did. Measured live: the feed is empty at the line,
holds one entry after nine seconds (one ask spent), and empties again the moment a new run
starts.

## Three things worth picking up

The run had one pickup already — the coin — and a coin cannot change a run. It is on the line you are
already running down, it asks for nothing, and its only pressure is the greedy mistake of leaving the
correct lane to collect it. So the field gained three verbs that do change one, each answering a
specific way a run goes wrong:

| pickup | what it does | how it reads |
| --- | --- | --- |
| **shield** | the next hit is spent on it instead of on `damage` — no pip, no combo reset | a pale blue octahedron |
| **magnet** | for 9 s, coins within 14 m bend into whatever lane the run is in | a pink horseshoe, face kept to the camera |
| **double** | for 11 s, the token curve pays twice | a gold pair of cubes, because it is the one pickup whose meaning is an amount |

**The rhythm is planned in distance, not in chunks.** `POWERUP_SPACING = 165` is the spacing the field
aims for, and `buildPattern(..., wantsPowerup)` places one in whichever chunk crosses that distance —
on the coin line (`POWERUP_Y = 1.05`), in a lane the coins already hold (`pickCoinLane`), so a pickup
never asks for a move of its own the way a high coin or a gate does. Measured over eight runs: the gap
between one pickup and the next is 160–250 m, median 191. The 165 m is a floor on the spacing, not a
metronome: a chunk is the smallest unit the field can put a pickup in, and a chunk is 30–60 m of road.

**A magnet pulls, it does not collect.** The coin is damped towards the runner's lane rather than
teleported into the score, so it still has to arrive — which is why `Coin.x` is an offset from a lane
rather than a position: the coin is still a coin *in the lane it was placed in* to every other rule in
the run, and the pull is only a render-time bend. Measured in one session: 664 samples of coins sitting
off-centre while a magnet was up, including a full 4.8 m crossing from lane 0 into lane 2.

**A doubled token is doubled by the same expression that pays it** — `coinValueAt(...) * (state.doubleTokens > 0 ? 2 : 1)`
— so the number above the runner's head and the score in the bank cannot disagree about what a coin was
worth. The `×2` is deliberately *not* a separate scoring path. Measured over 342 tokens in one session,
reported against the curve's own value at each collection distance: every doubled token paid exactly
twice it, every plain token exactly once it, worst difference 0.

**A shield is taken before `damage` moves.** It is checked in the collision branch the hit lands in, so
the stumble and the world's answer are the same as any other hit — what changes is that no pip is
spent, the combo survives, the frame flashes the pickup's own colour instead of the damage red
(`--absorb`; the red flash is the game saying a hit landed, and this is the hit that did not), and the
simulation publishes `powerup_spent` instead of `damage_taken`. Measured: shield collected at 398 m
with damage 0, spent at 427 m with damage still 0.

**A spend is said out loud** — `.run-callout`, under the top strip, in the pickup's own colour. The
chip in the HUD is the *state*; this is the moment it changed, and a state whose only sign is an
absence is the one thing a player cannot be asked to notice at speed — a magnet's clock running out
looks exactly the same. The words come from the same `describeAnswer` the world's feed uses, so the
card and the feed cannot drift apart, and the card's timer waits while the run is paused, because a
pause is a player who has stopped to look. Measured by `tools/pickup-probe.mjs`, which now fails the
run if the callout is missing, unreadable, or if the frame pulses the damage red for a hit a shield
absorbed: the card reads `SHIELD SPENT — it took the hit for you` at the moment the shield disappears,
with `--absorb` reading 1.00 while `--hit` reads 0.00 and the damage stays where it was.

**The HUD wears the pickup's own colour** (`.hud-pickup`, one border and one word per verb), counts the
two clocks down, and reserves nothing: a run with no pickups running draws exactly the row it drew
before they existed. The shield is the one that has to be on screen the whole time it is up, because it
is invisible until it saves you.

**The world answers all four moments, per world.** `eventFragments` gained `powerup_collected` and
`powerup_spent` for desert (the ruins pulse, then die back to embers), city (neon flares, then stutters
out) and forest (glowing plants brighten, then go dark as the fog closes), and `audioEvents` gained a
bright chime and a glassy shatter. All of them obey the same two rules as every other fragment — no
figure in the frame, no camera move — and `npm run check:prompts` now builds and scans them with the
rest (300 picture prompts, 78 captions).

**One bug worth recording, because it was invisible from the game.** The director used to hold a
single pending event, and a routine event was allowed to overwrite a routine one — correct for
near-miss chatter, fatal for a pickup, which fires once and then says nothing for a while.
Measured before the fix: **one pickup answer in 99 feed entries**, across a session that collected
dozens of pickups. The
fix is `isPlayEvent` in `src/game/run-state.ts` (pickups, a pickup spent, a hit, a tier crossing) and a
default in the director's `trigger`, so a player-caused moment claims the slot and the world's own
weather cannot displace it. Measured after: **19 pickup answers in 105 entries**.

`window.__runfield()` (development only) reports the field in front of the runner — pickups with their
lane, obstacles, the coins a magnet has bent and by how much, the two clocks, and what a token is worth
at this distance — and `tools/pickup-probe.mjs` plays a real run with an autopilot that dodges, chases
pickups, and walks into an obstacle on purpose when a shield is up, then checks every claim above
against the simulation's own numbers rather than against a screenshot.

## The world's own weather

Every world already promised one. The menu card sells the desert as *Sandstorm*, the city as
*Blackout*, the forest as *Fog*, and the pressure meter on the HUD is named for it — and nothing in the
run ever did it. The hazard is that promise made playable, and the reason to play a second world: each
one attacks a different channel. It is also where the generated world stops being scenery: the same
event that changes the rules of the run is the event Orbis is asked to draw, and the player is looking
at the answer while it is happening to them.

| world | hazard | what it attacks |
| --- | --- | --- |
| desert | **Sandstorm** | *where you are* — gusts push the runner a whole lane sideways |
| city | **Blackout** | *what you can see* — the city's power fails and the lane markings go dark |
| forest | **Fog** | *how far ahead you can plan* — the distance closes in to about 44 m |

**The schedule is measured in metres of run**, not seconds, for the same reason the pickups are: a slow
world and a fast one should meet the same weather for the same run, and a paused run must not burn
through a storm behind a pause screen. The first hazard waits for **240 m**; the warning band is 60 m;
the storm lasts 150 m at the line and 150 + `difficulty × 60` by the end of the curve; the spacing
between one warning and the next is 600 − `difficulty × 140`, floored so the quiet never disappears.
Intensity is *continuous* at every join (0.35 rising to 1 and back to 0.35, then out to zero), because
weather that switched on would read as a bug in the lighting rather than as the world turning.

**The warning is the interface's, the answer is the world's.** For 60 m before it lands the hazard has
a name on the HUD (`Sandstorm / incoming`, in the milestone gold, pulsing) and the sky is already
staining; the world itself is asked once, on arrival, as `hazard_started` — a play event, so it cannot
be displaced by the milestone chatter. Each world has its own fragment and its own camera hold — a wall
of sand sweeping the horizon, every light in the city failing at once, fog rolling across the ground —
and its own sound caption. `npm run check:prompts` builds and scans all of it with the rest.

**The shove is one whole lane, not a drift.** The runner's lateral position is a lane, so a continuous
push would be a state the simulation does not have (and a runner hanging between two lanes is a
collision the player cannot reason about). A gust takes a lane and the run has to take it back — and the
direction alternates with the hazard's index, so a storm walks the runner one way and then the other.
Measured in one desert storm: four lane changes with no key pressed, alternating 1→0, 0→1, 1→0, 1→2.

**The storm may take a lane; it may not take the lane that kills you.** A gust that lands the runner in
a lane an obstacle is already standing in is not a hazard, it is a hit the player had no way to answer —
and it reads as the game moving them into the obstacle rather than as weather. So every gust is checked
before it lands (`laneClearFor`): if the lane the wind wants has an obstacle within the next 22 m, the
gust goes the other way; if both side lanes are occupied ahead, the gust is held and lands the moment
the road opens. The storm still takes a lane — that is the hazard — but it can no longer take the one
that is already occupied. 22 m is over a second at every world's top speed, so what the player gets is
a decision rather than a coin flip.

**The blackout takes light, and light is information.** The road's and the apron's own materials are
driven down to 30% of their graded colour — the lane markings are painted into the colour map, so the
cost is exactly the thing the ground was giving away for free — and the roadside panels, which carry a
frame of the live world, go out with the rest of the city. Measured on the composite frame, against a
control pair: two clear frames 1.2 s apart read **41.2** and **39.0** mean luma (that 2.2 is the world's
own drift), and the peak reads **22.8**.

**The fog closes the road's own planning distance.** The WebGL fog is created with the scene and parked
past anything the run can see, so nothing recompiles when the weather pulls it in — a hitch in the
middle of a hazard about visibility would be the one thing the hazard must not be. At a hard run's peak
it closes to 44 − `difficulty × 10` m from the camera, which is inside the road's own fade (full at
40 m, gone at 83 m), and the near plane is held well past the runner so the character being steered
never becomes a smudge. Measured the same way: **49.4** and **51.1** clear, **90.8** at the peak.

**A sandstorm that does not haze the distance is a colour cast**, so the desert gets its own, gentler
fog — the far layer softening to about 140 m — on top of its scrim. Measured: **76.6** and **77.0**
clear, **91.9** at the peak (the desert is a bright world whose honest drift is 0.4 luma between two
clear frames, so the storm is the whole of the change).

**The weather over the picture is a screen-space scrim**, and it has to be: the generated world is a DOM
video *behind* the WebGL canvas, and a treatment that covered only the road would be a game effect
happening in front of a sunny world. The simulation publishes `--weather` (the intensity) and
`data-hazard` / `data-hazard-phase` on `:root`, throttled to real changes, and `.hazard-layer` — one
inert div — draws whichever of the three treatments applies. During the warning the same layer pulses,
which is how the sky changes before the weather lands.

**One ordering bug, and what it cost.** The director's pending queue delivers one ask per slot, which is
right — and a run's routine traffic (a near miss every second) kept taking the next slot, so a storm's
answer could sit behind it for a hundred metres: measured, the sandstorm arrived at 302 m and the world
answered it at **396 m** — and in the city and the forest the run was over before the answer went out at
all. Now a play event waiting in the queue *claims* the next slot: routine events arriving behind it
wait their turn instead of spending it. Measured after: arrival 302 m, answer **325 m**. The routine
events are not lost — they are the queue's tail, and they are still replaced by each other rather than
queued, because a distance milestone from four seconds ago is not news.

`tools/hazard-probe.mjs` plays each world until its weather has been seen, answered, and photographed —
restarting through the card when the hazard ends the run, which is allowed to happen — and brackets the
picture with two clear frames a second apart against the peak frame, so the numbers above are a change
and not a drift. `window.__runfield()` reports the phase, the intensity, how many hazards the run has
announced, and the lane, which is where a shove shows up without a key behind it.

## The skill ceiling

A run could always be *long*, and the only way to be good at it was to survive. Two things make it
possible to be good: a **flow** value that near misses and threaded gaps build and a hit wipes, and the
one moment the game slows down for — a gap taken between two obstacles in the adjacent lanes at once.

**Breaking even is a rhythm, and the constants are set so it is.** A near miss adds 0.15; the meter
drains at 0.03 a second. A player who takes a near miss every five seconds holds a steady meter; the only
ways up are to be close to things more often or to thread the gaps. The first values tried were 0.1 and
0.045 a second, and the measurement is worth keeping: **seventeen near misses left the meter pinned at
0.13** — a ceiling nobody could reach, which would have made the whole feature a decoration. A hit wipes
it outright: the meter is the run's *form*, and a hit is the end of it.

**Flow pays, in the same arithmetic the road already used.** The distance trickle is
`12 + flow × 18` points a second, so the *same* road pays up to two and a half times as much for the same
second of running — and the HUD says the multiplier (`×1.0` → `×2.5`) rather than the raw number, because
the player's question is "what is this worth now". Measured over one run of 2,000 m, with every token
subtracted by timestamp (coins pay separately and are not part of this claim): **112 s held at
flow ≈ 0.97 paid 29.5/s**, against a low-flow window at **12.16/s**. The formula predicts
12 + 0.97 × 18 = 29.5. Two and a half minutes of a real run agreeing with an arithmetic line to a tenth
of a point is the whole reason the trickle is a formula rather than a feeling.

**The perfect gap already existed in the content — as a complaint.** The `pair` shape blocks two lanes
and leaves one open, and its own comment records that the middle-open case was *discouraged*: "a pair
that opens the middle asks a runner already there for nothing at all". The skill ceiling is that nothing
turned into the game's best moment: two obstacles in the side lanes at the same z (within 4 m), the run
in the middle, and it has threaded a gap. `pair` opens the middle one time in three, so it is a shape to
read for rather than to farm.

**Threading slows time, and it slows *time* rather than speed.** For 0.42 s the run's clock drops to
0.45: the content field, the roadside scroll and the runner's cycle (all driven by the speed the
simulation publishes) slow with it, the token clocks run on the same clock — so a moment of slowness is
not a free eleven seconds of doubled tokens — and the distance trickle slows with it, because the trickle
is the ground paying for a second of *run*. The camera dollies 0.9 m closer and eases back out. Nothing
rolls or whips: the generated world is locked to the frame, and the one thing this rig may not do is turn.

**A slow-motion moment has a cooldown of 90 m**, because farming the middle is exactly what a player who
has read this far would do: `pair` leaves the middle open one time in three, and a run that only ever sits
there would spend a fifth of its life in slow motion. The thread still counts, still pays flow, and still
gets the world's answer while the flourish is on cooldown.

**The world answers a thread with a held breath** — the only answer in the game that is not an escalation:
the blowing sand stalls and the ruins sharpen, the rain hangs in the air and the far avenue goes still,
the fog thins and the far trunks come back — with its own sound caption. The feed line is
`GAP ×N — the world holds its breath`, and the end card keeps the count (`GAPS`) with the score and the
tokens.

`tools/flow-probe.mjs` plays a run to *seek* the good moments: it dodges only what is in its lane, holds
the middle whenever two side lanes are blocked at the same z, and then reads the claims back out of
`window.__runfield()` — the flow value, the gap count, the run's own clock and where the camera has been
dollied to. Measured in one forest run: **12 gaps threaded**, the clock at **0.48–0.53** through eighteen
samples, the camera down to **10.37 m** (from 11.5), the feed carrying `GAP ×2` through `GAP ×12`, and the
trickle numbers above.

## The deal you take

A run was one difficulty for everyone. Now the interface offers **four deals**, and every one of them is
a number the run already had: how many hits it survives, what a token pays, how fast the flow meter
fills, and whether the world is allowed to bring its weather.

| Deal | Hits | Tokens | Flow | Weather |
| --- | --- | --- | --- | --- |
| Standard | 3 | ×1 | ×1 | on |
| Close quarters | 2 | ×1.3 | ×1.5 | on |
| Glass cannon | 1 | ×1.6 | ×1.2 | on |
| Fair weather | 3 | ×0.9 | ×0.75 | **off** |

The deal is chosen before the line and travels as one object — `RunTerms` — into the simulation, which
reads the terms instead of the constants: the run ends at `terms.hits` rather than `MAX_DAMAGE`, a token
pays `coinValueAt(…) × terms.tokenScale`, a near miss adds `0.15 × terms.flowScale`, and
`hazardAt(…, terms.hazards)` returns `CALM` for a world that has agreed not to bring its weather. The HUD
chip names the deal and draws its pips from the same hit count the simulation ends on, so the display and
the rule cannot drift apart.

**The measurement is the point, because a contract that only changed a chip would look identical.**
`tools/contract-probe.mjs` plays each deal — including Glass cannon *deliberately into the traffic*, since a
one-hit limit can only be tested by taking the hit — and reads the run's own numbers back out of
`window.__runfield()`. Measured over one run per deal, live: **every token paid at its deal's exact
scale** (13 tokens at ×1.0 under Standard, 2 at ×1.6 under Glass cannon, 20 at ×0.9 under Fair weather,
2 at ×1.3 under Close quarters); **Glass cannon ended on the first hit** (1 of 1 allowed) and Close
quarters on the second (2 of 2), while Standard and Fair weather ran on; **Fair weather produced no hazard
phase at all** across 400 m — no badge, no start, nothing but `calm`; and the flow gained per near miss
measured **0.14–0.15 under Standard against 0.22 under Close quarters**, which is the 1.5 it claims. The
world answers every deal in its own voice: `TERMS · <name> — the world agrees to the deal`.

**The announcement nearly wasn't.** Getting the world to say which deal you took turned out to be the
hardest part of the feature, and the failures are all measured rather than guessed. Announced from the
simulation's clock, the ask landed inside the window that discards asks (zero `TERMS` lines across four
runs); moved to the interface's clock after the dive's quiet window, it landed inside the *cooldown*
behind the run's first routine ask; and even when it reached the queue it could be evicted, because the
chunk that read the dive prompt can stay the current chunk for a whole run — measured in the forest: the
ask waited for a boundary that never came, the run ended, and the run's own teardown cleared the queue.
Three changes came out of that, each one a rule rather than a patch: the deal is **asked again until the
feed shows the world answered it**; a **priority ask that has waited longer than 3.2 s goes out mid-chunk**, where it is still the newest prompt in force because the chunk hold keeps every other ask behind it;
and the same ask arriving twice **replaces its predecessor instead of queueing a copy**, so the retry can
never push a play event out of the slot to repeat itself. The probe now leaves a one-hit deal played
straight into the traffic out of the verdict — a run that is over in seconds has no announcement to miss —
and requires it of the runs that last.

```bash
node tools/contract-probe.mjs http://[::1]:5199/            # all four deals
ONLY=glass node tools/contract-probe.mjs http://[::1]:5199/ # one deal, while iterating
```

## What a run leaves behind

A run used to leave one thing: a score in a world. Now it leaves two, and the second one is the more
interesting of them.

**A line, not just a number.** Every 20 m the run writes down where it was — `distance, lane, score,
time` — and a run that sets a best files that line with the record (`watchme-run:records`). A best of
1,800 m says *what* happened; the line says *how*, and it is the only way a later run can be set against
it. The line is all-or-nothing on read: half a line would put the ghost in lanes the best run never held,
and any record written before lines existed (or hand-edited) reads as an ordinary best with nothing to
race.

**On the road, the line; in the HUD, the race.** Two different readings of the same quads, because they
answer different questions. The road carries a mark — a ring on the asphalt and a soft stand of light
over it, additive and unlit — standing in the lane the best run held at the metre the player is at now;
it is a thing to aim at, not a rival, and it slides across the lanes the way the record did.

**The mark on the road is opt-in, and off by default** (`src/game/marker.ts`, one switch used in the
menu's top bar and in the pause overlay). It is help rather than furniture: a player who has not asked
for a line to be drawn on their road should not have to work out how to ignore it, and on a first visit
there is no best run for it to point at anyway. With it on, the mark is the ring *and* the stand of
light over it — the column is what makes it findable in a crowded frame at speed, which is exactly what
someone who switches it on is asking for — and with it off, neither is drawn: the mesh stays mounted
and its `visible` is set per frame from the preference, which is also why the pause overlay's switch
is felt the frame it is pressed.
The HUD carries the comparison that
actually means something between two runs: **metres ahead or behind the best run at the same second**,
read by interpolating the line's times. Green is ahead, a dim red is behind. The moment a run is a whole
metre up on its best — once per run, and not in the opening metres, where the launch surge would beat any
line — the world answers: `BEST LINE BEATEN — N m up on your best run`.

**And tokens now outlive the run that earned them.** Every run banks what it collected
(`watchme-run:bank`), and the deals are bought with the balance: Fair weather 400, Close quarters 500,
Glass cannon 1,200, Standard free. The two halves are deliberately in different places — the picker
inside a run only *chooses*, because the player there is mid-decision and a price with a balance under
it would turn a run into a shop, while the buying lives in the menu, on the screen every run starts
from. That is what makes the deals a decision about more than one run: the deal that pays the most
tokens is the deal that survives the fewest hits, so the bank is fed by exactly the runs the record
punishes, and the chip a player cannot take is a target rather than a wall.

**Measured, in one probe run of the whole loop** (`tools/meta-probe.mjs`, forest, two runs): the first
run banked **exactly its 8 tokens** and the card said `BANK +8`; its line filed **14 samples for 252 m**,
evenly spaced at 20 m, every sample further and later than the one before it, and ending **0 m short** of
the distance the record claims; with a balance seeded at 500 the 1,200-token deal stayed shut while the
500-token one could be paid for, and paying took **exactly 500** (bank 500 → 0), wrote the deal, opened
the chip and took it; the second run was shown the ghost in **192 samples**, the ghost's lane matched the
stored line at **191 of 191 checks**, the mark on the road was drawn and standing in that same lane at
**188 of 188 reads** — the mesh checked, not just the numbers, because a marker the scene never received
would leave every other reading perfectly correct — the HUD's race number stayed within three metres of
the readout's own gap in **172 reads** (that gap is the HUD's five refreshes a second, not a
disagreement), and the world answered `BEST LINE BEATEN — 1 m up on your best run`.

**The probe found a bug the eye could not.** A run winds down rather than stopping — it coasts to a halt
behind its own card — and the road it coasts over is still full of tokens. Collected anyway, the HUD's
token count went on ticking *past* the number the run had already filed and banked: one run filed 8
tokens while the HUD reached 9, two numbers describing the same run and disagreeing. Coins and pickups
now stop being collected the moment the run is over, which is the same rule the distance trickle already
followed — a finished run earns nothing more.

```bash
node tools/meta-probe.mjs http://[::1]:5199/   # bank, line, ghost, purchase; or WORLD=city
```

## Running in your own picture

Selecting a world also offers an **optional landscape**: a picture the player uploads, which Orbis
then grows the world out of. It is the structural version of the horizon hold described above. Rather
than measuring the generated horizon and shifting the video to fix it, the picture is measured and
cropped *before* it is ever sent, so the world starts out agreeing with the game:

```text
upload → measure the horizon (same rule as the runtime lock, wider search)
       → cover-crop so that horizon lands on the game's 44% line
       → 1280×720 JPEG + a seed derived from its own pixels
       → reset the session → setImage → start
```

`src/orbis/landscape.ts` does the crop as a closed form rather than by iterating: the scale is the
smallest one that both covers a 16:9 frame and allows the horizon to sit on the line, then the offset
is solved directly, so the horizon lands *on* the line rather than near it. Sides are cropped
symmetrically; a picture whose horizon is already near the line is barely touched. A picture with no
clear horizon is not guessed at — it is centred on its cover crop and the menu says so.

**The picture is kept, and the world to run it in is asked for beside it.** Uploading is work the
player did with a file from their own device, so it is not thrown away on a reload: the `File` itself
is stored (`src/orbis/landscape-store.ts`, IndexedDB) and run back through the same preparation on the
next visit, which reproduces the identical landscape — same crop, same measured horizon, same seed,
same preview — without storing a prepared JPEG that could drift from the code that made it. Storing
the file rather than a string is also why it is IndexedDB and not `localStorage`: an upload may
legitimately be 14 MB of pixels (`LANDSCAPE_MAX_BYTES`). Every path here is best-effort — private
browsing, a blocked store, a quota error each degrade to "no stored picture", which is what the menu
did before — and the clear control deletes the record, so a picture the player removed stays removed.

The world is asked for in the same block, as soon as there is a picture to run in. A picture replaces
a world's *scenery*, not the world: the pacing, the obstacles, the road and the roadside still come
from the world cards, which makes the world a real second half of the upload rather than a setting
somewhere above it — so the three cards appear under the picture under the heading *Where do you want
to run?*, and a pick there moves the selected card above it (verified in the probe: picking Neon
Pursuit in the block sets `world-card.world-city.selected` and the stored choice, and the reload comes
back on both). The choice itself persists in `localStorage` (`readWorldChoice` / `rememberWorldChoice`
in `src/game/worlds.ts`), validated against the catalog on read so a stale key cannot put the game into
a world that does not exist.

Measured on the headless probe end to end: a fresh visit has no landscape card and no picker and
starts on the last world; a 39 KB picture uploaded through the real control lands as *Horizon found at
73% — placed on the game's horizon line* with the picker under it; picking Neon Pursuit there moves the
card above and stores `city`; and after `Page.reload` the landscape card, its note, the picker and the
city selection all come back from the store.

Measured with the probe's own row scan of the *prepared* frame (not the app agreeing with itself),
for four synthetic pictures whose horizons sat well below the line:

| picture horizon | prepared horizon | step | result |
| --- | --- | --- | --- |
| 0.54 | 0.4375 | 110 | placed on the game's line |
| 0.55 | 0.4375 | 110 | placed |
| 0.67 | 0.4167 | 93 | placed |
| 0.73 | 0.4167 | 95 | placed |

All four land within one 48-row sample of the 0.44 target. In the run, that shows up where it should:
the runtime lock measured the generated horizon at 0.42–0.46 against a game line of 0.4434–0.4460 and
**held a 0.000% shift for the whole run** — with the picture pinned, the lock has nothing to do. The
same run's generated horizon steps (93.6, 78.3, 74.7 luma at contrasts of 3.0–4.9) show the crisp
edge of the pinned frame carried through, rather than a skyline inferred out of texture.

**Pinning costs a session restart**, and the run waits for it on the loading screen: a starting image
can only be pinned before `start`, and only `reset` clears one, so changing the landscape is a rebuilt
world rather than a prompt swap. The pin belongs to the run rather than to the menu — the menu stages
the picture, and the picture is a *condition* of the session the run asks for, so the wait is named
where the work happens ("Pinning your landscape") instead of being a disabled Start button. The
alternative — the rebuild landing under a run — would be a hard cut through the dive, which is exactly
what the first version of this did.

Measured on a headless run with a 671 KB picture, end to end: menu at t=0 with `pinning: false` and
`status: disconnected` and an enabled Start button; Stage 2 (pinning) on the loader from t≈3 s;
`has_image: true` at t=40 s; run at t=40 s, with `data-landscape` on the world layer and
`has_image` true for the whole run.

Measured: **9.0 s** (pinned in 9032 ms, world armed in 11562 ms), 8.5-9 s across two other runs, 13.9 s
once through a link that was still recovering, and **36 s** once when the upload arrived while the
menu's own session start was still settling — the pin could not begin until that finished, and only
noticed it should because a `state` message happened to re-run the arming effect. That last case is now
an explicit retry (`ARM_RETRY_MS`) rather than an accident of message timing, which also closes the case
where an arm that *failed* would clear the pin without ever applying the picture.

Re-measured end to end through the real upload control: a 900×500 picture with its horizon at 0.72 is
scanned at **0.7292**, prepared to **0.4167** in one crop and staged with Start enabled; the run's own
arming pins it (stage 2 on the loader), and the bus reports `has_image: true` at 1080p for the whole
run, with `sourceHorizon 0.7292` and a seed derived from the pixels.

Because the world is grown *from* the picture, the prompts change with it: a landscape the player
supplied is described as "the exact landscape supplied as the starting frame… the same terrain, the
same colours, the same light… carried forward", never as a named world, since naming one would fight
the frame the model was handed and drag the scene back towards the named environment. The gameplay
world is unchanged — it still decides the pacing, the obstacles and the road — and the run's HUD names
both: the world on the label line, the picture as the value.

## What to expect from Orbis

The world takes a moment to become live. A run starts with `src/WorldLoader` on screen, naming the
step Orbis is on:

- `Waking the world engine` — session request in flight
- `Generating your world` — WebRTC negotiated and the conditions sent; usually 15-25 s to the first frame
- `Pinning your landscape` — only when the player supplied one: `reset`, the image, then the seed
- `Arming the run` — the delivery tier read from the offered list, then `start`, then the hand-over
- `World link offline` — no live world yet. At 55 s the wait is given up and the run starts anyway
  (20 s once Orbis has reported an error), and the chip in the run carries the real error and a retry

The menu's chip says something different on purpose — `World starts with your run` — because before a
run nothing has been asked for, and "Loading world engine" there would be a promise the menu is not
keeping. The menu's backdrop is the local per-world gradient (`data-world` follows the selected card).

The chip never shows an SDK string. A transport symptom on a link that was live reads "World link
interrupted — reconnecting", because the recovery effect is already retrying it; the same symptom on a
link that never came up reads "Couldn't reach the Orbis world — the run plays over the local backdrop",
because nothing is retrying that one. `[orbis] connect failed` in the console keeps the raw diagnosis
for whoever is debugging.

The world also answers the run's reward curve, not just the HUD's label: crossing a quarter of a
world's token value fires a directed prompt that escalates with each step — the desert's ruins igniting,
the city's billboards flaring, the forest's bioluminescence blooming — and it is queued as a milestone,
so a routine distance update cannot push it out of the slot.

It also **sounds like the world it is**. Orbis generates the audio with the picture on a separate
conditioning channel, and `setAudioPrompt` is steered per world and per event with what the scene
*sounds like* (the model's own guidance is blunt that a scene description here makes the audio worse
than sending nothing, and only about the first 128 tokens are read): a dry desert wind with fine grit
hissing past, rain on asphalt with tyres through standing water, wind high in old leaves with wood
creaking — and each event bends that bed rather than replacing it, so a near miss is a gust passing
close and a tier crossing is the ambience swelling with a rising shimmer over it. Every caption rules
out voices, narration and music in as many words, because the audio model's default reading of a
moving camera is a narrator, and a narrator is the one subject this world must not have.

**Pausing the game pauses the world.** Generation stops with the play button, and a hidden tab pauses
it too, since nobody is watching a world in a background tab. A paused session produces nothing, so
this is also the lever that stops an open session from costing anything while it is idle. Frames stop
arriving and the last frame holds — measured, not assumed: two samples of the raw video 2.5 s apart
changed by **0** while paused against **10.7–45.1** while running (re-measured after the throttle
below: 0 against 3.7–4).

**A chunk, then a rest.** The same lever duty-cycles generation down: every `chunk_complete` earns
the chunk loop `CHUNK_REST_MS` (3 s) of `pause`, and the next chunk starts when the rest expires.
Orbis produces continuously while a session is started — a chunk of frames every 1.5–2 s, forever —
and every chunk is spend, so this is the throttle on what an open session costs: measured from the
reconciler's own trace, a session now completes a chunk every **3.7 s** against **1.8–1.9 s**
unthrottled — about half the chunks per minute — and the rest is one constant if more is wanted. It is
visually free because of what the generated world now is (next section): a distant landscape drifting
slowly behind the game, which does not need frames at full rate to stay alive. Two guards came out of
measuring it: a run never opens on a rest (the rest is cleared when a run starts, or the launch prompt
waits out the pause), and a pause/resume command that never settles is bounded at 10 s and retried —
without that ceiling one lost reply wedges the reconciler's in-flight guard and *every* later pause
silently does nothing while chunks keep being paid for.

One rule governs the ask queue: Orbis reads the prompt that is in force when a chunk
*starts*, so a second prompt inside the same chunk is thrown away unread. The director subscribes to
`chunk_complete` and spends at most one ask per boundary, holding the rest for the next one. The single
exception is deliberate: a priority ask that has waited `PRIORITY_WAIT_MS` (3.2 s) takes the current
chunk anyway, because the alternative is a crash steering the world five seconds later — the journal
marks those entries `deadline: true`. A run measured 7 asks across 7 chunks with none overwritten,
where the version without the gate spent 6 asks on 5 chunks and lost one.

The account allows **one concurrent Orbis session per model**, so the app holds one and recycles it:
it disconnects on `pagehide`, and lets the session go **60 s** after a run ends — the menu is a
staging surface, so an open session there is one nobody is watching, and the grace window is only
there so that going straight back into another run skips the loading screen. While the menu is up the world layer is hidden
(`html[data-surface="menu"]`) and the recovery effect is gated on a run being on screen, so a blip in
the menu cannot connect a world the player did not ask for. It retries with the reason on screen while
a closed session is still releasing its slot. Gameplay never waits for it — the runner is fully
playable over the local backdrop.

A drop *during* a run is the case that used to end quietly over the local backdrop, and it is worth being
precise about why. The recovery effect reconnects the link, and the SDK hands back a session with
nothing armed on it — no prompt, no image, no running generation — so someone has to arm it again, and
the app's only `start()` is the arming pass. That pass returned early whenever a run was on screen:
re-arming is `reset` plus `start`, and a world rebuilt under the player's feet is worse than the one
they are already running through, so the guard earns its keep. The exception is a link that came back
*during* that run. The request still stands, the run is why it stands, and the arming went with the
session that dropped — which is precisely what an empty `applied` under a live run means, since
`applied` is cleared the moment the link leaves `ready`. Without that exception a recovered link comes
back connected and silent: the video re-attaches, generation never restarts, and the run finishes in
the local backdrop with the world reachable the whole time.

Measured with the link dropped under a live run (`tools/drop-probe.mjs`): `disconnected` 3 s later
with the video element unmounted and the run still playing, `ready` at 31 s, the re-arm reaching
`start()` at 41 s — `arm :: run=true recovered=true` then `started :: run=true recovered=true` in
`window.__orbisTrace` — and frames moving again at 45 s. Before the change no `arm` entry could exist
at all: the pass returned before it traced anything.

That slot is also the app's one dependency on a *server* setting, so the two have to agree. A
session is leased for at most `MAX_SESSION_DURATION_SECONDS` (`server/reactor-token.ts`, 20
minutes), and a leak is the one way a session outlives the tab that created it: the lease expires
on its own, but a release that fails — an orphaned session is exactly what `session termination
failed: http transport error: jwt resolver rejected: fetch failed` leaves behind — holds the slot
for that whole lease. Both retry loops (`BUSY_*` and `RECONNECT_*` in `WorldLayer.tsx`) therefore
poll quickly for the two minutes an ordinary release takes and then at a minute apiece for
`SLOW_RETRY_ATTEMPTS`, which outlasts any lease. Shortening either budget below the lease is how a
single dropped connection turned into a world that never came back until the page was reloaded.

The release itself is retried too (`releaseSession`). A `disconnect()` that fails is worth re-asking
rather than abandoning, because of what the SDK does with it: `Reactor.disconnect()` only frees the
wasm client *after* the release has succeeded, so the failed attempt leaves the one thing that still
knows which session to end alive, and the next attempt — with a working JWT — finishes what it
started. Until it lands, the session is a recorded debt (`releaseOwed`), carried into every later
connect so the slot is paid off *before* a new session is asked for instead of after the 429 that
asking for it would earn.

A 502 from `/api/reactor/token` is worth reading precisely, because it is not the Reactor API
rejecting anything: both token routes answer 502 only when their *own* outbound `fetch` to
`api.reactor.inc` throws, and the body carries Node's message for that (`{"error":"fetch failed"}`)
rather than an HTTP status from Reactor. It means the dev machine could not reach the API at that
moment, and the SDK reports the same moment as `jwt resolver rejected: fetch failed` — which is also
why the surrounding 429s are a *consequence*: the JWT that failed is the one termination needed.

## The generated world is the far layer

The generated video used to fill the frame at the road's depth, and the prompts asked for a camera at
running pace with "the ground sweeping continuously toward the bottom of the frame" — so the player
appeared to be running *through* the generated world's cliffs, dunes and clouds, at the same depth as
the road. It is now what a game's backdrop is: a distant landscape, farther away than the runner, and
therefore moving slower than the runner. Three things carry that:

1. **The prompts describe a distant landscape.** The camera "drifts steadily forward at a slow
   walking pace, far slower than a run", and every picture prompt carries a distance clause —
   cliffs, mountains, dunes, trees, ruins and buildings hold their distance near the horizon and
   never come close to the camera, no clouds cross the foreground, and the ground between the horizon
   and the bottom of frame stays flat and empty. The generated world also has **no path** of its own
   any more: the game draws the only path, and a road in the video was a second one ending nowhere.
   `npm run check:prompts` asserts the distance clause on all 300 picture prompts, like the horizon
   clause and the emptiness clause.
2. **A distance haze dissolves the near field.** `.world-video::after` in `src/styles.css` ramps
   atmosphere over the video below the meeting band (the game horizon is at ~44% and the ribbon fades
   at ~50%, so 44–50% stays clear where the two layers blend). Whatever the world puts close to the
   camera — a cliff flank, a dune face, low cloud — fades into haze before it can read as an obstacle,
   and the ribbon is the only near-field surface. Drawn over the video and under the WebGL layer, so
   the game is never hazed.
3. **The parallax is slight, because distance is slow.** The video answers `--world-x` (lane
   changes) and `--run-speed` (pace) at about a third of their old strength — 0.5% and 0.025 where
   they were 1.4% and 0.09 — so the road and the runner carry the speed and the backdrop trails.

Measured on captures, band by band (`frame-report` on the composite, the 3D layer and the video layer
of the same instant), in the desert: above 33% the composite is the video's (they agree to a few luma),
the 42–50% band is where the two hand over, and from 58% down the ribbon carries the frame
(|composite − video| 13 luma at 58%, 40 by 83%) while the video behind it falls away (44 → 17) — a lit
path through atmosphere rather than a road laid over a photograph.

The ribbon itself was lengthened with the roadside's reach, and for the same reason. It is 96 m of
plane now — twelve whole 8 m tiles, so the dashes still close on the far edge — against 56 m, and its
fade was re-cut to match: full opacity for the first 40 m and gone by 83, where it used to be solid for
8 m and gone by 32. The local apron under it grew from 90 m to 120 m with its dissolve carried out to
about 92 m, because the scenery's own far taper had to be standing on ground that was still there. On
screen this is not the move the numbers suggest, because the projection compresses hard near the
horizon: the ribbon's fade now completes about 48% down the frame rather than 53%. What the eye gets
is that the ribbon is *solid* from the bottom of the frame up to about 54% where it used to be solid
only to 65% — a road running to the meeting line instead of a mat laid on the ground.

The ribbon's grade follows the same reading: `world-palette` measures the ground band *just under the
measured horizon* (published by the vertical lock as `--world-horizon-window`) rather than the lower
third — which is haze now, and which straddled the skyline step half the time: `--road-grade` flapped
between 0.69 and its 2.0 clamp in one run until the band was anchored to the horizon and the reading
median-filtered. After: 0.71 → 0.82 across a run, tracking the world's tone.

## The roadside

The generated world is the far layer and the ribbon is the near one, and nothing used to be in
between: pace was judged from the ribbon alone, which reads as a treadmill in front of a painted
backdrop. The roadside fills the gap with content the run moves past, per world:

| world | what stands beside the road | pieces a cycle | panels |
| --- | --- | --- | --- |
| desert | five kinds of bought boulder in clusters, more of them bigger further out, five rock outcrops as the landform, saguaros, low adobe houses, signs | 105 in 16 kinds | 11 |
| city | the pack's shopfronts and houses at the kerb, its bins and bench as clutter, the tall narrow blocks in the skyline, street lights reaching over the shoulder, a billboard on legs, a sign on a roof | 92 in 16 kinds | 12 |
| forest | the pack's five trees in two stands, five kinds of stone between them, fallen logs and stumps at the shoulder, trail markers | 115 in 13 kinds | 7 |

Those pieces are not boxes either. The first roadside was one unit cube scaled per piece — cheap, and
it read as a fence of crates, because at 30 m/s there is no time to resolve a silhouette out of a box.
Now a world's *scenery* is artist-made models out of the packs in `models/` (see the assets section),
and the *furniture* — the signs, the billboards, the street lights, the logs, and the blocks a world
falls back to when its pack is missing — is authored out of three's primitives in
`src/game/roadside-props.ts`, its parts merged into one geometry with a colour baked per part (a
street light's pole and head are one mesh, not two).
Either way a kind is one `InstancedMesh`, so a world's roadside is a dozen-odd draw calls and 8–15k
triangles instead of two — still no per-piece objects, no materials per prop, and nothing that reacts
to where the runner is.

The two halves meet in one map. A prop, bought or hand-built, answers the same two questions — how much
ground does it take up, and how tall is it — and the layout works from that (`PropMetrics`), which is
what lets a row be built from a model when one is available and from the shape it was drawn with when
it is not. Every model is normalised to one metre tall with its base at zero by the cooker, so a row's
scale range in metres means the same thing for both, and a row names its variants in order of
preference (see `planRoadside`). That is also what a world does when a pack fails to fetch: the forest
falls back to its authored conifers and boulders and still runs, rather than starting with nothing
beside the road.

The layout is fixed data — each piece at a fixed offset in a 105 m cycle of Z, seeded per world so a
world is the same place every visit — and the scene wraps that cycle by the distance travelled each
frame, so a piece leaving the far end has already reappeared behind the runner. Nothing spawns, nothing
is culled, no React state changes per frame; the only per-frame work is one matrix per piece.

That cycle was 75 m, ending 58 m ahead of the origin, and 58 m is inside the part of the road the eye
is still reading: a piece arrived at that distance at full size, having finished growing while it was
still near the middle of the frame, which is what made the scenery read as appearing out of nowhere
rather than standing there all along. The density of the cycle is unchanged — the same rows at the
same spacing, so the road looks exactly as busy — it is simply 40% longer, which is 40% more metres
of warning before anything is beside the runner.

Three details are what keep it from looking wrong at speed:

- **Taper, not pop.** Pieces shrink into their own footprint over the last 24 m (`roadsideTaper`). At
  105 m the apron's alpha is nearly gone and the world's haze is thin, so a recycle has nothing to hide
  behind and the seam would otherwise be a visible event. The taper is wide in metres because the
  screen is what is narrow up there: 24 m of ground between 64 m and 88 m out is a couple of percent of
  the frame's height, so a piece grows from a speck to its own size over about a second of travel at a
  spot the eye has already accepted as landscape.
- **Cleared from the inner edge, not the centre, and measured rather than declared.** A piece is
  positioned from its row's *inner clearance* outwards, so a bigger one moves further out rather than
  reaching across the shoulder, and the clearance is worked out from the geometry's own bounding box
  (`PropMetrics`) — moving an arm on the cactus moves the clearance with it, and a bought boulder brings
  its own. The nearest
  piece edge therefore stands at its row's clearance and never inside it — 6.2 m from the road centre at
  the closest, which is the city's street light, against a road edge at 5.25 m — and the light is also
  the nearest thing in any world physically: its arm is what reaches in, hanging about a metre off the
  kerb at 4.7 m up.
- **On the ground, and a little into it.** Pieces used to sit on one flat base height, which was wrong
  wherever the apron's banks are not flat: the banks climb to 1.75 m, so near-shoulder pieces floated
  about half a metre and outer ones were buried. The apron's height field now lives in its own module
  (`src/game/apron.ts`) and has two callers — the terrain mesh and the props standing on it — so
  nothing can hover over the surface it is standing on. Each piece is then set into that ground by 8%
  of its own height (`roadsideSink`), which is what stops a boulder reading as balanced on a point and
  what absorbs the apron being a 2.5 m-per-quad mesh over a rolling field.

### The panels are Orbis

Orbis produces video and audio, not geometry. So the shapes are the game's — authored or bought — but
the picture on their camera-facing face is the live generated world: `src/orbis/world-frame.ts` samples the session's own
`<video>` into a 320×180 canvas about once a second, and the panels are textured with it. The roadside
wears the place the player is running through, and a change of world repaints it — the most direct
answer available to "can Orbis make the scenery": not by generating the scenery, which it cannot do,
but by generating what the scenery is wearing.

Only the kinds that can plausibly wear one do, and where it goes on each is one anchor apiece
(`panelAnchor`): a board on two posts in the desert, posts through a board in the forest, a billboard
frame on legs and a frame on a rooftop in the city, and a small lit sign on the wing of the adobe
house. Every panel is 16:9, because the picture is a frame of the generated world and another aspect
would letterbox or stretch it, and every panel faces straight down the road — a panel on a piece with
a random yaw would face away from the runner, and the picture is the point of it. Panels are unlit
(`toneMapped: false`) so they read as signage in any world's light. When there is no world to show —
the first seconds of a run, or any run over the local backdrop — they carry `createPosterArt`'s abstract
panel for that world, because a lit panel with nothing on it is a black rectangle.

Verified on headless runs in all three worlds, from `window.__roadside()`: 105 pieces in 16 kinds and
11 panels in the desert, 92 in 16 kinds and 12 panels in the city, 115 in 13 kinds and 7 panels in the
forest — the same figures on every run of a world, which is what "the plan is seeded per world" means
in practice. `models` reports how many cooked props the world has to draw
from (15 for the desert, 20 for the forest, 13 for the city), `travel` advances at the road's own
speed, `panelSource` reads `live` in every one of them a few seconds into a run (the sampler's canvas
being uploaded, which also confirms a stream-backed canvas is origin-clean and usable as a texture),
and `shoulder` reports the apron's height under the near row, which the props are placed on.

That the pieces are *in the frame* is measured, not assumed — and in a world where the scenery and the
ground behind it are both nearly black, a count of instances says nothing about whether any of them is
being drawn. So there is a switch for it: `window.__roadsideVisible(false)` hides the whole group,
and two captures either side of it difference out to exactly how much of the picture the roadside is.
Taken as with → without → with, about 200 ms apart, so that a contribution can be told apart from the
generated world drifting between captures:

| world | with | without | with | contribution |
| --- | --- | --- | --- | --- |
| city | 57.0 | 62.9 | 56.0 | **−6.4 luma**, whole frame |
| forest | 59.5 | 67.7 | 57.9 | **−9.0 luma** |
| desert | 70.9 | 67.7 | 72.9 | **+4.2 luma** |

The contribution is the later "with" against the "without", and on a roadside this long it is largest
where the pack's shapes are dark against a pale world: the forest (−6.1, −9.0 and +1.5 across three
passes) and the city (−5.3, −6.2, −6.4), whose textured buildings sit in the world's tone where the
authored near-black blocks they replaced read −14. The desert is the one world where the scenery *adds*
luma rather than taking it away (+3.4, +3.6, +4.2): its boulders are sandstone on sand, read by shape
and the shadow under them rather than by tone, and there are enough of them now to outweigh it.

The spread between passes is the world's, not the roadside's. A pass is only readable because the two
"with" frames agree to about a luma, which rules out drift *inside* it — the forest's +1.5 came from a
pass whose generated world ran at 33 luma against its usual 59, and the desert figure this replaced was
−0.6 in a single drifting pass. Nothing in a three-frame capture can rule out the world behind the
roadside changing between passes, which is why the table is a sample rather than a constant.

The apron under all of it is drawn per world (`TERRAIN_DETAIL` in `RunnerScene.tsx`). One mottling
serving as the material for all three read as exactly that — the same ground under a dune, a paving
slab and a forest floor — so each world now has its own tile size, ink and mark counts, published per
run as `--terrain-tile` / `--terrain-ink` on `:root` (14 / 4 in the desert, 11 / 4.2 in the city, 12 /
4.2 in the forest). The scroll is unchanged by any of it: the offset advances by distance over the
tile and the texture repeats every tile, so every world's pattern still travels exactly with the
ground. A smaller tile means finer detail, not slower ground.

That the ground moves in each of them is measured: frame-to-frame mean |Δluma| over the 31–62% rows —
the band the apron is actually seen in, below the horizon and above the HUD — with the Orbis layer
hidden so the capture is the game's own geometry over the local gradient. Over ~18 m of travel it
reads **14.1** (desert), **20.0** (city) and **19.4** (forest), against a sky band that reads exactly
**0.000** as the control. The spread between worlds is inside the noise of the measure, which is also
why the values are not fitted to it: the same unchanged desert read 22.9 in one run and 14.1 in
another, because the terrain grade adapts to the frames and the roadside puts different pieces under
the camera each run. They are chosen from what each material is and what survives being looked at —
see the constant's own note for why the city's tile is closer to the desert's than paving alone would
suggest.

## What the app asks of Orbis

`reactor/visko-orbis-stable` (`@reactor-models/visko-orbis-stable@^2.3.0`) declares ten model commands
and fifteen messages, on top of the SDK store's `connect` / `disconnect`. The app used to drive four of
the ten and listen to one message; it now uses all ten and four messages, each for something the game
needs. Read off the installed type declarations, not from memory:

| Command | What it does here | Verified by |
| --- | --- | --- |
| `connect` / `disconnect` *(store)* | the one session; released 60 s after a run ends, and on `pagehide` | session reaches `ready`; the busy path observed live ("still releasing the previous world (2/15)"), including the leaked-slot case where termination failed and the slot answered 429 until its lease ran out |
| `setPrompt` | the world's wide shot, the run's dive, one prompt per event | `window.__orbisPrompts` — one `launch` per dive, nothing steering after Exit |
| `setImage` | the player's landscape, as the starting frame | `image_accepted 1280x720`, `has_image:true`, and a run whose horizon the lock leaves alone |
| `setSeed` | armed from a hash of the prepared frame, so a picture opens the same world twice | sent before `start`, never refused. The reproducibility it promises is the model's contract, not something this probe observes |
| `setResolution` | `1080p` on every device — the tier changes what a session costs far more than what the player sees (the upscale is on the way out), and the world is the game's hazed backdrop | `want=1080p have=2k offered=["1080p","2k","4k"]` accepted, `resolution:"1080p"` in every later `state`. Read *after* the arming round-trips: the list only arrives with a `state`, and the one emitted on connect is gone before this layer's listener exists |
| `setAudioEnabled` | sound on — `main_audio` carries the generated soundtrack | `audio_enabled:true` in the state, the element unmuted with a live `audio:live` track |
| `setAudioPrompt` | one caption per world, bent per event | `audio_prompt` in the state is this world's caption; captions pair with visual prompts in the journal |
| `start` | arms and starts generation; chained per world | chunks advance (`current_chunk` 0 → 14 across a run) |
| `pause` / `resume` | the game's pause, a hidden tab, and the chunk rest that duty-cycles generation | `paused:true, running:false`, `generation_paused` / `generation_resumed` replies traced per cycle in `window.__orbisTrace`, and the chunk counter frozen across a held pause: **0 chunks over 22 s** of a paused run, then 4 over the 12 s after resuming — the pixels are the weaker evidence, since a live stream plays out the chunk it was already handed and reads as a moving picture for a second or two after the model has stopped |
| `reset` | clears the conditions so a new landscape can be pinned | `started:false, chunk:0, has_image:false` → re-armed |

| Message | What it does here |
| --- | --- |
| `state` | published on the bus as the session snapshot; every command is gated on it |
| `chunk_complete` | the world's real cadence; one ask per boundary, and the chunk each ask went out in is journaled. A priority ask past its 3.2 s deadline lands mid-chunk and is marked `deadline: true` |
| `command_error` | classified rather than surfaced raw — "already generating" after a `start` is the expected answer, and an audio refusal is remembered so a deployment without an audio track is asked once |
| `image_accepted` | logged with the decoded size, which is how the prepared frame is confirmed to have arrived at 1280×720 |

Two honest limits. Whether the generated sound is *audible* is not something a headless probe can
claim: `webkitAudioDecodedByteCount` stays 0 for a `MediaStream`-backed element even with a live audio
track, and an `AudioContext` cannot be resumed without a real user gesture — so the check is the
model's own report plus the track being live and unmuted. And `setSeed`'s reproducibility is the
contract's claim rather than a measurement here.

## Grading the ground into the world

The generated world is a video and the ground is WebGL, so the ground is graded into the frames'
tonal range rather than given a fixed colour: `src/orbis/world-palette.ts` samples the live video
(a few dozen pixels every 1.2 s) for its overall tone and for the tone of its ground band — the
generated terrain just under the horizon, where the ribbon fades into the world — and
`src/game/road-grade.ts` turns that into the ribbon's material multiplier, with per-world
calibration and limits. The band is anchored to the *measured* horizon rather than fixed, and the
reading is the median of the last five, because a band that straddles the skyline step swings the
grade by multiples as the lock shifts the video (see the far-layer section above).

Measured on the desert, at the spot in front of the runner:

| | before | after |
| --- | --- | --- |
| ribbon, alone | 20.8 luma | 33.2 |
| generated ground, same spot, same instant | 32.5 | 34.0 |

`--road-grade` and `--world-ground-luma` are published on `:root` while a run is live.

## Diagnostics

`tools/orbis-probe.mjs` drives headless Chrome through a real run — the menu first, then the run-entry
load, then the run — and prints the chip, the video element state, the layout of the world layer,
Reactor network responses, console output, and the grade. It asserts the two claims of this build on
the way: that the menu is *local* (no session started, no video element, the world layer at opacity 0)
and that the loader reached an armed world rather than giving up into the local backdrop. It follows the
loader by its own stages, and measures the dive from where it now begins — the first frame after the
loading surface leaves — so a cold run is reported as a slow load rather than a run that never ran:

```bash
node tools/orbis-probe.mjs http://localhost:5173/ 45 "$TEMP/watchme-run.png"
```

On this build the probe's audit run measured: the menu **local** (status `disconnected`, no `<video>`
element, layer opacity 0, no session asked for); the loader **armed in 24 s** (23–26 s across three cold
starts, 45 s on the day's first); the session at **1080p with its own sound on** and `started: true`;
**9 asks with nothing doubled outside the priority deadline** — the two mid-chunk sends the deadline
makes are listed with a `deadline` flag, not counted as faults; the pause **holding the chunk counter
still** (3 → 3 across the paused window) at **0.0 luma of change against a running control of 8.1**,
with the media clock still advancing — which is why the counter decides it and the clock cannot; and
**0 run prompts after Exit**.

It also writes frames for judging the composition without viewing the image:

| File | Contents |
| --- | --- |
| `…png` | the composite the player sees (UI hidden) |
| `…png.3d.png` | the 3D layer over the local gradient |
| `…png.ribbon.png` | the ribbon alone on black — its rendered tone |
| `…png.video.png` | the generated world alone |
| `…png.menu.png` / `.offline.png` | the homepage with and without the live world |

Every prompt the app asks for is journaled at the ask, with its reason, the world status, its channel
(`video` / `audio`), the chunk it went out in, and the outcome — readable in a headless pass at
`window.__orbisPrompts`, which is how the per-world intros are verified exactly (one `launch` per
dive, accepted, nothing else steering the world), how "nothing steers the world after Exit" is proved
rather than assumed, and how "one ask per boundary" is arithmetic on a real run rather than a claim
about the code — with the one sanctioned exception, the priority deadline's mid-chunk ask, marked in
the entry (`deadline: true`) and counted separately from a chunk that took two unsanctioned asks.
The live session snapshot is published the same way at `window.__orbisWorld`, and the pause
reconciler's own trace — what it wanted, what it asked for, and what the model answered for every
pause and resume — at `window.__orbisTrace` (the probe prints its counts and a tail as `pause trace:`).
The trace exists because the console is not evidence: the CDP console stream drops lines under load,
and the question it answers (did a rest turn into a real pause, and did the command settle) is exactly
the question a dropped line would answer wrong.

`LANDSCAPE=1 node tools/orbis-probe.mjs … 20` builds a picture in the page with its horizon
deliberately low (`LANDSCAPE_HORIZON=0.72` by default), hands it to the real upload control, then
measures the prepared frame with its own row scan and reports that the choice is *staged*: the pin
itself happens at run entry, which the loader's second stage is the record of. Measured end to end on
this build: a 900×500 upload with its horizon at 0.72 is scanned at **0.7292**, prepared to **0.4167**
— the game's own line — in one crop (step 95, preview 384×216) and staged with Start enabled; the pin
rides the run-entry arming (loader stage 2, *"Placing probe-landscape on the horizon line and growing
the world from it"*), the world is armed in **31 s** with `has_image: true` through the run, the HUD
reads `desert / probe-landscape`, every prompt says *the supplied landscape* instead of naming a world,
and the pause check still holds on the pinned world (chunks 3 → 3, 0.0 luma against a control of 2.8).

The probe's pause check waits for the pause that was *asked for* to reach the model, rather than for
any `paused` state: `pauseRequested` plus `paused`/not-running plus a chunk index that has held still
across two samples — a rest between chunks reads as `paused` too, and breaking on that reported the
world as paused before the model had answered. It then settles five seconds and samples two frames of
the raw `<video>` 2.5 s apart, with a running control taken first by the same code (retaken once if it
lands in a rest). The media clock is not evidence either way, since a live track keeps its element's
clock advancing whether or not frames arrive.

`tools/roadside-probe.mjs` drives one run per world and asks the two questions the roadside can be
asked. What is beside the road comes from `window.__roadside()`: pieces per kind, panels, how far the
scroll has reached, the height of the apron under the near row, and whether the panels are wearing the
live world or the fallback art. Whether any of it is *in the picture* cannot come from that, so the
probe hides the whole group with `window.__roadsideVisible(false)` — the world layer's sibling of
`window.__orbisDrop`, published in development — and captures the same instant of the run with,
without, and with it again. The three captures are what make the difference readable: the generated
world is a live video layer that keeps changing, so a flat with/without pair cannot separate a
roadside contribution from the world drifting, whereas a contribution shows up whichever way time runs
between the three. It writes the frames and prints the `frame-report.mjs` lines that turn them into
numbers, and it checks the one failure the readouts cannot see — a shader or program error in the
console, which is what a broken instanced mesh looks like.

```bash
node tools/roadside-probe.mjs http://[::1]:5199/ "$TEMP"   # or WORLD=city for one of them
```

`tools/pickup-probe.mjs` plays a real run with an autopilot — it dodges what is in its lane, steers
towards the next pickup, and, once a shield is up, deliberately stops dodging and walks into the next
obstacle — and checks the pickups against the simulation's own numbers instead of a screenshot. The
readout behind it is `window.__runfield()`, which reports the field *in front of* the runner (pickups
with lane and position, obstacles, the coins a magnet has bent and by how far), the two clocks, and
what a token is worth at this distance from the same `coinValueAt` the scoring uses. Beside it,
`window.__runnerSize()` reports the scale and foot height a runner resolved to, which is the readout
that turns "the runner came back the wrong size after a retry" into the two numbers to compare. Evidence is
gathered from three places — that readout, the HUD's `.hud-pickup` chips with their countdown text, and
the director feed together with the `+N` token readout, both watched as events with observers — and it
is accumulated across restarts, because one run is not long enough to meet three pickups. It exits
non-zero on a cadence outside 130–205 m, a kind that never appeared, a pickup the world never answered,
a shield spent without a `SHIELD SPENT` line, a magnet that never bent a coin, a token paid off the
curve, or a HUD with no chip on it.

```bash
node tools/pickup-probe.mjs http://[::1]:5199/            # or WORLD=city, DEADLINE_MS=600000
```

`tools/hazard-probe.mjs` does the same for the weather: a run per attempt (restarting through the card,
because a hazard is allowed to end a run), an autopilot that only *dodges* — so a lane change with no
key press behind it is unambiguously the storm's — and the HUD badge, the `:root` attributes, the feed
and the lane read from `window.__runfield()` as it goes. Its frames are a bracket: two clear ones
1.2 s apart for the world's own drift, one at the peak, one after it has passed if the run lived. It
ends with the `frame-report.mjs` lines that turn the bracket into the numbers quoted above.

```bash
node tools/hazard-probe.mjs http://[::1]:5199/            # or WORLD=forest, ATTEMPTS=3
```

`tools/contract-probe.mjs` plays the deals rather than the world: each one taken from wherever the player
happens to be — a pause, or the card — and then the deal's own claims read back as numbers, the chip and
its pips against the hit count, every `token-gain` against `window.__runfield()`'s own curve at that
moment, the highest damage against the deal's limit (Glass cannon is steered *into* the traffic, because a
one-hit deal can only be tested by taking the hit), the hazard count under Fair weather, and the flow gain
per near miss bucketed by deal. The feed is recorded from the DOM as it renders, at the observer callback,
so an answer that arrives while the card is remounting is still counted — a distinction that mattered: a
reader watching added `<li>` nodes only, and not their subtrees, missed the deal's acknowledgement three
runs in a row and made a working feature look broken. A phase that was over in seconds is reported as a
note rather than a fault, since a one-hit deal played into the traffic has no room for an announcement to
be spent.

```bash
node tools/contract-probe.mjs http://[::1]:5199/            # or ONLY=glass, WORLD=desert
```

`tools/meta-probe.mjs` plays the *meta* loop: two runs in one world with the stores cleared, the menu's
deals row read before anything has been run, and then every claim checked against the data itself rather
than against the UI — the bank against the run's own token count, the card against the bank, the stored
line against its own shape (whole quads, strictly increasing in distance and in time, spaced 20 m apart,
ending where the record's distance says the run stopped), the ghost's lane against the stored line at the
same metre, and the HUD's race number against the readout's own gap. The purchase half seeds a balance
rather than earning one — 1,200 tokens is four long runs, and the point is the *purchase*, not the
grinding — and then checks that a deal past the balance stays shut, a deal within it can be paid for,
that paying takes exactly the price, and that the deal is open afterwards. Like the contract probe, it
reads the feed from the DOM at the observer callback, subtree included.

```bash
node tools/meta-probe.mjs http://[::1]:5199/                # or WORLD=city, SEED_BANK=1200
```

`tools/drop-probe.mjs` drives a run and then takes the link away from under it, to check the one
failure that cannot be produced any other way: the network can be withheld from the token route and
from every other request, but not from an established WebRTC media path —
`Network.emulateNetworkConditions({offline:true})` was measured under a live run and the status sat at
`ready`/`streaming` for the whole twenty seconds while the world kept producing frames and the chunk
counter climbed from 1 to 7. The transition is therefore forced through `window.__orbisDrop`, which
the world layer publishes in development: the SDK told to drop while a run is on screen, which is what
the status goes through when the transport really dies. The probe then prints the status transitions,
the arming pass's trace entries, and the mean luma change of the world's pixels before and after — the
only honest evidence that frames are being produced again rather than that a media element exists.

```bash
node tools/drop-probe.mjs http://[::1]:5199/
```

`tools/frame-report.mjs` has a mode per question: `--cliff shot.png` prints the row-brightness profile
and the sharpest darkening step (the skyline rule, run on a capture so it reads where the horizon
actually lands rather than where the module says it does); `--activity a.png b.png` measures what
changed between two frames of the same shot, row by row — the measurement that killed the
movement-based detector, because in the desert the *sky* changes more than the ground.

`tools/frame-report.mjs` also turns captures into numbers: band means and a tile diff for several frames,
a per-frame edge/hue map, and a region readout for one rectangle.

```bash
node tools/frame-report.mjs "$TEMP/watchme-run.png" "$TEMP/watchme-run.png.3d.png" "$TEMP/watchme-run.png.video.png"
node tools/frame-report.mjs "$TEMP/watchme-run.png.ribbon.png" --region 0.35,0.70,0.65,0.92
```

Every attempt also logs `[orbis] status -> ...`, each model message, and video-element
attachments to the browser console.

## Auditing the run loop

`tools/run-audit.mjs` simulates full runs against the real pattern field, obstacle kinds, coin
placement, speed ramp, and difficulty curve, and reports what the content *asked* the player to do:
per-world hazards and coins per 100 m, the time available for each required move, coin placement
against the safe route, and the pressure band by band.

```bash
node tools/run-audit.mjs 60 1500   # 60 runs of 1500 m per world
```

It writes the raw output to `doc/run-loop-audit-data.md`; the report and what to change are in
[`doc/run-loop-audit.md`](doc/run-loop-audit.md). The headline: fairness is clean (zero unavoidable
rows, zero windows under 0.35 s, no coin walled off, no coin that costs you a hit), coin placement is
shaped by the move it rewards — an arc over a jump, a low line under a slide, a line in the lane a
dodge reaches — the dead air between decisions is closed (the gap after a chunk that asked for
nothing is shorter, and the late-game mix leans on chunks that block two lanes or carry a wall),
no row arrives closer than a lane change: the slalom's turns, the gauntlet's sequence and the
tunnel's gate-to-obstacle gap were all widened, so the tightest row in any world is 0.87 s instead of
0.63 s, while `slalom` fell from 24% to 11% of rows, no row closes two lanes at once (a `pair` carries
at most one wall, so the two-lane reads the audit was watching are **0.00 per run**), and the reward now
rises with the difficulty: 25 → 75 points a token, which takes coin points per 100 m from ~380 at the
line to ~1050 at the end. It also records what was tried and *reverted*, with numbers: steering a
`pair`'s open lane toward where the content believes it left the runner cost dead air (3.12 → 3.32 s on
the desert), because that belief is right only 37–41% of the time against 33% for naming a lane at
random. The claim is measured (`chunk hint` in the audit output); nothing steers on it.

It also reports where the run *looks* right, not just how it plays. `MOBILE=1 node
tools/orbis-probe.mjs …` holds the phone viewport (430×900) for the whole session and measures the
absolutely-positioned interface around the runner — element boxes, every pair of overlays and the pixels
they share, anything hanging off the screen, and which element actually receives a click at each control
(`document.elementFromPoint`), so a panel that merely *overlaps* a button is not mistaken for one that
covers it. That check caught the world chip covering the HUD's numbers on a phone; they are stacked
below the header at that breakpoint now, and the overlap measures zero.

`VIEWPORT=360x640` runs the same session at a narrower phone, which is a different question — the
interface is right-anchored and sized by its content. It found two: the HUD needed 345px and landed
exactly on `x=0`, and the header's three items shrank until the exit button's label wrapped, growing the
header to 60px past the chip's fixed top so the chip sat on the button's lower edge and swallowed clicks
there. The HUD now caps its width and wraps instead, and below 420px the run-status is dropped — the world
chip directly beneath it says the same thing in more detail. Both sizes are re-measured with nothing off
screen and no overlap.

## Auditing the prompts

The generated world has to stay a landscape and keep its sky above the game's ground, so the prompts
are checked like content. This builds every prompt the app can send on both channels — each world ×
(its own scenery or a player's landscape) × opening/launch/every event × every player style, plus every
audio caption — and fails if a picture prompt names a subject or drops the emptiness clause, the
distance clause or the horizon hold, or if a caption names a subject, forgets to rule out voices, or
runs past the length the model actually reads. Currently **300 picture prompts and 78 captions, all
clean**:

```bash
npm run check:prompts
```

## Scripts

```bash
npm run dev             # Vite dev server
npm run dev:netlify     # Netlify dev (functions + token route)
npm run build           # typecheck + production build
npm run preview         # preview the production build
npm run check:prompts   # fail if a prompt asks for a figure, drops the horizon hold, or sends a
                        # sound caption that is not sound
```
