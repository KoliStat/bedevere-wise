// WebGL spike entry — reachable via `?webgl-spike` in the URL.
// Mounts a self-contained WebGL2 grid against a synthetic 1M-row dataset
// next to a vanilla canvas-2d baseline rendered the same way for direct
// visual + perf comparison. Outside the TabManager / BedevereApp flow on
// purpose: this is exploratory code, not a production path.
//
// See WEBGL_SPIKE.md at the repo root for findings and verdict.

import "./styles/main.scss";
import { WebGLGrid, WebGLGridPalette } from "./components/SpreadsheetVisualizer/webgl/WebGLGrid";

const ROW_COUNT = 1_000_000;
const COL_COUNT = 50;
const ROW_HEIGHT = 24;
const COL_WIDTH = 120;
const ROW_HEADER_WIDTH = 60;
const HEADER_HEIGHT = 28;

// Tokyonight Storm — kept in sync by hand with `theme.ts`. The spike is
// dark-only on purpose; the theme dimension is unrelated to GPU rendering.
const PALETTE: WebGLGridPalette = {
  bg:             [0x1a / 255, 0x1b / 255, 0x26 / 255, 1],
  bgDark:         [0x16 / 255, 0x16 / 255, 0x1e / 255, 1],
  stripe:         [0x1d / 255, 0x1f / 255, 0x2c / 255, 1],
  border:         [0x29 / 255, 0x2e / 255, 0x42 / 255, 1],
  fg:             [0xc0 / 255, 0xca / 255, 0xf5 / 255],
  fgMuted:        [0x56 / 255, 0x5f / 255, 0x89 / 255],
  selectionFill:  [0x7a / 255, 0xa2 / 255, 0xf7 / 255, 0.22],
};

// Synthetic data — string-formatted numbers with a deterministic pattern,
// so the cost of rendering is text + layout, not data fetching.
const cellText = (row: number, col: number): string => {
  const v = (row * 31 + col * 7) % 100000;
  return col % 4 === 0 ? `R${row + 1}` : v.toString().padStart(5, "0");
};
const headerText = (col: number): string => `col_${col.toString().padStart(2, "0")}`;

interface PerfReadout {
  fps: number;
  avgMs: number;
  maxMs: number;
  rectCount: number;
  rendererLabel: string;
}

interface RendererHandle {
  draw(): void;
  setScroll(x: number, y: number): void;
  resize(w: number, h: number): void;
  perfRead(): { lastFrameMs: number; lastRectCount: number };
  destroy(): void;
}

export async function runWebGLSpike(host: HTMLElement): Promise<void> {
  document.title = "Bedevere — WebGL spike";
  document.body.classList.add("theme-dark");
  host.style.cssText = `
    margin: 0;
    background: ${rgbCss(PALETTE.bgDark)};
    color: ${rgbCss(PALETTE.fg)};
    font-family: Consolas, monospace;
    overflow: hidden;
    height: 100vh;
    display: grid;
    grid-template-rows: 28px 1fr 1fr;
  `;
  host.innerHTML = "";

  // Banner with a renderer toggle + perf readout.
  const banner = document.createElement("div");
  banner.style.cssText = `
    display: flex; align-items: center; gap: 16px; padding: 0 12px;
    background: ${rgbaCss(PALETTE.bgDark)}; border-bottom: 1px solid ${rgbaCss(PALETTE.border)};
    font-size: 12px;
  `;
  banner.innerHTML = `
    <strong>WebGL spike</strong>
    <span>1M rows × ${COL_COUNT} cols</span>
    <span id="webgl-perf">webgl: \u2014</span>
    <span id="canvas-perf">canvas2d: \u2014</span>
    <span style="margin-left:auto;opacity:.7">scroll either pane</span>
  `;
  host.appendChild(banner);

  // Two side-by-side renderers, stacked vertically because the viewport
  // axis matters: cell counts scale with width × height.
  const webglPane = document.createElement("div");
  const canvasPane = document.createElement("div");
  for (const pane of [webglPane, canvasPane]) {
    pane.style.cssText = `
      position: relative; overflow: auto; outline: none;
      border-bottom: 1px solid ${rgbaCss(PALETTE.border)};
    `;
    pane.tabIndex = 0;
  }
  host.appendChild(webglPane);
  host.appendChild(canvasPane);

  const webglRenderer = mountWebGL(webglPane);
  const canvasRenderer = mountCanvas2D(canvasPane);

  const webglPerfEl = document.getElementById("webgl-perf")!;
  const canvasPerfEl = document.getElementById("canvas-perf")!;
  const perf = {
    webgl: new RollingPerf(),
    canvas: new RollingPerf(),
  };

  const tick = () => {
    requestAnimationFrame(tick);
    if (webglRenderer.dirty) {
      webglRenderer.handle.draw();
      const r = webglRenderer.handle.perfRead();
      perf.webgl.push(r.lastFrameMs, r.lastRectCount);
      webglRenderer.dirty = false;
    }
    if (canvasRenderer.dirty) {
      canvasRenderer.handle.draw();
      const r = canvasRenderer.handle.perfRead();
      perf.canvas.push(r.lastFrameMs, r.lastRectCount);
      canvasRenderer.dirty = false;
    }
    webglPerfEl.textContent = formatPerf("webgl", perf.webgl.read());
    canvasPerfEl.textContent = formatPerf("canvas2d", perf.canvas.read());
  };
  requestAnimationFrame(tick);
}

