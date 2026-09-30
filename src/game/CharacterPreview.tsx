import { lazy, Suspense } from "react";
import { Canvas } from "@react-three/fiber";
import type { CharacterId } from "./character-catalog";

const RunnerCharacter = lazy(() => import("./RunnerCharacter"));

type CharacterPreviewProps = {
  characterId: CharacterId;
};

/**
 * The runner on the menu's stage.
 *
 * Two things about this camera are load-bearing.
 *
 * The rig is `RunnerCharacter`'s own: the model is normalised to 2.35 m with its feet on y = 0, so
 * the body spans 0 to 2.35 and the head sits in the top quarter of that. A camera left to pitch at
 * the origin — which is what R3F does with a `camera` prop that has no `rotation` — aims at the
 * runner's feet and cuts the frame off at eye level, which is how the menu ended up showing a
 * headless dancer. So the camera is placed at chest height and given an explicit `rotation`: aiming
 * it costs the head, and the rotation is also what tells R3F to leave the aim alone at all.
 *
 * And the runner has to be looking at the player. The run's camera is behind them (see the
 * `facing` prop in `RunnerCharacter`), so the stage asks for the other one — the one screen where
 * the player gets to see the character they are choosing.
 */
export default function CharacterPreview({ characterId }: CharacterPreviewProps) {
  return (
    <div className="character-preview">
      {/* 5 m back at a 32° lens is a 2.9 m tall frame: the whole 2.35 m runner with room above the
          head for a raised arm. */}
      <Canvas camera={{ position: [0, 1.15, 5], rotation: [0, 0, 0], fov: 32 }}>
        <ambientLight intensity={2.1} />
        <directionalLight position={[2, 4, 3]} intensity={3} color="#f6c84c" />
        <Suspense fallback={null}>
          <RunnerCharacter characterId={characterId} state="idle" facing="camera" />
        </Suspense>
      </Canvas>
    </div>
  );
}
