/**
 * WebSocket bridge to the host process running the backend.
 *
 * Protocol (docs/backend-protocol.md §4):
 *   - Text frames carry JSON RPC requests/responses keyed by `id` (uuid).
 *   - Binary frames carry Arrow IPC byte chunks. Each binary frame is
 *     prefixed by an 8-byte header: 4-byte little-endian stream id,
 *     4-byte little-endian chunk index. Stream id 0 is reserved.
 *
 * Public API:
 *   - call(method, params): Promise<result>         — JSON RPC
 *   - awaitArrowStream(streamId): Promise<Table>    — accumulates Arrow chunks
 *
 * Implementation status: connection + JSON RPC plumbing is real;
 * Arrow demux assembles the full byte stream and hands it to
 * `tableFromIPC` in one shot — incremental rendering is a future
 * optimisation (see ./arrow.ts).
 */

import type { Table } from "apache-arrow";
import { decodeArrowStream } from "./arrow";
import {
  ARROW_HEADER_BYTES,
  RESERVED_STREAM_ID,
  type IpcErrorCode,
  type IpcMethod,
  type JsonEvent,
  type MethodParams,
  type MethodResult,
} from "./types";

export interface BridgeOptions {
  port: number;
  token: string;
  /** Override only in tests. */
  host?: string;
}

/**
 * Typed error rejected by {@link Bridge.call} when the host returns
 * `{ ok: false, error }`. Callers branch on `code` to react to specific
 * failures (e.g. tolerate `UNKNOWN_METHOD` from old hosts, retry on
 * `INTERNAL`). Unknown / missing codes surface as `"unknown"`.
 *
 * The protocol explicitly states (docs/backend-protocol.md §7) that
 * unknown codes MUST be treated as generic failures, not rejected —
 * which is why we carry `"unknown"` as a first-class value instead of
 * crashing on an undeclared one.
 */
export class IpcRpcError extends Error {
  public readonly code: IpcErrorCode | "unknown";

  constructor(code: IpcErrorCode | "unknown", message: string) {
    super(`[${code}] ${message}`);
    this.name = "IpcRpcError";
    this.code = code;
  }
}

interface PendingRpc {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
}

/**
 * Mint a v4-ish uuid. We don't need crypto-grade uniqueness for an in-process
 * request id; webview environments may not all expose `crypto.randomUUID()`.
 */
