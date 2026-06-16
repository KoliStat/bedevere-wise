import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { SpreadsheetCache } from "../SpreadsheetCache";
import { DataProviderMock } from "@/test/mocks/DataProviderMock";
import { SpreadsheetOptions } from "../types";

/**
 * Advanced SpreadsheetCache scenarios: cache fragmentation, concurrent
 * reads (and in-flight fetch coalescing), and provider-error recovery.
 *
 * These assert on the *contract* — `getData(a, b)` returns the `b - a`
 * rows of the half-open interval `[a, b)` — rather than on the internal
 * chunk layout, so they stay robust as the chunk-growth heuristic
 * evolves. `maxCacheSize` is set comfortably above any range requested
 * here so eviction never truncates a multi-chunk read mid-assembly.
 */
describe("SpreadsheetCache — advanced scenarios", () => {
  const totalRows = 1000;
  let data: any[][];
  let provider: DataProviderMock;
  let options: SpreadsheetOptions;

  beforeEach(() => {
    data = Array.from({ length: totalRows }, (_, i) => [`Row ${i}`, `Value ${i}`, i]);
    provider = new DataProviderMock(data);
    options = { initialCacheSize: 20, cacheChunkSize: 10, maxCacheSize: 1000 };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("fragmented cache", () => {
    it("fills the gaps when getData spans non-contiguous cached chunks", async () => {
      const cache = new SpreadsheetCache(provider, options);
      await cache.initialize(totalRows); // caches [0, 20)
      await cache.loadChunk(40, 60); // leaves a gap at [20, 40)
      await cache.loadChunk(80, 100); // leaves a gap at [60, 80)
      expect(cache.getCacheStats().ranges.length).toBeGreaterThanOrEqual(3);

      // [10, 90) crosses three cached chunks and both gaps.
      const rows = await cache.getData(10, 90);
      expect(rows.length).toBe(80); // half-open: 90 - 10
      expect(rows[0][0]).toBe("Row 10");
      expect(rows[79][0]).toBe("Row 89");
    });
  });

  describe("concurrent access", () => {
    it("resolves overlapping simultaneous getData calls with correct data", async () => {
      const cache = new SpreadsheetCache(provider, options);
      await cache.initialize(totalRows);

      const [a, b, c] = await Promise.all([
        cache.getData(100, 200),
        cache.getData(150, 250), // overlaps the first request
        cache.getData(300, 400),
      ]);

      expect(a.length).toBe(100);
      expect(a[0][0]).toBe("Row 100");
      expect(b.length).toBe(100);
      expect(b[0][0]).toBe("Row 150");
      expect(c.length).toBe(100);
      expect(c[99][0]).toBe("Row 399");
    });

    it("coalesces concurrent fetches for the same missing range into one provider call", async () => {
      const cache = new SpreadsheetCache(provider, options);
      await cache.initialize(totalRows);
      const fetchSpy = vi.spyOn(provider, "fetchData");

      const [r1, r2] = await Promise.all([cache.getData(300, 400), cache.getData(300, 400)]);

      expect(r1.length).toBe(100);
      expect(r2.length).toBe(100);
      // Both reads hit the same in-flight range, so the provider is asked once.
      const fetchesForRange = fetchSpy.mock.calls.filter(([s, e]) => s === 300 && e === 400);
      expect(fetchesForRange.length).toBe(1);
    });
  });

  describe("error recovery", () => {
    it("rejects on a transient provider failure, then succeeds on retry", async () => {
      const cache = new SpreadsheetCache(provider, options);
      await cache.initialize(totalRows); // initial load uses the healthy provider

      // Fail the next fetch exactly once, then let the provider recover.
      const realFetch = provider.fetchData.bind(provider);
      let failOnce = true;
      provider.fetchData = async (s: number, e: number) => {
        if (failOnce) {
          failOnce = false;
          throw new Error("transient provider failure");
        }
        return realFetch(s, e);
      };

      await expect(cache.getData(300, 400)).rejects.toThrow("transient provider failure");

      // The failed range is cleared from the in-flight map, so a retry re-fetches.
      const rows = await cache.getData(300, 400);
      expect(rows.length).toBe(100);
      expect(rows[0][0]).toBe("Row 300");
    });
  });
});
