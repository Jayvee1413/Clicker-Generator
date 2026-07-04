// Image -> normalized RegionSet. Orchestrates matte + quantize + trace.
import type { RgbaImage } from './decode';
import { removeBackground } from './matte';
import { quantize } from './quantize';
import { traceRegions } from './trace';
import { traceRegionsPotrace } from './potraceTrace';
import type { RegionSet, RGB, TraceEngine } from '../types';

export interface ProcessOptions {
  /** Strip a flat background by edge flood-fill (skipped if image has alpha). */
  removeBg?: boolean;
  /** Edge smoothing strength, 0..1 (higher = smoother contours). */
  smoothing?: number;
  customColors?: RGB[];
  /** Which tracing engine to use. */
  engine?: TraceEngine;
}

export function processImage(
  img: RgbaImage,
  colorCount: number,
  opts: ProcessOptions = {},
): RegionSet {
  if (opts.removeBg !== false) removeBackground(img);
  const q = quantize(img, colorCount, opts.customColors);
  if (opts.engine === 'potrace') {
    return traceRegionsPotrace(q, { smoothing: opts.smoothing });
  }
  return traceRegions(q, opts.smoothing ?? 0.5);
}
