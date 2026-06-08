import type { Backend } from "../Backend";
import { SupportedFileType } from "../FileTreeTypes";

export interface ImportFileOptions {
  hasHeader?: boolean;
  delimiter?: string;
  sheetName?: string;
}

export interface FormatHandler {
  /** Which file types this handler supports */
  canHandle(fileType: SupportedFileType): boolean;

  /** Import a file into the active backend as a table */
  import(
    file: File,
    tableName: string,
    backend: Backend,
    options?: ImportFileOptions
  ): Promise<void>;

  /** For multi-sheet formats (Excel): return sheet names */
  getSheetNames?(file: File, backend: Backend): Promise<string[]>;
}
