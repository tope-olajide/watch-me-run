// Diagnostic: decodes a PNG screenshot and describes its composition in text so the blend
// between the 3D road and the generated Orbis video can be judged without viewing the image.
// "Strong edges" mark photographic content (the video); flat/low-contrast areas are the road.
import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";

function decodePng(path) {
  const buffer = readFileSync(path);
  let offset = 8;
  let width = 0;
  let height = 0;
  let colorType = 0;
  let bitDepth = 0;
  const idat = [];

  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    offset += length + 12;

    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      if (data[12] !== 0) throw new Error("interlaced PNG is not supported");
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
  }

  if (bitDepth !== 8) throw new Error(`unsupported bit depth ${bitDepth}`);
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  if (!channels) throw new Error(`unsupported color type ${colorType}`);

  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const pixels = Buffer.alloc(height * stride);

  let read = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[read];
    read += 1;
    const row = raw.subarray(read, read + stride);
    read += stride;
    const out = pixels.subarray(y * stride, (y + 1) * stride);
    const previous = y > 0 ? pixels.subarray((y - 1) * stride, y * stride) : null;

    for (let x = 0; x < stride; x += 1) {
      const a = x >= channels ? out[x - channels] : 0;
      const b = previous ? previous[x] : 0;
      const c = previous && x >= channels ? previous[x - channels] : 0;
      const value = row[x];
      let result;
      switch (filter) {
        case 0: result = value; break;
        case 1: result = value + a; break;
        case 2: result = value + b; break;
        case 3: result = value + ((a + b) >> 1); break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          result = value + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default: throw new Error(`unknown filter ${filter}`);
      }
      out[x] = result & 0xff;
    }
  }

  return { width, height, channels, pixels };
}

const paths = process.argv.slice(2);
const [path] = paths;
// `--activity` takes two files of its own, so the first argument is the flag itself and there is no
// single frame to decode up front. The other modes take a path first (then their own flags), so the
// default read below still holds for them.
const { width, height, channels, pixels } =
  paths.includes("--activity") || paths.includes("--cliff")
    ? { width: 0, height: 0, channels: 0, pixels: [] }
    : decodePng(path);

/**
 * Region readout — `node tools/frame-report.mjs shot.png --region 0.35,0.72,0.65,0.92` prints the
 * tone of one rectangle, given as fractions of the frame. Used to compare the road ribbon against
 * the generated ground at the same spot in two frames captured moments apart.
 */
const regionFlag = paths.indexOf("--region");
if (regionFlag !== -1) {
  const bounds = (paths[regionFlag + 1] ?? "0,0,1,1").split(",").map(Number);
  const [x0, y0, x1, y1] = bounds;
  const left = Math.max(0, Math.floor((x0 ?? 0) * width));
  const right = Math.min(width, Math.ceil((x1 ?? 1) * width));
  const top = Math.max(0, Math.floor((y0 ?? 0) * height));
  const bottom = Math.min(height, Math.ceil((y1 ?? 1) * height));
  let sum = 0;
  let red = 0;
  let green = 0;
  let blue = 0;
  let count = 0;
  const lumas = [];
  for (let y = top; y < bottom; y += 2) {
    for (let x = left; x < right; x += 2) {
      const index = (y * width + x) * channels;
      const luma = 0.2126 * pixels[index] + 0.7152 * pixels[index + 1] + 0.0722 * pixels[index + 2];
      sum += luma;
      red += pixels[index];
      green += pixels[index + 1];
      blue += pixels[index + 2];
      lumas.push(luma);
      count += 1;
    }
  }
  lumas.sort((a, b) => a - b);
  const percentile = (p) => lumas[Math.min(lumas.length - 1, Math.floor(lumas.length * p))] ?? 0;
  console.log(`region ${x0},${y0} → ${x1},${y1} of ${path} (${width}x${height})`);
  console.log(`  mean luma ${(sum / count).toFixed(1)}   mean colour ${(red / count).toFixed(0)},${(green / count).toFixed(0)},${(blue / count).toFixed(0)}`);
  console.log(`  luma p10 ${percentile(0.1).toFixed(1)}   p50 ${percentile(0.5).toFixed(1)}   p90 ${percentile(0.9).toFixed(1)}`);
  process.exit(0);
}

