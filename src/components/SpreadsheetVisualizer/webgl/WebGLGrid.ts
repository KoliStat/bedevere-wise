/**
 * WebGL2 spike: instanced-quad cell renderer for the spreadsheet.
 *
 * Scope (deliberately small — see WEBGL_SPIKE.md at repo root for the
 * design write-up):
 *
 *   - Renders cell backgrounds, alternating row stripes, gridlines, and
 *     the selection highlight as a single batched draw call (instanced
 *     unit quads). Capable of 100k+ rectangles per frame.
 *   - Text is rendered into an offscreen canvas-2d at every redraw and
 *     blitted as a single textured quad on top. The spike does NOT build
 *     a glyph atlas — that's the text-rendering R&D the writeup
 *     identifies as the real cost of going GPU-native.
 *   - No selection / hover overlay logic, no scroll bars, no headers
 *     beyond the column-name strip. The point is to MEASURE rect-batch
 *     throughput vs. canvas-2d, not to be a drop-in replacement.
 *
 * Run it via `?webgl-spike` in the URL. See `src/webgl-spike.ts`.
 */

import { RECT_VS, RECT_FS, TEX_VS, TEX_FS } from "./shaders";

export interface WebGLGridConfig {
  canvas: HTMLCanvasElement;
  /** Total rows in the synthetic dataset. */
  rowCount: number;
  /** Total columns. */
  colCount: number;
  /** Row height in CSS pixels. */
  rowHeight: number;
  /** Column width in CSS pixels (uniform across columns for the spike). */
  colWidth: number;
  /** Width of the row-index gutter in CSS pixels. */
  rowHeaderWidth: number;
  /** Height of the header row in CSS pixels. */
  headerHeight: number;
  /** Synthetic data callback — given (row, col) return the cell text. */
  cellText: (row: number, col: number) => string;
  /** Column header text (length must equal colCount). */
  headerText: (col: number) => string;
  /** Tokyonight Storm palette — same hex values as theme.ts. */
  palette: WebGLGridPalette;
}

export interface WebGLGridPalette {
  bg: [number, number, number, number];
  bgDark: [number, number, number, number];
  stripe: [number, number, number, number];
  border: [number, number, number, number];
  fg: [number, number, number]; // text colour for the canvas-2d overlay
  fgMuted: [number, number, number];
  selectionFill: [number, number, number, number];
}

interface ProgramInfo {
  program: WebGLProgram;
  attribs: Record<string, number>;
  uniforms: Record<string, WebGLUniformLocation | null>;
}

const QUAD_CORNERS = new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]);

/**
 * Instance buffer layout: 8 floats per rectangle.
 *   [x, y, w, h, r, g, b, a]
 *
 * 8 × Float32 = 32 bytes per rect; 100k rects = 3.2 MB. Well within
 * VRAM bounds even on integrated GPUs.
 */
const FLOATS_PER_RECT = 8;

export class WebGLGrid {
  private canvas: HTMLCanvasElement;
  private gl: WebGL2RenderingContext;
  private rectProgram: ProgramInfo;
  private texProgram: ProgramInfo;

  private quadBuffer: WebGLBuffer;
  private instanceBuffer: WebGLBuffer;
  private fullscreenQuadBuffer: WebGLBuffer;
  private vao: WebGLVertexArrayObject;
  private texVao: WebGLVertexArrayObject;
  private textTexture: WebGLTexture;
  private textCanvas: HTMLCanvasElement;
  private textCtx: CanvasRenderingContext2D;

  private config: WebGLGridConfig;
  private dpr: number;
  private viewportWidth = 0;
  private viewportHeight = 0;

  private scrollX = 0;
  private scrollY = 0;

  // Reusable scratch buffer for instance data — preallocated to the worst
  // case (one rect per visible cell + stripes + gridlines + selection).
  private instanceScratch = new Float32Array(0);

  // Last frame timing for the perf overlay.
  public lastFrameMs = 0;
  public lastRectCount = 0;

