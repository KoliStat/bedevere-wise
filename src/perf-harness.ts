// Spreadsheet perf harness — reachable via `?perf-harness` in the URL.
//
// Mounts a real SpreadsheetVisualizer against a synthetic 1M-row × 50-col
// dataset, scripts a long automated scroll, and reports the FPS / per-frame
// timing distribution in a banner. Outside the TabManager / BedevereApp
// flow on purpose so the measurement is uncontaminated by app chrome.
//
// Phase B's perf gate is "≥58 fps avg, p99 ≤ 24 ms on a 2× retina" against
// this scene. The harness prints both numbers to the page; eyeball them.

import "./styles/main.scss";
import { SpreadsheetVisualizer } from "./components/SpreadsheetVisualizer/SpreadsheetVisualizer";
import { ColumnStatsVisualizer } from "./components/ColumnStatsVisualizer/ColumnStatsVisualizer";
import { SyntheticDataProvider } from "./data/SyntheticDataProvider";

const ROWS = 1_000_000;
const COLS = 50;
const SIM_LATENCY_MS = 12; // realistic DuckDB chunk fetch
const SCROLL_DURATION_MS = 8_000;
const SCROLL_PIXELS = 200_000; // a few thousand rows worth

interface FrameStats {
  count: number;
  totalMs: number;
  maxMs: number;
  samples: number[]; // for percentile computation
}

export async function runPerfHarness(host: HTMLElement): Promise<void> {
  document.title = "Bedevere — perf harness";
  document.body.classList.add("theme-dark");
  host.style.cssText = `
    margin: 0; height: 100vh; width: 100vw;
    display: grid; grid-template-rows: 32px 1fr;
    background: #16161e; color: #c0caf5;
    font-family: Consolas, monospace;
  `;
  host.innerHTML = "";

  const banner = document.createElement("div");
  banner.id = "perf-banner";
  banner.style.cssText = `
    display: flex; align-items: center; gap: 18px; padding: 0 12px;
    border-bottom: 1px solid #292e42; font-size: 12px;
  `;
  banner.innerHTML = `
    <strong>Perf harness</strong>
    <span>${ROWS.toLocaleString()} rows × ${COLS} cols, ${SIM_LATENCY_MS}ms fetch latency</span>
    <span id="perf-status">init…</span>
    <button id="perf-rescroll" style="margin-left:auto;background:#7aa2f7;color:#16161e;border:0;padding:4px 10px;font-family:inherit;cursor:pointer">Re-scroll</button>
  `;
  host.appendChild(banner);

  const sheetContainer = document.createElement("div");
  sheetContainer.style.cssText = "position:relative;overflow:hidden;";
  host.appendChild(sheetContainer);

  // ColumnStatsVisualizer is required by the SpreadsheetVisualizer
  // constructor but isn't exercised by the scroll perf path.
  const statsContainer = document.createElement("div");
  statsContainer.style.cssText = "display:none;";
  document.body.appendChild(statsContainer);
  const statsViz = new ColumnStatsVisualizer(statsContainer, null);

  const provider = new SyntheticDataProvider({
    rows: ROWS,
    cols: COLS,
    fetchLatencyMs: SIM_LATENCY_MS,
  });

  const sheet = new SpreadsheetVisualizer(sheetContainer, provider, {}, statsViz, "perf-harness");
  await sheet.initialize();

  const statusEl = document.getElementById("perf-status")!;
  const rescrollBtn = document.getElementById("perf-rescroll") as HTMLButtonElement;

  const measureScroll = async (): Promise<void> => {
    statusEl.textContent = "scrolling…";
    const frames = await runScriptedScroll(sheetContainer);
    statusEl.innerHTML = renderStats(frames);
  };

  rescrollBtn.addEventListener("click", () => void measureScroll());

  // Auto-run once on load.
  setTimeout(() => void measureScroll(), 250);
}

/**
 * Drive the spreadsheet's native scroll over a ramp + observe per-frame
 * timing via requestAnimationFrame. We can't directly hook into the
 * SpreadsheetVisualizer's draw timer from outside; rAF cadence is a good
 * proxy for "did the page stay smooth."
 */
async function runScriptedScroll(host: HTMLElement): Promise<FrameStats> {
  const scroller = host.querySelector("div") as HTMLDivElement | null;
  if (!scroller) throw new Error("perf harness: spreadsheet scroll container not found");

  scroller.scrollTop = 0;
  await new Promise((r) => setTimeout(r, 100));

  const stats: FrameStats = { count: 0, totalMs: 0, maxMs: 0, samples: [] };
  const t0 = performance.now();
  let lastFrame = t0;

  return new Promise((resolve) => {
    const tick = (now: number) => {
      const elapsed = now - t0;
      const dt = now - lastFrame;
      lastFrame = now;
      if (stats.count > 0) {
        stats.totalMs += dt;
        stats.maxMs = Math.max(stats.maxMs, dt);
        stats.samples.push(dt);
      }
      stats.count++;

      // Linear scroll ramp.
      const progress = Math.min(1, elapsed / SCROLL_DURATION_MS);
      scroller.scrollTop = Math.round(progress * SCROLL_PIXELS);

      if (elapsed >= SCROLL_DURATION_MS) {
        resolve(stats);
        return;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

function renderStats(s: FrameStats): string {
  if (s.samples.length === 0) return "no frames captured";
  const sorted = s.samples.slice().sort((a, b) => a - b);
  const avg = s.totalMs / s.samples.length;
  const p50 = sorted[Math.floor(sorted.length * 0.5)];
  const p95 = sorted[Math.floor(sorted.length * 0.95)];
  const p99 = sorted[Math.floor(sorted.length * 0.99)];
  const fps = avg > 0 ? Math.round(1000 / avg) : 0;

  // Phase B gate: ≥58 fps avg, p99 ≤ 24ms.
  const passed = fps >= 58 && p99 <= 24;
  const label = passed ? "PASS" : "FAIL";
  const colour = passed ? "#9ece6a" : "#f7768e";

  return `
    <span>frames: ${s.samples.length}</span>
    <span>avg ${avg.toFixed(2)}ms (${fps}fps)</span>
    <span>p50 ${p50.toFixed(2)}ms</span>
    <span>p95 ${p95.toFixed(2)}ms</span>
    <span>p99 ${p99.toFixed(2)}ms</span>
    <span>max ${s.maxMs.toFixed(2)}ms</span>
    <span style="color:${colour};font-weight:bold">${label}</span>
  `;
}
