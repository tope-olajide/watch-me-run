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
 * One file per runner: the mesh, its rig and all five clips, exported from the FBX sources in
 * `models/characters/` by `tools/fbx-to-glb.html`. The clips are named for the states they drive, so
 * this map is the whole contract between the asset and the game.
 */
const characterAssets: Record<CharacterId, string> = {
  amy: amyUrl,
  james: jamesUrl,
  mousey: mouseyUrl,
};

export default function RunnerCharacter({ characterId, state, speedRef }: RunnerCharacterProps) {
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
  const normalized = useMemo(() => {
    const bounds = new THREE.Box3().setFromObject(model);
    const height = Math.max(bounds.max.y - bounds.min.y, 0.001);
    return { scale: 2.35 / height, y: -bounds.min.y };
  }, [model]);

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
    <group scale={normalized.scale} position={[0, 0, 0]} rotation={[0, Math.PI, 0]}>
      <primitive object={model} position={[0, normalized.y, 0]} />
    </group>
  );
}
