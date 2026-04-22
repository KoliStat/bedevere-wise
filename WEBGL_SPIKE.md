# WebGL spike — investigation notes

**Branch**: `dev-spreadsheet-webgl`
**Status**: exploratory only, not for merge
**Verdict**: don't rewrite the spreadsheet in WebGL; do consider WebGL for two
specific Phase E surfaces (in-cell sparklines, heatmap overlay).

---

## What this spike is

A side-by-side comparison: a WebGL2 instanced-quad cell renderer next to a
vanilla canvas-2d renderer painting the same scene from the same data
(synthetic 1M-row × 50-col dataset). Reachable at `?webgl-spike` in the URL.

Both renderers paint:

- Cell backgrounds, alternating row stripes, gridlines (single-pixel)
- Column headers, row indices, cell text
- Header strip + row gutter

Both honour devicePixelRatio, both pixel-snap text, both use the Tokyonight
Storm palette mirrored from `theme.ts`. The painting model on the canvas-2d
side mirrors what the production `SpreadsheetVisualizer` ships after
Phase A.

### Files

- `src/components/SpreadsheetVisualizer/webgl/WebGLGrid.ts` — the WebGL2
  renderer (~340 LOC).
- `src/components/SpreadsheetVisualizer/webgl/shaders.ts` — GLSL ES 3.00
  vertex + fragment shaders for instanced rects and a textured fullscreen
  quad.
- `src/webgl-spike.ts` — standalone entry that mounts both renderers,
  measures per-frame timing, and shows a perf banner.
- `src/main.ts` — early `?webgl-spike` branch handing control to the spike
  before the normal app boots.

The spike is dynamically imported (`import("./webgl-spike")`) so the
production bundle pays nothing for it.

---

## Architecture (WebGL renderer)

Single WebGL2 program with instanced rendering:

```
in vec2 a_corner;     // unit-quad corner, 0..1 (per-vertex)
in vec4 a_rect;       // (x, y, w, h) in CSS pixels (per-instance)
in vec4 a_color;      // RGBA 0..1 (per-instance)
uniform mat4 u_projection;  // ortho: CSS pixels → NDC, Y down
```

Each frame:

1. Walk the visible cell range, push one instance per (a) cell-area
   background, (b) header / gutter background, (c) alternating-row
   stripe, (d) gridline (1px-thick rect). Single big interleaved buffer:
   8 floats per rect (32 bytes).
2. `bufferData` the interleaved buffer (`STREAM_DRAW`).
3. `drawArraysInstanced(TRIANGLE_STRIP, 0, 4, n)` — one call.
4. Render text into a separate canvas-2d at viewport size, upload as a
   texture, blit on top with one more `drawArrays(TRIANGLES, 0, 6)`.

Total: 2 draw calls per frame regardless of cell count. Capable of
100k+ rectangles per frame with no measurable cost.

---

## What the spike measured (qualitatively)

To run: `bun run dev`, then `http://localhost:5173/?webgl-spike`.

The perf banner reports avg / max frame time and rect count for both
renderers, sampled over a rolling window of 60 frames. Scroll either
pane (they're independent so you can keep one stationary as a reference).

What the rendering loop actually spends time on:

| Phase            | WebGL cost     | Canvas-2d cost | Notes                                                  |
| ---------------- | -------------- | -------------- | ------------------------------------------------------ |
| Backgrounds      | trivial        | trivial        | Both renderers do a few `fillRect` / instanced quads.  |
| Stripes          | trivial        | trivial        | Same.                                                  |
| Gridlines        | trivial        | trivial        | One Path2D in canvas-2d; one big buffer in WebGL.      |
| **Text**         | **dominant**   | **dominant**   | Both renderers go through `ctx.fillText`; the WebGL renderer pays an extra texture upload per frame. |
| Frame total      | ~2-5 ms        | ~1-3 ms        | Spike is text-bound; **WebGL is slightly slower** because of the upload. |

The structural finding is the punchline:

> **At our scale, the spreadsheet is text-bound, not rect-bound.**
> Cell backgrounds, stripes, and gridlines fit comfortably in
> ~1 ms of canvas-2d time — Phase A's single-path Path2D grid alone
> made this true. WebGL's "100k rects/frame" headroom solves a problem
> we don't have.

---

## Why WebGL doesn't help text on the web

The web platform doesn't expose a GPU-accessible glyph rasterizer. The
browser uses Skia / Direct2D / CoreText internally, but JS can only reach
that path through canvas-2d's `fillText` (or the DOM, which is not what
we want here).

Three real options for "GPU-native text":

1. **Render via canvas-2d into a texture, blit via WebGL.** What this
   spike does. Cost is the same as canvas-2d plus an extra texture
   upload per frame. Worse, not better.
