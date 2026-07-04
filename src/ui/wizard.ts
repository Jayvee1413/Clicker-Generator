// Bambu-style image → model wizard. A single modal step:
//   Preprocessing — interactive crop, crop ratio, keep background, thickness,
//   tone/color sliders, color count, and a live quantized palette preview.
// On confirm it hands the adjusted image (background intact) + params back; the
// caller runs the trace/build pipeline (background removal is re-derived there).
import type { RgbaImage } from '../image/decode';
import { preprocessImage } from '../image/adjust';
import { removeBackground } from '../image/matte';
import { processImage } from '../image/pipeline';
import { DEFAULT_PREPROCESS, type CropRatio, type PreprocessParams, type RGB } from '../types';

export interface WizardResult {
  adjusted: RgbaImage; // cropped + tone-adjusted, background still present
  preprocess: PreprocessParams;
  colorCount: number;
  colorMode: 'normal' | 'limited';
  limitedColors?: RGB[];
  paletteOverrides?: RGB[];
}

interface WizardOpts {
  baseImage: RgbaImage;
  initialColorCount: number;
  onComplete(result: WizardResult): void;
  onCancel?(): void;
}

const SLIDERS: [keyof PreprocessParams, string][] = [
  ['exposure', 'Exposure'],
  ['contrast', 'Contrast'],
  ['saturation', 'Saturation'],
  ['brightness', 'Brightness'],
  ['whiteBalance', 'White Balance'],
  ['highlights', 'Highlights'],
  ['shadows', 'Shadows'],
];

const RATIOS: [CropRatio, string][] = [
  ['free', 'Free'],
  ['1:1', '1:1'],
  ['4:3', '4:3'],
  ['3:2', '3:2'],
  ['16:9', '16:9'],
];

const ALPHA_THRESHOLD = 128;

function hasOutline(img: RgbaImage, keepBackground: boolean): boolean {
  if (keepBackground) return true;
  const clone: RgbaImage = {
    data: new Uint8ClampedArray(img.data),
    width: img.width,
    height: img.height,
  };
  removeBackground(clone);
  let fg = 0;
  for (let p = 3; p < clone.data.length; p += 4) if (clone.data[p] >= ALPHA_THRESHOLD) fg++;
  return fg > 8;
}

function imageToCanvas(img: RgbaImage): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = img.width;
  c.height = img.height;
  const ctx = c.getContext('2d')!;
  ctx.putImageData(new ImageData(new Uint8ClampedArray(img.data), img.width, img.height), 0, 0);
  return c;
}

function rgbToCss(rgb: RGB): string {
  return `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`;
}

