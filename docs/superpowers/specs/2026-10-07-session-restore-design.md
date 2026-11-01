# Session restore — design

**Date**: 2026-10-07
**Branch**: `feature/session-restore` (off `dev-0.16`; renderer side) plus a sibling branch in bedevere-desktop for the host store
**Status**: design sections approved in terminal; written spec awaiting review
**Repos**: bedevere-wise (renderer, shared by web and desktop) and bedevere-desktop (host store)

## Goal

When the app opens, the workspace looks the way it did when the app closed.
Agreed scope ("level 3"):

1. Layout and environment: active environment, its folder, re-imported datasets, query tabs with their text, panel width and minimized state, SQL editor height.
2. Open dataset tabs in their order, and which dataset tab was active.
3. Column filters and sorts per dataset.

Not in scope: scroll position and selected cell (fragile when a re-imported file has changed, little value), query-result tabs, chart tabs, text tabs, tables opened from the catalog (their DuckDB tables do not exist after a restart), and dropped files (no stable path or handle on either platform).

## What exists today

The renderer already persists and restores item 1 on the web. `PersistenceService` stores five keys (`bedevere_settings`, `bedevere_queries`, `bedevere_aliases`, `bedevere_keymap`, `bedevere_environments`). `BedevereApp.initAsync` restores theme and panel state, then `ControlPanel.restoreActiveEnvironment` re-acquires the folder, rebuilds the tree and auto-imports the small files. `SqlEditor.restoreActiveEnvironment` rebuilds the query tabs from `workspace.openQueryIds` and `workspace.activeTab`.

On the desktop none of this survives a restart because the host's `loadPersistence` returns an empty object and `savePersistence` drops the payload (`rpc.cpp`, `TODO(kolistat-persistence)`). The renderer side, including the 750 ms debounce and the flush on `beforeunload` and `pagehide`, is already wired.

Items 2 and 3 are in memory only on both platforms. `EnvironmentWorkspaceState.openDataNodeIds` exists but nothing writes or reads it. `ColumnFilterManager` holds filters and sorts in maps that are never persisted; hidden columns and column order are persisted in `AppSettings` and restored by the `setOnBeforeAddDatasetCallback` hook in `BedevereApp`.

Desktop file grants (`%LOCALAPPDATA%\bedevere\file_grants.json`) survive restarts by design, so restored files can be re-registered without a picker dialog.

## Approach

Extend the existing environment workspace and app settings rather than adding a separate session document. The missing producers and consumers are filled in; the persistence plumbing is reused as it is.

## 1. Desktop host store (bedevere-desktop)

- File: `config_dir()/persistence.json`, next to `file_grants.json`.
- `loadPersistence`: read the file, parse it, return its object. A missing or unparsable file returns an empty object, as the stub does today. Only string values are passed through; other values are skipped. A corrupt file must never block startup.
- `savePersistence`: write the full map to `persistence.json.tmp`, then rename over `persistence.json`. The rename is the atomic step; a crash mid-write leaves the previous file intact. A failed write replies with an error instead of reporting success, so the renderer can log it.
- Implementation: a `persistence_path_` member on `RpcDispatcher` beside `grants_path_`, plus `load_persistence()` and `save_persistence()` modelled on `load_grants()` and `save_grants()`. No new wire types. The snapshot is a few kilobytes and arrives at most every 750 ms, so a full rewrite per save is fine.

Effect on its own: the desktop restores everything the web restores today.

## 2. Persisted shape (bedevere-wise)

### Environment workspace

`EnvironmentWorkspaceState` gains nothing new for the list: `openDataNodeIds: string[]` is the record of open dataset tabs in display order, referencing file-tree node ids. One optional field is added:

```ts
/** Dataset tab active in the bottom strip when the env was last left. */
activeDataNodeId?: string;
```