function makeId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  // Fallback — sufficient for local IPC tagging.
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export class Bridge {
  private ws: WebSocket | null = null;
  private readonly host: string;
  private readonly port: number;
  private readonly token: string;
  private readonly pending = new Map<string, PendingRpc>();
  private readonly arrowChunks = new Map<number, Uint8Array[]>();
  private readonly arrowResolvers = new Map<
    number,
    { resolve: (table: Table) => void; reject: (err: unknown) => void }
  >();

  constructor(opts: BridgeOptions) {
    this.host = opts.host ?? "127.0.0.1";
    this.port = opts.port;
    this.token = opts.token;
  }

  async connect(): Promise<void> {
    if (this.port <= 0) {
      throw new Error(
        "Bridge: invalid ipcPort. The host must inject ?ipcPort=<n>&ipcToken=<hex> into the renderer URL.",
      );
    }
    const url = `ws://${this.host}:${this.port}/?token=${encodeURIComponent(this.token)}`;
    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    this.ws = ws;

    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve(), { once: true });
      ws.addEventListener(
        "error",
        (ev) => reject(new Error(`Bridge: WebSocket connection failed (${String(ev)})`)),
        { once: true },
      );
    });

    // First frame after open must be the auth payload — the host closes
    // the connection with code 4401 otherwise. The token in the URL query
    // is a defense-in-depth marker; the host still requires the JSON
    // handshake before accepting any RPC.
    ws.send(JSON.stringify({ auth: this.token }));

    ws.addEventListener("message", (ev) => this.onMessage(ev));
    ws.addEventListener("close", () => this.onClose());
  }

  /**
   * Send a JSON RPC request and resolve with the `result` payload.
   * Rejects on `{ ok: false, error }` envelopes or socket close.
   *
   * Method-keyed generics tie `params` and the resolved value to the
   * `IpcMethodMap` entry for `method`; callers get autocomplete on the
   * method name and a compile-time check that `params` matches the shape
   * declared in `types.ts`.
   */
  call<M extends IpcMethod>(method: M, params: MethodParams<M>): Promise<MethodResult<M>> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("Bridge: not connected"));
    }
    const id = makeId();
    const payload = JSON.stringify({ id, method, params: params ?? {} });
    return new Promise<MethodResult<M>>((resolve, reject) => {
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
      });
      this.ws!.send(payload);
    });
  }

  /**
   * Wait for an Arrow stream to complete and return the assembled Table.
   * The caller is responsible for first issuing the RPC that allocates
   * `streamId` on the host side (e.g. `fetchData` returns `{ streamId }`).
   *
   * TODO: timeout + cancellation. Host-initiated cancellation needs a
   * dedicated control frame; deferred until the host side is implemented.
   */
  awaitArrowStream(streamId: number): Promise<Table> {
    if (streamId === RESERVED_STREAM_ID) {
      return Promise.reject(new Error("Bridge: stream id 0 is reserved"));
    }
    return new Promise<Table>((resolve, reject) => {
      this.arrowResolvers.set(streamId, { resolve, reject });
    });
  }

  /** Whether the underlying socket is connected and ready for RPCs. */
  isConnected(): boolean {
    return !!this.ws && this.ws.readyState === WebSocket.OPEN;
  }

  /** Close the underlying socket. Pending RPCs reject. */
  close(): void {
    if (this.ws && this.ws.readyState !== WebSocket.CLOSED) {
      this.ws.close();
    }
  }

  // ------------------------------------------------------------------------
  // Internal: frame routing
  // ------------------------------------------------------------------------

  private onMessage(ev: MessageEvent): void {
    if (typeof ev.data === "string") {
      this.onJsonFrame(ev.data);
      return;
    }
    if (ev.data instanceof ArrayBuffer) {
      this.onBinaryFrame(new Uint8Array(ev.data));
      return;
    }
    // Some platforms deliver Blob even with binaryType="arraybuffer" — fall
    // through and read it. Verify per-platform once the host-side server is up.
    if (ev.data instanceof Blob) {
      ev.data
        .arrayBuffer()
        .then((buf) => this.onBinaryFrame(new Uint8Array(buf)))
        .catch((err) => console.error("Bridge: blob read failed", err));
    }
  }

  private onJsonFrame(text: string): void {
    let msg: {
      id?: string;
      ok?: boolean;
      result?: unknown;
      error?: { code?: IpcErrorCode; message?: string };
      event?: JsonEvent["event"];
    };
    try {
      msg = JSON.parse(text);
    } catch (err) {
      console.error("Bridge: malformed JSON frame", err, text);
      return;
    }
    // Server-initiated event (no `id`). v0 only emits `streamEnd`; future
    // events extend the discriminated union via the `event` tag in types.ts.
    if (msg.event) {
      this.onJsonEvent(msg as JsonEvent);
      return;
    }
    if (!msg.id) {
      console.warn("Bridge: JSON frame missing both `id` and `event`", text);
      return;
    }
    const pending = this.pending.get(msg.id);
    if (!pending) {
      console.warn("Bridge: response for unknown request id", msg.id);
      return;
    }
    this.pending.delete(msg.id);
    if (msg.ok) {
      pending.resolve(msg.result);
    } else {
      const code = msg.error?.code ?? "unknown";
      const message = msg.error?.message ?? "host returned an error";
      pending.reject(new IpcRpcError(code, message));
    }
  }

  private onJsonEvent(event: JsonEvent): void {
    switch (event.event) {
      case "streamEnd": {
        if (event.ok) {
          this.finalizeArrowStream(event.streamId);
        } else {
          // Mid-stream abort: reject the awaiter with the host's error
          // payload and discard any partial chunks. Per types.ts §StreamEndEvent.
          this.abortArrowStream(
            event.streamId,
            event.error?.code ?? "DUCKDB_ERROR",
            event.error?.message ?? "stream aborted by host",
          );
        }
        return;
      }
    }
  }

  private onBinaryFrame(bytes: Uint8Array): void {
    if (bytes.byteLength < ARROW_HEADER_BYTES) {
      console.warn("Bridge: binary frame shorter than header", bytes.byteLength);
      return;
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const streamId = view.getUint32(0, /*littleEndian*/ true);
    if (streamId === RESERVED_STREAM_ID) {
      console.warn("Bridge: binary frame with reserved streamId 0");
      return;
    }
    // chunk_index lives at bytes 4..7 — read once the dispatcher needs it
    // for reorder buffering. For now the host sends in-order so we drop it.
    const payload = bytes.subarray(ARROW_HEADER_BYTES);

    let bucket = this.arrowChunks.get(streamId);
    if (!bucket) {
      bucket = [];
      this.arrowChunks.set(streamId, bucket);
    }
    bucket.push(payload);
    // End-of-stream comes via the `streamEnd` JSON event handled in
    // onJsonEvent(); the host never emits a binary sentinel.
  }

  private abortArrowStream(streamId: number, code: string, message: string): void {
    const resolver = this.arrowResolvers.get(streamId);
    this.arrowResolvers.delete(streamId);
    this.arrowChunks.delete(streamId);
    if (!resolver) {
      console.warn("Bridge: abort for unknown stream", streamId);
      return;
    }
    resolver.reject(new Error(`[${code}] ${message}`));
  }

  private finalizeArrowStream(streamId: number): void {
    const resolver = this.arrowResolvers.get(streamId);
    const chunks = this.arrowChunks.get(streamId) ?? [];
    this.arrowResolvers.delete(streamId);
    this.arrowChunks.delete(streamId);
    if (!resolver) {
      console.warn("Bridge: no resolver for completed stream", streamId);
      return;
    }
    decodeArrowStream(chunks)
      .then((table) => resolver.resolve(table))
      .catch((err) => resolver.reject(err));
  }

  private onClose(): void {
    const err = new Error("Bridge: WebSocket closed before RPC completed");
    for (const { reject } of this.pending.values()) {
      reject(err);
    }
    this.pending.clear();
    for (const { reject } of this.arrowResolvers.values()) {
      reject(err);
    }
    this.arrowResolvers.clear();
    this.arrowChunks.clear();
    this.ws = null;
  }
}
