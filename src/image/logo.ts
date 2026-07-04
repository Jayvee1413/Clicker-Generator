import * as THREE from 'three';
import { SVGLoader } from 'three/examples/jsm/loaders/SVGLoader.js';
import type { RegionSet, Ring, RGB } from '../types';

const DEFAULT_INK: RGB = [22, 22, 22];

function parseColor(colorStr: string): RGB {
  if (!colorStr || colorStr === 'currentColor') return DEFAULT_INK;
  try {
    const c = new THREE.Color(colorStr);
    return [Math.round(c.r * 255), Math.round(c.g * 255), Math.round(c.b * 255)];
  } catch {
    return DEFAULT_INK;
  }
}

/** Convert an SVG length (px, pt, mm, in, em) to user units. */
function parseLength(val: string | undefined, fallback: number): number {
  if (!val) return fallback;
  const m = val.trim().match(/^(-?\d+(?:\.\d+)?)(px|pt|mm|cm|in|em|ex|%)?$/);
  if (!m) return fallback;
  const n = parseFloat(m[1]);
  const unit = (m[2] || 'px').toLowerCase();
  switch (unit) {
    case 'px':
      return n;
    case 'pt':
      return n * 1.333333;
    case 'mm':
      return n * 3.779528;
    case 'cm':
      return n * 37.79528;
    case 'in':
      return n * 96;
    case 'em':
    case 'ex':
      return n * 16;
    case '%':
      return n * 0.01;
    default:
      return n;
  }
}

function resolveStyle(path: any): Record<string, any> {
  return path.userData?.style || {};
}

function sampleStrokeWidth(style: any): number {
  if (!style) return 1;
  const candidates = [style.strokeWidth, style['stroke-width']];
  for (const v of candidates) {
    if (v !== undefined) return parseLength(String(v), 1);
  }
  return 1;
}

function strokeGeomToContours(geom: THREE.BufferGeometry): Ring[] {
  const pos = geom.getAttribute('position');
  if (!pos) return [];
  const idx = geom.getIndex();
  const contours: Ring[] = [];

  const getTri = idx
    ? (t: number) => [idx.array[t * 3], idx.array[t * 3 + 1], idx.array[t * 3 + 2]]
    : (t: number) => [t * 3, t * 3 + 1, t * 3 + 2];

  const nTris = (idx ? idx.array.length : pos.count) / 3;
  for (let t = 0; t < nTris; t++) {
    const [ia, ib, ic] = getTri(t);
    const ax = pos.getX(ia),
      ay = pos.getY(ia);
    const bx = pos.getX(ib),
      by = pos.getY(ib);
    const cx = pos.getX(ic),
      cy = pos.getY(ic);

    const area = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay);
    if (Math.abs(area) < 1e-12) continue;

    if (area > 0) {
      contours.push([
        [ax, ay],
        [bx, by],
        [cx, cy],
      ]);
    } else {
      contours.push([
        [ax, ay],
        [cx, cy],
        [bx, by],
      ]);
    }
  }
  return contours;
}

export function parseSvg(svgText: string): RegionSet {
  const data = new SVGLoader().parse(svgText);
  const box = new THREE.Box2(new THREE.Vector2(Infinity, Infinity), new THREE.Vector2(-Infinity, -Infinity));

  const groups = new Map<string, { rgb: RGB; rings: Ring[] }>();

  function addRings(rgb: RGB, rings: Ring[]) {
    const hex = rgb.map((v) => v.toString(16).padStart(2, '0')).join('');
    let g = groups.get(hex);
    if (!g) {
      g = { rgb, rings: [] };
      groups.set(hex, g);
    }
    g.rings.push(...rings);
  }

  for (const path of data.paths) {
    const style = resolveStyle(path);
    const hasFill = style.fill && style.fill !== 'none';
    const hasStroke = style.stroke && style.stroke !== 'none';

    // Filled paths: keep curves with higher point density and preserve holes.
    if (hasFill) {
      const rgb = parseColor(style.fill);
      const shapes = SVGLoader.createShapes(path);
      for (const shape of shapes) {
        const points = shape.getPoints(48);
        if (points.length >= 3) {
          if (THREE.ShapeUtils.isClockWise(points)) points.reverse();
          const ring: Ring = [];
          for (const p of points) {
            box.expandByPoint(p);
            ring.push([p.x, p.y]);
          }
          addRings(rgb, [ring]);
        }
        for (const hole of shape.holes) {
          const hp = hole.getPoints(48);
          if (hp.length >= 3) {
            if (!THREE.ShapeUtils.isClockWise(hp)) hp.reverse();
            const ring: Ring = [];
            for (const p of hp) {
              box.expandByPoint(p);
              ring.push([p.x, p.y]);
            }
            addRings(rgb, [ring]);
          }
        }
      }
    }

    // Stroke-only paths: respect stroke width + linecap/join, and convert
    // into filled rings so they print as a solid color strip.
    if (hasStroke && !hasFill) {
      const rgb = parseColor(style.stroke);
      const width = sampleStrokeWidth(style);
      const lineCap = style.strokeLineCap || style['stroke-linecap'] || 'butt';
      const lineJoin = style.strokeLineJoin || style['stroke-linejoin'] || 'miter';
      const miterLimit = parseFloat(style.strokeMiterLimit || style['stroke-miterlimit'] || '4');
      const strokeStyle = SVGLoader.getStrokeStyle(width, style.stroke, lineCap, lineJoin, miterLimit);
      for (const sub of path.subPaths) {
        const pts = sub.getPoints(48);
        if (pts.length < 2) continue;
        const geom = SVGLoader.pointsToStroke(pts, strokeStyle);
        if (!geom) continue;
        const pos = geom.getAttribute('position');
        if (!pos || pos.count === 0) continue;
        for (let i = 0; i < pos.count; i++) {
          box.expandByPoint(new THREE.Vector2(pos.getX(i), pos.getY(i)));
        }
        const strokeRings = strokeGeomToContours(geom);
        addRings(rgb, strokeRings);
        geom.dispose();
      }
    }
  }

  const allRings: Ring[] = [];
  groups.forEach((g) => allRings.push(...g.rings));

  if (allRings.length === 0) {
    throw new Error('No drawable paths found in this SVG.');
  }

  const cx = (box.min.x + box.max.x) / 2;
  const cy = (box.min.y + box.max.y) / 2;
  const dx = box.max.x - box.min.x;
  const dy = box.max.y - box.min.y;
  const maxSide = Math.max(dx, dy) || 1;
  const aspect = dy !== 0 ? dx / dy : 1;

  const normalizeRing = (r: Ring): Ring =>
    r.map(([x, y]) => [(x - cx) / maxSide, -(y - cy) / maxSide]);

  const totalPoints = allRings.reduce((sum, r) => sum + r.length, 0);

  const regions = Array.from(groups.values()).map((g) => {
    const normRings = g.rings.map(normalizeRing);
    const ringPoints = g.rings.reduce((sum, r) => sum + r.length, 0);
    return {
      quantRgb: g.rgb,
      components: [{ rings: normRings, coverage: ringPoints / totalPoints }],
      coverage: ringPoints / totalPoints,
    };
  });

  const outline = allRings.map(normalizeRing);

  return { regions, outline, aspect };
}
