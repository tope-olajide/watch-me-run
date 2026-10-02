import type { Environment, RunState, WorldEvent } from "../game/run-state";

const environmentOpenings: Record<Environment, string> = {
  desert: "an ancient desert at sunset with monumental red dunes and distant ruins",
  city: "a dense neon city at night: enormous lit towers and glowing billboards rising over rain-wet streets with distant traffic",
  forest: "an ancient moss-covered forest with fog, enormous trees, and fireflies",
};

/**
 * Composition that one world needs stated outright, carried by both its opening and its launch.
 *
 * The horizon clause below holds the *line* — sky above, ground below — but says nothing about how
 * much frame each side gets, and a night world is where that distinction bites. "A neon city at
 * night" is, to a model, mostly night: left to itself the city opens on an expanse of dark sky with
 * the skyline somewhere far down the frame, and only grows the buildings once the run has gone far
 * enough for a distance event to push them there. The player's first impression of Neon Pursuit was
 * therefore a sky with no city in it.
 *
 * So the city is told where its buildings are — and, after the first version of this clause was
 * measured against a live frame that still put the city's ground line at 73% and its lights below
 * the game's own horizon, told in the terms a camera actually has: which part of the frame each thing
 * owns, where the ground line sits, and what shape of picture counts as wrong. "Tall skyline above
 * the horizon" was satisfiable by a thin distant strip low in a big sky; "the towers own the upper
 * half and pass the top edge" is not.
 *
 * A second measurement — the upper half by then held one lit cluster with night sky across the rest
 * of its width — added the thing the clause had left implicit: density. "Fills the frame edge to
 * edge" can be answered by one building too, so the clause now asks for buildings packed in layers
 * with no wide sky gaps between them and for the skyline to be lit across its whole width, and names
 * patches of empty dark sky between the buildings as the wrong picture along with the low strip.
 *
 * Nothing else moves: this is a composition clause, it does not ask for a camera move (a move is the
 * one thing `horizonLine` forbids), and the ground stays as empty as every other world's because the
 * near band still belongs to the game's own road.
 */
const environmentFraming: Partial<Record<Environment, string>> = {
  city:
    "The shot is at street level looking down a neon avenue, and the skyline is already there on the very first frame, dense and continuous: enormous towers and billboards fill the upper half of the picture from the left edge to the right edge, packed close together in layers at different depths with no wide gaps of night sky between them, rising from the ground line — which sits in the upper third of the frame — and their tops run past the top edge, so the only sky visible is a narrow strip along the very top. The skyline is lit across its whole width: windows, signs and billboards glow from one edge of the frame to the other. Large patches of empty dark sky between the buildings are the wrong picture, and so is a thin strip of distant buildings low in the frame.",
};

/**
 * What a prompt is describing: a world, or a picture the player supplied.
 *
 * The distinction is not cosmetic. A landscape grown from the player's own image must be *that
 * place* — naming a world in the prompt would fight the picture the model was handed and drag the
 * scene back towards the named environment, so the prompts talk about continuing the supplied frame
 * instead. The gameplay world (desert, city, forest) is still the environment: it decides the
 * obstacles, the pacing and the road, exactly as before.
 */
export type WorldView = { environment: Environment; custom?: boolean };

/**
 * The opening shot of a run, written per world. The menu holds a wide establishing shot, so the
 * dive has to say what this particular world does when the camera falls into it — the sand lifting,
 * the spray off the asphalt, the fog tearing open — rather than a generic "move forward".
 *
 * None of these may climb. "Diving over the crest of a dune" reads as a camera on the way up, and a
 * camera that goes up is a camera whose horizon slides down the frame — the exact failure the
 * `horizonLine` clause exists to prevent. Nor may anything stream past the lens: the landscape stays
 * far away and slow, and the sense of launch comes from the game drawn on top of it.
 */
const launchOpenings: Record<Environment, string> = {
  desert:
    "The light burns low across the open sand as heat haze shimmers over the distant dunes, fine dust drifting slowly far ahead, the ruins on the horizon resolving slowly out of the glare",
  city:
    "The neon glow deepens across the skyline above the avenue as distant traffic trails slide slowly through the rain and window lights flicker from the towers",
  forest:
    "Fog drifts slowly between the distant trunks as shafts of light move across the far canopy and fireflies gather in the depth of the forest",
};

