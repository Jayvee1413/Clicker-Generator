import './style.css';
import { createStore } from './store/store';
import { createViewer } from './viewer/viewer';
import { createUi, type UiState } from './ui/ui';
import { loadFileToImage, type RgbaImage } from './image/decode';
import { processImage } from './image/pipeline';
import { runWizard } from './ui/wizard';
import { downloadThreeMF } from './export/threemfExport';
import { parseSvg } from './image/logo';
import { SVG_SAMPLES } from './image/sample';
import { parseLetter, importFontFile } from './image/letter';
import { LUCIDE_ICONS, buildSvg } from './image/lucideIcons';
import type {
  BaseShapeKind,
  BuildParams,
  BuildRegion,
  ClickerPart,
  EdgeSetting,
  EdgeStyle,
  GeometryResponse,
  PaletteEntry,
  RegionSet,
  Ring,
  RGB,
} from './types';
import { FILAMENTS } from './types';

// Start fetching switch assets immediately at startup to run in parallel with worker setup
const base = import.meta.env.BASE_URL;
const assetsPromise = Promise.all([
  fetch(base + 'assets/switch/mx/mx-socket.3mf').then((r) => r.arrayBuffer()),
  fetch(base + 'assets/switch/mx/mx-stem.3mf').then((r) => r.arrayBuffer()),
  fetch(base + 'assets/switch/mx/mx-switch.3mf').then((r) => r.arrayBuffer()),
]).catch((err) => {
  console.error('[assets] Pre-fetch failed:', err);
  throw err;
});

/** Which editable color a clicked model part maps back to. */
type ColorTarget = { kind: 'region'; index: number; compIndex: number } | { kind: 'body' } | { kind: 'base' };

// ---- State (UI-facing) ----
const store = createStore<UiState>({
  status: 'Loading switch assets…',
  building: false,
  hasParts: false,
  colorCount: 4,
  palette: [],
  baseShape: 'outline',
  capWidthMm: 35,
  topThickness: 1.5,
  imageDepth: 0.8,
  tolerance: 0.4,
  smoothing: 0.1,
  keychain: false,
  removeBg: true,
  view: 'exploded',
  showSwitch: true,
  importMode: 'image', // Land on the Image tab by default
  currentIconName: 'circle',
  colorMode: 'normal',
  limitedColors: [],
  traceEngine: 'potrace',
  bodyColorRgb: [240, 240, 240] as RGB,
  paletteOverrides: [],
  baseColorOverride: null,
  shapeCornerRadius: 0,
  customOutline: null,
  partOverrides: {},
  editMode: 'color',
  edgeSettings: [
    { target: 'capTop', style: 'chamfer', radius: 0.5 },
    // One control for the whole clicker base — bevels top + bottom body edges together.
    { target: 'clickerBase', style: 'chamfer', radius: 0.5 },
  ],
  extrudeHeight: null,
  componentHeights: {},
  selectedParts: [],
  canUndo: false,
  canRedo: false,
  canRefresh: false,
});

// ---- Heavy data kept out of the reactive store ----
let originalImage: RgbaImage | null = null; // pristine decode (never mutated)
let regionSet: RegionSet | null = null;
let latestParts: ClickerPart[] = [];
let assetsReady = false;

// Vector states
let currentSvgText = '';
let currentSvgName = '';
let currentIconText = '';
let currentIconName = '';
let currentText = 'Custom\nText';
let currentFontId = 'helvetiker-regular';
let isInitialLoad = true;
let bodyColorUserSet = false;
let pendingGauge = false;

const hasImage = () => originalImage !== null;
function cloneImage(img: RgbaImage): RgbaImage {
  return { data: new Uint8ClampedArray(img.data), width: img.width, height: img.height };
}

// ---- DOM / subsystems ----
const sidebarLeft = document.getElementById('sidebar-left')!;
const sidebarRight = document.getElementById('sidebar-right')!;
const statusEl = document.getElementById('status')!;
const viewer = createViewer(document.getElementById('app')!);

// ---- Apply initial theme (system pref or saved preference) ----
(function applyInitialTheme() {
  const saved = localStorage.getItem('clicker-theme');
  const systemDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const theme = saved ?? (systemDark ? 'dark' : 'light');
  document.documentElement.setAttribute('data-theme', theme);
  viewer.setTheme(theme);
})();

