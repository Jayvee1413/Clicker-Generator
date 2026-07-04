// Author a 3MF that loads as a SINGLE object with N pre-colored, mating parts —
// the format the keycap generator uses, so Bambu Studio / OrcaSlicer import it
// clean with each part on its own filament slot. See DEV_PLAN.md §7.
//
//  - Each part is its own <object> (ids 2..N+1); a <components> wrapper (id N+2)
//    references them all -> "one object, N parts".
//  - <basematerials> gives spec-compliant slicers (PrusaSlicer) a color hint.
//  - Bambu/Orca read Metadata/model_settings.config, where each part maps to a
//    1-based filament slot (`extruder`). Parts sharing a color share a slot.
import { zipSync, strToU8 } from 'fflate';
import type { ClickerPart, PartGroup, RGB } from '../types';

const f = (n: number): string => String(Math.round(n * 1e4) / 1e4);

function hex(rgb: RGB): string {
  const h = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return `#${h(rgb[0])}${h(rgb[1])}${h(rgb[2])}FF`;
}

/** Stable 1-based filament slot per unique color, in first-seen order. */
function assignExtruders(parts: ClickerPart[]): number[] {
  const slotByColor = new Map<string, number>();
  return parts.map((p) => {
    const key = p.colorRgb.join(',');
    let slot = slotByColor.get(key);
    if (slot === undefined) {
      slot = slotByColor.size + 1;
      slotByColor.set(key, slot);
    }
    return p.extruder ?? slot;
  });
}

function meshXml(p: ClickerPart, minZ: number): string {
  const np = p.numProp;
  const vp = p.vertProperties;
  const tv = p.triVerts;
  const verts: string[] = [];
  for (let i = 0; i < vp.length; i += np) {
    verts.push(`<vertex x="${f(vp[i])}" y="${f(vp[i + 1])}" z="${f(vp[i + 2] - minZ)}"/>`);
  }
  const tris: string[] = [];
  for (let i = 0; i < tv.length; i += 3) {
    tris.push(`<triangle v1="${tv[i]}" v2="${tv[i + 1]}" v3="${tv[i + 2]}"/>`);
  }
  return `<mesh><vertices>${verts.join('')}</vertices><triangles>${tris.join('')}</triangles></mesh>`;
}

/** Axis-aligned bounding box for a set of parts (after the minZ shift). */
function groupBBox(
  parts: ClickerPart[],
  groupId: PartGroup,
  minZ: number,
): { minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number } {
  let bMinX = Infinity, bMaxX = -Infinity;
  let bMinY = Infinity, bMaxY = -Infinity;
  let bMinZ = Infinity, bMaxZ = -Infinity;
  for (const p of parts) {
    if (p.group !== groupId) continue;
    const np = p.numProp;
    const vp = p.vertProperties;
    for (let i = 0; i < vp.length; i += np) {
      const x = vp[i], y = vp[i + 1], z = vp[i + 2] - minZ;
      if (x < bMinX) bMinX = x;
      if (x > bMaxX) bMaxX = x;
      if (y < bMinY) bMinY = y;
      if (y > bMaxY) bMaxY = y;
      if (z < bMinZ) bMinZ = z;
      if (z > bMaxZ) bMaxZ = z;
    }
  }
  return { minX: bMinX, maxX: bMaxX, minY: bMinY, maxY: bMaxY, minZ: bMinZ, maxZ: bMaxZ };
}

/**
 * Build a 3×4 affine transform string for a 3MF `<item transform="...">`.
 * Row-major: m00 m01 m02 m10 m11 m12 m20 m21 m22 m30 m31 m32
 * (the 3MF spec stores it as 12 floats: columns of the 4×3 matrix, but the
 *  attribute is written as "m00 m01 m02 m10 m11 m12 m20 m21 m22 m30 m31 m32".)
 */
function transformAttr(
  m00: number, m01: number, m02: number,
  m10: number, m11: number, m12: number,
  m20: number, m21: number, m22: number,
  tx: number, ty: number, tz: number,
): string {
  return ` transform="${[m00, m01, m02, m10, m11, m12, m20, m21, m22, tx, ty, tz].map(f).join(' ')}"`;
}

export interface ThreeMFExportOptions {
  orientation?: 'faceDown' | 'faceUp' | 'asPreview';
  gap?: number;
}