/**
 * The subject line for a landscape the player supplied, in place of the world's own opening.
 *
 * It says "the exact landscape supplied as the starting frame… carried forward" because that is the
 * whole job: the model is handed a frame and has to grow a world out of it, not replace it with its
 * own idea of a desert. Everything that made the supplied image special — its terrain, its light, its
 * colours, where its horizon is — is named as the thing to preserve.
 */
const customOpening =
  "the exact landscape supplied as the starting frame — the same terrain, the same colours, the same light, the same time of day and the same horizon line, carried forward as one continuous moving shot";

/**
 * The real runner is drawn in WebGL on top of this video, so the generated world has to be the
 * *landscape* and nothing else — and a distant one at that: a backdrop the game plays out in front
 * of, not a place the runner travels through. Naming a subject is what makes the model render one: while the
 * prompts said "locked behind the runner" and "the runner travels along a narrow open path", Orbis
 * put its own runner on that path, and the two figures fought over the same patch of ground. So the
 * world is described as an empty landscape with a camera moving through it, and the emptiness is
 * stated outright rather than left to the model to infer from an absence.
 *
 * The ban is on figures — people, characters, runners — not on every living thing: the forest's
 * fireflies and fleeing birds are part of its identity, and a clause that forbade creatures while the
 * same prompt asked for fireflies taught the model to read the clause loosely, which is the last
 * thing an instruction this load-bearing can afford.
 */
const emptyFrame =
  "The landscape is completely empty: no people, no runners, no characters and no figures anywhere in the frame. This is landscape only, seen from the camera.";

/**
 * The same promise for a frame the player supplied, which may honestly contain someone.
 *
 * A clause that contradicts the starting image is a clause the model learns to read loosely, so this
 * one concedes the picture and forbids only what would be added on top of it. What has to be stopped
 * is the model inventing a runner to explain a camera moving at running pace — the player's own
 * runner is the only figure that may move through this world.
 */
const customEmptyFrame =
  "Aside from anything already present in the supplied frame, no new people, runners, characters or figures appear anywhere in the scene. The landscape stays landscape.";

/**
 * The generated frame has to keep its sky on top and its ground at the bottom.
 *
 * The game camera is a fixed rig — y=3.4, aimed about 3.25° down — so the ground plane's horizon
 * lands about 44% down the frame (43.3% at the base field of view, 44.9% at the widest) and the road
 * ribbon dissolves into the video at about 50% (measured with `frame-report` on a real capture: the
 * ribbon's furthest row sits at 50%). Everything the video shows below its own horizon is terrain the
 * game's road continues into; everything above it is sky. When the generated camera rises or tilts
 * up, its horizon slides down the frame, that 44-50% band — the only place the two layers actually
 * meet — turns into sky, and the runner reads as running in the sky.
 *
 * So the horizon is asked for high: the upper third, deliberately above the ~44% line the game
 * actually needs. Drift then has somewhere to go. Ground that covers too far *up* is invisible (the
 * ribbon is drawn over it); sky that covers the fade band is the bug. The margin is not decoration —
 * it is the whole reason the number is not simply 44%.
 *
 * This is a hard constraint, its own clause, carried by every prompt. As a passing description
 * ("the horizon held steady in the upper third") the model was free to let it drift over a long run.
 *
 * For a supplied frame the same clause reads as a promise about the picture: the composition is kept
 * where the player put it, and nothing is revealed by moving the camera.
 */
const horizonLine =
  "The horizon line never moves: it stays in the upper third of the frame, with sky above it and ground below it, and it keeps the position the frame it continues gave it. The camera never rises and never tilts up or down, and nothing in the scene is revealed by a camera move.";

