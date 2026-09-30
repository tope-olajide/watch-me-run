import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import type { Environment } from "./run-state";
import type { PropId, PropMetrics } from "./roadside-props";
import treesUrl from "../../models/trees/props.glb?url";
import rocksUrl from "../../models/rocks/props.glb?url";
import cityUrl from "../../models/city/props.glb?url";

/**
 * The roadside props that come from asset packs rather than from `roadside-props`.
 *
 * A world's scenery is two things. The shapes that define the place — the trees, the boulders, the
 * buildings — are artist-made models, cooked down from the packs in `models/` by
 * `tools/cook-props.mjs` into one small GLB per pack: five trees at 982 KB, fifteen boulders at
 * 1.28 MB and thirteen city buildings at 664 KB, out of over 100 MB of source scenes and textures.
 * Everything else beside the road is the game's own furniture — the signs, the billboards, the street
 * lights, the fallen logs — and stays procedural, because the packs have no opinion about any of it
 * and the panels on those signs are the one place Orbis's own picture gets shown to the player.
 *
 * ## The packs are props, and the props are already the right shape
 *
 * The cooker normalises every model it takes: centred across X and Z, base at y = 0, exactly 1 m
 * tall, which is the convention `roadside-props` authors its own shapes to. So a model and a
 * hand-built prop are interchangeable to the layout — one number, in metres, is all either of them
 * needs — and the recipes' scale ranges mean the same thing for both. Nothing here re-measures or
 * rescales; it reads the geometry's bounding box for the layout's clearance and leaves it alone.
 *
 * ## Loaded once, for the life of the page
 *
 * Props are cached by pack, and the geometries are shared by every world that uses them — the forest
 * and the desert both stand on the same boulders, tinted differently. That means these geometries are
 * deliberately *not* disposed when a world's roadside unmounts: they are page-lifetime assets like the
 * character models, not per-run content, and disposing them on a world change would leave the next
 * world drawing freed buffers. Materials are cloned per world, because the tint is per world and two
 * worlds should not be able to repaint each other's rocks.
 */

const PACK_URLS = {
  trees: treesUrl,
  rocks: rocksUrl,
  city: cityUrl,
} as const;

export type PackName = keyof typeof PACK_URLS;

/** Which packs a world stands its scenery on. */
const PACKS_FOR: Record<Environment, PackName[]> = {
  desert: ["rocks"],
  city: ["city"],
  forest: ["trees", "rocks"],
};

/**
 * What the packs are tinted by, per world.
 *
 * A pack belongs to one world and carries that world's colours in its textures: the boulders are
 * sandstone, because they were bought for the desert. The forest stands on the same boulders, so it
 * tints them — the material's colour multiplies its map, so the shape is shared and the colour is the
 * world's, which is the same arrangement the generated props use (`environmentLook`).
 */
const PACK_TINTS: Record<Environment, Partial<Record<PackName, string>>> = {
  desert: { rocks: "#ffffff" },
  city: { city: "#ffffff" },
  forest: { trees: "#ffffff", rocks: "#8f9d91" },
};

/** One prop out of a pack: its parts, and the footprint the layout needs. */
export type RoadsideModel = {
  id: PropId;
  /** A prop can be several meshes — a tree is a trunk and a canopy — and they all share one instance. */
  parts: { geometry: THREE.BufferGeometry; material: THREE.Material }[];
  metrics: PropMetrics;
};

const packs = new Map<PackName, Promise<RoadsideModel[]>>();

/** The bounding box of a prop's parts, which are all in the same normalised space. */
function measure(parts: RoadsideModel["parts"]): PropMetrics {
  const box = new THREE.Box3();
  const local = new THREE.Box3();
  for (const part of parts) {
    part.geometry.computeBoundingBox();
    if (part.geometry.boundingBox) box.union(local.copy(part.geometry.boundingBox));
  }
  if (box.isEmpty()) return { radius: 1, height: 1 };
  return {
    radius: Math.max(Math.abs(box.min.x), box.max.x, Math.abs(box.min.z), box.max.z),
    height: box.max.y - box.min.y,
  };
}

/**
 * Loads one pack and clones its materials for a world.
 *
 * The GLB holds one node per prop, each with the meshes the cooker merged into it, so a prop is a
 * node and its parts are what hangs off it. A prop with a single mesh comes back as a mesh rather
 * than a group, which is why this walks each node instead of reading its children.
 */
async function readPack(
  pack: PackName,
  environment: Environment,
  promise: Promise<RoadsideModel[]>,
): Promise<RoadsideModel[]> {
  const models = await promise;
  const tint = new THREE.Color(PACK_TINTS[environment][pack] ?? "#ffffff");
  return models.map((model) => ({
    ...model,
    parts: model.parts.map((part) => {
      const material = part.material.clone();
      // The material arrives white out of the cooker, so this is the world's coat over the pack's
      // own colours rather than a second thing multiplying them.
      if ("color" in material && material.color instanceof THREE.Color) material.color.copy(tint);
      return { geometry: part.geometry, material };
    }),
  }));
}

async function loadPack(pack: PackName): Promise<RoadsideModel[]> {
  const gltf = await new GLTFLoader().loadAsync(PACK_URLS[pack]);
  const models: RoadsideModel[] = [];

  /**
   * The props are the nodes that actually hold meshes, wherever they sit.
   *
   * The cooker exports one node per prop, but glTF has a single root node per scene, so a pack always
   * arrives with one wrapper above them (and a round trip through an exporter may add more). Looking
   * for the nodes that hold meshes rather than for the scene's children finds the props either way.
   */
  const collect = (node: THREE.Object3D) => {
    // A prop is the node directly above its meshes. Looking at the node's own children rather than at
    // everything below it is what tells a prop from the pack's root: the root has no meshes of its
    // own, so it recurses, and a prop that happens to hold four meshes is still one prop.
    const parts: RoadsideModel["parts"] = [];
    for (const child of node.children) {
      if (!(child instanceof THREE.Mesh) || !child.geometry) continue;
      const material = Array.isArray(child.material) ? child.material[0] : child.material;
      if (!material) continue;
      parts.push({ geometry: child.geometry, material });
    }
    if (parts.length > 0) {
      models.push({ id: node.name, parts, metrics: measure(parts) });
      return;
    }
    for (const child of node.children) collect(child);
  };
  collect(gltf.scene);
  return models;
}

/**
 * The packs a world stands on, loaded and ready.
 *
 * Returns an empty list when a pack cannot be fetched — the roadside then falls back to the shapes it
 * was drawn with before the packs existed, rather than starting the run with nothing beside the road.
 */
export async function roadsideModels(environment: Environment): Promise<RoadsideModel[]> {
  const wanted = PACKS_FOR[environment];
  const loaded = await Promise.all(
    wanted.map((pack) => {
      // Cached on the *promise*, so two worlds asking at once fetch once.
      if (!packs.has(pack)) packs.set(pack, loadPack(pack));
      return readPack(pack, environment, packs.get(pack) as Promise<RoadsideModel[]>).catch((error) => {
        console.warn(`roadside: the ${pack} props did not load — ${String(error).slice(0, 120)}`);
        return [] as RoadsideModel[];
      });
    }),
  );
  return loaded.flat();
}
