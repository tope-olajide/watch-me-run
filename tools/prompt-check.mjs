// Guard for the Orbis prompts: the generated world has to read as the *landscape* behind the game,
// because the real runner is drawn in WebGL on top of it. Any prompt that names a runner, a
// character, or a person makes the video model render one, and the generated figure then fights the
// player's own runner for the same patch of ground (this is exactly what happened: "locked behind
// the runner" put a runner in the frames).
//
//   node tools/prompt-check.mjs
//
// Every prompt the app can send is built here and scanned, on both channels:
//   - each world and each landscape the player can supply (the picture-anchored variants),
//     opening/launch/event, every player style;
//   - the audio captions, which get their own rules — no subject, no scene description, short.
// The emptiness clause is a list of negations ("no people, no runners"), so it is the fix rather than
// a violation and is stripped before scanning; its presence is asserted separately. Exits non-zero if
// a prompt names a subject or drops a clause, so this can gate a build.
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const temp = join(root, "node_modules", ".cache", "prompt-check");
const bundlePath = join(temp, "prompts.mjs");

mkdirSync(temp, { recursive: true });
await build({
  entryPoints: [join(root, "src", "orbis", "prompts.ts")],
  outfile: bundlePath,
  bundle: true,
  format: "esm",
  platform: "neutral",
});

const { openingPrompt, launchPrompt, eventPrompt, audioPrompt, audioEventPrompt } = await import(
  `file://${bundlePath.replace(/\\/g, "/")}`
);

const ENVIRONMENTS = ["desert", "city", "forest"];
const EVENTS = [
  { type: "near_miss" },
  { type: "combo_milestone", combo: 5 },
  { type: "damage_taken", amount: 1 },
  { type: "speed_milestone", speed: 14 },
  { type: "distance_milestone", distance: 300 },
  { type: "value_tier", tier: 2, value: 50 },
];
const STYLES = ["precise", "reckless", "aggressive", "explorer"];

/** Kept in sync with `emptyFrame` in src/orbis/prompts.ts. */
const EMPTY_FRAME =
  "The landscape is completely empty: no people, no runners, no characters and no figures anywhere in the frame. This is landscape only, seen from the camera.";

/**
 * Kept in sync with `customEmptyFrame`. A supplied picture may honestly contain someone, and a clue
 * that contradicts the starting frame is one the model learns to read loosely — so a player's own
 * landscape gets the version that concedes the frame and forbids only what would be added to it.
 */
const CUSTOM_EMPTY_FRAME =
  "Aside from anything already present in the supplied frame, no new people, runners, characters or figures appear anywhere in the scene. The landscape stays landscape.";

/**
 * Kept in sync with `horizonLine` in src/orbis/prompts.ts. The generated horizon has to stay in the
 * upper third so its ground always covers the band the game's road fades into; a horizon that drops
 * to the middle puts sky under the runner.
 */
const HORIZON_LINE =
  "The horizon line never moves: it stays in the upper third of the frame, with sky above it and ground below it, and it keeps the position the frame it continues gave it. The camera never rises and never tilts up or down, and nothing in the scene is revealed by a camera move.";

/**
 * Kept in sync with `distantLand` in src/orbis/prompts.ts. The generated world is the game's far
 * layer: a backdrop that drifts slowly precisely because it is distant. A prompt that lets the
 * landscape come close to the lens puts the player back to running *through* the video's cliffs and
 * clouds, so the distance clause is asserted on every picture prompt like the horizon clause is.
 */
const DISTANT_LAND =
  "Everything large stays far away: cliffs, mountains, dunes, trees, ruins and buildings hold their distance near the horizon and never come close to the camera, no clouds cross the foreground or hang close overhead, and the ground between the horizon and the bottom of the frame stays flat, open and empty.";

/** Every audio caption has to say this: a narrator over a run is the subject this world cannot have. */
const NO_VOICES = "No voices, no narration, no music.";

/**
 * Words that ask a video model for a subject. Every one of them is banned from a prompt.
 *
 * Plurals are spelled out rather than left to a trailing `s?`, because the first version of this
 * scan listed `crowd` alone and cheerfully passed "crowds" — a city fragment that asked for people
 * while the same prompt said there were none.
 */
const SUBJECT =
  /\b(runner|runners|character|characters|person|people|figure|figures|man|men|woman|women|human|humans|humanoid|boy|boys|girl|girls|child|children|crowd|crowds|silhouette|silhouettes)\b/i;

const baseState = (environment) => ({
  environment,
  distance: 240,
  speed: 12,
  score: 0,
  combo: 0,
  coins: 0,
  stumbles: 0,
  nearMisses: 0,
  jumps: 0,
  slides: 0,
  damage: 0,
  dangerLevel: 0,
  playerStyle: "explorer",
});