/**
 * The generated camera has to behave like the *far* layer of the game, or the two stop reading as
 * one world.
 *
 * The earlier wording asked for the opposite of what the composite needs: a camera at running pace
 * with "the ground sweeping continuously toward the bottom of the frame". That is exactly what made
 * the video read as somewhere the player runs *through* — cliffs, dunes and clouds rushing the lens
 * at the same apparent depth as the road. The generated world is the game's distant landscape, the
 * painted backdrop of a stage: it drifts toward the viewer slowly, *because it is far away*, while
 * the road and the runner carry the speed in the foreground.
 *
 * So the camera describes its own slow motion (never what it is following — "locked behind the
 * runner" made the shot a chase and put a subject in it), and the landscape is told to hold its
 * distance: everything large stays near the horizon, nothing comes close to the lens, and the near
 * ground between the horizon and the bottom of frame stays flat and empty — that band is where the
 * game's own road is drawn, and where the distance haze in src/styles.css dissolves whatever the
 * world still puts there.
 */
const distantLand =
  "Everything large stays far away: cliffs, mountains, dunes, trees, ruins and buildings hold their distance near the horizon and never come close to the camera, no clouds cross the foreground or hang close overhead, and the ground between the horizon and the bottom of the frame stays flat, open and empty.";

const cameraDirection = [
  "The camera drifts steadily forward at a slow walking pace, far slower than a run, and its height above the ground never changes.",
  distantLand,
  horizonLine,
  "Constant slow forward motion, no cuts, no camera shake, no whip pans, no crane or drone movement, no change of camera height, angle or direction.",
].join(" ");

/**
 * Event reactions are about what the *world* does, not about the runner doing something to it. Every
 * fragment here used to be phrased around "the runner" ("behind the runner", "the runner's pace"),
 * which re-introduced a subject into an otherwise empty frame on top of the resting shot.
 *
 * A fragment also may not ask for a reveal. "A giant tree becomes visible" and "a buried city becomes
 * visible" are shots a camera earns by tilting up or lifting, and the model took them: the horizon
 * dropped and the road was left hanging in sky. Anything that arrives, arrives *ahead on the horizon
 * line*, with the camera explicitly staying put.
 */
