import { afterEach, describe, expect, it, vi } from "vitest";
import type { Backend } from "../../Backend";
import { importCsvText } from "../CsvFormatHandler";

/**
 * Minimal Backend stub for the CSV import path: records every SQL
 * statement, optionally fails the first one to exercise the
 * ignore_errors retry.
 */
function captureBackend(opts?: { failFirst?: boolean }) {
  const statements: string[] = [];
  let calls = 0;
  const backend = {
    registerFileText: async () => undefined,
    executeQuery: async (sql: string) => {
      statements.push(sql);
      calls += 1;
      if (opts?.failFirst && calls === 1) throw new Error("simulated sniffer failure");
      return [];
    },
  } as unknown as Backend;
  return { backend, statements };
}

describe("importCsvText", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("creates the table with CREATE OR REPLACE so a re-import refreshes it", async () => {
    const { backend, statements } = captureBackend();

    await importCsvText(backend, "AE.csv", "a,b\n1,2", "AE");

    expect(statements).toHaveLength(1);
    expect(statements[0]).toMatch(/^CREATE OR REPLACE TABLE "AE" AS /);
  });

  it("keeps CREATE OR REPLACE on the ignore_errors retry", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { backend, statements } = captureBackend({ failFirst: true });

    await importCsvText(backend, "AE.csv", "a,b\n1,2", "AE");

    expect(statements).toHaveLength(2);
    expect(statements[1]).toMatch(/^CREATE OR REPLACE TABLE "AE" AS /);
    expect(statements[1]).toContain("ignore_errors=true");
  });
});
