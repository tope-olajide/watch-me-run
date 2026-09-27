export type CharacterId = "amy" | "james" | "mousey";

export type CharacterDefinition = {
  id: CharacterId;
  label: string;
};

/**
 * The runners, and the only place their names are written down.
 *
 * Assets live in `models/` at the repository root. Each runner is one GLB — mesh, rig and all five
 * clips — built from the FBX sources beside it by `tools/fbx-to-glb.html`:
 * `models/characters/<id>.glb` from `models/characters/<id>.fbx` plus
 * `models/animations/<id>@<state>.fbx` (dancing, running, jumping, sliding, stumbling). The `?url`
 * imports in `RunnerCharacter.tsx` are what actually load them, so this catalog is just the
 * id/label pairs the menu, the entrance veil and the scene share.
 */
export const characterCatalog: CharacterDefinition[] = [
  { id: "amy", label: "Amy" },
  { id: "james", label: "James" },
  { id: "mousey", label: "Mousey" },
];