const eventFragments: Record<Environment, Partial<Record<WorldEvent["type"], string>>> = {
  desert: {
    near_miss: "A violent sandstorm is building behind the run, on the same horizon line.",
    combo_milestone: "Ancient ruins begin glowing in answer to the pace of the run.",
    damage_taken: "The horizon turns dark red and the storm moves closer.",
    speed_milestone: "The wind becomes violent and distant dunes begin to move.",
    distance_milestone:
      "A buried ancient city becomes visible far ahead on the horizon line, with no camera move to reveal it.",
    value_tier:
      "The ancient ruins ignite with golden light as the storm ahead turns bright, the desert visibly answering the pace of the run without any change to the camera's height or angle.",
    powerup_collected:
      "The ruins far ahead pulse with golden light and the dunes catch it, the horizon line unmoved.",
    powerup_spent:
      "The golden light in the ruins dies back to embers and the storm ahead darkens, the horizon line unmoved.",
    // The hazard the card advertises, arriving in the picture. Each one is written as the *world*
    // doing it rather than as a thing happening to anyone on the ground, and each carries its own
    // camera hold, because a storm is the most tempting reason a model has to move the lens.
    hazard_started:
      "A wall of sand sweeps across the horizon and the whole frame fills with blowing grit until the far dunes are barely visible, with no camera move.",
    // The terms: the world settling into the deal the run was taken under. Written as the world
    // agreeing rather than as anything being announced — no sign, no text, no camera move, just a
    // landscape that falls into a rhythm and holds it for the rest of the run.
    contract_taken:
      "The distant dunes deepen in colour and the blowing sand settles into a steady, even rhythm that carries on unchanged, with no camera move.",
    // The best line, beaten: the world recognises the run rather than escalating on it — the far
    // ground opens up, as if something old had been walked past.
    ghost_passed:
      "The far dunes open into a wide, even expanse and the horizon sharpens in clean light, with no camera move.",
    // A threaded gap: the run's best move, and the world's answer is a held breath rather than an
    // escalation — the light steadies, the air clears a moment, nothing new appears.
    perfect_gap:
      "The blowing sand stalls in the air as if holding its breath and the far ruins sharpen for a moment, with no camera move.",
  },
  city: {
    near_miss: "Traffic becomes chaotic far down the avenue as vehicles swerve and brake.",
    combo_milestone: "Distant billboards and windows react to the impossible combo.",
    damage_taken: "Emergency lights activate across the city.",
    speed_milestone: "Neon lights stretch through the rain as the city accelerates.",
    // A city-wide blackout used to live here, and it was the wrong event in the wrong slot: a
    // `distance_milestone` fires every 50 m, so the city was asked to switch its own lights off again
    // and again through a run — which is how the neon world ended up reading as a dark sky with a few
    // lit windows, the very complaint the composition clause above was written for. The blackout is
    // the *hazard* (see `hazard_started`), on its own schedule with its own warning; a routine
    // milestone gets what the desert and the forest get — a landmark revealed, something added.
    distance_milestone:
      "A vast district of lit towers and billboards becomes visible far ahead on the same horizon line, more skyline rising over the distance, with no camera move to reveal it.",
    value_tier:
      "Every billboard and window ahead flares at once and the far skyline lights up gold, the city throwing its light across the distant streets without any change to the camera's height or angle.",
    powerup_collected:
      "Neon far down the avenue flares up in a bright pulse, the rain catching the light, with no camera move.",
    powerup_spent:
      "The bright pulse down the avenue bursts and the neon stutters out, leaving only rain and dark glass ahead, with no camera move.",
    hazard_started:
      "Every light in the city fails at once from the horizon towards the camera, leaving only wet asphalt, rain and the dark skyline, with no camera move.",
    contract_taken:
      "The far neon steadies into an even pulse and the rain settles into a regular rhythm across the wet avenue, with no camera move.",
    ghost_passed:
      "The far avenue opens into clear receding perspective and the neon stops flickering, holding a steady light, with no camera move.",
    perfect_gap:
      "The rain seems to hang in the air for a moment and the far avenue goes perfectly still and clear, with no camera move.",
  },
  forest: {
    near_miss: "Birds flee through the canopy and the forest wind intensifies.",
    combo_milestone: "Glowing plants bloom across the distant forest floor.",
    damage_taken: "The fog thickens and the forest becomes visibly hostile.",
    speed_milestone: "The canopy shakes as the wind tears through it.",
    distance_milestone:
      "A giant ancient living tree becomes visible far ahead on the horizon line, with the camera staying level rather than tilting up to show it.",
    value_tier:
      "A wave of golden light blooms through the distant undergrowth and the fireflies stream into long bright trails far ahead without any change to the camera's height or angle.",
    powerup_collected:
      "A cluster of glowing plants far ahead brightens in a slow pulse, throwing light through the undergrowth with no camera move.",
    powerup_spent:
      "The glowing plants far ahead flare once and go dark as the fog draws closer, with no camera move.",
    hazard_started:
      "Thick fog rolls across the ground and swallows everything past the nearest trees, the far trunks and canopy fading into flat white, with no camera move.",
    contract_taken:
      "The far canopy settles into a slow, even sway and the fireflies gather into a steady drift between the trunks, with no camera move.",
    ghost_passed:
      "The undergrowth far ahead thins into open, even ground and the light through the canopy steadies, with no camera move.",
    perfect_gap:
      "The fog thins for a moment and the far trunks come back sharp and still, the whole forest holding quiet, with no camera move.",
  },
};

export function openingPrompt(view: WorldView): string {
  const subject = view.custom
    ? `Continue a single uninterrupted cinematic shot of ${customOpening}.`
    : `Continue a single uninterrupted cinematic shot of ${environmentOpenings[view.environment]}.`;

  return [
    subject,
    cameraDirection,
    // A supplied picture has its own composition and is not talked over; a generated world may need
    // the one thing its subject line left open, which is how much of the frame is sky.
    view.custom ? undefined : environmentFraming[view.environment],
    view.custom ? customEmptyFrame : emptyFrame,
    // The generated world has no path of its own: the game draws the only path the runner uses, and
    // a path in the video would be a second road ending nowhere. What the video owns is the open
    // ground the game's ribbon fades into, and the far landscape beyond it.
    "The open ground below the horizon is flat and empty with no path, track or road on it, and the distant landscape is alive and evolving.",
    "Cinematic realism, strong environmental identity, stable composition.",
  ]
    .filter(Boolean)
    .join(" ");
}

