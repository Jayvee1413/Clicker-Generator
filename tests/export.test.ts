import { buildThreeMF } from '../src/export/threemfExport.ts';
import { unzipSync, strFromU8 } from 'fflate';

const tetra = (color: [number, number, number], name: string, z: number, group: 'top' | 'base') => ({
  kind: 'cap' as const,
  group,
  colorRgb: color,
  name,
  numProp: 3,
  vertProperties: new Float32Array([0, 0, z, 10, 0, z, 0, 10, z, 0, 0, z + 10]),
  triVerts: new Uint32Array([0, 2, 1, 0, 1, 3, 1, 2, 3, 0, 3, 2]),
});

const parts = [
  tetra([255, 0, 0], 'red', 5, 'top'),
  tetra([0, 128, 255], 'blue', 8, 'base'),
];
const bytes = buildThreeMF(parts as any);

const files = unzipSync(bytes);
const names = Object.keys(files);
const model = strFromU8(files['3D/3dmodel.model']);

const objCount = (model.match(/<object /g) || []).length;
const itemCount = (model.match(/<item /g) || []).length;

const checks: [string, boolean][] = [
  ['has [Content_Types].xml', names.includes('[Content_Types].xml')],
  ['has _rels/.rels', names.includes('_rels/.rels')],
  ['has 3D/3dmodel.model', names.includes('3D/3dmodel.model')],
  ['unit=millimeter', /unit="millimeter"/.test(model)],
  ['2 basematerials', (model.match(/<base /g) || []).length === 2],
  ['2 leaf + 2 wrapper objects', objCount === 4],
  ['2 build items', itemCount === 2],
  ['dropped to plate (min z=0)', /z="0"/.test(model)],
  ['blue color present', /displaycolor="#0080ffFF"/i.test(model)],
];

let ok = true;
for (const [label, pass] of checks) {
  console.log((pass ? 'PASS ' : 'FAIL ') + label);
  if (!pass) ok = false;
}

// Orientation checks
const faceUp = strFromU8(unzipSync(buildThreeMF(parts as any, { orientation: 'faceUp' }))['3D/3dmodel.model']);
const asPreview = strFromU8(unzipSync(buildThreeMF(parts as any, { orientation: 'asPreview' }))['3D/3dmodel.model']);
const faceDown = strFromU8(unzipSync(buildThreeMF(parts as any, { orientation: 'faceDown' }))['3D/3dmodel.model']);
const gap = strFromU8(unzipSync(buildThreeMF(parts as any, { gap: 12 }))['3D/3dmodel.model']);

function topTransform(model: string): string | null {
  const items = [...model.matchAll(/\u003citem objectid="\d+"([^\u003e]*)\/?\u003e/g)];
  return items[0]?.[1] ?? null;
}

// transform="m00 m01 m02 m10 m11 m12 m20 m21 m22 tx ty tz"
function parseTransform(t: string): number[] {
  const m = t.match(/transform="([^"]+)"/);
  if (!m) return [];
  return m[1].trim().split(/\s+/).map(Number);
}

const faceDownT = parseTransform(topTransform(faceDown) ?? '');
const faceUpT = parseTransform(topTransform(faceUp) ?? '');
const asPreviewT = parseTransform(topTransform(asPreview) ?? '');
const gapT = parseTransform(topTransform(gap) ?? '');

const orientChecks: [string, boolean][] = [
  ['faceDown has transform', faceDownT.length === 12],
  ['faceDown flips Y', faceDownT[4] === -1],
  ['faceDown flips Z', faceDownT[8] === -1],
  ['faceUp keeps orientation', faceUpT[4] === 1 && faceUpT[8] === 1],
  ['asPreview keeps orientation', asPreviewT[4] === 1 && asPreviewT[8] === 1],
  ['custom gap is used', Math.abs(gapT[9] - faceUpT[9] - 7) < 0.1],
];
for (const [label, pass] of orientChecks) {
  console.log((pass ? 'PASS ' : 'FAIL ') + label);
  if (!pass) ok = false;
}

console.log(ok ? '\nALL EXPORT CHECKS PASSED' : '\nEXPORT CHECKS FAILED');
process.exit(ok ? 0 : 1);
