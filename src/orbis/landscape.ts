import { GAME_HORIZON, PICTURE_BAND, findSkyline, sampleRowBrightness } from "./skyline";

/**
 * Turning a picture the player uploaded into a landscape the game can actually be run in.
 *
 * The problem this solves is not "make it look nice" — it is the same one the runtime lock exists
 * for, one level up. The game camera's horizon sits ~44% down the frame and the road ribbon dissolves
 * into the video at ~50%, so the two layers only meet in that band. A generated world whose horizon
 * is somewhere else leaves the road hanging in sky.
 *
 * Generating a world from an arbitrary picture makes that worse, not better: the model inherits the
 * picture's composition, so a photo with its horizon at 75% hands us a world whose road floats and a
 * ground the player is running *under*. Measuring that at runtime and dragging it back up needs
 * overscan the player pays for in every frame, and it can only ever correct in one direction.
 *
 * So the picture is prepared before it is ever sent: its horizon is measured with the same rule the
 * runtime lock uses, and it is cropped so that horizon lands on the game's line. The model then grows
 * a world that already rhymes with the game — sky above the game's sky line, ground under the game's
 * road — and the lock is left with nothing to do.
 *
 * ## The crop
 *
 * Always a cover crop: scaled so the picture fills the frame, then positioned. The scale is the
 * *smallest* one that both covers the frame and allows the horizon to sit where it is wanted, so a
 * picture whose horizon is already near the line is barely touched — only the part sticking out past
 * the frame is lost, and it is lost from the side away from the horizon.
 *
 * Two consequences worth stating plainly. A portrait photo is cropped hard, because there is no
 * version of a 16:9 frame that shows all of one. And a picture with no clear horizon in it is not
 * guessed at: it is centred on its cover crop and reported as such, rather than having some arbitrary
 * edge declared a horizon and half the picture cropped away to honour it.
 */

/** The frame the model is handed. 16:9 because every delivery tier is (1080p, 2k, 4k), and 1280 wide
 * because the model fits it to its own canvas regardless — a bigger upload only uploads slower. */
export const LANDSCAPE_WIDTH = 1280;
export const LANDSCAPE_HEIGHT = 720;

/** Refused above this. A phone photo is a few MB; anything past this is not a photo. */
export const LANDSCAPE_MAX_BYTES = 14 * 1024 * 1024;

export type PreparedLandscape = {
  /** Identity, so a world can tell this landscape from another and from no landscape at all. */
  id: string;
  /** The prepared, horizon-aligned frame, ready to upload to the session. */
  blob: Blob;
  /** The same frame as a small data URL, for the menu to show exactly what will be sent. */
  preview: string;
  /** The file's name, trimmed, for the interface to name it by. */
  label: string;
  /** Where the horizon sat in the player's own picture, or null when none was clear. */
  sourceHorizon: number | null;
  /** True when that horizon was placed on the game's line; false when the picture was just centred. */
  placed: boolean;
  /**
   * A seed derived from the prepared pixels, so the same picture opens the same world twice.
   *
   * Orbis never draws its own seed and only reads one when `start` fires, so this is what makes
   * "my landscape" a place rather than a new performance every time. It is a hash of the frame as it
   * will be sent, so two pictures that differ produce two worlds.
   */
  seed: number;
  width: number;
  height: number;
};

/** A failure the interface can put in front of the player without translating it. */
export class LandscapeError extends Error {}

/**
 * The scale and offset that put a source image's horizon on the game's line.
 *
 * Solved in destination pixels, then handed to `drawImage` directly — the negative offsets are the
 * cropping, and the browser clips them. Deriving it as a closed form rather than iterating keeps it
 * exact: the horizon lands on the line rather than near it.
 */
function placement(
  sourceWidth: number,
  sourceHeight: number,
  horizon: number | null,
): { scale: number; x: number; y: number } {
  const cover = Math.max(LANDSCAPE_WIDTH / sourceWidth, LANDSCAPE_HEIGHT / sourceHeight);
  if (horizon === null) {
    // No horizon to honour: cover, centred. Nothing is gratuitously lost.
    const scale = cover;
    return {
      scale,
      x: (LANDSCAPE_WIDTH - sourceWidth * scale) / 2,
      y: (LANDSCAPE_HEIGHT - sourceHeight * scale) / 2,
    };
  }

  // The smallest scale at which the horizon *can* be placed, from two constraints: the picture must
  // reach down to the wanted line (so the horizon's own row can be pushed up to it) and must still
  // cover the frame's bottom edge below that.
  const wanted = GAME_HORIZON;
  const scale = Math.max(
    cover,
    (wanted * LANDSCAPE_HEIGHT) / (horizon * sourceHeight),
    ((1 - wanted) * LANDSCAPE_HEIGHT) / ((1 - horizon) * sourceHeight),
  );

  return {
    scale,
    // Centred horizontally: the horizon is a vertical constraint, and the sides are where a 16:9
    // frame's extra width comes from — cropping them symmetrically keeps the subject in the middle.
    x: (LANDSCAPE_WIDTH - sourceWidth * scale) / 2,
    y: wanted * LANDSCAPE_HEIGHT - horizon * sourceHeight * scale,
  };
}