/**
 * The menu holds a wide establishing shot of the world; a run begins with the camera already
 * moving. This is sent the moment a run starts, so the chunks that land as the interface dives away
 * are the run's opening — the same world, its far landscape now slowly drawing nearer.
 */
export function launchPrompt(view: WorldView): string {
  const subject = view.custom
    ? `Continue the same uninterrupted cinematic shot of ${customOpening}.`
    : `Continue the same uninterrupted cinematic shot of ${environmentOpenings[view.environment]}.`;

  return [
    subject,
    // The dive is written per world, so a supplied landscape gets the neutral version rather than
    // a dune crest or a neon avenue it may not contain.
    view.custom
      ? "The camera glides slowly forward through that same landscape, the atmosphere of the place evolving far ahead."
      : `${launchOpenings[view.environment]}.`,
    cameraDirection,
    view.custom ? undefined : environmentFraming[view.environment],
    view.custom ? customEmptyFrame : emptyFrame,
    "A strong sense of gliding deep into the distance as the far landscape slowly draws nearer, while everything close to the camera stays flat and empty.",
    "Cinematic realism, strong environmental identity, stable composition, no cuts.",
  ]
    .filter(Boolean)
    .join(" ");
}

/**
 * How a run is going is expressed as what the world does, never as what a figure in the frame is
 * doing — the frame has to stay free for the player's own runner. `playerStyle` therefore sets the
 * world's posture (clean, unravelling, raging open) rather than describing a person.
 */
const styleClauses: Record<RunState["playerStyle"], string> = {
  precise: "The world reacts cleanly and precisely, disturbed only where the run touches it.",
  reckless: "The world is unsettled all around the path, reacting faster than it can settle.",
  aggressive: "The world is being driven into chaos, reacting violently on every side.",
  explorer: "The world reveals itself calmly ahead, opening up with each metre.",
};

export function eventPrompt(state: RunState, event: WorldEvent, view?: WorldView): string {
  const custom = view?.custom ?? false;
  const fragment = eventFragments[state.environment][event.type];

  /**
   * A tier crossing is an escalation, not a mood change: the same world has answered before, and
   * this answer has to read as larger than the last one. Without this clause the four crossings
   * would be four unrelated visual events that happen to arrive in order.
   *
   * "Bigger" has to mean bigger in the world, not in the camera. Escalation is the most tempting
   * reason for a model to pull back or rise, and a pull-back is how the horizon ended up in the
   * middle of the frame, so the escalation carries its own camera hold.
   */
  const escalation =
    event.type === "value_tier"
      ? `This is escalation ${event.tier} of 4 in how this world answers the run, so the reaction must be visibly stronger than the previous one — larger in the world itself, with no change to the camera's height, angle or horizon line.`
      : "";

  return [
    // "shot", not "run": the noun was the one thing in the sentence a video model could turn into
    // a subject, and a subject is exactly what this frame must not have.
    custom
      ? "Continue the same uninterrupted cinematic shot of the supplied landscape."
      : `Continue the same uninterrupted cinematic ${state.environment} shot.`,
    styleClauses[state.playerStyle],
    fragment ?? "The atmosphere evolves naturally while preserving the current world.",
    // The travelled distance is stated to anchor continuity, and re-anchored to the camera at the
    // same time: a model that reads "600 meters" as licence to open the view out now reads what
    // it may not move while doing so.
    `The run is ${Math.round(state.distance)} meters in, and the camera height, angle and horizon line are unchanged.`,
    escalation,
    custom ? customEmptyFrame : emptyFrame,
    // The composition, re-asserted on every event, not only at the opening: the city's clause is the
    // one prompt content that describes where things sit in the frame, and a long run is exactly when
    // a model drifts back to its default "mostly night" reading. The horizon hold alone cannot catch
    // that — a horizon in the upper third with a huge sky above it satisfies every clause but this one.
    custom ? undefined : environmentFraming[state.environment],
    `Preserve the same environment and camera direction. ${cameraDirection}`,
    "Apply this change as a smooth visual evolution rather than a hard cut.",
  ]
    .filter(Boolean)
    .join(" ");
}

