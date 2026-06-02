export type SupportedFileType = "csv" | "tsv" | "json" | "parquet" | "xlsx" | "xls" | "sas7bdat" | "xpt" | "sav" | "dta" | "html";

export type FileNodeKind = "folder" | "file" | "sheet";

export interface FileTreeNode {
  id: string;
  name: string;
  alias?: string;
  kind: FileNodeKind;
  children?: FileTreeNode[];
  fileHandle?: File | FileSystemFileHandle;
  fileType?: SupportedFileType;
  isImported: boolean;
  isExpanded: boolean;
  sheetName?: string;
  /** DuckDB table name assigned when this node was imported; used to re-select the dataset on later clicks. */
  tableName?: string;
  /** True if the format handler reports this type as unavailable (extension not loaded) */
  isUnavailable?: boolean;
  /** File size in bytes (only set for file/sheet nodes). Drives the
   *  auto-import policy (small ↦ silent, large ↦ user-click) and the
   *  size label shown next to each row. */
  size?: number;
  /** True when the dataset is currently open as a spreadsheet tab.
   *  Distinct from `isImported` (which only tracks "is registered as
   *  a DuckDB table"): silent-imported files have `isImported = true`
   *  but `isOpenAsTab = false`, so the row stays visually neutral
   *  until the user actually opens it. */
  isOpenAsTab?: boolean;
}

/** Map file extensions to SupportedFileType */
export function detectFileType(fileName: string): SupportedFileType | null {
  const ext = fileName.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "csv": return "csv";
    case "tsv": return "tsv";
    case "txt": return "csv"; // treat .txt as CSV
    case "json": return "json";
    case "parquet": return "parquet";
    case "xlsx": return "xlsx";
    case "xls": return "xls";
    case "sas7bdat": return "sas7bdat";
    case "xpt": return "xpt";
    case "sav": return "sav";
    case "dta": return "dta";
    case "html": return "html";
    case "htm": return "html";
    default: return null;
  }
}

/** All extensions the app can potentially handle */
export function getAllSupportedExtensions(): string[] {
  return [".csv", ".tsv", ".txt", ".json", ".parquet", ".xlsx", ".xls", ".sas7bdat", ".xpt", ".sav", ".dta", ".html", ".htm"];
}