interface MountedRenderer {
  handle: RendererHandle;
  dirty: boolean;
}

function mountWebGL(pane: HTMLElement): MountedRenderer {
  const canvas = document.createElement("canvas");
  canvas.style.cssText = "display:block;position:sticky;top:0;left:0;";
  const spacer = document.createElement("div");
  spacer.style.cssText = `width:${COL_COUNT * COL_WIDTH + ROW_HEADER_WIDTH}px;height:${ROW_COUNT * ROW_HEIGHT + HEADER_HEIGHT}px;position:absolute;top:0;left:0;`;
  pane.appendChild(spacer);
  pane.appendChild(canvas);
  // Position canvas to overlay scroll viewport.
  canvas.style.position = "sticky";
  canvas.style.top = "0";
  canvas.style.left = "0";

  const grid = new WebGLGrid({
    canvas,
    rowCount: ROW_COUNT,
    colCount: COL_COUNT,
    rowHeight: ROW_HEIGHT,
    colWidth: COL_WIDTH,
    rowHeaderWidth: ROW_HEADER_WIDTH,
    headerHeight: HEADER_HEIGHT,
    cellText,
    headerText,
    palette: PALETTE,
  });

  const mounted: MountedRenderer = {
    handle: {
      draw: () => grid.draw(),
      setScroll: (x, y) => grid.setScroll(x, y),
      resize: (w, h) => grid.resize(w, h),
      perfRead: () => ({ lastFrameMs: grid.lastFrameMs, lastRectCount: grid.lastRectCount }),
      destroy: () => {/* no-op; gc handles it */},
    },
    dirty: true,
  };

  const onResize = () => {
    grid.resize(pane.clientWidth, pane.clientHeight);
    mounted.dirty = true;
  };
  onResize();
  new ResizeObserver(onResize).observe(pane);

  pane.addEventListener("scroll", () => {
    grid.setScroll(pane.scrollLeft, pane.scrollTop);
    mounted.dirty = true;
  });

  return mounted;
}

/**
 * Vanilla canvas-2d baseline using the same painting model the production
 * SpreadsheetVisualizer uses (after Phase A): single Path2D for the grid,
 * pixel-snapped text, alternating stripes. The spike compares LIKE WITH
 * LIKE — both renderers paint the same scene from the same data.
 */
