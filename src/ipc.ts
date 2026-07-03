/**
 * IPC sub-entry — `@kolistat/bedevere-wise/ipc`.
 *
 * The Bedevere Backend Protocol: a Bridge that speaks JSON RPC + Arrow
 * IPC streaming over a localhost WebSocket, an IpcBackend that
 * implements the Backend interface against it, and an IpcDataProvider
 * for the row-fetching path.
 *
 * Host processes — bedevere-desktop (C++ shell) today; one day maybe
 * a Python or R kernel, or a remote relay — import from here:
 *
 *   import {
 *     Bridge,
 *     IpcBackend,
 *   } from "@kolistat/bedevere-wise/ipc";
 *
 *   const bridge = new Bridge({ port, token });
 *   await bridge.connect();
 *   const backend = new IpcBackend({ bridge });
 *   await backend.initialize();
 *
 *   const app = new BedevereApp(parent, version, { backend });
 *
 * Zero DuckDB-WASM dependency — only `apache-arrow` (a peer-dep).
 */

export { Bridge, IpcRpcError } from "./data/ipc/bridge";
export type { BridgeOptions } from "./data/ipc/bridge";

export { IpcBackend } from "./data/IpcBackend";
export type { IpcBackendOptions } from "./data/IpcBackend";

export { IpcDataProvider } from "./data/ipc/IpcDataProvider";

export { IpcFilesystemPersistence } from "./data/persistence/IpcFilesystemPersistence";
export type { IpcFilesystemPersistenceOptions } from "./data/persistence/IpcFilesystemPersistence";

export { IpcFileSource } from "./data/files/IpcFileSource";
export type { IpcFileSourceOptions } from "./data/files/IpcFileSource";

// Wire types — re-exported so host implementations + tests can build
// against the canonical protocol shape.
export {
  IPC_PROTOCOL_VERSION,
  ARROW_HEADER_BYTES,
  RESERVED_STREAM_ID,
} from "./data/ipc/types";
export type {
  IpcMethod,
  IpcMethodMap,
  MethodParams,
  MethodResult,
  IpcErrorCode,
  IpcProtocolVersion,
  RpcRequest,
  RpcResponse,
  RpcResponseSuccess,
  RpcResponseError,
  JsonEvent,
  StreamEndEvent,
  BinaryHeader,
  // Wire data shapes
  WireDataType,
  WireColumn,
  WireDatasetMetadata,
  WireColumnStats,
  WireColumnStatsNumeric,
  WireColumnStatsTemporal,
  WireColumnFilter,
  // Plugin / license shapes
  WirePluginManifest,
  WirePluginStatus,
  WirePluginRuntimeView,
  WireLicense,
  WireLicenseToken,
  // Per-method param/result aliases (handy for host-side implementations)
  GetMetadataParams,
  GetMetadataResult,
  FetchDataParams,
  FetchDataResult,
  FetchDataColumnRangeParams,
  FetchDataColumnRangeResult,
  GetColumnStatsParams,
  GetColumnStatsResult,
  GetColumnStatsFilteredParams,
  GetColumnStatsFilteredResult,
  SearchColumnValuesParams,
  SearchColumnValuesResult,
  SetNameParams,
  SetDescriptionParams,
  SetLabelParams,
  SetMutatorResult,
  RegisterFileParams,
  RegisterFileResult,
  ExecuteQueryParams,
  ExecuteQueryResult,
  ListTablesParams,
  ListTablesResult,
  VisualizeParams,
  VisualizeResult,
  GetPluginCatalogParams,
  GetPluginCatalogResult,
  LoadPluginParams,
  LoadPluginResult,
  UnloadPluginParams,
  UnloadPluginResult,
  ListLicensesParams,
  ListLicensesResult,
  AddLicenseParams,
  AddLicenseResult,
  RemoveLicenseParams,
  RemoveLicenseResult,
  LoadPersistenceParams,
  LoadPersistenceResult,
  SavePersistenceParams,
  SavePersistenceResult,
  PickFolderParams,
  PickFolderResult,
  PickFilesParams,
  PickFilesResult,
  ListFolderFilesParams,
  ListFolderFilesResult,
  GetProtocolVersionParams,
  GetProtocolVersionResult,
} from "./data/ipc/types";