  constructor(config: WebGLGridConfig) {
    this.config = config;
    this.canvas = config.canvas;
    const gl = this.canvas.getContext("webgl2", { antialias: false, alpha: false });
    if (!gl) throw new Error("WebGL2 not available — spike requires WebGL2 support.");
    this.gl = gl;
    this.dpr = window.devicePixelRatio || 1;

    this.rectProgram = this.compileProgram(RECT_VS, RECT_FS, ["a_corner", "a_rect", "a_color"], ["u_projection"]);
    this.texProgram = this.compileProgram(TEX_VS, TEX_FS, ["a_pos", "a_uv"], ["u_tex"]);

    this.quadBuffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, QUAD_CORNERS, gl.STATIC_DRAW);

    this.instanceBuffer = gl.createBuffer()!;

    // Fullscreen-quad geometry for the text texture blit (NDC + UV).
    // Two triangles, 6 verts × 4 floats each.
    this.fullscreenQuadBuffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.fullscreenQuadBuffer);
    // prettier-ignore
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      // pos.x  pos.y   uv.x  uv.y
      -1, -1,    0, 1,
       1, -1,    1, 1,
      -1,  1,    0, 0,
      -1,  1,    0, 0,
       1, -1,    1, 1,
       1,  1,    1, 0,
    ]), gl.STATIC_DRAW);

    this.vao = this.buildRectVAO();
    this.texVao = this.buildTextVAO();

    this.textCanvas = document.createElement("canvas");
    this.textCtx = this.textCanvas.getContext("2d", { alpha: true })!;

    this.textTexture = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.textTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    gl.clearColor(...config.palette.bg);
  }

  // ---- Public API ---------------------------------------------------------

  public resize(cssWidth: number, cssHeight: number): void {
    this.dpr = window.devicePixelRatio || 1;
    this.viewportWidth = cssWidth;
    this.viewportHeight = cssHeight;
    this.canvas.width = Math.round(cssWidth * this.dpr);
    this.canvas.height = Math.round(cssHeight * this.dpr);
    this.canvas.style.width = `${cssWidth}px`;
    this.canvas.style.height = `${cssHeight}px`;
    this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    this.textCanvas.width = this.canvas.width;
    this.textCanvas.height = this.canvas.height;
  }

  public setScroll(x: number, y: number): void {
    this.scrollX = x;
    this.scrollY = y;
  }

  public draw(): void {
    const t0 = performance.now();
    const gl = this.gl;
    const cfg = this.config;
    const W = this.viewportWidth;
    const H = this.viewportHeight;
    const ch = cfg.rowHeight;
    const cw = cfg.colWidth;
    const rhw = cfg.rowHeaderWidth;
    const hh = cfg.headerHeight;

    // Visible cell range.
    const firstRow = Math.max(0, Math.floor(this.scrollY / ch));
    const lastRow = Math.min(cfg.rowCount, Math.ceil((this.scrollY + H - hh) / ch) + 1);
    const firstCol = Math.max(0, Math.floor(this.scrollX / cw));
    const lastCol = Math.min(cfg.colCount, Math.ceil((this.scrollX + W - rhw) / cw) + 1);
    const visibleRows = lastRow - firstRow;
    const visibleCols = lastCol - firstCol;

    // Worst-case rect count (header strip + gutter + stripes + gridlines).
    const stripes = visibleRows;
    const hLines = visibleRows + 2;       // row separators + header bottom + gutter top
    const vLines = visibleCols + 2;       // col separators + gutter right + outer
    const headers = visibleCols + visibleRows + 2; // column headers + row indices + corner + gutter strip
    const worstCase = stripes + hLines + vLines + headers + 2;
    if (this.instanceScratch.length < worstCase * FLOATS_PER_RECT) {
      this.instanceScratch = new Float32Array(worstCase * FLOATS_PER_RECT * 2);
    }
    const buf = this.instanceScratch;
    let n = 0;

    const push = (x: number, y: number, w: number, h: number, c: [number, number, number, number]): void => {
      const i = n * FLOATS_PER_RECT;
      buf[i] = x; buf[i + 1] = y; buf[i + 2] = w; buf[i + 3] = h;
      buf[i + 4] = c[0]; buf[i + 5] = c[1]; buf[i + 6] = c[2]; buf[i + 7] = c[3];
      n++;
    };

    const pal = cfg.palette;

    // 1. Solid backgrounds: cell area, header strip, row gutter.
    push(rhw, hh, W - rhw, H - hh, pal.bg);
    push(0, 0, W, hh, pal.bgDark);
    push(0, 0, rhw, H, pal.bgDark);

    // 2. Alternating row stripes.
    for (let row = firstRow; row < lastRow; row++) {
      if ((row & 1) === 1) {
        const y = hh + row * ch - this.scrollY;
        push(rhw, y, W - rhw, ch, pal.stripe);
      }
    }

    // 3. Gridlines as 1px-thick rectangles (instanced quads outperform
    //    LINE primitives at this scale because GPUs avoid line-rendering
    //    fast paths for non-AA 1px lines).
    // Header bottom edge.
    push(0, hh, W, 1, pal.border);
    // Row separators.
    for (let row = firstRow + 1; row <= lastRow; row++) {
      const y = hh + row * ch - this.scrollY;
      push(0, y, W, 1, pal.border);
    }
    // Gutter right edge.
    push(rhw, 0, 1, H, pal.border);
    // Column separators.
    for (let col = firstCol + 1; col <= lastCol; col++) {
      const x = rhw + col * cw - this.scrollX;
      push(x, 0, 1, H, pal.border);
    }

    this.lastRectCount = n;

    // 4. Upload instance buffer + draw rects.
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, buf.subarray(0, n * FLOATS_PER_RECT), gl.STREAM_DRAW);

    gl.useProgram(this.rectProgram.program);
    gl.uniformMatrix4fv(this.rectProgram.uniforms.u_projection, false, this.orthoMatrix(W, H));
    gl.disable(gl.BLEND);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, n);

    // 5. Render text into the offscreen canvas-2d, upload as texture,
    //    blit on top. This is the spike's most informative cost: every
    //    frame re-rasterises every visible glyph through canvas-2d.
    this.renderTextLayer(firstRow, lastRow, firstCol, lastCol);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.textTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.textCanvas);

    gl.useProgram(this.texProgram.program);
    gl.uniform1i(this.texProgram.uniforms.u_tex, 0);
    gl.bindVertexArray(this.texVao);
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    this.lastFrameMs = performance.now() - t0;
  }

  // ---- Internals ----------------------------------------------------------

  private renderTextLayer(firstRow: number, lastRow: number, firstCol: number, lastCol: number): void {
    const cfg = this.config;
    const ctx = this.textCtx;
    const W = this.canvas.width;
    const H = this.canvas.height;
    const dpr = this.dpr;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.scale(dpr, dpr);
    ctx.font = `${13}px Consolas, monospace`;
    ctx.textBaseline = "middle";

    const ch = cfg.rowHeight;
    const cw = cfg.colWidth;
    const rhw = cfg.rowHeaderWidth;
    const hh = cfg.headerHeight;
    const pad = 8;

    const fg = cfg.palette.fg;
    const fgMuted = cfg.palette.fgMuted;

    // Cell text
    ctx.fillStyle = `rgb(${fg[0] * 255}, ${fg[1] * 255}, ${fg[2] * 255})`;
    ctx.textAlign = "left";
    for (let row = firstRow; row < lastRow; row++) {
      const y = hh + row * ch - this.scrollY + ch / 2;
      for (let col = firstCol; col < lastCol; col++) {
        const x = rhw + col * cw - this.scrollX + pad;
        ctx.fillText(cfg.cellText(row, col), Math.round(x), Math.round(y));
      }
    }

    // Column headers
    ctx.fillStyle = `rgb(${fg[0] * 255}, ${fg[1] * 255}, ${fg[2] * 255})`;
    const headerY = hh / 2;
    for (let col = firstCol; col < lastCol; col++) {
      const x = rhw + col * cw - this.scrollX + pad;
      ctx.fillText(cfg.headerText(col), Math.round(x), Math.round(headerY));
    }

    // Row indices (right-aligned)
    ctx.fillStyle = `rgb(${fgMuted[0] * 255}, ${fgMuted[1] * 255}, ${fgMuted[2] * 255})`;
    ctx.textAlign = "right";
    const indexX = rhw - pad;
    for (let row = firstRow; row < lastRow; row++) {
      const y = hh + row * ch - this.scrollY + ch / 2;
      ctx.fillText((row + 1).toString(), indexX, Math.round(y));
    }
  }

  private buildRectVAO(): WebGLVertexArrayObject {
    const gl = this.gl;
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);

    // Per-vertex: a_corner (vec2)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
    const cornerLoc = this.rectProgram.attribs.a_corner;
    gl.enableVertexAttribArray(cornerLoc);
    gl.vertexAttribPointer(cornerLoc, 2, gl.FLOAT, false, 0, 0);

    // Per-instance: a_rect (vec4) + a_color (vec4) — interleaved in one buffer.
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer);
    const stride = FLOATS_PER_RECT * 4;
    const rectLoc = this.rectProgram.attribs.a_rect;
    gl.enableVertexAttribArray(rectLoc);
    gl.vertexAttribPointer(rectLoc, 4, gl.FLOAT, false, stride, 0);
    gl.vertexAttribDivisor(rectLoc, 1);
    const colorLoc = this.rectProgram.attribs.a_color;
    gl.enableVertexAttribArray(colorLoc);
    gl.vertexAttribPointer(colorLoc, 4, gl.FLOAT, false, stride, 16);
    gl.vertexAttribDivisor(colorLoc, 1);

    gl.bindVertexArray(null);
    return vao;
  }

  private buildTextVAO(): WebGLVertexArrayObject {
    const gl = this.gl;
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.fullscreenQuadBuffer);
    const stride = 4 * 4;
    const posLoc = this.texProgram.attribs.a_pos;
    const uvLoc = this.texProgram.attribs.a_uv;
    gl.enableVertexAttribArray(posLoc);
    gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(uvLoc);
    gl.vertexAttribPointer(uvLoc, 2, gl.FLOAT, false, stride, 8);
    gl.bindVertexArray(null);
    return vao;
  }

  private compileProgram(
    vsSrc: string,
    fsSrc: string,
    attribNames: string[],
    uniformNames: string[],
  ): ProgramInfo {
    const gl = this.gl;
    const vs = this.compileShader(gl.VERTEX_SHADER, vsSrc);
    const fs = this.compileShader(gl.FRAGMENT_SHADER, fsSrc);
    const program = gl.createProgram()!;
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(`Program link failed: ${gl.getProgramInfoLog(program)}`);
    }
    const attribs: Record<string, number> = {};
    for (const name of attribNames) attribs[name] = gl.getAttribLocation(program, name);
    const uniforms: Record<string, WebGLUniformLocation | null> = {};
    for (const name of uniformNames) uniforms[name] = gl.getUniformLocation(program, name);
    return { program, attribs, uniforms };
  }

  private compileShader(type: number, source: string): WebGLShader {
    const gl = this.gl;
    const shader = gl.createShader(type)!;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(shader);
      const kind = type === gl.VERTEX_SHADER ? "vertex" : "fragment";
      throw new Error(`${kind} shader compile failed:\n${log}\n--- source ---\n${source}`);
    }
    return shader;
  }

  /**
   * Orthographic projection that maps CSS-pixel coordinates (0,0 top-left,
   * Y down) to NDC ([-1, 1], Y up).
   */
  private orthoMatrix(w: number, h: number): Float32Array {
    return new Float32Array([
      2 / w, 0, 0, 0,
      0, -2 / h, 0, 0,
      0, 0, 1, 0,
      -1, 1, 0, 1,
    ]);
  }
}