function mountCanvas2D(pane: HTMLElement): MountedRenderer {
  const canvas = document.createElement("canvas");
  canvas.style.cssText = "display:block;position:sticky;top:0;left:0;";
  const spacer = document.createElement("div");
  spacer.style.cssText = `width:${COL_COUNT * COL_WIDTH + ROW_HEADER_WIDTH}px;height:${ROW_COUNT * ROW_HEIGHT + HEADER_HEIGHT}px;position:absolute;top:0;left:0;`;
  pane.appendChild(spacer);
  pane.appendChild(canvas);

  let scrollX = 0;
  let scrollY = 0;
  let viewportWidth = 0;
  let viewportHeight = 0;
  let lastMs = 0;
  let dpr = window.devicePixelRatio || 1;
  const ctx = canvas.getContext("2d", { alpha: false })!;

  const draw = (): void => {
    const t0 = performance.now();
    const W = viewportWidth;
    const H = viewportHeight;
    const ch = ROW_HEIGHT;
    const cw = COL_WIDTH;
    const rhw = ROW_HEADER_WIDTH;
    const hh = HEADER_HEIGHT;
    const pad = 8;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    // Backgrounds
    ctx.fillStyle = rgbCss(PALETTE.bg);
    ctx.fillRect(rhw, hh, W - rhw, H - hh);
    ctx.fillStyle = rgbCss(PALETTE.bgDark);
    ctx.fillRect(0, 0, W, hh);
    ctx.fillRect(0, 0, rhw, H);

    const firstRow = Math.max(0, Math.floor(scrollY / ch));
    const lastRow = Math.min(ROW_COUNT, Math.ceil((scrollY + H - hh) / ch) + 1);
    const firstCol = Math.max(0, Math.floor(scrollX / cw));
    const lastCol = Math.min(COL_COUNT, Math.ceil((scrollX + W - rhw) / cw) + 1);

    // Stripes
    ctx.fillStyle = rgbCss(PALETTE.stripe);
    for (let row = firstRow; row < lastRow; row++) {
      if ((row & 1) === 1) {
        const y = hh + row * ch - scrollY;
        ctx.fillRect(rhw, y, W - rhw, ch);
      }
    }

    // Cell text
    ctx.font = "13px Consolas, monospace";
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";
    ctx.fillStyle = rgbCss(PALETTE.fg);
    for (let row = firstRow; row < lastRow; row++) {
      const y = hh + row * ch - scrollY + ch / 2;
      for (let col = firstCol; col < lastCol; col++) {
        const x = rhw + col * cw - scrollX + pad;
        ctx.fillText(cellText(row, col), Math.round(x), Math.round(y));
      }
    }

    // Headers
    for (let col = firstCol; col < lastCol; col++) {
      const x = rhw + col * cw - scrollX + pad;
      ctx.fillText(headerText(col), Math.round(x), Math.round(hh / 2));
    }

    // Row indices
    ctx.fillStyle = rgbCss(PALETTE.fgMuted);
    ctx.textAlign = "right";
    for (let row = firstRow; row < lastRow; row++) {
      const y = hh + row * ch - scrollY + ch / 2;
      ctx.fillText((row + 1).toString(), rhw - pad, Math.round(y));
    }

    // Single-path grid
    ctx.strokeStyle = rgbaCss(PALETTE.border);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, hh + 0.5);
    ctx.lineTo(W, hh + 0.5);
    for (let row = firstRow + 1; row <= lastRow; row++) {
      const y = hh + row * ch - scrollY;
      ctx.moveTo(0, y + 0.5);
      ctx.lineTo(W, y + 0.5);
    }
    ctx.moveTo(rhw + 0.5, 0);
    ctx.lineTo(rhw + 0.5, H);
    for (let col = firstCol + 1; col <= lastCol; col++) {
      const x = rhw + col * cw - scrollX;
      ctx.moveTo(x + 0.5, 0);
      ctx.lineTo(x + 0.5, H);
    }
    ctx.stroke();

    lastMs = performance.now() - t0;
  };

  const mounted: MountedRenderer = {
    handle: {
      draw,
      setScroll: (x, y) => { scrollX = x; scrollY = y; },
      resize: (w, h) => {
        dpr = window.devicePixelRatio || 1;
        viewportWidth = w;
        viewportHeight = h;
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
        canvas.style.width = `${w}px`;
        canvas.style.height = `${h}px`;
      },
      perfRead: () => ({ lastFrameMs: lastMs, lastRectCount: 0 }),
      destroy: () => {/* no-op */},
    },
    dirty: true,
  };

  const onResize = () => {
    mounted.handle.resize(pane.clientWidth, pane.clientHeight);
    mounted.dirty = true;
  };
  onResize();
  new ResizeObserver(onResize).observe(pane);

  pane.addEventListener("scroll", () => {
    mounted.handle.setScroll(pane.scrollLeft, pane.scrollTop);
    mounted.dirty = true;
  });

  return mounted;
}

class RollingPerf {
  private samples: number[] = [];
  private rectCounts: number[] = [];
  private static MAX = 60;
  push(ms: number, rectCount: number): void {
    this.samples.push(ms);
    this.rectCounts.push(rectCount);
    if (this.samples.length > RollingPerf.MAX) this.samples.shift();
    if (this.rectCounts.length > RollingPerf.MAX) this.rectCounts.shift();
  }
  read(): PerfReadout {
    if (this.samples.length === 0) {
      return { fps: 0, avgMs: 0, maxMs: 0, rectCount: 0, rendererLabel: "" };
    }
    const sum = this.samples.reduce((a, b) => a + b, 0);
    const avg = sum / this.samples.length;
    const max = Math.max(...this.samples);
    return {
      fps: avg > 0 ? Math.round(1000 / avg) : 0,
      avgMs: avg,
      maxMs: max,
      rectCount: this.rectCounts[this.rectCounts.length - 1],
      rendererLabel: "",
    };
  }
}

function formatPerf(label: string, p: PerfReadout): string {
  if (p.avgMs === 0) return `${label}: \u2014`;
  return `${label}: avg ${p.avgMs.toFixed(2)}ms (${p.fps}fps), p-max ${p.maxMs.toFixed(2)}ms${p.rectCount ? `, ${p.rectCount} rects` : ""}`;
}

function rgbCss(c: [number, number, number] | [number, number, number, number]): string {
  const [r, g, b] = c;
  return `rgb(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)})`;
}

function rgbaCss(c: [number, number, number, number]): string {
  const [r, g, b, a] = c;
  return `rgba(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)}, ${a})`;
}
