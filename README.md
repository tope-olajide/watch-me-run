# WatchMe Run

A 3D endless runner where the player's actions shape a live Orbis-generated world.

The runner itself is deterministic — lanes, obstacles, jumping, sliding, damage, and score all
run locally at full frame rate. Behind it, Reactor's `reactor/visko-orbis-stable` model generates
the world the player is running through, and the Orbis Director steers that world from gameplay
events: near misses, damage, speed, and distance.

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
sandbox cannot make outbound connections, in which case its token route answers `500` with
an `AggregateError` while the identical function code works on the host and on Netlify.
The game stays playable in that case and says so in the world chip.

## How the world is wired

One Orbis session, one `<video>`, one prompt channel — mounted above the interface and below
everything else, for the whole visit:

```text
App
├── WorldLayer (lazy)          src/orbis/WorldLayer.tsx   the only Reactor session
│   ├── .world-video           the generated frames
│   └── .world-local           per-world gradient until frames arrive
├── MenuExperience             previews the world, picks a world and a runner
└── RunExperience (lazy)       deterministic runner + Orbis Director
```

The interface talks to that layer through `src/orbis/world-bus.ts` — a tiny store with commands
(`world.showWorld`, `world.sendPrompt`, `world.sendAudio`, `world.setPaused`, `world.selectLandscape`)
and a snapshot (`useWorld()`). The layer is lazy, so the menu paints first and the world fades in
behind it; because the layer never unmounts, a run continues inside the same generated stream and
returning to the menu does not cut it. The road grade reads the world's tone from
`src/orbis/world-palette.ts`, which samples the live frames.

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
the city and **31.0 → 75.5** in the forest, both landing on the declared 75 (`tools/orbis-probe.mjs`,
selected per world with `WORLD=`).

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

Starting is a dive into the world that is already generating behind the menu: the live frames push
in and brighten, the interface blurs away, the world's name passes through frame, and the runner
arrives inside the chunks that were already on their way. The same session keeps streaming through
the whole transition, and the moment it begins the world layer is sent a *launch* prompt so the
chunks landing next belong to the run rather than to the menu's establishing wide.

The dive is a phase machine in `src/App.tsx` (`menu → entering → run → exiting → menu`) plus CSS
keyed off `html[data-entering]` / `html[data-exiting]`; `prefers-reduced-motion` gets the arrival
without the ride. The run chunk is prefetched 800 ms after the menu appears so a lazy load cannot
land in the middle of the dive.

Each world also brings its own beat: selecting a card swaps the launch prompt and paints that world's
weather over the live frames for the length of the dive, with a line of copy and an ambience readout
(`intro` in `src/game/worlds.ts`) — sand haze lifting off the ridge, rain sheeting through the neon,
pollen drifting under the canopy. It is atmosphere only: nothing in it asks the player to act.

A run opens with the momentum of that dive: `LAUNCH_BOOST` in `src/game/RunnerScene.tsx` adds a
surge (≈11.6) that decays over 1.8 s into the normal ramp (≈8.4, then climbing). It is part of the
run's speed rather than a cosmetic effect, so the world's scale, the camera's field of view, the
road scroll, and the approaching obstacles all read as one launch — and the controls are unchanged.

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

Measured with `node tools/run-audit.mjs 60 1500`: the city is the densest per 100 m (3.9 decision rows,
14.5 coins) and still the most forgiving moment to moment (its tightest row gives you 1.07 s), while
the desert has the fewest rows (3.6) and the tightest read (0.87 s) because it arrives fastest. No row
in any world arrives closer than 0.87 s — a lane change costs 0.5 s even by the harness's optimistic
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
used — running 0.633 s, jumping 0.867 s, sliding 1.533 s in both — so the run-cycle tuning in
`RunnerCharacter.tsx` was left exactly as it was.

Two files carry the wiring: `src/game/character-catalog.ts` (ids and labels) and
`src/game/RunnerCharacter.tsx` (the `?url` import, the mixer, the crossfades). Only the selected
runner's file is fetched — the menu pulls it when the card is picked and the run reuses it from
cache — so a visit downloads 2–3.4 MB of character, not all three.

