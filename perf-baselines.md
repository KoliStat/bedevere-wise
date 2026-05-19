# Spreadsheet perf baselines (dev-spreadsheet only)

> **Strip this file when Phase B merges back to a release branch.**
> Same rule as `src/perf-harness.ts` and `src/data/SyntheticDataProvider.ts`
> — these only exist on `dev-spreadsheet` to gate the perf work.

## Setup

| | |
|---|---|
| Hardware | massi's primary dev machine (2× retina) |
| Browser | (record on first run that flips a number meaningfully) |
| Scenario | 1M × 50 synthetic grid, 8s scripted linear scroll, simulated fetch latency |
| URL | `http://localhost:3000/?perf-harness` |

## Phase B gate

≥58 fps avg, p99 ≤ 24ms. Recorded as `PASS` / `FAIL` per item.

The baseline already PASSes on this machine, so each Phase B item is
measured as a **ms-delta from the baseline**, not a gate flip. The
items still earn their place: lower-spec hardware, larger datasets,
memory bounds, and the dirty-region machinery that Phase C will rely on.

## Baseline — before Phase B (commit `8f60c30`)

| metric | value |
|---|---|
| frames | 1133 |
| avg | 7.07 ms (141 fps) |
| p50 | 7.00 ms |
| p95 | 7.20 ms |
| p99 | 13.80 ms |
| max | 14.10 ms |
| gate | **PASS** |

Recorded 2026-05-06.

---

## Phase B — per-item results

Filled in as each item lands. Δ columns are signed ms (negative = faster).

| # | item | avg | p50 | p95 | p99 | max | gate | commit |
|---|---|---|---|---|---|---|---|---|
| 0 | baseline | 7.07 | 7.00 | 7.20 | 13.80 | 14.10 | PASS | `8f60c30` |
| 1 | rAF batching for scroll | | | | | | | |
| 6 | LRU cache cap | | | | | | | |
| 7 | Chunked column-width measurement | | | | | | | |
| 2 | Truncation-width memoisation | | | | | | | |
| 5 | Pre-allocated cell-render scratch | | | | | | | |
| 3+4 | Skeleton placeholders + dirty regions | | | | | | | |