const ui = createUi(sidebarLeft, sidebarRight, statusEl, {
  onUpload: (file) => openWizard(() => loadFileToImage(file)),
  onSample: (load) => openWizard(load),
  onColorCount: (n) => {
    store.set({ colorCount: n });
    debouncedReprocess();
  },
  onFilament: (i, hex) => {
    // Live recolor (same path as clicking the color on the 3D model). A color change
    // never changes geometry, so we skip the full worker rebuild — picking a filament
    // in the left menu now behaves exactly like recoloring in Color mode.
    if (!store.get().palette[i]) return;
    applyModelRecolor({ kind: 'region', index: i, compIndex: 0 }, hexToRgb(hex), -1);
  },
  onShape: (kind) => {
    store.set({ baseShape: kind });
    debouncedRebuild();
  },
  onCornerRadius: (mm) => {
    store.set({ shapeCornerRadius: mm });
    debouncedRebuild();
  },
  onCustomOutlineUpload: async (file) => {
    try {
      store.set({ building: true, status: 'Reading custom outline…' });
      const svgText = await file.text();
      const rs = parseSvg(svgText);
      store.set({ baseShape: 'custom', customOutline: rs.outline });
      debouncedRebuild();
      store.set({ status: 'Custom outline applied.' });
    } catch (err) {
      store.set({ building: false, status: 'Could not read outline: ' + String(err) });
    }
  },
  onWidth: (mm) => {
    store.set({ capWidthMm: mm });
    debouncedRebuild();
  },
  onTopThickness: (mm) => {
    store.set({ topThickness: mm });
    debouncedRebuild();
  },
  onImageDepth: (mm) => {
    store.set({ imageDepth: mm });
    debouncedRebuild();
  },
  onTolerance: (mm) => {
    store.set({ tolerance: mm });
    debouncedRebuild();
  },
  onKeychain: (on) => {
    store.set({ keychain: on });
    debouncedRebuild();
  },
  onSmoothing: (v) => {
    store.set({ smoothing: v });
    if (store.get().importMode === 'image' && hasImage()) debouncedReprocess();
  },
  onTraceEngine: (engine) => {
    store.set({ traceEngine: engine });
    if (store.get().importMode === 'image' && hasImage()) debouncedReprocess();
  },
  onRemoveBg: (on) => {
    store.set({ removeBg: on });
    if (store.get().importMode === 'image' && hasImage()) reprocess();
  },
  onView: (mode) => {
    store.set({ view: mode });
    viewer.setView(mode);
  },
  onShowSwitch: (on) => {
    store.set({ showSwitch: on });
    viewer.showSwitch(on);
  },
  onSection: (axis, pos) => viewer.setSection(axis, pos),
  onExport: (options) => {
    if (!latestParts.length) return;
    downloadThreeMF(latestParts, 'clicker.3mf', options);
  },
  onExportGauge: () => {
    if (!latestParts.length || !regionSet || pendingGauge) return;
    pendingGauge = true;
    store.set({ building: true, status: 'Building fit gauge…' });
    const s = store.get();
    worker.postMessage({
      type: 'buildGauge',
      outline: regionSet.outline,
      params: {
        baseShape: s.baseShape,
        capWidthMm: s.capWidthMm,
        topThickness: Math.max(1, s.topThickness),
        imageDepth: s.imageDepth,
        imageMargin: 1.2,
        borderWidth: 2.6,
        capProud: 4.0,
        tolerance: s.tolerance,
        colorBleed: 0.12,
        stepHeight: 0.6,
        travel: 4.0,
        floorThickness: 1.6,
        keychainHole: false,
        baseFilamentRgb: [240, 240, 240],
        bodyColorRgb: [120, 124, 130],
        cornerRadius: s.shapeCornerRadius,
        customOutline: s.customOutline ?? undefined,
        edgeSettings: [],
        componentHeights: {},
      },
    });
  },
  onRenderPng: async () => {
    const blob = await viewer.renderToPng();
    if (blob) downloadBlob(blob, 'clicker-render.png');
  },
  onAiPrompt: async () => {
    try {
      await navigator.clipboard.writeText(AI_PROMPT);
      store.set({ status: 'AI image prompt copied to clipboard ✓' });
    } catch {
      store.set({ status: 'Could not copy, see console.' });
      console.log(AI_PROMPT);
    }
  },
  onSaveProject: () => saveProject(),
  onLoadProject: (file) => loadProject(file),
  onShareProject: () => shareProject(),
  onBodyColor: (hex) => {
    // Live recolor of the clicker body — no rebuild (geometry is unchanged).
    bodyColorUserSet = true;
    const idx = latestParts.findIndex((p) => p.name === 'base-body');
    if (idx >= 0) applyModelRecolor({ kind: 'body' }, hexToRgb(hex), idx);
    else store.set({ bodyColorRgb: hexToRgb(hex) });
  },

  onImportMode: (mode) => {
    const s = store.get();
    store.set({
      importMode: mode,
      baseShape: mode === 'text' ? 'outline' : s.baseShape,
      colorMode: mode !== 'image' ? 'normal' : s.colorMode,
    });
    reprocess();
  },
  onSvgUpload: async (file) => {
    try {
      store.set({ building: true, status: 'Reading SVG…' });
      const svgText = await file.text();
      ui.addUploadedSvg(svgText, file.name.replace(/\.svg$/i, ''));
      store.set({ building: false });
    } catch (err) {
      store.set({ building: false, status: 'Error reading SVG: ' + String(err) });
    }
  },
  onSelectSvg: (svgText, name) => {
    currentSvgText = svgText;
    currentSvgName = name;
    store.set({ status: `Selected SVG: ${name}. Click Generate to update.` });
  },
  onSelectIcon: (svgText, name) => {
    currentIconText = svgText;
    currentIconName = name;
    store.set({ currentIconName: name, status: `Selected icon: ${name}. Click Generate to update.` });
  },
  onTextChange: (text) => {
    currentText = text;
    store.set({ status: 'Text updated. Click Generate to update.' });
  },
  onFontSelect: (fontId) => {
    currentFontId = fontId;
    store.set({ status: 'Font changed. Click Generate to update.' });
  },
  onImportFont: async (file) => {
    try {
      store.set({ building: true, status: 'Importing font…' });
      const font = await importFontFile(file);
      ui.addFontOption(font);
      currentFontId = font.id;
      store.set({ building: false, status: `Font ${font.name} imported! Click Generate to update.` });
    } catch (err) {
      store.set({ building: false, status: 'Could not import font: ' + String(err) });
    }
  },
  onThemeChange: (theme) => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('clicker-theme', theme);
    viewer.setTheme(theme);
  },
  onGenerate: () => {
    reprocess();
  },
  onEditMode: (mode) => {
    // Geometry is always kept in sync by the live edit rebuilds. Keep the selection
    // when moving between extrude/edges (so you can raise then bevel the same parts),
    // but clear it entering color mode so no stray highlight tints the swatches.
    store.set({ editMode: mode, selectedParts: mode === 'color' ? [] : store.get().selectedParts });
  },
  onEdgeStyle: (target: string, style: EdgeStyle) => {
    const s = store.get();
    const edgeSettings = [...s.edgeSettings];
    const idx = edgeSettings.findIndex(x => x.target === target);
    if (idx >= 0) {
      const cur = edgeSettings[idx];
      // Picking fillet/chamfer with no size yet gets a sensible default so the
      // result is immediately visible (the old code left radius at 0 = no-op).
      const radius = style !== 'none' && (!cur.radius || cur.radius < 0.2) ? 1.0 : cur.radius;
      edgeSettings[idx] = { ...cur, style, radius };
    } else {
      edgeSettings.push({ target, style, radius: style === 'none' ? 0 : 1.0 });
    }
    store.set({ edgeSettings });
    debouncedQuietRebuild(); // live preview of the bevel
  },
  onEdgeStep: (target: string, delta: number) => {
    const s = store.get();
    const edgeSettings = [...s.edgeSettings];
    const idx = edgeSettings.findIndex(x => x.target === target);
    const current = idx >= 0 ? edgeSettings[idx].radius : 1.0;
    const next = Math.max(0.2, Math.min(5.0, current + delta));
    if (idx >= 0) {
      edgeSettings[idx] = { ...edgeSettings[idx], radius: next };
    } else {
      edgeSettings.push({ target, style: 'chamfer', radius: next });
    }
    store.set({ edgeSettings });
    debouncedQuietRebuild(); // live preview of the bevel size
  },
  onExtrudeStep: (delta: number) => {
    const s = store.get();
    if (s.selectedParts.length === 0) return;
    const componentHeights = { ...s.componentHeights };
    let changed = false;
    for (const partName of s.selectedParts) {
      const current = componentHeights[partName] ?? 0;
      const next = Math.max(-5, Math.min(6, current + delta));
      if (current !== next) {
        componentHeights[partName] = next;
        changed = true;
      }
    }
    if (changed) {
      store.set({ componentHeights });
      // Rebuild for real so the part grows in place (no floating slab) — this IS
      // the preview, and it bakes the height into the exported geometry.
      debouncedQuietRebuild();
    }
  },
  onUndo: () => undo(),
  onRedo: () => redo(),
  onRefresh: () => refreshDesign(),
});