/**
 * ASCII composition map — `node tools/frame-report.mjs shot.png --ascii`. A coarse luminance map of
 * the frame so a capture can be *read* in a terminal: the road is a smooth mass, the generated
 * landscape is texture, and a skyline is a run of alternating light and dark columns. `--cols` and
 * `--rows` set the grid (96x28 by default), and `--gamma` lifts the shadows (2 = honest, 0.5 = a
 * night frame opened up) — the default is 1.
 */
const asciiFlag = paths.indexOf("--ascii");
if (asciiFlag !== -1) {
  const flagValue = (name) => {
    const index = paths.indexOf(name);
    return index === -1 ? null : Number(paths[index + 1]);
  };
  const cols = flagValue("--cols") ?? 96;
  const rows = flagValue("--rows") ?? 28;
  const gamma = flagValue("--gamma") ?? 1;
  const ramp = " .:-=+*#%@";
  console.log(`ascii — ${path} (${width}x${height}, ${cols}x${rows}, gamma ${gamma})`);
  for (let row = 0; row < rows; row += 1) {
    const y0 = Math.floor((row / rows) * height);
    const y1 = Math.max(y0 + 1, Math.floor(((row + 1) / rows) * height));
    let line = "";
    for (let column = 0; column < cols; column += 1) {
      const x0 = Math.floor((column / cols) * width);
      const x1 = Math.max(x0 + 1, Math.floor(((column + 1) / cols) * width));
      let sum = 0;
      let count = 0;
      for (let y = y0; y < y1; y += 2) {
        for (let x = x0; x < x1; x += 2) {
          const index = (y * width + x) * channels;
          sum += 0.2126 * pixels[index] + 0.7152 * pixels[index + 1] + 0.0722 * pixels[index + 2];
          count += 1;
        }
      }
      const luma = sum / Math.max(1, count);
      const level = Math.pow(Math.min(1, Math.max(0, luma / 255)), gamma);
      line += ramp[Math.min(ramp.length - 1, Math.round(level * (ramp.length - 1)))];
    }
    console.log(`${String(Math.round((row / rows) * 100)).padStart(3)}% ${line}`);
  }
  process.exit(0);
}

/**
 * Skyline readout — `node tools/frame-report.mjs --cliff shot.png`. Finds the sharpest darkening step
 * between adjacent rows, the same rule `src/orbis/world-align.ts` uses to find the generated horizon.
 * Run it on a `.video.png` capture (the world layer alone, transforms and all) to check where the
 * horizon actually *lands*, rather than where the module says it lands.
 */
const cliffFlag = paths.indexOf("--cliff");
if (cliffFlag !== -1) {
  const frame = decodePng(paths[cliffFlag + 1]);
  const rows = 32;
  const brightness = [];
  for (let row = 0; row < rows; row += 1) {
    const y0 = Math.floor((row / rows) * frame.height);
    const y1 = Math.max(y0 + 1, Math.floor(((row + 1) / rows) * frame.height));
    let sum = 0;
    let count = 0;
    for (let y = y0; y < y1; y += 2) {
      for (let x = 0; x < frame.width; x += 4) {
        const index = (y * frame.width + x) * frame.channels;
        sum += 0.2126 * frame.pixels[index] + 0.7152 * frame.pixels[index + 1] + 0.0722 * frame.pixels[index + 2];
        count += 1;
      }
    }
    brightness.push(sum / count);
  }
  let best = -1;
  let bestStep = 0;
  let second = 0;
  for (let row = 1; row < rows; row += 1) {
    const step = brightness[row - 1] - brightness[row];
    if (step <= 0) continue;
    if (step > bestStep) {
      second = bestStep;
      bestStep = step;
      best = row;
    } else if (step > second) {
      second = step;
    }
  }
  console.log(`skyline — ${paths[cliffFlag + 1]} (${frame.width}x${frame.height})`);
  brightness.forEach((value, row) => {
    console.log(`${String(Math.round((row / rows) * 100)).padStart(3)}%  ${value.toFixed(1).padStart(6)}`);
  });
  console.log(
    `sharpest darkening step at ${Math.round((best / rows) * 100)}% (row ${best}), ` +
      `step ${bestStep.toFixed(1)}, next largest ${second.toFixed(1)}`,
  );
  process.exit(0);
}

