/**
 * Pick a free table name for a file import. Different files can share
 * a stem (the same file name in two subfolders, or `AE.csv` next to
 * `AE.sas7bdat`), and the import SQL uses `CREATE OR REPLACE`, so an
 * unresolved collision would silently replace the earlier table.
 * Suffix the newcomer instead: `AE`, then `AE_2`, `AE_3`, counting
 * past suffixes that are themselves taken. Names compare
 * case-insensitively because the DuckDB catalog does.
 */
export function resolveTableName(baseName: string, taken: Iterable<string>): string {
  const lowered = new Set<string>();
  for (const name of taken) lowered.add(name.toLowerCase());
  if (!lowered.has(baseName.toLowerCase())) return baseName;
  let n = 2;
  while (lowered.has(`${baseName}_${n}`.toLowerCase())) n += 1;
  return `${baseName}_${n}`;
}