// ---- Undo / redo ----------------------------------------------------------
// History snapshots the editable "document" fields (colors, heights, edges,
// shape/size). Each tracked change pushes a snapshot; re-tracing a new source
// (reprocess) starts a fresh baseline. Restoring rebuilds the geometry.
const HISTORY_FIELDS = [
  'palette', 'paletteOverrides', 'partOverrides', 'bodyColorRgb', 'baseColorOverride',
  'componentHeights', 'edgeSettings', 'baseShape', 'capWidthMm', 'topThickness',
  'imageDepth', 'tolerance', 'keychain', 'selectedParts', 'shapeCornerRadius',
] as const;
let history: string[] = [];
let histIndex = -1;
let restoringHistory = false;
let pendingHistoryReset = false;

function snapshotHistory(): string {
  const s = store.get() as any;
  const picked: Record<string, unknown> = {};
  for (const k of HISTORY_FIELDS) picked[k] = s[k];
  return JSON.stringify(picked);
}
function updateHistoryButtons() {
  store.set({ canUndo: histIndex > 0, canRedo: histIndex < history.length - 1, canRefresh: history.length > 1 });
}
function resetHistory() {
  history = [snapshotHistory()];
  histIndex = 0;
  updateHistoryButtons();
}
const commitHistory = debounce(() => {
  if (restoringHistory || pendingHistoryReset || histIndex < 0) return;
  const snap = snapshotHistory();
  if (snap === history[histIndex]) return;
  history = history.slice(0, histIndex + 1);
  history.push(snap);
  const MAX = 60;
  if (history.length > MAX) history = history.slice(history.length - MAX);
  histIndex = history.length - 1;
  updateHistoryButtons();
  debouncedAutosave();
}, 350);
function applyHistorySnapshot(snap: string) {
  restoringHistory = true;
  store.set(JSON.parse(snap));
  restoringHistory = false;
  updateHistoryButtons();
  rebuild(); // regenerate geometry + colors for the restored state
}
function undo() {
  if (histIndex <= 0) return;
  histIndex--;
  applyHistorySnapshot(history[histIndex]);
}
function redo() {
  if (histIndex >= history.length - 1) return;
  histIndex++;
  applyHistorySnapshot(history[histIndex]);
}
function refreshDesign() {
  if (history.length > 1) {
    applyHistorySnapshot(history[0]);
    // The state now matches the original snapshot, but we want this to be an undoable action
    // so we call commitHistory right away to push the "refreshed" state as a new history step
    // (commitHistory is debounced, but that's fine).
    commitHistory();
  }
}