/**
 * World activity profile — `node tools/frame-report.mjs --activity a.png b.png`.
 *
 * Takes two frames of the **same shot** a fraction of a second apart and measures, row by row, how
 * much each row changed. This is the premise the vertical lock rests on: the sky holds still (weather
 * drifts over seconds) while the ground scrolls toward the camera, and the scroll only gets faster
 * further down the frame, so activity is a monotone ramp whose low end is the sky. The row where it
 * lifts off the noise floor is therefore the sky/ground boundary, and unlike an edge or variance
 * measure it survives a forest whose "sky" is textured canopy and a city whose sky is dark and smooth.
 *
 * The readout is a text map so the boundary can be read off by eye, plus the row the detector in
 * `src/orbis/world-align.ts` would pick, so the two can be compared.
 */
const activityFlag = paths.indexOf("--activity");
if (activityFlag !== -1) {
  const [fileA, fileB] = paths.slice(activityFlag + 1);
  const a = decodePng(fileA);
  const b = decodePng(fileB);
  if (a.width !== b.width || a.height !== b.height) {
    console.error("frames must be the same size");
    process.exit(1);
  }

  const rows = 32;
  const luma = (frame, x, y) => {
    const index = (y * frame.width + x) * frame.channels;
    return 0.2126 * frame.pixels[index] + 0.7152 * frame.pixels[index + 1] + 0.0722 * frame.pixels[index + 2];
  };

  const profile = [];
  for (let row = 0; row < rows; row += 1) {
    const y0 = Math.floor((row / rows) * a.height);
    const y1 = Math.max(y0 + 1, Math.floor(((row + 1) / rows) * a.height));
    let sum = 0;
    let count = 0;
    for (let y = y0; y < y1; y += 2) {
      for (let x = 0; x < a.width; x += 4) {
        sum += Math.abs(luma(a, x, y) - luma(b, x, y));
        count += 1;
      }
    }
    profile.push(sum / Math.max(1, count));
  }

  // Relative to the bottom of the frame, which is always the nearest, fastest-moving ground: an
  // absolute threshold would read a dark or hazy world as entirely sky.
  const reference = profile[rows - 1];
  const ratio = profile.map((value) => (reference > 0 ? value / reference : 0));
  const glyph = (value) =>
    value < 0.05 ? "." : value < 0.12 ? ":" : value < 0.25 ? "+" : value < 0.45 ? "*" : value < 0.7 ? "#" : "@";

  console.log(`world activity — ${fileA} → ${fileB} (${a.width}x${a.height})`);
  console.log(`bottom-band mean |Δluma| ${reference.toFixed(1)} (the reference)`);
  console.log("row   ratio  map");
  ratio.forEach((value, row) => {
    console.log(`${String(Math.round((row / rows) * 100)).padStart(3)}%  ${value.toFixed(3)}  ${glyph(value)}`);
  });

  // The same rule the lock uses: the highest row whose activity clears a fraction of the bottom's.
  const SHARE = 0.15;
  let first = -1;
  for (let row = 0; row < rows; row += 1) {
    if (ratio[row] >= SHARE) {
      first = row;
      break;
    }
  }
  console.log(
    first === -1
      ? `no row clears ${SHARE} of the bottom band — the frame looks frozen`
      : `detector would pick row ${Math.round((first / rows) * 100)}% (first row ≥ ${SHARE} of the bottom band)`,
  );
  process.exit(0);
}