export function buildThreeMF(parts: ClickerPart[], options: ThreeMFExportOptions = {}): Uint8Array {
  const orientation = options.orientation ?? 'faceDown';
  const GAP_MM = options.gap ?? 5;

  // Drop the whole assembly onto the build plate (min Z -> 0), keeping relative
  // positions.
  let minZ = Infinity;
  for (const p of parts) {
    for (let i = 2; i < p.vertProperties.length; i += p.numProp) {
      if (p.vertProperties[i] < minZ) minZ = p.vertProperties[i];
    }
  }
  if (!isFinite(minZ)) minZ = 0;

  const extruders = assignExtruders(parts);

  // Two movable objects, each a <components> wrapper over its colored sub-parts,
  // so the slicer lets you orient "clicker top" and "clicker base" independently.
  const groups: { id: PartGroup; label: string }[] = [
    { id: 'top', label: 'clicker_top' },
    { id: 'base', label: 'clicker_base' },
  ].filter((g) => parts.some((p) => p.group === g.id)) as { id: PartGroup; label: string }[];

  const baseMaterials = parts
    .map((p) => `<base name="${p.name}" displaycolor="${hex(p.colorRgb)}"/>`)
    .join('');
  const leafObjects = parts
    .map((p, i) => `<object id="${i + 2}" type="model" pid="1" pindex="${i}">${meshXml(p, minZ)}</object>`)
    .join('');

  const firstWrapperId = parts.length + 2;
  const wrapperObjects = groups
    .map((g, gi) => {
      const comps = parts
        .map((p, i) => (p.group === g.id ? `<component objectid="${i + 2}"/>` : ''))
        .join('');
      return `<object id="${firstWrapperId + gi}" type="model"><components>${comps}</components></object>`;
    })
    .join('');

  // Compute per-group bounding boxes (in the already-shifted coordinate space)
  const baseBB = groupBBox(parts, 'base', minZ);
  const topBB = groupBBox(parts, 'top', minZ);

  const buildItems = groups
    .map((g, gi) => {
      if (g.id === 'base') {
        return `<item objectid="${firstWrapperId + gi}"/>`;
      }
      const baseWidth = isFinite(baseBB.maxX) ? baseBB.maxX - baseBB.minX : 0;
      const topWidth = isFinite(topBB.maxX) ? topBB.maxX - topBB.minX : 0;
      const baseCenterX = isFinite(baseBB.minX) ? (baseBB.minX + baseBB.maxX) / 2 : 0;
      const topCenterX = isFinite(topBB.minX) ? (topBB.minX + topBB.maxX) / 2 : 0;
      const tx = baseCenterX + baseWidth / 2 + GAP_MM + topWidth / 2 - topCenterX;

      if (orientation === 'faceDown') {
        // Flip 180° around X so the image face points downward on the build plate.
        const topCenterY = isFinite(topBB.minY) ? (topBB.minY + topBB.maxY) / 2 : 0;
        const ty = 2 * topCenterY;
        const tz = topBB.maxZ;
        const xform = transformAttr(1, 0, 0, 0, -1, 0, 0, 0, -1, tx, ty, tz);
        return `<item objectid="${firstWrapperId + gi}"${xform}/>`;
      }
      // faceUp / asPreview: keep original orientation, rest the cap bottom on the plate.
      const tz = -topBB.minZ;
      const xform = transformAttr(1, 0, 0, 0, 1, 0, 0, 0, 1, tx, 0, tz);
      return `<item objectid="${firstWrapperId + gi}"${xform}/>`;
    })
    .join('');

  const model =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<model unit="millimeter" xml:lang="en-US"` +
    ` xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"` +
    ` xmlns:m="http://schemas.microsoft.com/3dmanufacturing/material/2015/02">` +
    `<resources>` +
    `<basematerials id="1">${baseMaterials}</basematerials>` +
    leafObjects +
    wrapperObjects +
    `</resources>` +
    `<build>${buildItems}</build>` +
    `</model>`;

  const objectCfg = groups
    .map((g, gi) => {
      const partsCfg = parts
        .map((p, i) =>
          p.group === g.id
            ? `<part id="${i + 2}" subtype="normal_part">` +
              `<metadata key="name" value="${p.name}"/>` +
              `<metadata key="extruder" value="${extruders[i]}"/>` +
              `</part>`
            : '',
        )
        .join('');
      return (
        `<object id="${firstWrapperId + gi}">` +
        `<metadata key="name" value="${g.label}"/>` +
        `<metadata key="extruder" value="1"/>` +
        partsCfg +
        `</object>`
      );
    })
    .join('');
  const modelSettings =
    `<?xml version="1.0" encoding="UTF-8"?>\n` + `<config>` + objectCfg + `</config>`;

  const contentTypes =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>` +
    `<Default Extension="config" ContentType="text/xml"/>` +
    `</Types>`;

  const rels =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Target="/3D/3dmodel.model" Id="rel0"` +
    ` Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>` +
    `</Relationships>`;

  return zipSync(
    {
      '[Content_Types].xml': strToU8(contentTypes),
      '_rels/.rels': strToU8(rels),
      '3D/3dmodel.model': strToU8(model),
      'Metadata/model_settings.config': strToU8(modelSettings),
    },
    { level: 6 },
  );
}

export function downloadThreeMF(
  parts: ClickerPart[],
  fileName = 'clicker.3mf',
  options?: ThreeMFExportOptions,
) {
  const bytes = buildThreeMF(parts, options);
  const blob = new Blob([bytes as unknown as BlobPart], { type: 'model/3mf' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