// Ctrl/Cmd+Z = undo, Ctrl/Cmd+Shift+Z or Ctrl+Y = redo (ignored while typing).
window.addEventListener('keydown', (e) => {
  const el = e.target as HTMLElement | null;
  const tag = el?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || el?.isContentEditable) return;
  if (!(e.ctrlKey || e.metaKey)) return;
  const k = e.key.toLowerCase();
  if (k === 'z') {
    e.preventDefault();
    if (e.shiftKey) redo(); else undo();
  } else if (k === 'y') {
    e.preventDefault();
    redo();
  }
});

store.subscribe((s) => {
  ui.update(s);

  // Highlight the current selection in every mode (hover is handled separately).
  const indices: number[] = [];
  s.selectedParts.forEach((name) => {
    const idx = latestParts.findIndex((p) => p.name === name);
    if (idx >= 0) indices.push(idx);
  });
  viewer.highlightParts(indices);

  // Record undoable edits (debounced; no-op if nothing tracked actually changed).
  if (!restoringHistory && !pendingHistoryReset) commitHistory();
});
ui.update(store.get());

// ---- Click a colored region on the 3D model to recolor it (live, no rebuild) ----
viewer.onPartPick((index, clientX, clientY, shiftKey) => {
  const s = store.get();

  // Empty space clears the selection (all modes).
  if (index === null) {
    store.set({ selectedParts: [] });
    return;
  }

  const partName = latestParts[index]?.name;
  if (!partName) return;

  if (s.editMode === 'color') {
    // Color mode: single target. Open the swatch picker for the clicked color and
    // recolor its whole group; clear the highlight on close so the true color shows.
    store.set({ selectedParts: [partName] });
    const part = latestParts[index];
    if (!part) return;
    const target = partColorTarget(part.name);
    if (!target) return;
    const options: RGB[] =
      s.colorMode === 'limited' && s.limitedColors.length > 0
        ? s.limitedColors
        : FILAMENTS.map(([, hex]) => hexToRgb(hex));
    ui.showColorPopoverAt(clientX, clientY, rgbToHex(part.colorRgb), options, {
      onSelect: (hex) => applyModelRecolor(target, hexToRgb(hex), index),
      onClose: () => store.set({ selectedParts: [] }),
    });
    return;
  }

  // Extrude / edges: unified multi-selection — shift toggles a part in/out, a plain
  // click selects one. The floating panels act on every selected part.
  let nextSelected = s.selectedParts.slice();
  if (shiftKey) {
    nextSelected = nextSelected.includes(partName)
      ? nextSelected.filter((p) => p !== partName)
      : [...nextSelected, partName];
  } else {
    nextSelected = [partName];
  }
  store.set({ selectedParts: nextSelected });
});

function partColorTarget(name: string): ColorTarget | null {
  if (name === 'base-body') return { kind: 'body' };
  if (name === 'top-base') return { kind: 'base' };
  const m = /^top-color-(\d+)(?:-(\d+))?$/.exec(name);
  if (m) {
    return { kind: 'region', index: +m[1], compIndex: m[2] ? +m[2] : 0 };
  }
  return null;
}

// --- Edit Mode Event Hooks (Gizmo Drag Handlers Removed) ---

// Apply a recolor to the clicked part: update the live material + export data, and
// persist into store state so it survives rebuilds. Geometry is identical for a
// color change, so we deliberately skip the worker rebuild.
function applyModelRecolor(target: ColorTarget, rgb: RGB, partIndex: number) {
  const s = store.get();
  if (target.kind === 'region') {
    // Recolor EVERY component of this color across the model (not just the clicked
    // one) and update the palette swatch + overrides, so clicking a color in the
    // viewport behaves like changing its filament in the left menu (whole model).
    const i = target.index;
    const prefix = `top-color-${i}-`;
    const overrides = s.partOverrides ? { ...s.partOverrides } : {};
    latestParts.forEach((p, idx) => {
      if (p.name.startsWith(prefix)) {
        viewer.setPartColor(idx, rgb);
        latestParts[idx] = { ...latestParts[idx], colorRgb: rgb };
        overrides[p.name] = rgb;
      }
    });
    const palette = s.palette.slice();
    if (palette[i]) palette[i] = { ...palette[i], filamentRgb: rgb };
    const paletteOverrides = s.paletteOverrides.slice();
    paletteOverrides[i] = rgb;
    store.set({ partOverrides: overrides, palette, paletteOverrides });
    syncBaseColor(); // the cap frame mirrors the dominant region, keep it in step
  } else if (target.kind === 'body') {
    viewer.setPartColor(partIndex, rgb);
    if (latestParts[partIndex]) latestParts[partIndex] = { ...latestParts[partIndex], colorRgb: rgb };
    store.set({ bodyColorRgb: rgb });
  } else {
    viewer.setPartColor(partIndex, rgb);
    if (latestParts[partIndex]) latestParts[partIndex] = { ...latestParts[partIndex], colorRgb: rgb };
    store.set({ baseColorOverride: rgb });
  }
}