/** Band table for several frames at once, used to diff the composite against its layers. */
if (paths.length > 1) {
  const bands = 12;
  const tables = paths.map((file) => {
    const frame = decodePng(file);
    const rows = [];
    const lumaOf = (x, y) => {
      const index = (y * frame.width + x) * frame.channels;
      return 0.2126 * frame.pixels[index] + 0.7152 * frame.pixels[index + 1] + 0.0722 * frame.pixels[index + 2];
    };
    for (let band = 0; band < bands; band += 1) {
      const y0 = Math.floor((band / bands) * frame.height);
      const y1 = Math.floor(((band + 1) / bands) * frame.height);
      let sum = 0;
      let count = 0;
      for (let y = y0; y < y1; y += 2) {
        for (let x = 0; x < frame.width; x += 2) {
          sum += lumaOf(x, y);
          count += 1;
        }
      }
      rows.push(sum / count);
    }
    return rows;
  });

  console.log("band means (0 = top of frame):");
  console.log("band   composite   3d only   video only   |c-3d| (video visible)   |c-video| (3d visible)");
  for (let band = 0; band < bands; band += 1) {
    const composite = tables[0][band];
    const withoutVideo = tables[1] ? tables[1][band] : composite;
    const videoOnly = tables[2] ? tables[2][band] : composite;
    console.log(
      `${String(Math.round((band / bands) * 100)).padStart(3)}%   ` +
      `${composite.toFixed(1).padStart(9)}   ${withoutVideo.toFixed(1).padStart(8)}   ${videoOnly.toFixed(1).padStart(10)}   ` +
      `${Math.abs(composite - withoutVideo).toFixed(1).padStart(20)}   ${Math.abs(composite - videoOnly).toFixed(1).padStart(18)}`,
    );
  }

  // Band means only describe brightness. "Is the generated world visible here?" needs a detail
  // measure, so the first two frames are compared tile by tile: mean difference between them and
  // the share of strong gradients in each tile.
  if (paths.length > 1) {
    const frames = paths.slice(0, 2).map((file) => decodePng(file));
    const dims = frames.map((frame) => ({
      width: frame.width,
      height: frame.height,
      channels: frame.channels,
      pixels: frame.pixels,
    }));
    if (dims[0].width === dims[1].width && dims[0].height === dims[1].height) {
      const cols = 8;
      const rows = 5;
      const tileW = Math.floor(dims[0].width / cols);
      const tileH = Math.floor(dims[0].height / rows);
      const luma = (frame, x, y) => {
        const index = (y * frame.width + x) * frame.channels;
        return 0.2126 * frame.pixels[index] + 0.7152 * frame.pixels[index + 1] + 0.0722 * frame.pixels[index + 2];
      };
      const tile = (frame, cx, cy) => {
        let diff = 0;
        let detail = 0;
        let count = 0;
        for (let y = cy * tileH; y < (cy + 1) * tileH - 1; y += 2) {
          for (let x = cx * tileW; x < (cx + 1) * tileW - 1; x += 2) {
            diff += Math.abs(luma(frames[0], x, y) - luma(frames[1], x, y));
            detail += Math.abs(luma(frame, x, y) - luma(frame, x + 1, y));
            count += 1;
          }
        }
        return { diff: diff / count, detail: detail / count };
      };

      console.log(`\ntiles (${cols}x${rows}) — top number: mean difference between the two frames,`);
      console.log("bottom number: detail (mean neighbour contrast) in the first frame:");
      for (let cy = 0; cy < rows; cy += 1) {
        const diffs = [];
        const details = [];
        for (let cx = 0; cx < cols; cx += 1) {
          const stats = tile(frames[0], cx, cy);
          diffs.push(stats.diff.toFixed(1).padStart(6));
          details.push(stats.detail.toFixed(1).padStart(6));
        }
        console.log(`${String(Math.round(((cy + 0.5) / rows) * 100)).padStart(3)}% ${diffs.join("")}`);
        console.log(`     ${details.join("")}`);
      }
    }
  }
  process.exit(0);
}