**The FBX sources stay in `models/`** as the source of truth but are kept out of git — 122 MB of FBX
against 6.9 MB of GLB, so only the GLBs are committed (`.gitignore` carries the `models/**/*.fbx`
rule) — and `tools/fbx-to-glb.mjs` rebuilds the GLBs from them: 4096² textures are cut to 1024 (colour)
and 512 (normal, specular), a vertex per face corner is welded down to one per vertex
(73,692 → 13,835 for Amy), and the FBX's `MeshPhongMaterial` becomes a physical one that keeps its
gloss rather than approximating it: shininess 20 becomes roughness 0.30, and the specular colour and
map ride through as `KHR_materials_specular` instead of being inverted into a roughness map. That is
122 MB of source down to 6.9 MB of runtime assets, and `dist/` down to 9.0 MB. Re-run the tool after
changing anything in `models/` — a fresh clone cannot, since it has the GLBs and not the sources. And
to look at the two side by side rather than take that on trust, `tools/fidelity-check.html` renders
the FBX and the GLB in the game's own light and measures the difference: mean 0.8–1.4 of 255, at most
3.4% of pixels differing by more than 8, and neighbour-pixel detail within a few percent either way —
the residue being the texture downscale, not the material.

## Controls

| Input | Action |
| --- | --- |
| `←` / `→` or `A` / `D` | Change lane |
| `↑` / `W` | Jump |
| `↓` / `S` | Slide |
| `Space` | Pause / resume |

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

**Pinning costs a session restart**, and the menu holds the run for it: a starting image can only be
pinned before `start`, and only `reset` clears one, so changing the landscape is a rebuilt world rather
than a prompt swap. The Start button is disabled and renamed ("Pinning your landscape…") while that
happens, because the alternative — the rebuild landing under a run — would be a hard cut through the
dive, which is exactly what the first version of this did.

Measured: **9.0 s** (pinned in 9032 ms, world armed in 11562 ms), 8.5-9 s across two other runs, 13.9 s
once through a link that was still recovering, and **36 s** once when the upload arrived while the
menu's own session start was still settling — the pin could not begin until that finished, and only
noticed it should because a `state` message happened to re-run the arming effect. That last case is now
an explicit retry (`ARM_RETRY_MS`) rather than an accident of message timing, which also closes the case
where an arm that *failed* would clear the pin without ever applying the picture.

Because the world is grown *from* the picture, the prompts change with it: a landscape the player
supplied is described as "the exact landscape supplied as the starting frame… the same terrain, the
same colours, the same light… carried forward", never as a named world, since naming one would fight
the frame the model was handed and drag the scene back towards the named environment. The gameplay
world is unchanged — it still decides the pacing, the obstacles and the road — and the run's HUD names
both: the world on the label line, the picture as the value.

## What to expect from Orbis

The world takes a moment to become live, and the chip reports each stage:

- `Waking the world engine` — session request in flight
- `Generating first frames` — WebRTC negotiated; usually 15-25 s to the first frame
- `Live world streaming` — 1080p generated video with audio (the tier the app asks for)
- `Local world mode` — no live world; the chip shows the real error and a retry

The chip never shows an SDK string. A transport symptom on a link that was live reads "World link
interrupted — reconnecting", because the recovery effect is already retrying it; the same symptom on a
link that never came up reads "Couldn't reach the Orbis world — the run plays in local world mode",
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
silently does nothing while chunks keep being paid for, which is exactly what a probe run caught.

One thing to know if you change the director: Orbis reads the prompt that is in force when a chunk
*starts*, so a second prompt inside the same chunk is thrown away unread. The director subscribes to
`chunk_complete` and spends at most one ask per chunk, holding the rest for the next boundary — a run
measured 7 asks across 7 chunks with none overwritten, where the version without the gate spent 6 asks
on 5 chunks and lost one.

The account allows **one concurrent Orbis session per model**, so the app holds one and recycles
it: it disconnects on `pagehide`, refreshes its session after 25 minutes of idling, and retries
with the reason on screen while a closed session is still releasing its slot. Gameplay never waits
for it — the runner is fully playable in local world mode.

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
   `npm run check:prompts` asserts the distance clause on all 156 picture prompts, like the horizon
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

Measured on captures, before and after, band by band (`frame-report` on the composite, the 3D layer
and the video layer of the same instant): above 25% the composite is now pure video (sky, backdrop
intact), 33–50% is video terrain at the meeting line, and below 58% the ribbon shows through the
haze (|composite − video| 7–21 luma) while the video behind it drops to 15–20 — a lit path through
atmosphere rather than a road laid over a photograph.