// ---- Cap frame / backing color ----
const LIGHT_FRAME: RGB = [240, 240, 240];
const DARK_FRAME: RGB = [38, 38, 42];

function relLuminance(rgb: RGB): number {
  return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
}
// A light or dark backing chosen to contrast the given ink, so a single-color design
// is always visible against it.
function contrastingFrame(ink: RGB): RGB {
  return relLuminance(ink) > 150 ? DARK_FRAME : LIGHT_FRAME;
}

function dominantInk(s: UiState): RGB {
  if (s.palette.length === 0) return [180, 180, 185];
  let domIdx = 0;
  for (let i = 1; i < s.palette.length; i++) {
    if (s.palette[i].coverage > s.palette[domIdx].coverage) domIdx = i;
  }
  return s.palette[domIdx]?.filamentRgb ?? [180, 180, 185];
}

// The cap backing/frame color. A photographic IMAGE tiles the whole cap, so the frame
// mirrors its dominant region and blends in naturally. Line-art modes (icon/svg/text)
// are typically a single ink — mirroring that ink would make the design vanish into
// its own backing (the "svg comes out one color" bug), so we pick a contrasting frame
// instead. The design then reads clearly without any manual recolor.
function deriveFrameColor(s: UiState): RGB {
  const ink = dominantInk(s);
  return s.importMode === 'image' ? ink : contrastingFrame(ink);
}

// After a region recolor, repaint the frame part to match the derived color — live, no
// rebuild — so it never lags a frame behind the inlay it shares a color with.
function syncBaseColor() {
  const s = store.get();
  if (s.baseColorOverride || s.palette.length === 0) return;
  const baseRgb = deriveFrameColor(s);
  const bi = latestParts.findIndex((p) => p.name === 'top-base');
  if (bi >= 0) {
    latestParts[bi] = { ...latestParts[bi], colorRgb: baseRgb };
    viewer.setPartColor(bi, baseRgb);
  }
}

// Seed the SVG panel with bundled vector presets (added quietly, not selected).
(async function loadSvgSamples() {
  for (const sample of SVG_SAMPLES) {
    try {
      const svgText = await fetch(sample.src).then((r) => r.text());
      ui.addUploadedSvg(svgText, sample.name, false);
    } catch (err) {
      console.warn('Could not load SVG sample', sample.name, err);
    }
  }
})();

// ---- Geometry worker ----
const worker = new Worker(new URL('./workers/geometry.worker.ts', import.meta.url), {
  type: 'module',
});

worker.onmessage = (e: MessageEvent<GeometryResponse>) => {
  const msg = e.data;
  switch (msg.type) {
    case 'ready':
      initAssets();
      break;
    case 'initDone': {
      assetsReady = true;
      console.log('[assets] socket:', msg.socketInfo, '| stem:', msg.stemInfo, '| switch:', msg.switchInfo);
      viewer.setSwitch(msg.switchMesh);
      viewer.showSwitch(store.get().showSwitch);
      store.set({
        status: 'Ready. Import an image, SVG, icon, or text.',
      });

      // Try to restore a shared link or auto-save before falling back to the default icon.
      (async () => {
        const restored = (await restoreFromHash()) || (await restoreAutosave());
        if (restored) {
          isInitialLoad = false;
          return;
        }
        // Build a default icon clicker dynamically instead of fetching a 1 MB JSON asset.
        if (isInitialLoad) {
          store.set({ importMode: 'icon', baseShape: 'circle' });
          const first = LUCIDE_ICONS.find((ic) => ic.name === 'circle') || LUCIDE_ICONS[0];
          if (first) {
            currentIconText = buildSvg(first.node);
            currentIconName = first.name;
            store.set({ currentIconName: first.name });
          }
          reprocess();
        } else {
          reprocess();
        }
      })();
      break;
    }
    case 'parts': {
      if (pendingGauge) {
        pendingGauge = false;
        store.set({ building: false, status: 'Fit gauge ready ✓' });
        downloadThreeMF(msg.parts, 'clicker-fit-gauge.3mf');
        break;
      }
      latestParts = msg.parts;
      viewer.setParts(msg.parts, !pendingHistoryReset);
      viewer.setView(store.get().view);

      // Extrude heights are baked into the geometry now — do NOT translate the
      // meshes too, or the raised part would float a second step above the model.
      // (Selection highlight is re-applied by the store subscription below.)

      store.set({
        building: false,
        hasParts: msg.parts.length > 0,
        status: '', // Clear the banner when ready
      });
      isInitialLoad = false;

      // After a re-trace, the first build becomes the new undo baseline.
      if (pendingHistoryReset) {
        pendingHistoryReset = false;
        resetHistory();
      }
      debouncedAutosave();
      break;
    }
    case 'error':
      store.set({ building: false, status: 'Error: ' + firstLine(msg.message) });
      console.error('[geometry worker]', msg.message);
      isInitialLoad = false;
      break;
  }
};
worker.onerror = (e) => {
  store.set({ building: false, status: 'Worker failed: ' + e.message });
  console.error(e);
};

async function initAssets() {
  try {
    const [socket, stem, sw] = await assetsPromise;
    worker.postMessage({ type: 'init', socket, stem, switch: sw }, [socket, stem, sw]);
  } catch (err) {
    store.set({ status: 'Failed to load switch assets: ' + String(err) });
    isInitialLoad = false;
  }
}