/* ---- the sound channel -------------------------------------------------------------------------
 *
 * Orbis generates the audio with the picture, on its own conditioning channel, and the prompt for it
 * describes *what the scene sounds like* — not what is on screen. The model's own guidance is blunt
 * about the difference: sending a scene description to the audio prompt makes the audio worse than
 * sending nothing, and only roughly the first 128 tokens are read.
 *
 * So these are all sound, in one sentence each: materials, weather, distance, and no voices. Voices
 * are called out as absent because the audio model's default reading of a moving camera is a
 * narrator, and a narrator over a run is exactly the subject this world must not have.
 *
 * The world sets the bed; an event bends it. That is also why these are cheap to send on every
 * event — a caption is one sentence, where the visual prompt that accompanies it is a paragraph.
 */
const audioBeds: Record<Environment, string> = {
  desert:
    "Dry desert ambience: a steady wind moving across open sand, fine grit hissing past, a low distant rumble under everything.",
  city:
    "Rain-wet city ambience: rain on asphalt, tyres hissing through standing water, a distant low traffic hum.",
  forest:
    "Old forest ambience: wind moving high through leaves, wood creaking, a low insect hum, occasional water dripping.",
};

const customAudioBed =
  "Wide open-air ambience: a steady wind moving past the microphone, faint loose gravel underfoot, a low distant atmosphere.";

const audioEvents: Partial<Record<WorldEvent["type"], string>> = {
  near_miss: "A sudden gust rises over the ambience and a low whoosh passes close by, then settles.",
  combo_milestone: "A quick bright shimmering accent rides over the ambience.",
  damage_taken: "A hard low impact with a scrape of stone, and the ambience briefly drops out.",
  speed_milestone: "The ambience swells: wind and motion louder, faster and closer together.",
  distance_milestone: "The ambience opens out, wider and more spacious than before.",
  value_tier: "The ambience swells into a brighter, fuller wash with a rising shimmer over it.",
  powerup_collected: "A clean bright chime rises over the ambience, short and sharp, then fades.",
  // The one spent pickup is the shield, spent by taking a hit: the sound of something breaking in
  // front of the run rather than around it.
  powerup_spent: "A glassy shatter with a low thud, and the ambience briefly thins out.",
  // The world's weather, heard: each one takes the bed somewhere it does not normally go, which is
  // what makes a hazard audible before it is visible.
  hazard_started: "The ambience drops away and a vast low roar moves in over the top, levelling everything else.",
  // The deal, heard: the bed settling into a level hold that then keeps going.
  contract_taken: "The ambience settles into a steady level tone that holds, as if something has agreed.",
  // A record being overtaken, heard: the same settling as a deal, but warmer and shorter, so the two
  // acknowledgements are not the same sound with different words over them.
  ghost_passed: "A warm low chord opens in the ambience and resolves, brief and even.",
  // A held breath: everything thins and stretches, then comes back.
  perfect_gap: "The ambience thins to almost nothing and holds for a beat, then returns slowly.",
};

/** No voices, in every caption: the one thing the audio model must never add to this world. */
const noVoices = "No voices, no narration, no music.";

/** The sound of a world, sent once when the world is armed. */
export function audioPrompt(view: WorldView): string {
  return `${view.custom ? customAudioBed : audioBeds[view.environment]} ${noVoices}`;
}

/**
 * The sound of an event, which is the world's own bed bent towards what just happened — so the two
 * never fight. Falls back to the bed when the event has no sound of its own, which is most of them:
 * a distance milestone every few seconds does not need its own score.
 */
export function audioEventPrompt(state: RunState, event: WorldEvent, view?: WorldView): string {
  const custom = view?.custom ?? false;
  const bed = custom ? customAudioBed : audioBeds[state.environment];
  const accent = audioEvents[event.type];
  return `${bed} ${accent ?? ""} ${noVoices}`.replace(/\s+/g, " ").trim();
}
