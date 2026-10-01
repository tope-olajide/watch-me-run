import { useEffect, useMemo, useRef } from "react";
import { useFrame, useLoader } from "@react-three/fiber";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import * as THREE from "three";
import type { CharacterId } from "./character-catalog";
import amyUrl from "../../models/characters/amy.glb?url";
import jamesUrl from "../../models/characters/james.glb?url";
import mouseyUrl from "../../models/characters/mousey.glb?url";

type AnimationState = "run" | "jump" | "slide" | "stumble" | "idle";

type RunnerCharacterProps = {
  characterId: CharacterId;
  state: AnimationState;
  /** Live run speed, so the run cycle keeps pace with the world instead of drifting. */
  speedRef?: { current: number };
  /**
   * Which way the runner faces. A run is shot from behind, so the default is their back; the menu's
   * stage puts the player in front of the runner instead, and has to ask for it — the models are
   * authored facing +Z, which is straight at the menu's camera.
   */
  facing?: "away" | "camera";
};

/** Run cycle speed at which the clip plays at its authored rate. */
const RUN_CYCLE_SPEED = 11;

/** Fade time per state: impacts snap, locomotion blends. */
const TRANSITION_SECONDS: Record<AnimationState, number> = {
  idle: 0.2,
  run: 0.16,
  jump: 0.1,
  slide: 0.12,
  stumble: 0.06,
};

const LOOPING_STATES: AnimationState[] = ["run", "idle"];

/**
 * The runner's own size, measured once per file rather than from wherever it happens to be attached
 * when it is measured.
 *
 * `Box3.setFromObject` measures in world space, which is fine the first time — the model comes out of
 * the loader unattached — but a second mount measures the model while the *previous* mount's group is
 * still attached (React renders the replacement before it removes the old subtree), so the reading
 * includes the last normalisation and the new scale divides it back out. That is the retry that came
 * back a different size than the first run: the same file, scaled by whatever the old group happened
 * to be, then normalised against it.
 *
 * The bounds here are taken against the model's own root instead: every mesh's geometry box pushed
 * through the file's internal node transforms, with no ancestor in the answer. Cached per file, so
 * every mount of a runner is the same runner.
 */
const normalisedCache = new Map<string, { scale: number; y: number }>();

function normalisedSize(model: THREE.Object3D): { scale: number; y: number } {
  const cached = normalisedCache.get(model.uuid);
  if (cached) return cached;

  const bounds = new THREE.Box3();
  const walk = (object: THREE.Object3D, parent: THREE.Matrix4): void => {
    object.updateMatrix();
    const local = new THREE.Matrix4().multiplyMatrices(parent, object.matrix);
    const mesh = object as THREE.Mesh;
    if (mesh.isMesh && mesh.geometry) {
      mesh.geometry.computeBoundingBox();
      const box = mesh.geometry.boundingBox;
      if (box) bounds.union(new THREE.Box3().copy(box).applyMatrix4(local));
    }
    for (const child of object.children) walk(child, local);
  };
  walk(model, new THREE.Matrix4());

  const height = Math.max(bounds.max.y - bounds.min.y, 0.001);
  const value = bounds.isEmpty() ? { scale: 1, y: 0 } : { scale: 2.35 / height, y: -bounds.min.y };
  normalisedCache.set(model.uuid, value);
  return value;
}

/**
 * One file per runner: the mesh, its rig and all five clips, exported from the FBX sources in
 * `models/characters/` by `tools/fbx-to-glb.html`. The clips are named for the states they drive, so
 * this map is the whole contract between the asset and the game.
 */
const characterAssets: Record<CharacterId, string> = {
  amy: amyUrl,
  james: jamesUrl,
  mousey: mouseyUrl,
};

export default function RunnerCharacter({ characterId, state, speedRef, facing = "away" }: RunnerCharacterProps) {
  const gltf = useLoader(GLTFLoader, characterAssets[characterId]);
  const model = gltf.scene;
  const mixer = useMemo(() => new THREE.AnimationMixer(model), [model]);
  const clips = useMemo(() => {
    const found = new Map(gltf.animations.map((clip) => [clip.name, clip]));
    return {
      idle: found.get("idle"),
      run: found.get("run"),
      jump: found.get("jump"),
      slide: found.get("slide"),
      stumble: found.get("stumble"),
    } as Record<AnimationState, THREE.AnimationClip>;
  }, [gltf]);
  const normalized = useMemo(() => normalisedSize(model), [model]);

  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const host = window as unknown as { __runnerSize?: () => unknown };
    host.__runnerSize = () => ({ scale: normalized.scale, y: normalized.y });
    return () => {
      delete host.__runnerSize;
    };
  }, [normalized]);

  const active = useRef<THREE.AnimationAction | null>(null);

  useEffect(() => {
    const clip = clips[state];
    if (!clip) return;
    const action = mixer.clipAction(clip);
    const previous = active.current;
    const looping = LOOPING_STATES.includes(state);
    const fade = TRANSITION_SECONDS[state];

    action.reset();
    action.setLoop(looping ? THREE.LoopRepeat : THREE.LoopOnce, looping ? Infinity : 1);
    // Jump, slide, and stumble hold their last frame instead of snapping back to the start.
    action.clampWhenFinished = !looping;
    action.enabled = true;
    action.setEffectiveTimeScale(1);
    action.setEffectiveWeight(1);
    action.play();

    if (previous && previous !== action) {
      // crossFadeFrom keeps both clips weighted for the duration of the blend.
      action.crossFadeFrom(previous, fade, false);
    } else {
      action.fadeIn(fade);
    }

    active.current = action;
  }, [clips, mixer, state]);

  useEffect(() => () => {
    mixer.stopAllAction();
  }, [mixer]);

  useFrame((_, delta) => {
    if (speedRef && active.current && LOOPING_STATES.includes(state)) {
      const target = THREE.MathUtils.clamp(speedRef.current / RUN_CYCLE_SPEED, 0.55, 1.6);
      active.current.setEffectiveTimeScale(target);
    }
    mixer.update(delta);
  });

  return (
    // Feet sit on y = 0, which is also the road and obstacle baseline.
    <group scale={normalized.scale} position={[0, 0, 0]} rotation={[0, facing === "camera" ? 0 : Math.PI, 0]}>
      <primitive object={model} position={[0, normalized.y, 0]} />
    </group>
  );
}

/**
 * Starts fetching a runner's GLB before anything renders it.
 *
 * `RunnerCharacter` is a lazy chunk behind a `Suspense` boundary in both places it appears, so the
 * first frame that needs it either suspends or arrives late. The loading screen is the one place
 * with time to spare, so it calls this: the chunk is imported and the model warmed into the loader
 * cache the render then reads synchronously — which is what keeps the stand-in from ever being on
 * screen.
 *
 * Returns the load, so the loading screen can *wait* for the runner rather than only start it: a
 * promise is the difference between the run opening with the character in it and the run opening
 * with a gap where the character goes.
 */
export function preloadCharacter(characterId: CharacterId): Promise<void> {
  // `useLoader.preload` does return the load — suspend-react's `preload` — even though the R3F types
  // declare it `void`. It is funnelled through `Promise.resolve` on purpose: if a future version
  // really does return nothing, awaiting a non-thenable resolves at once and the loading screen
  // simply stops waiting for the runner instead of hanging on it.
  const loading = useLoader.preload(GLTFLoader, characterAssets[characterId]) as unknown;
  return Promise.resolve(loading).then(() => undefined);
}
