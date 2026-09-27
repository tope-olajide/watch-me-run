import { lazy, Suspense } from "react";
import { Canvas } from "@react-three/fiber";
import type { CharacterId } from "./character-catalog";

const RunnerCharacter = lazy(() => import("./RunnerCharacter"));

type CharacterPreviewProps = {
  characterId: CharacterId;
};

export default function CharacterPreview({ characterId }: CharacterPreviewProps) {
  return (
    <div className="character-preview">
      <Canvas camera={{ position: [0, 1.3, 5], fov: 32 }}>
        <ambientLight intensity={2.1} />
        <directionalLight position={[2, 4, 3]} intensity={3} color="#f6c84c" />
        <Suspense fallback={null}>
          <RunnerCharacter characterId={characterId} state="idle" />
        </Suspense>
      </Canvas>
    </div>
  );
}