export function runWizard(opts: WizardOpts) {
  const params: PreprocessParams = { ...DEFAULT_PREPROCESS };
  let colorCount = Math.max(2, Math.min(12, opts.initialColorCount));

  const overlay = document.createElement('div');
  overlay.className = 'wz-overlay';
  document.body.appendChild(overlay);

  const close = () => overlay.remove();
  const cancel = () => {
    close();
    opts.onCancel?.();
  };

  const adjusted = () => preprocessImage(opts.baseImage, params);

  function fitCropToRatio(ratio: CropRatio) {
    if (ratio === 'free') {
      params.crop = null;
      return;
    }
    const W = opts.baseImage.width;
    const H = opts.baseImage.height;
    const map: Record<string, number> = { '1:1': 1, '4:3': 4 / 3, '3:2': 3 / 2, '16:9': 16 / 9 };
    const target = map[ratio];
    let w = W;
    let h = Math.round(W / target);
    if (h > H) {
      h = H;
      w = Math.round(H * target);
    }
    params.crop = { x: Math.round((W - w) / 2), y: Math.round((H - h) / 2), w, h };
  }

  fitCropToRatio(params.cropRatio);

  function stepPreprocess() {
    overlay.innerHTML = `
      <div class="wz-modal lg">
        <div class="wz-head">Image Preprocessing</div>
        <div class="wz-body">
          <div class="wz-crop-wrap checker" id="wzCropWrap">
            <div class="wz-canvas" id="wzPrev"></div>
            <div class="wz-crop-rect" id="wzCropRect">
              <div class="wz-crop-handle nw" data-handle="nw"></div>
              <div class="wz-crop-handle ne" data-handle="ne"></div>
              <div class="wz-crop-handle sw" data-handle="sw"></div>
              <div class="wz-crop-handle se" data-handle="se"></div>
            </div>
          </div>
          <div class="wz-controls">
            <div class="wz-label">Crop Ratio</div>
            <div class="seg" id="wzRatio">${RATIOS.map(
              ([k, l]) => `<button data-r="${k}">${l}</button>`,
            ).join('')}</div>

            <div class="field" style="margin: 12px 0;">
              <label for="wzColorCount">Colors</label>
              <select id="wzColorCount">
                ${Array.from({ length: 11 }, (_, i) => {
                  const n = i + 2;
                  return `<option value="${n}">${n} Colors</option>`;
                }).join('')}
              </select>
            </div>

            <div class="wz-label">Quantized Palette Preview</div>
            <div class="wz-palette" id="wzPalette"></div>

            <div class="wz-row spread">
              <span class="wz-label">Keep Background</span>
              <label class="toggle"><input type="checkbox" id="wzKeep" /><span class="track"></span></label>
            </div>

            <div class="wz-row spread">
              <span class="wz-label">Image Thickness</span>
              <span class="wz-num"><input type="number" id="wzThick" min="0.2" max="10" step="0.2" /> mm</span>
            </div>

            <div class="wz-label">Image Adjustment</div>
            ${SLIDERS.map(
              ([k, l]) => `
              <div class="wz-adj">
                <span>${l}</span>
                <input type="range" data-k="${k}" min="0" max="2" step="0.05" />
                <span class="wz-num"><input type="number" data-n="${k}" min="0" max="2" step="0.05" /></span>
              </div>`,
            ).join('')}
          </div>
        </div>
        <div class="wz-foot">
          <span class="wz-error" id="wzErr" hidden>No outline found — adjust the image and try again.</span>
          <button id="wzCancel">Cancel</button>
          <button class="primary" id="wzDone">Confirm</button>
        </div>
      </div>`;

    const wrap = overlay.querySelector<HTMLElement>('#wzCropWrap')!;
    const prev = overlay.querySelector<HTMLElement>('#wzPrev')!;
    const rect = overlay.querySelector<HTMLElement>('#wzCropRect')!;
    const done = overlay.querySelector<HTMLButtonElement>('#wzDone')!;
    const err = overlay.querySelector<HTMLElement>('#wzErr')!;
    const colorSel = overlay.querySelector<HTMLSelectElement>('#wzColorCount')!;
    const paletteEl = overlay.querySelector<HTMLElement>('#wzPalette')!;

    colorSel.value = String(colorCount);

    function updateCropRect() {
      const img = opts.baseImage;
      const wrapRect = wrap.getBoundingClientRect();
      const scaleX = wrapRect.width / img.width;
      const scaleY = wrapRect.height / img.height;
      const c = params.crop;
      if (!c) {
        rect.style.display = 'none';
        return;
      }
      rect.style.display = 'block';
      rect.style.left = `${c.x * scaleX}px`;
      rect.style.top = `${c.y * scaleY}px`;
      rect.style.width = `${c.w * scaleX}px`;
      rect.style.height = `${c.h * scaleY}px`;
    }

    function updatePalette() {
      try {
        const a = adjusted();
        const rs = processImage(
          { data: new Uint8ClampedArray(a.data), width: a.width, height: a.height },
          colorCount,
          { removeBg: params.keepBackground, smoothing: 0 },
        );
        paletteEl.innerHTML = '';
        if (!rs.regions.length) {
          paletteEl.innerHTML = '<span class="wz-sub">No colors found</span>';
          return;
        }
        for (const r of rs.regions) {
          const dot = document.createElement('span');
          dot.className = 'wz-palette-dot';
          dot.style.backgroundColor = rgbToCss(r.quantRgb);
          dot.title = `${r.quantRgb.join(', ')} — ${Math.round(r.coverage * 100)}%`;
          paletteEl.appendChild(dot);
        }
      } catch {
        paletteEl.innerHTML = '<span class="wz-sub">Preview unavailable</span>';
      }
    }

    let paletteTimer = 0;
    const schedulePalette = () => {
      window.clearTimeout(paletteTimer);
      paletteTimer = window.setTimeout(updatePalette, 120);
    };

    const redraw = () => {
      const a = adjusted();
      prev.innerHTML = '';
      prev.appendChild(imageToCanvas(a));
      updateCropRect();
      const ok = hasOutline(a, params.keepBackground);
      done.disabled = !ok;
      err.hidden = ok;
      schedulePalette();
    };
    redraw();

    // Crop interaction
    let dragging: { action: 'move' | 'resize'; handle?: string; startX: number; startY: number; startCrop: NonNullable<PreprocessParams['crop']> } | null = null;

    const startDrag = (e: PointerEvent, action: 'move' | 'resize', handle?: string) => {
      if (!params.crop) return;
      e.preventDefault();
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
      dragging = { action, handle, startX: e.clientX, startY: e.clientY, startCrop: { ...params.crop } };
    };

    const onPointerMove = (e: PointerEvent) => {
      if (!dragging || !params.crop) return;
      const img = opts.baseImage;
      const wrapRect = wrap.getBoundingClientRect();
      const dx = Math.round((e.clientX - dragging.startX) * (img.width / wrapRect.width));
      const dy = Math.round((e.clientY - dragging.startY) * (img.height / wrapRect.height));
      let { x, y, w, h } = dragging.startCrop;

      if (dragging.action === 'move') {
        x += dx;
        y += dy;
      } else if (dragging.handle) {
        const keepRatio = params.cropRatio !== 'free';
        const ratio = w / h;
        switch (dragging.handle) {
          case 'se':
            w += dx; h += dy;
            break;
          case 'nw':
            x += dx; y += dy; w -= dx; h -= dy;
            break;
          case 'ne':
            y += dy; w += dx; h -= dy;
            break;
          case 'sw':
            x += dx; w -= dx; h += dy;
            break;
        }
        if (keepRatio) {
          if (Math.abs(w) > Math.abs(h) * ratio) w = Math.round(h * ratio);
          else h = Math.round(w / ratio);
        }
      }

      // Clamp
      w = Math.max(8, Math.min(w, img.width));
      h = Math.max(8, Math.min(h, img.height));
      x = Math.max(0, Math.min(x, img.width - w));
      y = Math.max(0, Math.min(y, img.height - h));

      params.crop = { x, y, w, h };
      updateCropRect();
      schedulePalette();
    };

    const onPointerUp = (e: PointerEvent) => {
      if (!dragging) return;
      (e.target as HTMLElement).releasePointerCapture(e.pointerId);
      dragging = null;
      redraw();
    };

    rect.addEventListener('pointerdown', (e) => {
      const target = e.target as HTMLElement;
      const handle = target.dataset.handle;
      if (handle) startDrag(e, 'resize', handle);
      else startDrag(e, 'move');
    });
    rect.addEventListener('pointermove', onPointerMove);
    rect.addEventListener('pointerup', onPointerUp);
    rect.addEventListener('pointercancel', onPointerUp);

    for (const b of overlay.querySelectorAll<HTMLElement>('#wzRatio button')) {
      b.classList.toggle('active', b.dataset.r === params.cropRatio);
      b.addEventListener('click', () => {
        params.cropRatio = b.dataset.r as CropRatio;
        fitCropToRatio(params.cropRatio);
        for (const x of overlay.querySelectorAll('#wzRatio button')) x.classList.remove('active');
        b.classList.add('active');
        redraw();
      });
    }

    colorSel.addEventListener('change', () => {
      colorCount = Math.max(2, Math.min(12, +colorSel.value || 4));
      updatePalette();
    });

    const keep = overlay.querySelector<HTMLInputElement>('#wzKeep')!;
    keep.checked = params.keepBackground;
    keep.addEventListener('change', () => {
      params.keepBackground = keep.checked;
      redraw();
    });

    const thick = overlay.querySelector<HTMLInputElement>('#wzThick')!;
    thick.value = String(params.thicknessMm);
    thick.addEventListener('input', () => (params.thicknessMm = +thick.value || 1));

    let raf = 0;
    const scheduleRedraw = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(redraw);
    };
    for (const [k] of SLIDERS) {
      const range = overlay.querySelector<HTMLInputElement>(`input[data-k="${k}"]`)!;
      const num = overlay.querySelector<HTMLInputElement>(`input[data-n="${k}"]`)!;
      range.value = num.value = String(params[k] as number);
      const apply = (v: number) => {
        (params[k] as number) = v;
        range.value = num.value = String(v);
        scheduleRedraw();
      };
      range.addEventListener('input', () => apply(+range.value));
      num.addEventListener('input', () => apply(+num.value));
    }

    overlay.querySelector('#wzCancel')!.addEventListener('click', cancel);
    done.addEventListener('click', () => {
      if (done.disabled) return;
      close();
      opts.onComplete({
        adjusted: adjusted(),
        preprocess: { ...params },
        colorCount,
        colorMode: 'normal',
      });
    });

    window.setTimeout(updateCropRect, 0);
  }

  stepPreprocess();
}