const sample = (x, y) => {
  const index = (y * width + x) * channels;
  return [pixels[index], pixels[index + 1], pixels[index + 2]];
};
const lumaAt = (x, y) => {
  const [r, g, b] = sample(x, y);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
/** Strong gradients mark photographic content; the road's grain stays under this. */
const EDGE_THRESHOLD = 34;

function cellStats(x0, y0, x1, y1) {
  let edges = 0;
  let r = 0;
  let g = 0;
  let b = 0;
  let count = 0;
  for (let y = y0; y < y1 - 1; y += 1) {
    for (let x = x0; x < x1 - 1; x += 1) {
      const [pr, pg, pb] = sample(x, y);
      r += pr; g += pg; b += pb;
      count += 1;
      const here = lumaAt(x, y);
      if (Math.abs(here - lumaAt(x + 1, y)) > EDGE_THRESHOLD) edges += 1;
      else if (Math.abs(here - lumaAt(x, y + 1)) > EDGE_THRESHOLD) edges += 1;
    }
  }
  return {
    edges: edges / Math.max(1, count),
    color: [r / count, g / count, b / count],
  };
}

const COLUMNS = 64;
const ROWS = 30;
const cellW = width / COLUMNS;
const cellH = height / ROWS;

function hueLetter([r, g, b]) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const saturation = max === 0 ? 0 : (max - min) / max;
  if (max < 42) return "k";
  if (saturation < 0.12) return max > 150 ? "W" : "d";
  if (r >= g && r >= b) return g > b * 1.15 ? "y" : "r";
  if (g >= r && g >= b) return b > r ? "c" : "g";
  return r > g ? "m" : "b";
}

const edgeRows = [];
const hueRows = [];
let worldCells = 0;
let totalCells = 0;
let upperWorld = 0;
let upperTotal = 0;

for (let row = 0; row < ROWS; row += 1) {
  let edgeLine = "";
  let hueLine = "";
  for (let column = 0; column < COLUMNS; column += 1) {
    const stats = cellStats(
      Math.floor(column * cellW),
      Math.floor(row * cellH),
      Math.floor((column + 1) * cellW),
      Math.floor((row + 1) * cellH),
    );
    const photographic = stats.edges > 0.022;
    edgeLine += photographic ? "#" : stats.edges > 0.008 ? "+" : ".";
    hueLine += hueLetter(stats.color);
    totalCells += 1;
    if (photographic) worldCells += 1;
    if (row < ROWS * 0.7) {
      upperTotal += 1;
      if (photographic) upperWorld += 1;
    }
  }
  edgeRows.push(edgeLine);
  hueRows.push(hueLine);
}

console.log(`frame: ${path}  (${width}x${height})`);
console.log("\nedge map — '#' photographic (video visible), '+' some detail, '.' flat surface:");
edgeRows.forEach((line, row) => {
  console.log(`${String(Math.round(((row + 1) / ROWS) * 100)).padStart(3)}% ${line}`);
});
console.log("\nhue map — r/y/g/c/b/m hues, 'k' dark, 'd' desaturated, 'W' bright:");
hueRows.forEach((line, row) => {
  console.log(`${String(Math.round(((row + 1) / ROWS) * 100)).padStart(3)}% ${line}`);
});

console.log(`\nworld visible: ${((worldCells / totalCells) * 100).toFixed(1)}% of the frame`);
console.log(`world visible (upper 70%): ${((upperWorld / upperTotal) * 100).toFixed(1)}%`);