const prompts = [];
for (const environment of ENVIRONMENTS) {
  for (const custom of [false, true]) {
    const view = { environment, custom };
    const suffix = custom ? " (player's landscape)" : "";
    const emptiness = custom ? CUSTOM_EMPTY_FRAME : EMPTY_FRAME;
    prompts.push({ label: `${environment}${suffix} opening`, prompt: openingPrompt(view), emptiness });
    prompts.push({ label: `${environment}${suffix} launch`, prompt: launchPrompt(view), emptiness });
    for (const event of EVENTS) {
      for (const playerStyle of STYLES) {
        prompts.push({
          label: `${environment}${suffix} ${event.type} ${playerStyle}`,
          prompt: eventPrompt({ ...baseState(environment), playerStyle }, event, view),
          emptiness,
        });
      }
    }
  }
}

// The sound channel, which has different rules: it conditions the audio, so it describes what the
// scene sounds like. A scene description here makes the audio worse than sending nothing, and only
// roughly the first 128 tokens are read — so a caption is checked for length, not for prose.
const captions = [];
for (const environment of ENVIRONMENTS) {
  for (const custom of [false, true]) {
    const view = { environment, custom };
    const suffix = custom ? " (player's landscape)" : "";
    captions.push({ label: `${environment}${suffix} audio bed`, prompt: audioPrompt(view) });
    for (const event of EVENTS) {
      captions.push({
        label: `${environment}${suffix} audio ${event.type}`,
        prompt: audioEventPrompt(baseState(environment), event, view),
      });
    }
  }
}

let named = 0;
for (const { label, prompt, emptiness } of prompts) {
  const withoutEmptiness = prompt.split(emptiness).join("");
  const hit = withoutEmptiness.match(SUBJECT);
  if (hit) {
    named += 1;
    console.log(`FAIL ${label}: the prompt names "${hit[0]}"\n     ${withoutEmptiness}\n`);
  }
}

let captionProblems = 0;
for (const { label, prompt } of captions) {
  const hit = prompt.match(SUBJECT);
  const problems = [];
  if (hit) problems.push(`names "${hit[0]}"`);
  if (!prompt.includes(NO_VOICES)) problems.push("does not rule out voices");
  if (prompt.length > 260) problems.push(`${prompt.length} chars, past the useful budget`);
  if (problems.length) {
    captionProblems += 1;
    console.log(`FAIL ${label}: ${problems.join("; ")}\n     ${prompt}\n`);
  }
}

const missingEmptiness = prompts.filter((entry) => !entry.prompt.includes(entry.emptiness));
const missingHorizon = prompts.filter((entry) => !entry.prompt.includes(HORIZON_LINE));
const missingDistance = prompts.filter((entry) => !entry.prompt.includes(DISTANT_LAND));

console.log(`picture prompts checked:         ${prompts.length}`);
console.log(`  naming a subject:              ${named}`);
console.log(`  missing the emptiness clause:  ${missingEmptiness.length}`);
if (missingEmptiness.length) console.log(`    ${missingEmptiness.map((e) => e.label).join(", ")}`);
console.log(`  missing the horizon clause:    ${missingHorizon.length}`);
if (missingHorizon.length) console.log(`    ${missingHorizon.map((e) => e.label).join(", ")}`);
console.log(`  missing the distance clause:   ${missingDistance.length}`);
if (missingDistance.length) console.log(`    ${missingDistance.map((e) => e.label).join(", ")}`);
console.log(`audio captions checked:          ${captions.length}`);
console.log(`  breaking an audio rule:        ${captionProblems}`);

const longestCaption = captions.reduce((worst, entry) =>
  entry.prompt.length > worst.prompt.length ? entry : worst,
);
console.log(`  longest caption:               ${longestCaption.prompt.length} chars (${longestCaption.label})`);

console.log(`\n--- ${ENVIRONMENTS[0]} opening ---\n${openingPrompt({ environment: ENVIRONMENTS[0] })}`);
console.log(`\n--- your own landscape, opening ---\n${openingPrompt({ environment: ENVIRONMENTS[0], custom: true })}`);
console.log(
  `\n--- forest value_tier (aggressive) ---\n` +
    eventPrompt({ ...baseState("forest"), playerStyle: "aggressive", distance: 520 }, {
      type: "value_tier",
      tier: 3,
      value: 75,
    }),
);
console.log(`\n--- desert sound ---\n${audioPrompt({ environment: "desert" })}`);
console.log(
  `\n--- sound on a tier crossing ---\n` +
    audioEventPrompt(baseState("city"), { type: "value_tier", tier: 2, value: 50 }, {
      environment: "city",
    }),
);

if (named || captionProblems || missingEmptiness.length || missingHorizon.length || missingDistance.length) {
  console.error(
    "\nFAILED: a prompt would put a figure in the generated world, let the landscape come close, drop the horizon hold, or send an unusable sound caption.",
  );
  process.exit(1);
}
console.log(
  "\nOK: no prompt asks for a figure, every prompt keeps the landscape distant and holds the horizon, and every caption is sound.",
);