The existing `activeTab` keeps its current meaning (it drives the SQL editor's expanded state). The two tab strips restore their own active entries independently. No schema bump: old environment files have an empty list and no `activeDataNodeId`.

### Stable node ids

Folder-tree nodes already have stable ids (`ipc/<folder>/<relative path>` on desktop, `<folder id>/<path>` on web) and sheet nodes derive from their workbook (`<workbook node id>/<sheet name>`). Single files picked on desktop do not: their id is `ipc/file/<path>/<timestamp>/<random>`. It becomes `ipc/file/<path>`, and picking an already-present file reuses the node instead of adding a twin. Dropped files keep their `drop/…` ids and are never restored.

### Filters and sorts

Two optional fields in `AppSettings`, keyed by dataset name like `hiddenColumns` and `columnOrder`:

```ts
columnFilters?: Record<string, ColumnFilter[]>;
columnSorts?: Record<string, SortConfig[]>;
```

`ColumnFilter` and `SortConfig` are already plain JSON, including the `dataType` the SQL builder needs for casting. Empty lists prune the key. Known limit, shared with hidden columns: two environments with a same-named table share the entry.

### Where it lands

Web: `bedevere_environments` and `bedevere_settings` in localStorage. Desktop: the same keys inside `persistence.json`.

## 3. When it saves

- **Dataset tabs.** `ControlPanel.persistDataWorkspace()` derives `openDataNodeIds` from the TabManager's tab order mapped back to tree nodes, and `activeDataNodeId` from the active tab, then calls `environmentService.setWorkspace` with the other fields untouched. It runs when a tab opens (an import that opens a tab, "open existing table"), when a tab closes (the three places that flip `isOpenAsTab` off), and when a tab is activated. Tabs without a restorable source are filtered out: `drop/…` nodes, `dataset/<name>` nodes, result, chart and text tabs.
- **TabManager additions.** `getActiveTabId()` and an `onTabActivated` callback; today activation has no hook and the active id has no getter.
- **Filters and sorts.** `BedevereApp` subscribes once to `ColumnFilterManager.onChange(datasetName)`, which already fires on every filter, sort, hide and reorder change, and writes `settings.columnFilters[name]` and `settings.columnSorts[name]` the way `persistHiddenColumns` does.
- **Flush on close.** Nothing new. localStorage writes are synchronous; the desktop backend debounces and flushes on `beforeunload` and `pagehide`.

Two guards:

- **Switching environments.** `applyActiveEnvironment` closes every tab before loading the next environment. The outgoing workspace is snapshotted before teardown and saving is suspended until the new environment is attached, so the closes do not wipe the outgoing list. Same pattern the SQL editor uses for its tabs.
- **During restore.** Saving is suspended while tabs reopen and one save runs at the end with the tabs that actually opened.

## 4. Restore sequence

Runs inside `applyActiveEnvironment`, after the tree rebuild, with saving suspended.

1. **Tree rebuild (existing).** Desktop: folder re-listed through the surviving grant, small files auto-imported silently. Web: folder handle from IndexedDB, permission re-checked, same auto-import. On the web the browser will not ask for folder permission at boot, because there is no click to hang the prompt on. The folder comes back later, when the user clicks it in the recent list or picks it again. The restore runs at that point instead.
2. **Picked single files (new, desktop only).** Environment datasets whose node id starts with `ipc/file/` get their tree row back, recreated from the id (the path is the id suffix). They are not imported here. Step 3 reopens the ones that were open. The rest stay as rows to click.
3. **Reopen tabs in order.** For each id in `openDataNodeIds`: find the node; for a sheet id, enumerate the workbook's sheets first (the lazy step the tree does on expand) so the child node exists; then run `importNode` in non-silent mode, which imports if needed and opens the tab. Files above the auto-import size threshold are imported here anyway, with the usual progress, because the user had them open.
4. **Filters and sorts come back with the tab.** The `setOnBeforeAddDatasetCallback` hook also loads `columnFilters[name]` and `columnSorts[name]` into the filter manager through a new `hydrate(dataset, { filters, sorts }, existingColumns)` method, dropping entries whose column no longer exists. The manager has state before the tab is built, so the tab starts on the filtered provider with no flash of unfiltered data. Filters therefore return whenever the dataset is reopened, not only at startup, matching hidden columns.
5. **Activate.** The tab for `activeDataNodeId` is activated if it opened; otherwise the TabManager default (first tab) stands. The SQL editor restores its own tabs and active query as it does now.
6. **One save at the end** with the tabs that opened.

### Failure handling (all non-fatal)

- File gone or renamed: the node is not in the rebuilt tree, skipped. Node present but import fails: skipped and reported. Its row stays clickable, so the user can retry it.
- Skips are reported once in the status bar: "Restored 3 of 4 tabs. Missing: sales_2025.csv". No modal, no per-file error.
- Web permission denied or dismissed: nothing opens and the saved list is left untouched, so the next successful open restores it.
- Corrupt or partial persisted data: unknown node ids and malformed filter entries are ignored one by one; the rest restores.

## 5. Testing

Pure functions carry the logic so vitest covers it without the DOM-heavy components:

- `src/data/workspaceRestore.ts` (new): `deriveDataWorkspace(tabNamesInOrder, activeTabName, tree)` returns `openDataNodeIds` and `activeDataNodeId`, excluding non-restorable tabs; `planRestore(openDataNodeIds, tree)` returns the nodes to open in order, the sheet children to enumerate first, and the missing names; `pickedFileNodeId(path)` and `pickedFilePath(nodeId)` round-trip the stable id. Tests: ordering, exclusion, sheet nodes, missing nodes, malformed ids.
- `ColumnFilterManager.hydrate`: entries for vanished columns are dropped; `hasAnyState` turns true afterwards.
- Round trips: `PersistenceService` with the two new settings fields; `EnvironmentService.setWorkspace` with `activeDataNodeId`.
- Suspension guard: switching environments does not overwrite the outgoing environment's `openDataNodeIds`.
- The existing suite stays green.

End-to-end script, run by hand on web and desktop:

1. Open a folder, open two dataset tabs and one sheet tab, apply a value filter on one, a sort on another, make the second tab active, widen the panel.
2. Close and reopen. Expect the same three tabs in order, the second active, the filter and sort still applied, the panel width kept, the query tabs as before.
3. Rename one file on disk and reopen. Expect the other tabs back and one status line naming the missing file.
4. Desktop: `%LOCALAPPDATA%\bedevere\persistence.json` exists; replace its content with garbage; the app still starts clean. Web: deny the folder permission once; nothing opens and a later allow restores the tabs.

The host store has no unit-test harness in the desktop repo; the build plus steps 2 and 4 cover it.

## Files

bedevere-wise:

- `src/data/environments/types.ts`: `activeDataNodeId`.
- `src/data/PersistenceService.ts`: `columnFilters`, `columnSorts`.
- `src/data/ColumnFilterManager.ts`: `hydrate`.
- `src/data/workspaceRestore.ts` (new) and its test.
- `src/components/TabManager/TabManager.ts`: `getActiveTabId`, `onTabActivated`.
- `src/components/ControlPanel/ControlPanel.ts`: stable picked-file ids, `persistDataWorkspace`, restore step, suspension guards, status message.
- `src/components/SqlEditor/SqlEditor.ts`: keeps the dataset tab fields when it writes the workspace.
- `src/components/BedevereApp/BedevereApp.ts`: filter and sort persistence, hydration in the before-add hook.
- `docs/backend-protocol.md`: the `loadPersistence` and `savePersistence` sections.
- `CHANGELOG.md` under "Unreleased".

bedevere-desktop:

- `shell/ipc/rpc.h`, `shell/ipc/rpc.cpp`: `persistence_path_`, `load_persistence`, `save_persistence`, the two RPC arms.

## Rollout

The host store can ship alone and already improves the desktop. The renderer changes ship in one PR against `dev-0.16`; the desktop PR is independent of them.