The ribbon's grade follows the same reading: `world-palette` measures the ground band *just under the
measured horizon* (published by the vertical lock as `--world-horizon-window`) rather than the lower
third — which is haze now, and which straddled the skyline step half the time: `--road-grade` flapped
between 0.69 and its 2.0 clamp in one run until the band was anchored to the horizon and the reading
median-filtered. After: 0.71 → 0.82 across a run, tracking the world's tone.

## What the app asks of Orbis

`reactor/visko-orbis-stable` (`@reactor-models/visko-orbis-stable@^2.3.0`) declares ten model commands
and fifteen messages, on top of the SDK store's `connect` / `disconnect`. The app used to drive four of
the ten and listen to one message; it now uses all ten and four messages, each for something the game
needs. Read off the installed type declarations, not from memory:

| Command | What it does here | Verified by |
| --- | --- | --- |
| `connect` / `disconnect` *(store)* | the one session; recycled after 25 min idle, released on `pagehide` | session reaches `ready`; the busy path observed live ("still releasing the previous world (2/15)") |
| `setPrompt` | the world's wide shot, the run's dive, one prompt per event | `window.__orbisPrompts` — one `launch` per dive, nothing steering after Exit |
| `setImage` | the player's landscape, as the starting frame | `image_accepted 1280x720`, `has_image:true`, and a run whose horizon the lock leaves alone |
| `setSeed` | armed from a hash of the prepared frame, so a picture opens the same world twice | sent before `start`, never refused. The reproducibility it promises is the model's contract, not something this probe observes |
| `setResolution` | `1080p` on every device — the tier changes what a session costs far more than what the player sees (the upscale is on the way out), and the world is the game's hazed backdrop | `want=1080p have=2k offered=["1080p","2k","4k"]` accepted, `resolution:"1080p"` in every later `state`. Read *after* the arming round-trips: the list only arrives with a `state`, and the one emitted on connect is gone before this layer's listener exists |
| `setAudioEnabled` | sound on — `main_audio` carries the generated soundtrack | `audio_enabled:true` in the state, the element unmuted with a live `audio:live` track |
| `setAudioPrompt` | one caption per world, bent per event | `audio_prompt` in the state is this world's caption; captions pair with visual prompts in the journal |
| `start` | arms and starts generation; chained per world | chunks advance (`current_chunk` 0 → 14 across a run) |
| `pause` / `resume` | the game's pause, a hidden tab, and the chunk rest that duty-cycles generation | `paused:true, running:false`, the frame delta above, and `generation_paused` / `generation_resumed` replies traced per cycle in `window.__orbisTrace` |
| `reset` | clears the conditions so a new landscape can be pinned | `started:false, chunk:0, has_image:false` → re-armed |

| Message | What it does here |
| --- | --- |
| `state` | published on the bus as the session snapshot; every command is gated on it |
| `chunk_complete` | the world's real cadence; one ask per chunk, and the chunk each ask went out in is journaled |
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

`tools/orbis-probe.mjs` drives headless Chrome through a real run — menu world preview first, then
a run — and prints the chip, the video element state, the layout of the world layer, Reactor
network responses, console output, and the grade:

```bash
node tools/orbis-probe.mjs http://localhost:5173/ 45 "$TEMP/watchme-run.png"
```

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
rather than assumed, and how "one ask per chunk" is arithmetic on a real run rather than a claim about
the code. The live session snapshot is published the same way at `window.__orbisWorld`, and the pause
reconciler's own trace — what it wanted, what it asked for, and what the model answered for every
pause and resume — at `window.__orbisTrace` (the probe prints its counts and a tail as `pause trace:`).
The trace exists because the console is not evidence: the CDP console stream drops lines under load,
and the question it answers (did a rest turn into a real pause, and did the command settle) is exactly
the question a dropped line would answer wrong.

`LANDSCAPE=1 node tools/orbis-probe.mjs … 20` builds a picture in the page with its horizon
deliberately low (`LANDSCAPE_HORIZON=0.72` by default), hands it to the real upload control, then
measures the prepared frame with its own row scan and waits for the Start button to come back. It also
reports the world's sound state and, between two samples of the raw `<video>` 2.5 s apart, whether the
world actually stops when the run is paused — the media clock is not evidence either way, since a live
track keeps its element's clock advancing whether or not frames arrive.

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
audio caption — and fails if a picture prompt names a subject or drops either the emptiness clause or
the horizon hold, or if a caption names a subject, forgets to rule out voices, or runs past the length
the model actually reads. Currently **156 picture prompts and 42 captions, all clean**:

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