// ---- Pipeline ----
async function openWizard(getter: () => Promise<RgbaImage>) {
  try {
    store.set({ building: true, status: 'Reading image…' });
    const baseImage = await getter();
    store.set({ building: false, status: 'Preprocess your image…' });
    runWizard({
      baseImage,
      initialColorCount: store.get().colorCount,
      onCancel: () =>
        store.set({ status: originalImage ? 'Ready.' : 'Ready. Drop an image or try the sample.' }),
      onComplete: ({ adjusted, preprocess, colorCount, colorMode, limitedColors, paletteOverrides }) => {
        originalImage = adjusted;
        let defaultBodyColor = store.get().bodyColorRgb;
        if (colorMode === 'limited' && limitedColors && limitedColors.length > 0) {
          const blackHex = '#161616';
          const blackRgb = hexToRgb(blackHex);
          const hasBlack = limitedColors.some(c => c[0] === blackRgb[0] && c[1] === blackRgb[1] && c[2] === blackRgb[2]);
          defaultBodyColor = hasBlack ? blackRgb : limitedColors[0];
        }
        store.set({
          removeBg: !preprocess.keepBackground,
          colorCount,
          topThickness: Math.max(1, preprocess.thicknessMm),
          colorMode,
          limitedColors: limitedColors || [],
          bodyColorRgb: defaultBodyColor,
          paletteOverrides: paletteOverrides || [],
        });
        reprocess();
      },
    });
  } catch (err) {
    store.set({ building: false, status: 'Could not read image: ' + String(err) });
  }
}

function reprocess() {
  // A fresh trace means fresh regions, so start a new undo baseline and drop any
  // pinned frame color so it re-derives.
  pendingHistoryReset = true;
  store.set({ baseColorOverride: null });
  const s = store.get();

  if (s.importMode === 'image') {
    if (!originalImage) return;
    store.set({ building: true, status: 'Removing background & tracing…' });
    regionSet = processImage(cloneImage(originalImage), s.colorCount, {
      removeBg: s.removeBg,
      smoothing: s.smoothing,
      engine: s.traceEngine,
      customColors: s.colorMode === 'limited' ? s.limitedColors : undefined,
    });
  } else if (s.importMode === 'svg') {
    if (!currentSvgText) {
      store.set({ status: 'Upload an SVG file first.' });
      return;
    }
    try {
      store.set({ building: true, status: 'Parsing SVG…' });
      regionSet = parseSvg(currentSvgText);
    } catch (e: any) {
      store.set({ building: false, status: 'Error: ' + e.message });
      return;
    }
  } else if (s.importMode === 'icon') {
    if (!currentIconText) {
      const first = LUCIDE_ICONS.find((ic) => ic.name === 'circle') || LUCIDE_ICONS[0];
      if (first) {
        currentIconText = buildSvg(first.node);
        currentIconName = first.name;
        store.set({ currentIconName: first.name });
      }
    }
    if (!currentIconText) {
      store.set({ status: 'Select an icon first.' });
      return;
    }
    try {
      store.set({ building: true, status: 'Parsing Icon…' });
      regionSet = parseSvg(currentIconText);
    } catch (e: any) {
      store.set({ building: false, status: 'Error: ' + e.message });
      return;
    }
  } else if (s.importMode === 'text') {
    try {
      store.set({ building: true, status: 'Generating Text…' });
      regionSet = parseLetter(currentText, currentFontId, 15);
    } catch (e: any) {
      store.set({ building: false, status: 'Error: ' + e.message });
      return;
    }
  }

  if (!regionSet) return;

  const palette: PaletteEntry[] = regionSet.regions.map((r, i) => ({
    quantRgb: r.quantRgb,
    filamentRgb: s.paletteOverrides[i] ?? r.quantRgb,
    coverage: r.coverage,
  }));
  store.set({ palette });

  // Derive a body color that contrasts the dominant cap ink unless the user has
  // explicitly chosen one.
  if (!bodyColorUserSet) {
    const ink = dominantInk(store.get());
    store.set({ bodyColorRgb: contrastingFrame(ink) });
  }

  if (palette.length === 0) {
    store.set({ building: false, status: 'No outline found.' });
    return;
  }
  rebuild();
}

