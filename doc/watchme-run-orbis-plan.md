# WatchMe Run

## Orbis Integration and Implementation Plan

## 1. Project concept

**WatchMe Run** is a 3D endless runner in which the player runs through a deterministic game world while a live Orbis-generated world evolves around them.

The player chooses one of three environments:

- Desert
- City
- Forest

The runner mechanics remain responsive and deterministic: lane switching, jumping, sliding, falling, collision detection, obstacles, score, distance, and animation are handled locally by the game. Orbis generates and evolves the surrounding world in real time based on the player's actions.

The core idea is:

> The player is not simply running through a generated video. Their behavior changes the world that is being generated while they are running through it.

This makes Orbis an essential part of the experience rather than a decorative video background.

---

## 2. How Orbis will be used

Orbis will be used as the game's **living world layer**.

It will generate:

- The distant environment and horizon
- Weather and atmospheric effects
- Distant creatures, crowds, vehicles, and structures
- Environmental transformations
- Cinematic events
- Generated environmental audio
- The visual progression of the run

The local 3D game will generate:

- The playable track
- The player character
- Obstacles
- Collision geometry
- Player movement
- Running, jumping, sliding, and falling animations
- Camera control
- Score and game state
- Gameplay audio feedback

### The generated world must never contain a figure

The runner is the local 3D game's, and only the local 3D game's. If the generated world also renders a
runner, the two figures occupy the same patch of ground and fight each other on screen — the video
one cannot be dodged, collided with, or explained, and it reads as a bug.

A video model renders what a prompt names, so this is a prompt-authoring rule: **no prompt may name a
subject.** No "runner", no "character", no "person". The world is described as an empty landscape
with a camera moving through it, and the emptiness is stated outright rather than assumed:

```text
The path and the landscape are completely empty: no people, no runners,
no characters and no creatures anywhere in the frame.
This is landscape only, seen from the camera.
```