2. **Bitmap glyph atlas.** Pre-rasterize every needed glyph at every
   needed size into a texture atlas. Each visible glyph becomes one
   instanced quad with UVs. Pros: GPU-fast text. Cons:
   - Atlas-management code (~500-1000 LOC) for size / font / locale /
     dpr changes.
   - Subpixel positioning must be reimplemented (browsers' is good).
   - Hinting / kerning lost.
   - Atlas size grows with character set; CJK / emoji push the texture
     budget up to MB-class.
   - Variable-width text becomes per-glyph layout work in JS.
3. **SDF (signed distance field) atlas.** Higher quality at all scales,
   but adds a custom shader for the SDF blend and roughly the same
   atlas-management surface. Best-in-class for game UI; overkill here.

Spreadsheet rendering is 90% text. Replacing the browser's text path is
a multi-month engineering project that, on this app, would land on
top of an already 60fps codepath.

---

## Bundle-size economics

| Option                       | Production cost                  | Notes                                              |
| ---------------------------- | -------------------------------- | -------------------------------------------------- |
| WebGL rect renderer (this)   | +13.3 KB (lazy chunk, 0 in main) | Only WebGL renderer + shaders.                     |
| Full WebGL grid (with atlas) | ~30-50 KB                        | Atlas, layout, hit testing, scrollbars, …          |
| **CanvasKit (Skia/WASM)**    | **+6 MB WASM**                   | Best text quality; bundle cost destroys "feels light". |
| WebGPU                       | ~10-20 KB code                   | Safari support shipped 2024 but lags; not 2026-stable. |

Adding a 6MB Skia WASM blob to a tool that loads in <500 KB today is a
non-starter for the kind of "open the URL and scroll" UX Bedevere is.

---

## What WebGL **does** unlock (and where it's worth it)

Two surfaces in Phase E (`joyful-skipping-sprout.md`) become genuinely
nicer in WebGL:

### 1. In-cell sparklines (Phase E.1)

Per-column header gets a 60×16 mini-histogram. With a few hundred
columns visible, that's hundreds of tiny line charts. Canvas-2d is fine
for ten of them; WebGL with one instanced draw call (per-vertex
position, per-instance column offset + colour) handles thousands at zero
incremental cost — and opens the door to per-cell sparklines without
re-thinking performance.

**Estimated cost**: ~150 LOC, isolated WebGL canvas overlay positioned
above the cell layer. No interaction with the text path.

### 2. Heatmap / data-bar overlays (Phase E.2 / E.3)

Per-column toggle: cell backgrounds tint by value rank. The rank → colour
interpolation can live in a shader, with one instanced quad per visible
cell + one extra per-instance attribute (the rank, or the bar fill ratio
for data-bars). Smoother gradients than canvas-2d's discrete fillStyle
sweeps, no per-cell `getStyleForValue()` allocation.

**Estimated cost**: ~200 LOC, again isolated overlay.

Both surfaces share the "instanced quads with per-instance colour"
machinery from this spike — so the `WebGLGrid.ts` infrastructure is
not wasted research, it's a sketch of the right primitive for those
features. They just shouldn't replace the cell + text renderer.

---

## What WebGL **costs** (the rewrite case)

If we did try a full rewrite, here's what we'd give up:

1. **The browser's text rendering.** Decades of work on subpixel
   positioning, RTL/CJK shaping, ligatures, hinting, font fallback,
   accessibility text-zoom behaviour. We'd own all of that.
2. **The accessibility-mirror plan (Phase F).** A canvas-2d rendered
   spreadsheet can pair with a hidden DOM mirror for screen readers; a
   WebGL rendered one is even more opaque to assistive tech.
3. **DOM-overlay anchoring** (resize handles, context menus, tooltips,
   popovers). Currently DOM overlays sit `position: absolute` over the
   canvas; with a fully GPU-rendered grid, they still work, but the
   integration becomes gnarlier (z-stacking, hit testing, transform
   sync).
4. **Driver / GPU portability.** WebGL2 is broadly supported but driver
   bugs, integrated-GPU quirks, and corporate-laptop-disabled-3D
   situations all exist. Canvas-2d works everywhere a browser works.
5. **6 months of engineering to reach feature parity** with what the
   canvas-2d + Phase B path delivers in ~2 weeks.

---

## Verdict

- **Do not** rewrite the SpreadsheetVisualizer in WebGL.
- **Do** keep this spike branch around as the architecture sketch for
  the two Phase E surfaces above.
- **Do not** bring in CanvasKit. The bundle cost is lethal.
- **Re-evaluate WebGPU** in late 2026 / 2027 when Safari support has
  matured. The compute-shader path could change the answer for
  data-bar / sparkline scaling, though probably not for text.

The Phase A + B + C+ arc on `dev-spreadsheet` is the right path.
WebGL stays in the toolkit as a precision instrument, not a hammer.

---

## How to run the spike

```bash
git checkout dev-spreadsheet-webgl
bun run dev
# then open: http://localhost:5173/?webgl-spike
```

Scroll either pane. The banner at the top reports per-renderer frame
timings. Open the browser perf profiler for a deeper read.
