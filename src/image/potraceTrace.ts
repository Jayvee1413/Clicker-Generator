// Potrace-based image tracing: produces much cleaner, curve-accurate outlines
// than marching-squares contouring, and handles holes correctly via even-odd fill.
// Output is normalized to unit bbox, centered, Y-up, matching the rest of the app.
import {
  Bitmap,
  traceBitmap,
  getPaths,
  type Path,
} from '@cadit-app/potrace-ts';
import type { QuantizeResult } from './quantize';
import type { RegionSet, Ring, RGB } from '../types';

export interface TraceOpts {
  /** Higher = more smoothing (0..1). */
  smoothing?: number;
  /** Minimum area (as a fraction of image area) to keep a traced island. */
  minAreaFrac?: number;
}

export function traceRegionsPotrace(
  q: QuantizeResult,
  opts: TraceOpts = {},
): RegionSet {
  const { indices, width, height, palette } = q;
  const smoothing = Math.max(0, Math.min(1, opts.smoothing ?? 0.5));
  const minAreaFrac = Math.max(0, opts.minAreaFrac ?? 0.00008);

  // Foreground bbox for normalization.
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (indices[y * width + x] >= 0) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (!isFinite(minX)) {
    return { regions: [], outline: [], aspect: 1 };
  }
  const bw = maxX - minX + 1;
  const bh = maxY - minY + 1;
  const maxSide = Math.max(bw, bh);
  const cx = (minX + maxX + 1) / 2;
  const cy = (minY + maxY + 1) / 2;

  const norm = (p: [number, number]): [number, number] => [
    (p[0] - cx) / maxSide,
    -(p[1] - cy) / maxSide, // flip Y -> Y-up
  ];

  // Blur argmax tiling: smoother shared boundaries, no gaps.
  const K = palette.length;
  const fields: Float64Array[] = [];
  for (let k = 0; k < K; k++) {
    const m = new Float64Array(width * height);
    for (let p = 0; p < indices.length; p++) if (indices[p] === k) m[p] = 1;
    fields.push(boxBlur(m, width, height, 1.4));
  }
  const label = new Int16Array(width * height).fill(-1);
  for (let p = 0; p < indices.length; p++) {
    if (indices[p] < 0) continue;
    let best = 0;
    let bestV = -1;
    for (let k = 0; k < K; k++) {
      const v = fields[k][p];
      if (v > bestV) {
        bestV = v;
        best = k;
      }
    }
    label[p] = best;
  }

  const minAreaPx = minAreaFrac * width * height;

  // Potrace options tuned by smoothing slider.
  // Smoothing mainly drives curve optimization and corner threshold.
  const optTolerance = 0.04 + smoothing * 0.9;
  const alphamax = 0.25 + (1 - smoothing) * 1.1; // low smoothing = sharper corners
  const turdsize = 1 + Math.round((1 - smoothing) * 5);

  const potraceOptions = {
    turnpolicy: 'right' as const,
    turdsize,
    optcurve: true,
    alphamax,
    opttolerance: optTolerance,
  };

  // Trace a binary mask and return normalized rings grouped by path.
  const traceMask = (mask: Uint8Array): Ring[] => {
    const bitmap = new Bitmap(width, height);
    for (let i = 0; i < mask.length; i++) bitmap.data[i] = mask[i] ? 1 : 0;
    let paths: Path[];
    try {
      paths = traceBitmap(bitmap, potraceOptions);
    } catch {
      return [];
    }

    // Filter tiny specks.
    paths = paths.filter((p) => Math.abs(p.area) >= minAreaPx);
    if (paths.length === 0) return [];

    const segments = getPaths(paths);
    const rings: Ring[] = [];
    for (const seg of segments) {
      if (seg.length < 3) continue;
      const ring: [number, number][] = [];
      let current: [number, number] | null = null;
      for (const s of seg) {
        if (s.type === 'POINT') {
          current = [s.x, s.y];
          ring.push(current);
        } else if (current) {
          // Approximate cubic bezier with a few points so downstream geometry
          // (Manifold CrossSection) sees smooth curves without importing an SVG.
          const steps = 4;
          for (let t = 1; t <= steps; t++) {
            const tt = t / steps;
            ring.push(cubicBezier(current, [s.x1, s.y1], [s.x2, s.y2], [s.x, s.y], tt));
          }
          current = [s.x, s.y];
        }
      }
      // Close the ring if needed.
      if (ring.length > 1 && (ring[0][0] !== ring[ring.length - 1][0] || ring[0][1] !== ring[ring.length - 1][1])) {
        ring.push([ring[0][0], ring[0][1]]);
      }
      if (ring.length >= 3) {
        rings.push(ring.map(norm));
      }
    }
    return rings;
  };

  const regions: RegionSet['regions'] = [];
  for (let k = 0; k < K; k++) {
    const mask = new Uint8Array(width * height);
    for (let p = 0; p < label.length; p++) mask[p] = label[p] === k ? 1 : 0;
    const rings = traceMask(mask);
    if (rings.length === 0) continue;
    regions.push({
      quantRgb: palette[k].rgb as RGB,
      components: [{ rings, coverage: palette[k].coverage }],
      coverage: palette[k].coverage,
    });
  }

  // Overall silhouette.
  const fgMask = new Uint8Array(width * height);
  for (let p = 0; p < indices.length; p++) fgMask[p] = indices[p] >= 0 ? 1 : 0;
  const outline = traceMask(fgMask);

  return { regions, outline, aspect: bw / bh };
}

function cubicBezier(
  p0: [number, number],
  p1: [number, number],
  p2: [number, number],
  p3: [number, number],
  t: number,
): [number, number] {
  const u = 1 - t;
  const u2 = u * u;
  const u3 = u2 * u;
  const t2 = t * t;
  const t3 = t2 * t;
  return [
    u3 * p0[0] + 3 * u2 * t * p1[0] + 3 * u * t2 * p2[0] + t3 * p3[0],
    u3 * p0[1] + 3 * u2 * t * p1[1] + 3 * u * t2 * p2[1] + t3 * p3[1],
  ];
}

/** Separable box blur over a w×h field (radius in px, fractional ok). */
function boxBlur(src: Float64Array, w: number, h: number, radius: number): Float64Array {
  const r = Math.max(1, Math.round(radius));
  const tmp = new Float64Array(w * h);
  const out = new Float64Array(w * h);
  const norm = 1 / (2 * r + 1);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let sum = 0;
    for (let x = -r; x <= r; x++) sum += src[row + clampI(x, 0, w - 1)];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = sum * norm;
      sum += src[row + clampI(x + r + 1, 0, w - 1)] - src[row + clampI(x - r, 0, w - 1)];
    }
  }
  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let y = -r; y <= r; y++) sum += tmp[clampI(y, 0, h - 1) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = sum * norm;
      sum += tmp[clampI(y + r + 1, 0, h - 1) * w + x] - tmp[clampI(y - r, 0, h - 1) * w + x];
    }
  }
  return out;
}

function clampI(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