Gameplay state still reaches the model, but as what the *world* does ("the world is being driven into
chaos") rather than as what a figure in the frame is doing ("the runner is reckless"). Even the shot
is called a *shot*, not a *run*, so no noun in the sentence can be turned into a subject.

`npm run check:prompts` builds every prompt the app can send — each world, each event, each player
style — and fails if any of them names a subject or drops the emptiness clause.

### The generated sky stays above the game world

The generated frame is the *landscape*, and the game's road is a 46 m ribbon that fades into it. The
road fades at about 50% down the frame; the game camera's own horizon is at about 44%. That narrow
band is the only place the two layers visibly meet, so the video's ground has to cover it: below the
video's horizon the video is terrain the road continues into, above it the video is sky.

If the generated camera rises or tilts up, its horizon slides *down* the frame, that band turns into
sky, and the runner is left running in the air — the single most common way the composite breaks.
So every prompt carries a horizon hold as its own clause:

```text
The horizon line never moves: it stays in the upper third of the frame,
with sky above it and ground below it. The camera never rises and never
tilts up or down, and nothing in the scene is revealed by a camera move.
```

Three details are deliberate:

- **The horizon is asked for in the upper third, not at the 44% the geometry implies.** Drift needs
  somewhere safe to go. Ground covering too far up is invisible — the ribbon is drawn over it — while
  sky covering the 44–50% band is the bug. The margin *is* the point of the number.
- **Reveals are banned by name.** "A giant tree becomes visible", "a buried city becomes visible" are
  shots a camera earns by tilting up or lifting, and the model took them. Anything that arrives now
  arrives *ahead on the horizon line*, with the camera explicitly staying put.
- **Escalation may not be bought with the camera.** A tier crossing asks for a visibly stronger
  reaction, which is the most tempting reason of all for a model to pull back or rise, so the
  escalation clause carries its own camera hold.

`.world-layer`'s idle breath animation is a push-in only, with no vertical travel: the old
`translateY(-1.4%)` slid the whole world up and back down on a 26 s cycle, which is a slow, constant
mismatch between the landscape and the ground it belongs to.

### The vertical lock (`src/orbis/world-align.ts`)

A prompt is a request, and the desert routinely declines it: measured live, its generated skyline sat
at 50–56% while the game's line is 44.9%, so sky covered the band the road fades into. So the horizon
is also *measured and enforced*.

**Finding the horizon.** The sharpest darkening step between rows of the generated frame. Every live
capture from all three worlds has the same shape — a bright atmosphere band peaking just above a hard
cliff, darker ground below — and in each the largest single downward step is that cliff by 1.6x to
3.0x over the next largest (desert 52%, step 56 luma; city 38%, 52; forest 31%, 44).

A movement-based detector was built first and thrown away. Over a pair of **raw** frames the desert's
*sky* changes more than its ground does, because these prompts deliberately put heat haze, glare and
streaming sand up there; the premise "the ground is what moves" is simply false for this world.

**Only one direction.** The artefact is sky under the road, which appears when the generated horizon
*drops*. So the lock only ever raises the horizon, a horizon already at or above the line is left
exactly where it is, and an unneeded shift is given back. A misread frame therefore cannot cause the
thing the lock exists to prevent.

**Which measurement to trust — the audit.** Thresholds were not guessed. Eight live profiles were
captured (per-row brightness *and* how much each row changed between two frames) and sorted, and step
size splits them in two with nothing in between:

| capture | skyline | step | contrast | row that changed most | verdict |
| --- | --- | --- | --- | --- | --- |
| desert | 52% | **56** | 2.95 | 54 | real, isolated cliff |
| city | 38% | **52** | 2.89 | 4.2 | real — 74% of the frame's whole range |
| forest | 31% | **44** | 1.57 | 7.0 | real |
| city | 60% | 18 | 3.60 | 1.5 | staircase 60/63/69%, frame barely changes |
| desert | 65% | 26 | 1.18 | 20.1 | staircase 58/63/65% |
| city | 56% | 25 | 2.50 | 3.5 | staircase 50/54/56% |
| desert | 48% | 36 | 2.12 | 4.3 | staircase 44/46/48% |
| forest | 44% | 38 | 1.46 | 15.4 | staircase 40/42/44% |

Two conclusions, both of which changed the code:

- **Size is the signal, contrast is not.** The weak group reaches 3.60 while a real skyline sits at
  1.57, so a contrast gate would wave the worst case through while refusing a good one. The gate is a
  minimum step (42 at the 48-row grid the detector now samples on), with contrast kept only as a floor
  at 1.5.
- **The band is 10–60%.** Real horizons measured 31–52%; past ~60% the 8.5% ceiling cannot bring the
  horizon near the line anyway (a 60% skyline lands at 51.5%), so refusing there costs almost nothing
  and is where the doubtful measurements live.

Replayed through the shipped rule: the desert is accepted and shifted 7.0%, the city and forest are
accepted and already above the line so they get nothing, and all five ambiguous captures are refused.

**Guards, each of which came from a live failure.**

| Guard | Failure it answers |
| --- | --- |
| Median of the last 3 measurements | One sample found a "horizon" at 0.563 among neighbours at 0.438, and an average carried a 7% lurch into the world |
| Decision and correction solve from the *same* value | Solving the size from the newest row while the decision used the median made the shift drift back up while the median still said the horizon was down |
| Minimum step, then contrast | A staircase in a near-static frame drove the shift to its ceiling and held it there for a whole run |
| Skyline must sit in 10–60% | A city run found one at 91% — a foreground ridge, not a horizon |
| Correction clamped to half the overscan | Bounds the damage any wrong measurement can do |

**The cost.** Moving the video needs material to move into, so it is rendered 17% larger than its frame
(`--world-overscan` in `src/styles.css`), which allows 8.5% of travel either way and no more. The
ceiling is sized to the genuine need — 7.0% is the largest shift a *real* skyline has required — not to
the 20%+ some measurements have asked for: that would buy a 1.4x zoom on the strength of measurements
the gates now refuse, and would let a wrong one move the world by 20%. Past the ceiling the lock still
helps, raising an out-of-reach skyline by the full 8.5% rather than leaving it.

**Verified live** (`tools/orbis-probe.mjs`, which reads `--world-horizon`, `--world-horizon-window`,
`--world-y` and the video element's own composited `transform`):

- Before the audit tightened the gates, the desert measured 0.50–0.56 and was shifted to the ceiling,
  while the city and forest measured above the line and were left at 0.
- After it, a desert run found a skyline at 0.375 with a step of 44.3 and a contrast of 2.43 — accepted,
  and correctly left at 0 because it sits above the line — and a second desert run measured 18 frames
  and **refused every one**, holding the world at zero rather than guessing.
- `--game-horizon` tracks the camera's field of view as it widens with speed (0.4474–0.4488 on screen).

Three states are distinguishable from the published numbers alone, which is the point of counting
samples before the gate: no `--world-horizon-samples` means no frames arrived (the world never
connected); a sample count with no `--world-horizon` means frames arrived and no skyline was clear
enough; both present means a skyline was found. A shift already applied is held when later frames are
refused — the last good correction stands rather than being dropped on a bad reading.

### Why Orbis should not control collisions

Orbis generates video in continuous chunks rather than producing a structured 3D scene graph. Its output should not be used as the source of truth for collision detection because generated objects may not be spatially stable or frame-accurate enough for gameplay.

The recommended composition is:

```text
Orbis-generated world
  - sky
  - distant environment
  - weather
  - crowds / creatures
  - cinematic events

Local 3D game
  - runner
  - path
  - obstacles
  - collisions
  - camera
  - HUD
```

This preserves reliable gameplay while allowing Orbis to make the world feel alive and reactive.

---

## 3. Recommended visual presentation

The first version should render the Orbis stream as a living horizon behind the local 3D game.

Possible implementations:

1. A large video background behind the 3D scene
2. A curved Three.js surface surrounding the playable path
3. A distant panoramic world surface
4. A cinematic portal or world screen placed beyond the track
5. A video texture used on distant environment geometry

The preferred MVP is a large background or curved horizon surface. This avoids difficult perspective and depth problems while still making the generated world clearly visible.

The local path and player should remain in the foreground so the player always understands what is interactive.

---

## 4. The three environments

## 4.1 Desert: The Dunes Remember

### Local game elements

- Sand-colored track
- Ancient ruins
- Rock formations
- Buried machinery
- Sand ramps
- Falling columns
- Heat haze

### Orbis world elements

- A sandstorm forming in the distance
- Ancient ruins emerging from the dunes
- A red sun changing as the run progresses
- Giant distant silhouettes beneath the sand
- Lightning inside the storm
- A buried ancient city being revealed

### Reactive events

- Near misses intensify the sandstorm
- High speed causes distant ruins to collapse
- Repeated jumps reveal floating rock formations
- Damage turns the horizon dark red
- Long survival reveals a buried city

### Example prompt

```text
Continue the same uninterrupted cinematic shot of an ancient desert at sunset.
The camera moves steadily forward at a running pace, roughly waist height.
A colossal sandstorm is forming behind the camera, swallowing distant ruins.
The path and the landscape are completely empty: no people, no runners,
no characters anywhere in the frame. This is landscape only.
Dust, red light, enormous scale, dramatic forward motion, cinematic realism.
Preserve the same desert identity and continuous camera direction.
```

---

## 4.2 City: Neon Pursuit

### Local game elements

- Road barriers
- Subway entrances
- Construction machinery
- Parked vehicles
- Low signs requiring slides
- Security gates
- Rooftop ramps

### Orbis world elements

- Traffic and crowds
- Neon advertisements
- Rain and wet reflections
- Police drones
- A distant chase
- Buildings opening or shifting
- A city-wide blackout
- Fireworks after a high-combo run

### Reactive events

- High combo makes distant billboards celebrate the player
- Damage activates emergency lighting
- High speed makes traffic more chaotic
- Frequent slides transition the distant world toward subway tunnels
- Long survival transforms the city into a cyberpunk skyline

### Example prompt

```text
Continue the same uninterrupted cinematic shot of a dense neon city at night.
The camera moves steadily forward down a rain-slick avenue.
The run has built a high combo and the city is reacting to the performance.
Distant digital billboards glow, the wet streets reflect the colored lights,
and the empty path stays clear: no people, no runners, no characters in frame.
Preserve the same forward motion, city identity, and continuous camera direction.
```

---

## 4.3 Forest: The Forest Is Watching

### Local game elements

- Tree roots
- Fallen logs
- Branches
- Mud patches
- Stone bridges
- Fog zones
- Local animals

### Orbis world elements

- Fireflies reacting to movement
- Giant trees moving in the wind
- A distant forest spirit
- Fog revealing hidden landmarks
- Birds fleeing after near misses
- Glowing plants blooming
- A forest becoming magical or hostile
- A lunar eclipse during a long run

### Reactive events

- Careful movement makes the forest calm and luminous
- Aggressive movement causes animals to flee
- High score reveals glowing symbols
- Damage makes the forest darker and more threatening
- Long survival reveals a giant living tree

### Example prompt

```text
Continue the same uninterrupted cinematic shot of an ancient moss-covered forest.
The camera moves steadily forward beneath the canopy, fog tearing open ahead.
The long run is beginning to awaken the forest.
Glowing plants open along the distant path, fireflies gather in the air,
and a huge ancient tree becomes visible through the mist.
The path is completely empty: no people, no runners, no characters in frame.
Keep the same forward motion, atmosphere, environment identity, and continuous shot.
```

---

## 5. Player behavior changes the generated world

The game maintains a local Run State and uses it to decide when Orbis should receive a new prompt.

```ts
type RunState = {
  environment: "desert" | "city" | "forest";
  distance: number;
  speed: number;
  score: number;
  combo: number;
  nearMisses: number;
  jumps: number;
  slides: number;
  damage: number;
  dangerLevel: number;
  playerStyle: "reckless" | "precise" | "aggressive" | "explorer";
  currentEvent?: string;
};
```

Examples:

- Repeated near misses cause the world to become more dangerous.
- A high combo causes crowds, billboards, or wildlife to react.
- High speed increases weather and camera intensity.
- Damage makes the generated world darker or more hostile.
- Careful play creates a calmer, more beautiful atmosphere.
- Long survival unlocks a major environmental transformation.

The game should not send prompts on every frame. Instead, prompts are sent for meaningful events or controlled atmospheric updates.

Recommended prompt triggers:

- Environment selected
- Run started
- Major combo milestone
- Near-miss threshold reached
- Damage taken
- Speed milestone
- Distance milestone
- Power-up collected
- Major cinematic event
- Run ended

---

## 6. Orbis Director

The Orbis Director is the layer between gameplay and Reactor.

```text
Gameplay events
      ↓
Run State
      ↓
Orbis Director
      ↓
Prompt scheduler
      ↓
Reactor set_prompt()
      ↓
Live Orbis video and audio
```

The Director is responsible for:

- Mapping gameplay events to world events
- Selecting the correct environment prompt
- Preserving visual continuity
- Preventing duplicate prompts
- Applying cooldowns
- Scheduling atmospheric changes
- Triggering major transformations
- Handling Orbis errors without stopping gameplay

Example interface:

```ts
class OrbisDirector {
  update(runState: RunState): void;
  triggerEvent(event: WorldEvent): void;
  setEnvironment(environment: Environment): void;
  reset(): void;
}
```

The Director should keep the last prompt and the last prompt timestamp. It should avoid sending updates more frequently than the model can visually absorb.

---

## 7. Reactor and Orbis model integration

The recommended model is:

```text
reactor/visko-orbis-stable
```

The Reactor documentation describes Orbis Stable as a real-time steerable video model that:

- Streams continuously
- Produces 33-frame chunks of approximately 1.833 seconds
- Applies prompt updates at chunk boundaries
- Supports prompt changes while generation is active
- Supports optional starting images
- Produces a dedicated generated audio track
- Supports several delivery resolutions

The main interaction is:

```text
connect
  ↓
set_image (optional)
  ↓
set_prompt
  ↓
start
  ↓
set_prompt while running
  ↓
pause / resume / reset
```

A prompt update during a run should use `set_prompt` only. It should not call `start` again, because Orbis is already running and should morph into the new condition at the next chunk boundary.

---

## 8. Authentication architecture

The raw Reactor API key must never be exposed to the browser.

Recommended flow:

```text
Browser game
    │
    │ POST /api/reactor/token
    ▼
Server token route
    │
    │ REACTOR_API_KEY stored as server environment variable
    ▼
Reactor /tokens endpoint
    │
    ▼
Short-lived session-scoped JWT
    │
    ▼
Browser Reactor SDK
```

The token should be scoped to:

```text
reactor/visko-orbis-stable
```

The client should cache the JWT in memory for the session and refresh it only near expiration. It should not mint a new token on every request.

Required environment variable:

```text
REACTOR_API_KEY=rk_...
```

The key must remain server-side and must not be committed to the repository.

---

## 9. Image-anchored openings, and the landscape a player brings

Image anchoring was the original plan, and it is now built — with two changes that came from using it.

The first is that the image is not a fixed per-environment opening but **a picture the player uploads**.
The world they pick still decides the pacing, the obstacles and the road; the picture decides what they
are running through. It is offered next to the world cards, because it is the same kind of choice.

The second is that the image has to be *corrected before it is sent*, not after. A generated world
inherits the composition of its starting frame, and the game camera's horizon sits about 44% down the
frame with the road ribbon dissolving at about 50%: a picture whose horizon is at 70% hands us a world
whose road floats and a ground the player runs *under*. Measuring that at runtime and dragging it back
up needs overscan the player pays for in every frame, and the correction only goes one way. So the
picture is measured with the same rule the runtime lock uses (`src/orbis/skyline.ts`), cropped so its
horizon lands on the game's line, and only then sent:

```text
prepareLandscape(file)
  measure the horizon on a 48-row grid, searched wide (5-95%) — a picture is not our world
  scale = max(cover, wanted*H/(horizon*h), (1-wanted)*H/((1-horizon)*h))   # closed form, not iterated
  drawImage(source, round(x), round(y), w*scale, h*scale)                  # x/y negative = the crop
  1280x720 JPEG + a preview + a seed hashed from the prepared pixels

uploadFile(blob)
set_seed(seed)
set_image(ref)
set_audio_prompt(...)
set_prompt(continue-the-supplied-landscape prompt)
start()
```

The scale is the *smallest* one that both covers the frame and allows the horizon to sit on the line, so
a picture that is already close to the line is barely touched. A picture with no clear horizon is not
guessed at: it is centred on its cover crop and the menu says so.

Verified against four synthetic pictures whose horizons sat well below the line — 0.54, 0.55, 0.67,
0.73 — the prepared frames measured 0.4375, 0.4375, 0.4167 and 0.4167, all within one 48-row sample of
the 0.44 target, with steps of 93-110 luma. In the run, the runtime lock then measured the generated
horizon at 0.42-0.46 against a game line of 0.4434-0.4460 and **held a 0.000% shift for the whole run**:
with the picture pinned there is nothing left for the lock to do, which is the argument for pinning it.

**Pinning costs a session restart**: measured at 9.0 s (pinned in 9032 ms, world armed in 11562 ms),
8.5-9 s on two other runs, 13.9 s once through a link that was still recovering, and 36 s once when the
upload landed while the menu's own start was still settling — the pin could not run until that finished,
and only ran at all because a `state` message happened to re-run the arming effect. That is now an
explicit retry (`ARM_RETRY_MS` in `WorldLayer.tsx`), which also closes the case where a *failed* arm
cleared `pinning` without ever applying the picture: the Start button would have come back, the run would
have played, and the player's landscape would silently not have been in it. The menu holds the
run for it. `set_image` is a session condition — it can only be pinned before `start`, and only `reset`
clears one — so changing the landscape is a rebuilt world rather than a prompt swap. The first version
let the run start anyway, and the rebuild landed under the dive: a hard cut through the launch shot the
transition had just asked for. The Start button is now disabled and renamed while the pin is in flight,
which is what `pinning` on the world bus means.

The prompts change with the picture. A player's landscape is never described as a named world — naming
one would fight the frame the model was handed and drag the scene back towards that environment — it is
described as *the exact landscape supplied as the starting frame: the same terrain, the same colours,
the same light, the same time of day and the same horizon line, carried forward*. The emptiness clause
concedes the frame ("aside from anything already present in the supplied frame, no new people, runners,
characters or figures appear") because a clause that contradicts the image is one the model learns to
read loosely, and what has to be stopped is the model inventing a runner to explain a camera moving at
running pace.

---

## 10. Audio strategy

**Built: the world's own generated soundtrack.** Orbis generates the audio with the picture on its own
conditioning channel, and `main_audio` was being connected and then muted — so the entire soundtrack was
silence until now. `setAudioPrompt` is sent per world and bent per event, always describing *what the
scene sounds like* rather than what is on screen (the model's guidance is blunt that a scene description
here makes the audio worse than sending nothing, and that only about the first 128 tokens are read):

| | bed | an event's version of it |
| --- | --- | --- |
| desert | dry wind across open sand, fine grit hissing past, a low distant rumble | a near miss is a gust passing close, then settling (242 chars) |
| city | rain on asphalt, tyres through standing water, a distant traffic hum | a tier crossing swells into a brighter wash with a rising shimmer (236 chars) |
| forest | wind high in leaves, wood creaking, a low insect hum, water dripping | the ambience opens out, wider and more spacious (201 chars) |
| a player's picture | wide open-air ambience, wind past the microphone, loose gravel underfoot | as above — event accents are place-agnostic |

Every caption ends "No voices, no narration, no music." The audio model's default reading of a moving
camera is a narrator, and a narrator is the one subject this world must not have. The prompt guard
checks captions as well as prompts: no subject, the no-voices clause present, and under 260 characters
(the useful budget is smaller; the longest caption is 243).

The sound is verified as far as a headless pass can take it: the session reports `audio_enabled: true`
and `audio_prompt` as this world's caption, the element carries a live `audio:live` track and is
unmuted, and captions pair with visual prompts in the journal. Whether it is *audible* is not something
the probe can claim — `webkitAudioDecodedByteCount` stays 0 for a `MediaStream`-backed element, and an
`AudioContext` cannot be resumed without a real user gesture.

**Still open: local sound for gameplay feedback.**

- Jump
- Slide
- Collision
- Power-up
- Footsteps
- Countdown
- Game over
- User interface

Use Orbis audio for environmental sound:

- Wind
- Rain
- Forest ambience
- City noise
- Sandstorm rumble
- Distant cinematic effects

Provide separate volume controls:

- Gameplay SFX
- Orbis World
- Music

The player should click Start Run before audio begins so browser autoplay restrictions do not break the experience.

---

## 11. Major cinematic events

The prototype should include one reliable transformation per environment.

### Desert: The Sandstorm Awakens

At a distance milestone:

- Local lighting becomes warmer
- Wind audio increases
- Orbis receives a storm prompt
- A giant storm appears in the distant world
- The player continues running through the event

### City: The Blackout

At a high combo:

- Local city lights flicker
- Orbis receives a blackout prompt
- Distant emergency lights and vehicle headlights appear
- The local track remains playable

### Forest: The Forest Watches Back

After a survival milestone:

- Local fireflies appear
- Orbis receives an awakening prompt
- A giant distant tree or figure becomes visible
- The path continues normally

These events are designed to be easy for judges to recognize in a short demo.

---

## 12. Failure and fallback behavior

The game must remain playable if Orbis is:

- Connecting
- Priming
- Delayed
- Reconnecting
- Temporarily unavailable
- Out of credits
- Blocked by browser audio policy

Fallback behavior:

- Continue the local 3D game
- Show a static or procedural local background
- Display a small world status indicator
- Queue major world events
- Apply queued prompts after reconnection where possible

The runner must never pause because a prompt request or video stream is delayed.

Suggested statuses:

```text
Connecting...
Generating world...
World live
Reconnecting...
World link offline
```

---

## 13. Recommended project structure

Once the legacy `cave-runner` repository is available, preserve its working mechanics and add an Orbis layer around them.

```text
src/
  game/
    RunnerGame.tsx
    PlayerController.ts
    CollisionSystem.ts
    WorldGenerator.ts
    RunState.ts
  orbis/
    OrbisProvider.tsx
    OrbisVideoSurface.tsx
    OrbisDirector.ts
    OrbisPrompts.ts
    OrbisEvents.ts
  scenes/
    desert.ts
    city.ts
    forest.ts
  ui/
    EnvironmentSelect.tsx
    RunHUD.tsx
    OrbisStatus.tsx
    RunSummary.tsx
```

The gameplay code should not directly call Reactor commands. It should emit game events, which the Orbis Director translates into prompts.

---

## 14. MVP scope

The first competition-ready version should contain:

- One playable 3D endless runner
- Desert, City, and Forest selection
- Running, jumping, sliding, and falling
- Basic obstacle collisions
- Score and distance
- One Orbis session per run
- Initial Orbis world generation
- At least two live prompt updates per run
- Orbis video visible during gameplay
- One major transformation per environment
- Graceful local fallback
- A simple status indicator

Optional features should only be added after the core live interaction is reliable:

- Generated audio
- Clip capture
- Run summary
- Power-ups
- In-world billboards
- Multiple player skins
- More advanced animations
- Cross-environment transitions

---

## 15. Demonstration flow

The best judging demonstration is:

1. Open the game.
2. Select City.
3. Show the initial Orbis world being generated.
4. Start the local 3D run.
5. Perform near misses and build a combo.
6. Show the city reacting through a live Orbis prompt update.
7. Trigger the Neon Pursuit or Blackout event.
8. Continue playing while the generated world changes.
9. End the run.
10. Show a short run summary with distance, score, environment, and major world events.

The demo should make it obvious that the generated world changed because of the player's actions.

---

## 16. Implementation phases

### Phase 1: Audit and preserve legacy mechanics

- Inspect the old `cave-runner` repository
- Identify the current framework and rendering engine
- Locate player model and animation clips
- Locate movement, collision, camera, and track generation code
- Run the existing application
- Preserve working mechanics before refactoring

### Phase 2: Build the three local environment shells

- Add desert, city, and forest themes
- Add local lighting and materials
- Add environment-specific obstacles
- Add placeholder background surfaces

### Phase 3: Prove Orbis independently

- Add the server token route
- Connect to `reactor/visko-orbis-stable`
- Render the Orbis video
- Set an initial prompt
- Send a second prompt while the stream is running
- Confirm video and audio behavior

### Phase 4: Compose Orbis with the game

- Add the Orbis stream as a video texture or background surface
- Place local 3D geometry in the foreground
- Add loading and fallback states
- Test browser autoplay and WebRTC behavior

### Phase 5: Implement the Orbis Director

- Add Run State
- Add gameplay event detection
- Add environment prompt libraries
- Add prompt cooldowns
- Add atmospheric evolution
- Add major cinematic events

### Phase 6: Polish and record the demo

- Add the environment selection screen
- Add HUD and world status
- Add audio controls
- Add run summary
- Test the three demonstration paths
- Record the submission video

---

## 17. Legacy reference audit

The legacy reference is now available at:

```text
reference/cave-runner/
```

It is a Vite + TypeScript + plain Three.js game using older direct-DOM scene management. The legacy dependency tree is not the foundation for WatchMe Run.

The characters were the last live dependency on this folder — the runner component imported all 18
of its FBX files by path. §22 moved them to `models/`, after which nothing under `src/`, `server/` or
`tools/` reads the folder and it can be deleted.

### Reusable gameplay ideas

- Three-lane movement at approximately `-18`, `0`, and `18`
- Keyboard controls with left, right, up, and down actions
- Touch swipe controls
- Running, jumping, sliding, and stumbling states
- A repeating forward-moving environment
- Reusable obstacle pattern groups
- Coins arranged in lane formations
- Character selection with persistent active-character state
- Score, coins, pause, restart, and game-over flows

### Legacy assets found

```text
public/assets/characters/xbot.fbx
public/assets/characters/jolleen.fbx
public/assets/characters/peasant-girl.fbx

public/assets/animations/*@running.fbx
public/assets/animations/*@jumping.fbx
public/assets/animations/*@sliding.fbx
public/assets/animations/*@stumbling.fbx
public/assets/animations/*@dancing.fbx

public/assets/models/barrel.fbx
public/assets/models/box.fbx
public/assets/models/coin.fbx
public/assets/models/spike.fbx
public/assets/models/wooden-cave.fbx
```

### Legacy code that will not be copied

- Direct manipulation of many DOM elements from the Three.js scene classes
- The old authentication and PlanetScale/Netlify data flow
- Deprecated package versions
- Tween-driven scene logic tightly coupled to UI elements
- Repeated per-character loader fields
- FBX-only asset assumptions for all future content

### Modern WatchMe Run decisions

- Build a new React + TypeScript application.
- Use React Three Fiber for the 3D scene and React state for screens and HUD.
- Keep gameplay state separate from rendering.
- Use a reusable character asset adapter so legacy FBX assets can be tested without coupling the game to them.
- Prefer GLB/GLTF for new production assets, with FBXLoader retained only as a compatibility path for the reference assets.
- Use a lane-based runner controller with explicit movement/action state.
- Use procedural primitive obstacles first; replace them with environment-specific assets after the playable loop works.
- Keep Orbis in a separate world-surface layer behind the deterministic playable path.

### Revised implementation order

1. Create the new modern app shell.
2. Build the environment-selection screen.
3. Build a playable three-lane runner using procedural geometry.
4. Add the reference character/animation adapter.
5. Add deterministic obstacle and coin patterns.
6. Add Run State events and connect the Orbis Director.
7. Add the Reactor token route and live Orbis surface.
8. Add the desert, city, and forest visual themes.
9. Add polish, fallback behavior, and the hackathon demo flow.

---

## 18. Current implementation status

The first modern WatchMe Run slice is implemented:

- React + TypeScript + Vite application shell
- React Three Fiber runner scene
- Environment selection for desert, city, and forest
- Three-lane movement with keyboard controls
- Jump and slide actions
- Procedural obstacles and distance scoring
- Damage and near-miss event generation
- Orbis Director connected to gameplay events
- Typed Reactor Orbis Stable SDK installed
- Secure Netlify token function at `/api/reactor/token`
- Cached browser JWT resolver
- Live Orbis video surface with local visual fallback
- Amy, James and Mousey runners from `models/`, each with its own retargeted clips
- Character archive screen with lazy-loaded previews
- Selected character passed into the active runner
- Reactor provider mounted only for active runs
- Stable provider options to prevent disposed-session reuse during development
- Correct Wasm MIME headers for Vite and Netlify
- Reactor packages excluded from Vite dependency pre-bundling so the wasm glue and binary resolve
- Token route served by both the Netlify function and a Vite dev/preview middleware
- Session end on run exit, unmount, and `pagehide`, with automatic retry while a previous session closes
- Live Orbis video and audio surface confirmed streaming at 2560x1440 behind the transparent runner
- Fading, speed-scrolled road so the generated world becomes the horizon instead of being hidden
- Camera field of view, video scale, and lane parallax all driven by one run-speed value
- Environment-specific obstacle kinds, pattern shapes, and coin patterns per world
- Stumble and recovery state with crossfaded one-shot clips and a momentum penalty
- World chip reporting connection status, video state, and the real error text
- Headless diagnostic probe in `tools/orbis-probe.mjs`
- Strict TypeScript and production build verification

The current Orbis adapter is credential-gated. Without `REACTOR_API_KEY`, WatchMe Run remains playable in local-world fallback mode. With a configured Reactor key, the generated Orbis video appears behind the deterministic 3D runner and receives prompt updates from the Orbis Director.

The production build still emits a bundle-size warning for the React Three Fiber runtime, but the initial application chunk is now separated from the active-run and character-preview chunks. The Reactor provider and heavy runner code mount only after the player starts a run. Legacy FBX model and animation files are loaded only when a character preview or run actually needs them.

### Local Orbis startup

Either command now serves the token route:

1. Copy `.env.example` to `.env`.
2. Set the server-only `REACTOR_API_KEY`.
3. Run `npm run dev` (Vite, http://localhost:5173) or `npm run dev:netlify` (http://localhost:8888).

The token route is implemented twice on purpose, sharing one minting module in
`server/reactor-token.ts`:

- `netlify/functions/reactor-token.ts` for deployment and `netlify dev`
- a Vite dev/preview middleware for plain `npm run dev` and `npm run preview`

Without the key, the game stays playable in local-world fallback mode and the world
chip reports why.

On this machine the local `netlify dev` function sandbox cannot reach
`api.reactor.inc` (its outbound connection fails with
`AggregateError ... internalConnectMultiple`), so its token route answers 500 while the
same function code returns 200 with a JWT when run on the host and the Vite middleware
works. Local play therefore uses `npm run dev`; the Netlify function remains the
deployment path, where it runs in Netlify's own runtime.

### Verified Orbis behaviour

A headless run through `npm run dev` was used to confirm the full path, and it
surfaced two real blockers that are now fixed:

1. **Wasm never loaded under Vite dev.** The Reactor SDK imports its wasm glue through
a vite-ignored dynamic import, so the browser resolves `./wasm/reactor_wasm.js` against
the served module URL. Dependency pre-bundling relocated the SDK into
`node_modules/.vite/deps`, where `./wasm` does not exist and the dev server answered with
`index.html` (`200 text/html`), so wasm init failed with
`reactor-wasm failed to load` and the world silently stayed in fallback. The fix is to
exclude the Reactor packages from `optimizeDeps` and to pre-bundle their CommonJS
dependencies (`awaitqueue`, `hls.js`, `mp4box`) explicitly.

2. **Session quota is one concurrent Orbis session per account.** A run that ends without
closing its session blocks the next one with
`429 quota_exceeded: concurrent_sessions_per_model`. The game therefore ends its session
on exit, on unmount, and on `pagehide`, retries automatically when Reactor reports the
previous session is still closing, and caps session duration at 20 minutes so an
orphaned session frees the slot quickly.

Observed timings on a working connection: session created in ~5 s, WebRTC transport
negotiated and video track received by ~25-35 s (status `waiting` during that window),
then `ready` with a 2560x1440 video and audio track that plays continuously while
prompt updates arrive as `prompt_accepted`, `conditions_ready`, and `chunk_complete`
messages.

### Blending the runner into the generated world

The 3D layer exists to anchor gameplay, not to cover the video. Three rules keep the layers
reading as one place:

1. **The ground is a short ribbon, not a floor.** The road plane is about 46 m long and 10.5 m
wide, its alpha ramps from solid under the runner to gone within roughly 20 m, and it fades at
its outer edges too. Past that, the terrain *is* the generated video — there is no fog wall and no
floor covering the world's own ground. Its lane lines and surface grain scroll at exactly the run
speed, so ribbon, obstacles, and coins move as one field.

   Measured with the headless probe (capturing the composite, a 3D-only frame, and a video-only
   frame): the upper half of the frame matches the video-only render almost exactly, the ribbon's
   contribution is a few luma points through the middle, and it only dominates the bottom sliver
   where the runner's feet are. The road's colour was also pulled back toward the world's range —
an earlier, darker road was dimming the video by 12-14 luma across the lower half, which read as a
sheet laid over the world instead of ground inside it.
2. **One speed value drives everything visual.** The simulation publishes `--run-speed`,
`--world-x`, and `--hit` on the document. Camera FOV widens with speed, the video layer scales
and shifts laterally when changing lanes, and impact flashes the frame. The run cycle's playback
rate is tied to the same speed, so the character's feet keep pace with the world.
3. **The character is planted.** Feet, obstacles, and coins all share the y = 0 baseline, with a
soft contact shadow under the runner that spreads and fades while airborne.

The camera sits at y = 3.4, z = 11.5, aimed about 3.25 degrees down, which puts the ground plane's
horizon at about **44%** down the frame — 43.3% at the base field of view (46°) and 44.9% at the
widest (58°) — with the runner in the lower middle instead of filling the frame with ground. (An
earlier note here said "the upper third"; that was wrong, and it is the number the Orbis prompts had
been written against.) The road ribbon, being a fixed 46 m strip, dissolves into the video at about
50%, so the only band where the two layers actually meet is 44–50%. Everything the generated video
shows below that is the terrain the road continues into; everything above is sky. That asymmetry is
why the prompts ask for the generated horizon in the *upper third* rather than at 44%: ground that
covers too far up is hidden under the ribbon, while sky covering the 44–50% band leaves the road
hanging in open air — see "The generated world must never contain a figure" in §2 and the horizon
clause in `src/orbis/prompts.ts`.

### Homepage

The menu is a three-column cinematic layout: brand, lede, and run facts on the left; a live 3D
runner preview with a selectable runner rail in the middle; world cards with per-world tinting,
hazard chips, and the start action on the right. Selecting a world retints the backdrop through CSS
custom properties *and* steers the live world behind it. The generated world is the homepage
backdrop — translucent scrim, live badge, and a status chip that reports the real world state — so
the page is alive before a run starts, under a scrim heavy enough for the copy to stay readable.
Layout is verified at 1280x800 and 430x900, with the start action pinned to the bottom of the
viewport on phones. See §19 for the layer itself and for the ground grade that keeps the runner
sitting inside the generated frames.

### Content design

Each world asks for different tricks, and each has its own silhouettes:

| World | Jump-over | Slide-under | Lane change only | Tokens |
| --- | --- | --- | --- | --- |
| Desert | sandstone slab | ruin beam on pillars | obelisk | spinning gold scarab ring |
| City | neon-edged crate | glowing sign beam | container stack | cyan data chip |
| Forest | fallen log | low vine branch | lichen boulder | glowing orb |

Pattern shapes are shared — single, pair, slalom, tunnel, gauntlet, and jump arcs — but the mix,
spacing, and obstacle kinds come from the environment recipe, and the mix hardens with distance:
walls (the only unavoidable obstacle) appear after the run has settled, pairs and gauntlets unlock
with difficulty, and the gap between patterns tightens.

Each world also has its own tempo (`environmentPace`), so the three differ in how they play rather
than only in how they look:

| | desert | city | forest |
| --- | --- | --- | --- |
| Speed ramp | 8.6 → 17.0 m/s over 320 m | 7.4 → 14.0 m/s over 260 m | 7.8 → 15.2 m/s over 520 m |
| Content peaks at | 820 m | 520 m | 700 m |
| Gap scale | 1.08 | 0.78 | 0.96 |
| Obstacle kinds | block-heavy | gate-heavy | balanced |
| Reads as | open road, quick and sparse | crowded from the start, but slower | a long climb that keeps tightening |
| Tightest row | 0.87 s | 1.07 s | 0.98 s |

Speed and spacing move in opposite directions on purpose, so the worlds arrive at similar windows in
*time* from different places: the city is the densest per 100 m and still the most forgiving moment to
moment, while the desert is the sparsest and the tightest because it comes at you fastest. It also
changes when the late-game mix begins — difficulty 0.5 is 410 m in the desert, 260 m in the city, and
350 m in the forest. `--run-speed` and the camera's field of view are normalised against each world's
own range, so "flat out" reads the same in a slow world as a fast one.

The constants live in `src/game/pattern-field.ts` — a module with no three.js or React in it — so the
simulator reads the same numbers the game runs on. They used to be duplicated in
`tools/run-audit.mjs`, which would have silently measured the wrong ramp the moment they became
per-world; the harness now imports `speedAt` / `difficultyAt` / `topSpeed` from the field.

Coins reward the required move, and that is now enforced rather than intended. The first version
placed them by shape with `otherLane()` — a coin flip — so a coin often sat exactly where the next
wall arrived; `tools/run-audit.mjs` measured 213 per run in the desert doing it. Placement now
happens **after** a shape's obstacles, in a lane the required move leaves the runner in, and only if
no wall will cross that lane within an escape window of any coin in the line. The reward is shaped by
the move: an arc over a `block` (caught mid-jump), a low line under a `gate` (grabbed while sliding),
a line in the destination lane after a `wall` dodge, and in a slalom the lane that is open across
*two* turns, so the coins pay for reading it rather than for leaving late. Only walls disqualify a
lane, because a block or a gate can be passed in place; a pattern whose every lane is spoken for
carries no coins instead of carrying a trap. All three worlds now measure zero baited coins, and the
mid-air share rose from 17% to 19–22% as arcs took over from flat lines.

Spacing works the same way: the gap after a chunk is sized by what that chunk asked for. Only two
things demand a move regardless of where the runner is running — a wall, which cannot be passed in
place, and a row that blocks two lanes and so leaves one. That is `isDemanding`, an intrinsic
property decided when the chunk is built, because the alternative (did this threaten the *player*?)
needs a lane the generator does not know. A chunk nobody had to react to is followed more closely,
which is what closed the dead air between decisions (median 3.3 s → 3.0 s, opening band 4.6–5.0 s →
3.8–4.0 s). The gap is floored twice: at one lane change at top speed, and at the distance that keeps
this chunk's coins out of the escape window of the next chunk's first hazard — which is why each
pattern reports its own `tail` rather than the code assuming the empty space at its end. The
late-game shape mix then leans on pairs and gauntlets (`SHAPES_LATE`, after difficulty 0.5), taking
the share of chunks that ask for nothing from 57% to 46%. `tools/run-audit.mjs` measures all of it.

The shapes themselves were then spaced so that no row arrives closer than a lane change. `slalom` was
the worst offender — three turns 11 m apart is 0.65 s at the desert's top speed, against the ~0.5 s
the harness spends on a lane change — and the `gauntlet` sequence and the `tunnel`'s gate-to-obstacle
gap were the same problem one step behind it, so widening only the slalom would have moved the
tightest read rather than removing it. All three were widened at the source, by distance rather than
by tuning numbers: `SLALOM_STEP` 11 → **16 m**, `GAUNTLET_STEP` 12 → **15 m**, and the tunnel's gap
13 → **16 m**. No row in any world now arrives closer than **0.87 s** (0.87 / 1.07 / 0.98), against
0.63 / 0.78 / 0.72 before, and `slalom` dropped from 24% to 11% of rows with the widest windows of
the tight shapes. Cutting it removed decisions too, so `SHAPES_LATE` leans on `pair` — one row, two
lanes blocked, a decision that is not a twitch — which left *fewer* chunks asking for nothing than
before the change (38% vs 46%). The honest cost is that wider shapes are longer chunks, so decisions
sit ~0.1–0.2 s further apart in the two slower worlds; that trade was taken deliberately, since a
0.63 s read is a lost run for a human and a 3.1 s gap between decisions is not.

All three worlds were then played headlessly over the widened field, not just the desert, because the
shapes are shared but the pace is not — and a spacing that fits at 17 m/s is a different fraction of a
second at 14. `WORLD=city node tools/orbis-probe.mjs …` clicks that world's card before the run
starts, so the same probe drives whichever world is asked for. A 40 s pass in each: desert 595 m,
city 493 m, forest 448 m, with the desert and city HUDs reaching their own tops (17.0 / 14.0) and the
forest still climbing at 14.2 because its ramp is 520 m long. Between them they collected 30 / 19 / 16
tokens, took one stumble each in desert and forest, and logged **zero errors and zero warnings**, with
the world `ready`/`streaming` at every sample and handed back to the menu mid-stream on exit. The
forest pass was the first launch after a cold server start, so its menu warm-up sat in `Local world
mode` for ~60 s before the transport came up; the run itself was live from its first sample.

Pace and spacing were only the difficulty side of the curve. Coin *density* is flat by design — 11–15
tokens per 100 m in every band, because density is the fairness property `tools/run-audit.mjs` measures
— so with speed rising and density flat, the reward per metre never went up: the content asked for more
at 800 m and paid exactly the same. The value of a token now scales with difficulty instead
(`coinValueAt`, 25 points at the line to 75 once a world's content peaks), which takes coin points per
100 m from ~380 in the opening band to ~1050 in the last full one — a measured curve rather than a
claim, since the harness reports the value at both ends and points per band in the data file. Changing
value rather than density was deliberate: placement is what the fairness checks look at, and placement
is untouched (0 violations, 0 traps, unchanged coins per 100 m). The HUD carries it too, the token
count reading `TOKENS 27 ×2.4`, so the ramp is something the player can see rather than only something
the scoring code knows.

The curve was then checked in all three worlds in the running game rather than only in the model, since
the cap belongs to each world's own content peak. `×` climbs 1.2 → 3.0 and holds in desert, city and
forest alike, reaching its ceiling at ~680 m / ~497 m / ~745 m respectively — which is the pace profile
showing through (desert content peaks at 820 m, city 520, forest 700). More than the multiplier: score
is 12 pts/second plus token value, so `score − 12 × elapsed` differenced against the token count is what
a token actually paid on the machine — **45.0 → 75.0 pts/token** in the city and **31.0 → 75.5** in the
forest, monotone, both landing on the declared 75. What that measurement cannot do is per-metre reward:
a single run collects whatever its route touched (the city pass took 0 tokens between 775 m and 842 m and
9 between 979 m and 1,051 m), so points per 100 m stays the harness's 60-runs-per-world number and the
in-game passes verify the per-token half.

A curve nobody can see mid-run is a spreadsheet, so the token cell now draws it: a ramp filling from the
line to that world's ceiling, notches at the four quarters where the value steps into a new tier, the
points in play (`62 PTS · MAX 75`), the payout of the token just taken (`+62`), and a `VALUE UP · 63 PTS`
announcement for 1.8 s when a quarter is crossed. The payout comes from `RunnerScene`'s own `coinValueAt`
result through a new `onToken` callback rather than being recomputed in the interface — a second copy of
the scoring rule is a second thing to drift, and a coin pickup deliberately does *not* travel through
`onWorldEvent`, which is the channel that steers the generated world. Verified in the running game at
both breakpoints: value climbs 25 → 75 and the beats land where each world's content peaks (desert
`VALUE UP · 75` at 844 m, city 63 at 405 m and 75 by 596 m), with the HUD at 430×900 measuring 353×89 and
zero overlap against the world chip or the director card.

The crossing is also the one reward beat the *world* answers rather than only the label. It fires a
`value_tier` event at the director with `priority: true` — the director queues one event at a time, so
without that a tier crossing could be evicted by the next distance milestone and never reach the model —
carrying a per-world fragment (the desert's ruins igniting, the city's billboards flaring, the forest's
bioluminescence blooming) and an escalation clause naming which step of four it is, so the four answers
read as one world getting louder rather than four unrelated events. Checked in the running city game from
the page's own prompt journal rather than from console lines: `prompts in run: 45 (run-event …), tier
crossings asked for: 4`, none dropped, with 13 value-up beats and top tier 4/4.

The run was then checked where it is actually played. The interface around the runner is absolutely
positioned, which is the layout that breaks on a phone, so the probe can hold the phone viewport for
the whole session (`MOBILE=1`) and report each element's box, the pixels any two of them share, and
anything hanging off the screen. That found a real bug: at 430×900 the run HUD and the world chip sat
in the same band, and with the chip at a higher `z-index` the *status chip was drawn over the player's
numbers*. They are stacked at that breakpoint now — chip under the header, HUD below it — and the
overlap measures 0×0, with nothing off-screen, no page overflow, and the same content and ramp running
(`SPEED 17.0`, `TOKENS 9 ×2.5`).

A full session (150 s, 30 samples) at 430×900 held that, and the pause panel was cleared rather than
assumed: it covers the HUD's band, but it lives inside `.game-stage` (z-index 2), so the interface at
z-index 3–4 stays above it — the probe now asks `document.elementFromPoint` at each control's centre and
gets the control back, not the panel. `VIEWPORT=WxH` then ran the same session at 360×640, which is a
different phone and turned up two real bugs: the HUD (right-anchored, content-sized, and wider since the
reward ramp moved into the token cell) needed 345px and sat exactly on x=0, and the header's three items
shrank until the exit button's label wrapped, growing the header to 60px — past the chip's fixed 72px top,
so the chip covered the button's bottom edge and swallowed clicks there. The HUD got a `max-width` so it
wraps at the margin instead of growing past it, and below 420px the run-status is dropped, being the one
header item the world chip underneath already reports in more detail.

A hit costs momentum, not just points: the character plays the stumble clip, the camera shoves,
the frame flashes, and the next second of running is measurably slower while the character
recovers.

**A row never closes two lanes at once.** A lane is only closed by a `wall`, so a row holding one
obstacle can never take the runner's own lane *and* the one beside it — closing two at once needs two
obstacles in one row, which is `pair` and nothing else. A `pair` is therefore built with **at most one
wall**: one is enough to keep the row unavoidable (the runner is still standing in one of the two blocked
lanes two times in three), while two would leave a single lane and ask a runner at the far end of it for
two lane changes at once. The other way to kill that read — prefer the middle as the open lane — costs
more than it looks, because a middle-open pair asks a runner already there for nothing at all and the
harness's route holds the middle by default, so the decisions the shape exists for would drain away.
`patternGap` still holds the gap for a chunk that can close two lanes at `REACTION_S + 2 ×
LANE_CHANGE_S`, and the harness now reports **0.00 such rows per run** in every world: the guard is
unnecessary, which is a measurement rather than an assumption.

### Diagnosing the world layer

`tools/orbis-probe.mjs` drives headless Chrome through a real run and prints the status
chip, the video element state, Reactor network responses, and console output:

```bash
node tools/orbis-probe.mjs http://localhost:5173/ 45
```

Set `CHROME_PATH` if Chrome is not in the default Windows location. It also closes the
page target when it finishes so it does not leak the account's single session slot.

Every connection attempt logs `[orbis] status -> ...` and `[orbis] <message type>` to the
browser console, and the world chip exposes `data-orbis-status`, `data-orbis-video`, and
`data-orbis-error` for inspection.

## 19. The world layer, the homepage preview, and grading the ground

The world is not a per-screen effect. It is one layer, mounted once for the whole visit, above the
interface and below everything else:

```text
App
├── WorldLayer (lazy)      src/orbis/WorldLayer.tsx   the only Reactor session
│   ├── .world-video       the generated frames (the SDK's own wrapper, sized by us)
│   └── .world-local       per-world gradient until frames arrive
├── MenuExperience         previews the world live while the player chooses
└── RunExperience (lazy)   deterministic runner + Orbis Director
```

The menu asks for a world (`world.showWorld`) as soon as it mounts, so the homepage generates one
before a run starts; choosing another world re-prompts the same session and the shot morphs at the
next chunk boundary. Because the layer never unmounts, a run continues inside the same stream, and
returning to the menu does not cut it. The interface talks to the layer through
`src/orbis/world-bus.ts` — a store of commands plus a `useWorld()` snapshot — which exists because
the layer is lazy and therefore arrives *after* the interface that wants to drive it.

Measured on a desktop viewport, the homepage world was live 16-23 s after load, and the world layer
was genuinely visible in the captured frames (11-38 luma difference per band in the region the
scrim leaves clear).

### Things that only broke once

- **Zero-height video.** The SDK's `ReactorView` renders its own wrapper `div` around the `<video>`
  and sizes the video as a percentage of it. Styling the inner video with `position: absolute`
  resolved against a zero-height wrapper, so the world was "streaming" in the DOM and invisible on
  screen — in the menu *and* in runs. The wrapper is what carries the frame (`.world-video`).
- **Effect loops from SDK identity.** The provider hands back new callbacks on every render. Effects
  that depended on them re-ran forever, re-issuing `start()` (`command_error: Already generating.`)
  and, through the bus, re-registering the layer until React threw "Maximum update depth exceeded".
  All SDK access now goes through a ref.
- **Prop-driven media rebuilds.** Toggling `muted` through the view's props rebuilt the media
  element, blanking the world for the rest of the run. The view's props are constant and sound is
  applied imperatively while the element is playing.
- **The one-session limit.** A closed session holds the account's only slot, so a fast reload or a
  second tab lands on `429 concurrent_sessions_per_model`. The world layer retries for a couple of
  minutes with the reason on screen, recycles its session after 25 minutes of idling, and releases
  it on `pagehide`.
- **Asking for a world mid-connect.** `connect()` throws "Already connected or connecting" for every
  status except `disconnected`, so a `showWorld` arriving while the transport was still negotiating
  was reported to the player as a broken world. Worlds are now steered unless the session is
  genuinely gone, a second `connect` cannot overlap, and a session that has already been live is
  treated as renegotiating rather than failing to start.

### Grading the ground into the frames

The ground is WebGL and the world is video, so the ground is graded into the frames' tonal range
instead of carrying a fixed colour. `src/orbis/world-palette.ts` samples the live video (32x18,
`drawImage`, no Reactor dependency) every 1.2 s for two numbers: the whole frame's tone and the tone
of its lower region, which is the generated terrain the ribbon crosses. `src/game/road-grade.ts`
turns the measured ground tone into the ribbon's material multiplier, with a per-world calibration
(`ribbonAtUnity`), a per-world colour lean, and limits so a world keeps its identity.

The first version aimed the ribbon at the whole-frame average, which is the sky's tone rather than
the ground's — and a fixed offset cannot know how bright the terrain under the runner actually is.
The current model is a closed loop: the grade is the ratio that lands the ribbon's own rendered
level on the measured ground tone, and it tracks the world as the shot changes.

Verification, same region (`--region 0.35,0.70,0.65,0.92`), same instant, in the desert:

| | before | after |
| --- | --- | --- |
| ribbon alone (`…ribbon.png`) | 20.8 luma | 33.2 |
| generated ground (`…video.png`) | 32.5 | 34.0 |
| `--road-grade` during the run | pinned at its floor | 0.43-1.26, tracking |

### Diving into the world

Starting a run is a transition, not a screen swap. Because the world is already generating behind
the menu, the dive is: the live frames push in and brighten, the interface leaves (opacity, scale,
blur), the scrim lifts, the world's name slams through frame, and the runner arrives inside the
chunks that were already on their way. The session streams through all of it — the chip never
leaves `Live world streaming` across the transition.

`src/App.tsx` runs the phases (`menu → entering → run`); everything visual is CSS keyed off
`html[data-entering]`, with `ENTER_MS` in the component and the keyframe durations in
`src/styles.css` mirroring each other. Two details make it hold together:

- The world layer is sent a **launch prompt** the instant the dive begins (`launchPrompt()` in
  `src/orbis/prompts.ts`), so the chunks that land as the interface leaves are the run's opening
  shot rather than the menu's establishing wide. The dive is also what unsilences the world.
- The dive animation owns the world layer's transform, so it ends just above the resting scale and
  the flag is cleared at the swap — the run's speed-driven transform then settles in through the
  existing 0.5 s transition instead of snapping.

The menu also takes no input while entering, the run chunk is prefetched 800 ms after the menu
appears so a lazy load cannot land mid-dive, and `prefers-reduced-motion` skips the ride (220 ms,
no animations, no title card).

Measured in the probe, where the dive is sampled at four points:

| | entering | menu | scrim | world frames |
| --- | --- | --- | --- | --- |
| t+325 ms | true | opacity .93, blur .7px | .68 | scale 1.014, sat 1.08 |
| t+714 ms | true | opacity .47, blur 5.3px | .16 | scale 1.028, sat 1.14 |
| t+1061 ms | true | opacity 0, blur 10px | 0 | scale 1.040, sat 1.17 |
| after | cleared | gone | — | handed back to scale 1 |

The dive is also the run's first second: a launch surge (`LAUNCH_BOOST` in `RunnerScene.tsx`) puts
the run at 11.6 speed and the world's scale coupling at 0.45 the moment it lands, decaying over 1.8 s
into the cruise ramp (8.4 and 0.05 at +2.4 s). Because the surge is part of the run's speed, the
camera's field of view, the road scroll, and the approaching obstacles open up together with it.

Leaving mirrors arriving, on the same phase machine: the run shell pulls back (opacity .94 → .44 with
blur 0.6 → 5.6 px over 800 ms), the menu reassembles with `data-returning`, and the world is handed
back to its wide establishing shot. The session is never cut — across an exit the chip stays
`Live world streaming` and the element's clock keeps running (27.6 s → 28.9 s in one measurement).

### A world's own intro

Each world opens as itself rather than as a generic launch. Selecting a card in the menu swaps the
launch prompt (`launchPrompt()` branches on the environment) and paints a beat of that world's
weather over the live frames while the interface leaves, alongside a line of copy and an ambience
readout (`intro` in `src/game/worlds.ts`):

| World | Weather layer | Line | Ambience |
| --- | --- | --- | --- |
| desert | `heat`, sand haze lifting off the ridge | Heat lifts off the ridge | 43°C · storm rising |
| city | `rain`, neon smearing through the sheets | Rain sheets through the neon | grid dark · asphalt wet |
| forest | `pollen`, canopy-dappled drift | The canopy leans in | fog thick · pollen drift |

The beat is decoration and the copy is flavour — nothing in it asks the player to act, and the whole
veil is `aria-hidden`. It is verified per world by reading the dive at three points: the weather layer
is at ~0.8 opacity and the line fades in from ~0.3 to 1 as `data-entering` runs, then everything
clears at the swap.

### What steers the world, and when

The world is fed by four kinds of prompt, and the interface says which is which instead of leaving it
to be inferred from the text (`src/orbis/prompt-journal.ts`):

| Reason | Sent by | Meaning |
| --- | --- | --- |
| `world-morph` | the world layer | keep the background world matching the selected world |
| `launch` | the entering transition | the run's opening dive — the first chunks of a run belong to this |
| `exit-opening` | the exiting transition | hand the world back to its wide establishing shot |
| `run-event` | the run's director | one meaningful gameplay event |

The four are gated so they cannot fight each other:

- **`run-event` is a channel with an owner.** `world.sendPrompt(prompt, { channel: "run" })` is dropped
the moment the run stops being active, and `beginExit` clears that flag *synchronously at the click*
rather than in an effect. The director's flush timer only needed the render gap to fire a distance
event over the menu's wide shot.
- **The dive is protected.** `markRunStart()` measures the director's cooldown from the launch prompt
and drops (does not queue) events for 2.4 s, so the opening shot is never overwritten by
"the runner has traveled 12 meters".
- **The morph is a standing state, not a per-render action.** It re-applies only when the selected
world changes or the session underneath is a new one, and never while a run owns the world. Before
this, every status blip re-issued the menu's wide shot — measured once as arriving **19 ms after the
launch dive**, undoing it.- **A blip is not a broken world.** A `set_prompt` failure over a dropped peer connection used to be
  surfaced verbatim as the world's error; transport symptoms now get "World link interrupted —
  reconnecting", a ready session clears the error whatever the last command said, and a session that
  dropped on its own is recovered with bounded exponential backoff (2.5 s doubling, 6 attempts, reset
  when the link returns).
- **A failed `connect()` is classified too, and says something different.** Both paths that publish a
  world error go through `failureMessage()`, but the copy forks on where the failure happened, because
  only one of the two is coming back: a link that was once live is being retried by the backoff above,
  while a link that never readied has nothing retrying it — so calling that a reconnect would be a lie
  and it reads "Couldn't reach the Orbis world — the run plays over the local backdrop" instead. This was
  the last path that could put a raw SDK string on screen (`http transport error: jwt resolver rejected:
  fetch failed`); verified by breaking the token route on purpose, which is what makes the cold-start
  branch reachable: the chip showed the friendly copy, and the raw string stayed in the console's
  `[orbis] connect failed` line.

The journal records every ask with its reason, the world status at the time, and the outcome —
`at` is the request and `ok` the acknowledgement, a distinction that matters because `setPrompt`
resolves at the next chunk boundary, which can be seconds later. `window.__orbisPrompts` is read by
`tools/orbis-probe.mjs`, which is how the per-world intros are checked exactly rather than by
scraping console lines that lag the send.

Verified across three dives (one per world), each starting from the menu:

```
desert: prompts 1; bespoke launch yes (accepted); wrong-world 0; run events before the launch 0
city:   prompts 2; bespoke launch yes (accepted); wrong-world 0; run events before the launch 0
forest: prompts 2; bespoke launch yes (accepted); wrong-world 0; run events before the launch 0

world link during every dive: ready/streaming
prompts after Exit: 0 (none); run events after Exit: 0
```

### Frames without eyes

The probe writes a frame per layer (`…png`, `.3d.png`, `.ribbon.png`, `.video.png`, `.menu.png`,
`.menu.png.offline.png`) and `tools/frame-report.mjs` reads them back as numbers: band means and a
tile diff for several frames at once, an edge/hue map for one frame, and a `--region` readout for a
rectangle. That is how the homepage preview and the ground grade were checked without viewing an
image, and how the calibration constants in `road-grade.ts` were derived.

Two newer readings are in the same spirit — numbers where the honest answer cannot be an image. The
probe samples the raw `<video>` into a canvas twice (2.5 s apart, no CSS transform, no lane parallax,
no idle breath in the measurement) and reports how much the picture changed: **0** while paused against
**10.7-45.1** while running, which is what proves the pause reaches the model rather than just the game.
And it reads `window.__orbisWorld` for the session snapshot, because whether Orbis accepted a
resolution, a starting image or an audio setting exists nowhere in the DOM. `LANDSCAPE=1` builds a
picture in the page with its horizon deliberately low, drives the real upload control with it, and
measures the prepared frame with the probe's own row scan rather than the app's — the app agreeing with
itself would prove nothing.

## 20. The session surface, as built

For most of this project the integration drove **four of the model's ten commands and read one of its
fifteen messages** — `connect`, `setPrompt`, `start`, and the `command_error` broadcast. Orbis was being
treated as a pixel source: swap the prompt, sample the frames for grading, and infer everything else
from the picture. It exposes a *scene* API, and the gap is where most of the remaining work was:

| Added | Why the game needs it |
| --- | --- |
| `setImage` + `reset` | the player's landscape, and the only way to clear one |
| `setAudioPrompt` + `setAudioEnabled` | the world's soundtrack, steered per world and per event |
| `pause` / `resume` | the game's pause pauses generation, and a hidden tab does too |
| `setResolution` | `1080p` everywhere — the one lever that changes what a session costs without changing what the player does |
| `setSeed` | a picture that opens the same world twice |
| `state` (message) | the preconditions for every command above |
| `chunk_complete` (message) | one ask per chunk |
| `image_accepted` (message) | confirmation the prepared frame arrived, and at what size |

Three of these changed behaviour rather than adding polish.

**Pausing generation.** A paused session produces nothing, so the pause is also the compute lever: a
player who pauses, or a tab nobody is looking at, stops costing anything. It is reconciled against the
model's own `state` rather than commanded blindly, because `pause` on an already-paused session is a
`command_error`, not a no-op. Measured: `paused:true / running:false`, and two samples of the raw video
2.5 s apart changed by **0** while paused against **10.7-45.1** while running. The media clock is not
evidence either way — a live WebRTC track keeps its element's clock advancing whether or not frames are
arriving, which is why the check is on pixels.

**One ask per chunk.** Orbis reads the prompt that is in force when a chunk *starts*, so a second prompt
inside the same chunk is overwritten before the model ever sees it — a gameplay event spent on nothing.
The director subscribes to `chunk_complete` and holds further asks for the next boundary, with no time
limit on the hold on purpose: a long chunk, a paused world and a stalled generation all release at the
next boundary anyway, and the newest pending event is the one worth sending when it comes. A capped
version (4 s) was measured first and lost an ask: 6 asks across 5 chunks, one doubled. Without the cap:
**7 asks across 7 chunks, none doubled**, which is arithmetic on a real run's journal rather than a
claim about the code.

**A landscape that already agrees with the game.** See section 9; the practical effect is that the
runtime horizon lock, which exists for generated worlds, measures a 0.000% shift for the whole run when
a picture is pinned.

Two honest limits, both about the sound: its audibility cannot be checked headlessly (see section 10),
and the reproducibility `setSeed` promises is the model's contract rather than something measured here.
The visibility pause cannot be exercised headlessly either — the probe's tab is always visible — so that
path shares the player's pause reconciliation but is not separately observed.

## 21. The world as a far landscape, and slowing the spend

The composite had one structural problem left: the generated video sat at the road's depth. It filled
the frame, the prompts asked for a camera at running pace with the ground sweeping toward the bottom
of frame, and the world's near field — cliff flanks, dune faces, low cloud — read as things the player
was running *through*. The ask was to make the video behave like a game backdrop: a landscape farther
away than the runner, and therefore moving slower.

**The prompts carry the distance.** `cameraDirection` now asks for a slow drift (“far slower than a
run”), and a `distantLand` clause — asserted on every picture prompt by `tools/prompt-check.mjs`, like
the horizon clause — keeps everything large near the horizon, forbids close clouds, and holds the
ground between the horizon and the bottom of frame flat and empty. The generated world's own path is
gone with it: “A narrow open path runs from the bottom of the frame to the horizon line” was the
model's invitation to build a road for the runner to be on, and the game already draws one. The
`horizonLine` clause is untouched — the lock and the meeting band still depend on it.

**The haze carries the depth.** `.world-video::after` ramps atmosphere over the video below the
meeting band (44–50% is left clear: game horizon at ~44%, ribbon fade at ~50%). This is the standard
backdrop treatment — painted landscape above, fog where the playable ground takes over — and it also
hides the sky-under-the-road failure mode the vertical lock exists for. It is drawn inside the world
layer, so the WebGL road and runner are never hazed.

**The parallax carries the speed difference.** `--world-x` and `--run-speed` move the video at a
third of their old strength (0.5% / 0.025 against 1.4% / 0.09). The near layer carries the speed; the
backdrop trails.

Band tables on matched captures (composite vs 3D-only vs video-only) show the intended reading:
pure video above 25%, video terrain at 33–50%, and the ribbon through the haze below 58%. The
ribbon's grade moved with it: the ground band is now anchored under the *measured* horizon
(`--world-horizon-window`) instead of a fixed 0.45–0.62 — a fixed band straddles the skyline step as
the lock shifts the video, and `--road-grade` flapped between 0.69 and its 2.0 clamp in one run
before the anchor and a median of five readings: after, 0.71 → 0.82 tracking the world's tone.

**Slowing the spend.** Orbis has no rate knob — only `pause`/`resume`/`reset` — so the chunk loop is
duty-cycled: each `chunk_complete` buys `CHUNK_REST_MS` (3 s) of pause. Measured from the reconciler's
own trace: 3.7 s per chunk against 1.8–1.9 s unthrottled, roughly half the chunks per minute, at a
constant the rest is tuned by. The delivery tier went to `1080p` everywhere (upscaler-delivered, so
the cost moves more than the picture does), and — the subtle one — `setResolution` is now issued
*after* the arming round-trips rather than at their head: the offered list only arrives with a `state`,
and the one emitted on connect is gone before this layer's listener exists, so the old ordering
silently kept the deployment's default forever (visible only once the default stopped being the tier
we wanted). A converger effect arms the tier whenever the list becomes known, so a late one fixes the
next start.

Two bugs came out of measuring this rather than assuming it:

- **A pause command that never settles wedges everything.** One probe run had the throttle dead, the
  player's pause dead, and chunks at full rate — all of which follow from a single `pause()` promise
  that never resolved, because the reconciler's in-flight guard is a ref with no owner. Commands are
  now bounded at 10 s and retried on expiry; if the original lands anyway, the retry's pass finds the
  state already right and does nothing.
- **The console is not evidence.** The CDP console stream drops lines under load (an arming log and
every pause line vanished while prompt lines beside them survived), which first read as “the pause
  path never ran”. The reconciler now keeps its own bounded trace (`window.__orbisTrace`, printed by
  the probe as `pause trace:`): what it wanted, what it asked for, what the model answered
  (`generation_paused` / `generation_resumed`), per cycle. The first run with it showed the duty
cycle working end to end, and pinned the resolution race to a single line of state.

## 22. The runners come from `models/`

The runner characters and their clips were swapped from the legacy cave-runner FBX files to the
purpose-made set in `models/` at the repository root. Nothing about gameplay moved: the same five
states (`idle`, `run`, `jump`, `slide`, `stumble`), the same `AnimationMixer` crossfades, and the
same `speedRef` scaling of the run cycle against the world's speed.

| | amy | james | mousey |
| --- | --- | --- | --- |
| Source (FBX) | `models/characters/amy.fbx` 28.7 MB | `james.fbx` 54.4 MB | `mousey.fbx` 29.6 MB |
| Shipped (GLB) | `models/characters/amy.glb` 2.0 MB | `james.glb` 3.4 MB | `mousey.glb` 1.5 MB |
| Rig | 65 Mixamo bones | 65 bones (`mixamorig9:`) | 57 bones |
| Clips | `models/animations/amy@*.fbx` | `james@*.fbx` | `mousey@*.fbx` |

- **Clips are retargeted per character** (`MotionOnlyScene; Retargeted Clip;` in the file header), and
the loader resolves a clip by bone name, which was the swap's one real risk. Verified in the browser
against three's own lookup (`PropertyBinding.parseTrackName` + `findNode`): all 15 clips bind their
entire track set to their own rig — zero unresolved tracks. The legacy `xbot` set was run through the
same check as a control and also reported 53/53, so the check itself is sound.
- **The clips carry the same motions as the legacy set, at their source lengths.** The same 23 of 53
tracks move in `jumping`, 43 in `sliding`, and baking preserves every duration exactly — the FBX and
the GLB agree to the millisecond on all 15 clips. Running is 0.633 s on every runner, the value
`RUN_CYCLE_SPEED` in `RunnerCharacter.tsx` is tuned against, which is why it did not need retuning;
`jumping` (0.767–0.933 s) and `sliding` (1.167–1.533 s) are trimmed a little differently per runner
in the sources, and nothing reads those lengths — jump, slide and stumble play once and clamp, and
the next crossfade cuts them. (The earlier version of this note claimed all three durations matched the
legacy set on every runner; `running` does, on all three, and `jumping` and `sliding` do not.)
- **Wiring is two files:** `src/game/character-catalog.ts` (ids and labels) and
`src/game/RunnerCharacter.tsx` (the `?url` imports and the mixer); `CharacterPreview`, `RunnerScene`,
`MenuExperience`, `RunExperience` and `App` only carry the `CharacterId` type.
- **`reference/cave-runner/` is now unused.** The character component used to import all 18 of its
FBX files directly; with those imports gone, nothing under `src/`, `server/` or `tools/` reads the
folder, and it can be deleted.
- **Cost, measured.** The FBX sources embed 4096² textures and carry a vertex per face corner, so
they weigh 113 MB between them (2.0 / 1.9 / 1.1 MB of placeholder → 28.7 / 54.4 / 29.6 MB), with a
further 9.7 MB of clips in `models/animations/`.
`tools/fbx-to-glb.mjs` converts them to one GLB per runner: textures cut to 1024 (colour) and 512
(normal, specular) and re-encoded as JPEG — the exporter writes PNG unless asked otherwise, which
was most of the weight — and duplicate vertices welded, so each corner stops being its own vertex
(73,692 → 13,835 for amy, 161,625 → 30,322 for james, 36,519 → 6,968 for mousey). James is one mesh
split into five material groups: the groups are welded one at a time and merged back with their
material indices intact, which is why its five primitives share a single vertex buffer. The result
is 2.0 / 3.4 / 1.5 MB, 6.9 MB in total, and `dist/` fell from 119 MB to 9.0 MB. The FBX files stay on
disk as the source of truth but are kept out of git — `models/**/*.fbx` in `.gitignore`, so 122 MB of
source stays out of the repository and only the 6.9 MB of GLBs is committed. The trade is explicit: a
fresh clone can run the game but cannot re-run the conversion, and `tools/fidelity-check.html` can
only draw its FBX half where the sources are present.
- **The gloss survives the conversion.** Materials are rebuilt as `MeshPhysicalMaterial` and the
FBX's specular lobe is carried into the GLB rather than approximated: shininess 20 becomes
`roughness` 0.30 (`sqrt(2 / (shininess + 2))`), `specularColor` takes the FBX's specular colour
(`#808080` → 0.214 linear; james' eyelashes are `#000000`, so they correctly carry none), and the
specular map is written as `specularColorMap` at 512 in **sRGB** colour space — it is colour data,
unlike the normal map, which is why it does not take the data texture path. The exporter emits it as
the `KHR_materials_specular` extension; three 0.180 both writes and reads that back
(`specularFactor` 1, `specularColorFactor`, `specularColorTexture`), so the game's runner draws the
same lobe the FBX did. The only thing still dropped is the `ShininessExponent` texture `FBXLoader`
never supported. First built as a `MeshStandardMaterial` with the specular map inverted into
roughness, which measured as a mean difference of 1.7–3.5 of 255 between FBX and GLB; carrying the
map through took that to **0.79–1.35**, with the worst pair (`james`, close camera) going from 5.0%
of pixels differing by more than 8 to 3.4%.
- **Fidelity was measured, not assumed.** `tools/fidelity-check.html` draws each runner from the FBX
and from the GLB in the desert world's own light (the values are copied from `RunnerScene.tsx`), from
the game camera and from the preview's closer camera, and reports brightness, neighbour-pixel detail,
blown-out highlights and the per-pixel difference. In the game view, detail energy comes out 0.170 →
0.169 for amy, 0.322 → 0.298 for james and 0.220 → 0.218 for mousey — within a few percent either
way, so nothing reads as flat — and the per-pixel difference is a mean of 0.79 / 1.06 / 1.19 of 255
for the three runners (1.02 / 1.35 / 1.26 at the closer preview camera), at most 3.4% of pixels
differing by more than 8 and at most 0.2% by more than 24. With the material model now matching, the
residue that is left is the texture downscale — the maps ship at 1024 and 512 where the FBX carries
4096² — and it is small enough to leave alone.
The first run of that comparison was wrong in a way worth remembering: `FBXLoader` resolves before
its embedded 4096² images have decoded, so a render taken in that window draws an untextured,
near-black model — which reads as “the GLB looks completely different” when the FBX simply was not
ready. The page now waits for every map to have real dimensions before it measures anything.

## 23. References

- [Visko Orbis Online Challenge](https://www.visko.ai/challenge/orbis-september-2026)
- [Reactor documentation](https://docs.reactor.inc/overview)
- [Orbis Stable overview](https://docs.reactor.inc/model-api-reference/visko-orbis-stable/overview)
- [Orbis Stable tutorial](https://docs.reactor.inc/model-api-reference/visko-orbis-stable/tutorial)
- [Reactor authentication](https://docs.reactor.inc/authentication)
- [Reactor SDK usage](https://docs.reactor.inc/sdk-reference/using-the-sdk)