/** Decodes the file, or throws something worth showing. */
async function decode(file: File): Promise<CanvasImageSource & { width: number; height: number }> {
  if (!file.type.startsWith("image/")) {
    throw new LandscapeError("That file is not an image.");
  }
  if (file.size > LANDSCAPE_MAX_BYTES) {
    throw new LandscapeError("That image is too large — try one under 14 MB.");
  }

  if (typeof createImageBitmap === "function") {
    try {
      return await createImageBitmap(file);
    } catch {
      // A format the browser cannot decode as a bitmap (some HEIC builds) can still sometimes be
      // painted by an `<img>`, so it is worth the second attempt rather than failing here.
    }
  }

  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    return image;
  } catch {
    throw new LandscapeError("That image could not be read — try a JPEG or PNG.");
  } finally {
    URL.revokeObjectURL(url);
  }
}

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob);
        else reject(new LandscapeError("That image could not be prepared for upload."));
      },
      "image/jpeg",
      0.92,
    );
  });
}

/** FNV-1a over the frame's own row brightness: stable for a picture, different for two pictures. */
function seedFrom(rows: number[]): number {
  let hash = 0x811c9dc5;
  for (const value of rows) {
    hash ^= Math.round(value) & 0xff;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % 2_147_483_647;
}

/** The copy the menu shows about what was done to the picture. */
export function landscapeNote(landscape: PreparedLandscape): string {
  if (!landscape.placed || landscape.sourceHorizon === null) {
    return "No clear horizon found — centred on the frame";
  }
  const source = Math.round(landscape.sourceHorizon * 100);
  return `Horizon found at ${source}% — placed on the game's horizon line`;
}

/**
 * Prepares an uploaded picture as a landscape, off the render path.
 *
 * Everything here is canvas work in the page, so the menu can show the result — and the player can
 * see the crop they are about to run in — before a session is asked for a single frame.
 */
export async function prepareLandscape(file: File): Promise<PreparedLandscape> {
  const source = await decode(file);

  const raster = document.createElement("canvas");
  const rows = sampleRowBrightness(source, raster);
  if (!rows) throw new LandscapeError("That image could not be measured.");

  // The wide band: an uploaded picture is not one of our generated worlds, and a horizon low in the
  // frame is the case this whole module exists for. Refusing to look for it would be the one failure
  // that makes the upload pointless.
  const skyline = findSkyline(rows, PICTURE_BAND);

  const canvas = document.createElement("canvas");
  canvas.width = LANDSCAPE_WIDTH;
  canvas.height = LANDSCAPE_HEIGHT;
  const context = canvas.getContext("2d");
  if (!context) throw new LandscapeError("That image could not be prepared for upload.");
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";

  const { scale, x, y } = placement(source.width, source.height, skyline?.horizon ?? null);
  // Rounded to whole destination pixels: the offsets are the crop, and half a pixel of interpolation
  // across the whole frame is a softer picture for no gain. Rounding moves the placed horizon by less
  // than 0.1% of the frame.
  context.drawImage(
    source,
    Math.round(x),
    Math.round(y),
    source.width * scale,
    source.height * scale,
  );

  const preparedRows = sampleRowBrightness(canvas, raster);

  const previewCanvas = document.createElement("canvas");
  previewCanvas.width = 384;
  previewCanvas.height = 216;
  previewCanvas.getContext("2d")?.drawImage(canvas, 0, 0, 384, 216);

  const id = `${file.name}:${file.size}:${file.lastModified}:${skyline?.horizon ?? "none"}`;
  return {
    id,
    blob: await canvasToBlob(canvas),
    preview: previewCanvas.toDataURL("image/jpeg", 0.8),
    label: file.name.replace(/\.[^.]+$/, "").slice(0, 40) || "Your landscape",
    sourceHorizon: skyline?.horizon ?? null,
    placed: Boolean(skyline),
    seed: seedFrom(preparedRows ?? rows),
    width: LANDSCAPE_WIDTH,
    height: LANDSCAPE_HEIGHT,
  };
}