function rebuild(quiet = false) {
  if (!regionSet || regionSet.regions.length === 0) return;
  if (!assetsReady) {
    store.set({ status: 'Waiting for switch assets…' });
    return;
  }
  const s = store.get();

  const regions: BuildRegion[] = [];
  regionSet.regions.forEach((r, i) => {
    const baseColor = s.palette[i]?.filamentRgb ?? r.quantRgb;
    r.components.forEach((comp, j) => {
      const partName = `top-color-${i}-${j}`;
      regions.push({
        filamentRgb: s.partOverrides?.[partName] ?? baseColor,
        coverage: r.coverage, // Use the parent coverage for priority
        rings: comp.rings,
        partName,
      });
    });
  });

  // Icons are line-art (a single-color silhouette), not a multi-color picture.
  // Using their thin stroke as the body outline makes a broken ring, so the body
  // is always a solid shape (circle/square) and the icon rides on top as a design.
  const isIcon = s.importMode === 'icon';
  const effectiveBaseShape = isIcon && s.baseShape === 'outline' ? 'circle' : s.baseShape;
  // The cap backing contrasts line-art designs so they stay visible (see
  // deriveFrameColor). A frame the user pinned by clicking the model wins over it.
  const capBaseColor: RGB = s.baseColorOverride ?? deriveFrameColor(s);

  const isText = s.importMode === 'text';
  const params: BuildParams = {
    baseShape: effectiveBaseShape,
    capWidthMm: s.capWidthMm,
    topThickness: Math.max(1, s.topThickness),
    imageDepth: s.imageDepth,
    imageMargin: isText ? 2.5 : 1.2,
    borderWidth: isText ? 3.5 : 2.6,
    capProud: 4.0,
    tolerance: s.tolerance,
    colorBleed: 0.12,
    stepHeight: 0.6,
    travel: 4.0,
    floorThickness: 1.6,
    keychainHole: s.keychain,
    baseFilamentRgb: capBaseColor,
    bodyColorRgb: s.bodyColorRgb ?? ([120, 124, 130] as RGB),
    cornerRadius: s.shapeCornerRadius,
    customOutline: s.customOutline ?? undefined,
    edgeSettings: s.edgeSettings,
    componentHeights: s.componentHeights,
  };

  if (quiet) {
    // Live edit preview (extrude / edges): rebuild silently — no full-screen overlay.
  } else if (isInitialLoad) {
    store.set({ status: 'Building clicker…' });
  } else {
    store.set({ building: true, status: 'Building clicker…' });
  }
  worker.postMessage({ type: 'buildClicker', regions, outline: regionSet.outline, params });
}

// ---- Debounce ----
function debounce(fn: () => void, ms: number) {
  let t = 0;
  return () => {
    clearTimeout(t);
    t = window.setTimeout(fn, ms);
  };
}
const debouncedRebuild = debounce(rebuild, 130);
// Quiet rebuild used by live edit modes (extrude / edges) so the preview reflects
// the real geometry without flashing the loading overlay on every step.
const debouncedQuietRebuild = debounce(() => rebuild(true), 160);
const debouncedReprocess = debounce(reprocess, 220);

function hexToRgb(hex: string): RGB {
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
}
function rgbToHex(rgb: RGB): string {
  return (
    '#' +
    rgb.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')
  );
}
function firstLine(s: string): string {
  return s.split('\n')[0];
}

// ---- Project serialization -------------------------------------------------
interface ProjectFile {
  version: number;
  settings: Record<string, unknown>;
  palette: PaletteEntry[];
  image: string | null;
}

function serializeProject(): ProjectFile {
  const s = store.get();
  return {
    version: 2,
    settings: {
      colorCount: s.colorCount,
      baseShape: s.baseShape,
      capWidthMm: s.capWidthMm,
      topThickness: s.topThickness,
      imageDepth: s.imageDepth,
      tolerance: s.tolerance,
      smoothing: s.smoothing,
      removeBg: s.removeBg,
      importMode: s.importMode,
      currentText,
      currentFontId,
      currentSvgText,
      currentSvgName,
      currentIconText,
      currentIconName,
      colorMode: s.colorMode,
      limitedColors: s.limitedColors,
      traceEngine: s.traceEngine,
      bodyColorRgb: s.bodyColorRgb,
      paletteOverrides: s.paletteOverrides,
      baseColorOverride: s.baseColorOverride,
      partOverrides: s.partOverrides,
      edgeSettings: s.edgeSettings,
      componentHeights: s.componentHeights,
      shapeCornerRadius: s.shapeCornerRadius,
      customOutline: s.customOutline,
      bodyColorUserSet,
    },
    palette: s.palette,
    image: originalImage ? imageToDataUrl(originalImage) : null,
  };
}

async function applyProject(proj: ProjectFile, quiet = false) {
  const set = proj.settings ?? {};

  currentText = (set.currentText as string) ?? 'Custom\nText';
  currentFontId = (set.currentFontId as string) ?? 'helvetiker-regular';
  currentSvgText = (set.currentSvgText as string) ?? '';
  currentSvgName = (set.currentSvgName as string) ?? '';
  currentIconText = (set.currentIconText as string) ?? '';
  currentIconName = (set.currentIconName as string) ?? '';
  bodyColorUserSet = !!set.bodyColorUserSet;

  if (currentSvgText && currentSvgName) {
    ui.addUploadedSvg(currentSvgText, currentSvgName);
  }

  store.set({
    importMode: (set.importMode as UiState['importMode']) ?? 'image',
    colorCount: (set.colorCount as number) ?? store.get().colorCount,
    baseShape: (set.baseShape as BaseShapeKind) ?? store.get().baseShape,
    capWidthMm: (set.capWidthMm as number) ?? store.get().capWidthMm,
    topThickness: (set.topThickness as number) ?? store.get().topThickness,
    imageDepth: (set.imageDepth as number) ?? store.get().imageDepth,
    tolerance: (set.tolerance as number) ?? store.get().tolerance,
    smoothing: (set.smoothing as number) ?? store.get().smoothing,
    removeBg: (set.removeBg as boolean) ?? store.get().removeBg,
    currentIconName: currentIconName || 'circle',
    colorMode: (set.colorMode as UiState['colorMode']) ?? 'normal',
    limitedColors: (set.limitedColors as RGB[]) ?? [],
    traceEngine: (set.traceEngine as UiState['traceEngine']) ?? 'potrace',
    bodyColorRgb: (set.bodyColorRgb as RGB) ?? [120, 124, 130],
    paletteOverrides: (set.paletteOverrides as RGB[]) ?? [],
    baseColorOverride: (set.baseColorOverride as RGB | null) ?? null,
    partOverrides: (set.partOverrides as Record<string, RGB>) ?? {},
    edgeSettings: (set.edgeSettings as EdgeSetting[]) ?? store.get().edgeSettings,
    componentHeights: (set.componentHeights as Record<string, number>) ?? {},
    shapeCornerRadius: (set.shapeCornerRadius as number) ?? 0,
    customOutline: (set.customOutline as Ring[] | null) ?? null,
  });

  if (store.get().importMode === 'image' && proj.image) {
    originalImage = await dataUrlToImage(proj.image as string);
  }

  reprocess();

  if (Array.isArray(proj.palette)) {
    const pal = store.get().palette.map((p, i) => ({
      ...p,
      filamentRgb: (proj.palette[i]?.filamentRgb as RGB) ?? p.filamentRgb,
    }));
    store.set({ palette: pal });
    rebuild();
  }

  if (!quiet) store.set({ status: 'Project loaded ✓' });
}

// ---- Render / project save-load / AI prompt ----
function downloadBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function imageToDataUrl(img: RgbaImage): string {
  const c = document.createElement('canvas');
  c.width = img.width;
  c.height = img.height;
  c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(img.data), img.width, img.height), 0, 0);
  return c.toDataURL('image/png');
}

function dataUrlToImage(url: string): Promise<RgbaImage> {
  return new Promise((resolve, reject) => {
    const im = new Image();
    im.onload = () => {
      const c = document.createElement('canvas');
      c.width = im.naturalWidth;
      c.height = im.naturalHeight;
      const ctx = c.getContext('2d')!;
      ctx.drawImage(im, 0, 0);
      const d = ctx.getImageData(0, 0, c.width, c.height);
      resolve({ data: d.data, width: c.width, height: c.height });
    };
    im.onerror = () => reject(new Error('bad image data'));
    im.src = url;
  });
}

function saveProject() {
  downloadBlob(new Blob([JSON.stringify(serializeProject())], { type: 'application/json' }), 'clicker-project.json');
  store.set({ status: 'Project saved ✓' });
}

async function loadProject(file: File) {
  try {
    store.set({ building: true, status: 'Loading project…' });
    const proj = JSON.parse(await file.text());
    await applyProject(proj);
  } catch (err) {
    store.set({ building: false, status: 'Could not load project: ' + String(err) });
  }
}

// ---- Auto-save + share link ----
const AUTOSAVE_KEY = 'clicker-project-autosave';

function debouncedAutosave() {
  window.clearTimeout((debouncedAutosave as any)._t);
  (debouncedAutosave as any)._t = window.setTimeout(() => {
    try {
      const proj = serializeProject();
      let payload = JSON.stringify(proj);
      if (payload.length > 4 * 1024 * 1024) {
        // Drop the image to stay under typical localStorage quotas.
        proj.image = null;
        payload = JSON.stringify(proj);
      }
      localStorage.setItem(AUTOSAVE_KEY, payload);
    } catch (e) {
      console.warn('[autosave] failed:', e);
    }
  }, 1000);
}

async function restoreAutosave(): Promise<boolean> {
  try {
    const raw = localStorage.getItem(AUTOSAVE_KEY);
    if (!raw) return false;
    const proj = JSON.parse(raw);
    await applyProject(proj, true);
    store.set({ status: 'Project restored from auto-save' });
    return true;
  } catch (e) {
    console.warn('[autosave] restore failed:', e);
    return false;
  }
}

async function shareProject() {
  try {
    const proj = serializeProject();
    // URL sharing omits the image unless it's tiny; recipients must re-drop the image.
    if (proj.image && proj.image.length > 50000) {
      proj.image = null;
    }
    const json = JSON.stringify(proj);
    const hash = btoa(encodeURIComponent(json))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    const url = `${location.origin}${location.pathname}#${hash}`;
    await navigator.clipboard.writeText(url);
    store.set({ status: 'Share link copied to clipboard ✓' });
  } catch (e) {
    store.set({ status: 'Could not copy share link' });
  }
}

async function restoreFromHash(): Promise<boolean> {
  try {
    const hash = location.hash.slice(1);
    if (!hash) return false;
    const b64 = hash.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((hash.length + 3) % 4);
    const json = decodeURIComponent(atob(b64));
    const proj = JSON.parse(json);
    window.history.replaceState(null, '', location.pathname + location.search);
    await applyProject(proj, true);
    store.set({ status: 'Project loaded from share link' });
    return true;
  } catch (e) {
    console.warn('[share] restore failed:', e);
    return false;
  }
}

const AI_PROMPT = [
  'Create a simple, flat vector-style illustration suitable for a small multi-color 3D print.',
  'Requirements:',
  '- Bold, clean shapes with thick outlines; no gradients, no shading, no texture.',
  '- A small number of FLAT solid colors (4–6 max), each clearly separated.',
  '- Centered subject on a plain solid (or transparent) background.',
  '- High contrast between adjacent colors; avoid thin slivers and tiny details.',
  '- Square-ish framing, subject fills ~80% of the canvas.',
  'Subject: <describe your subject here>.',
].join('\n');
