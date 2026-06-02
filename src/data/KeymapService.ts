import { persistenceService } from "./PersistenceService";

/**
 * A key combination descriptor. Matches against KeyboardEvent properties.
 * Examples: "Ctrl+B", "Ctrl+Shift+P", "ArrowUp", "Ctrl+Enter", "F11", "Escape"
 */
export interface KeyBinding {
  key: string;        // KeyboardEvent.key value (e.g. "b", "ArrowUp", "Enter", "F11")
  ctrl?: boolean;     // Require Ctrl (or Cmd on Mac)
  shift?: boolean;    // Require Shift
  alt?: boolean;      // Require Alt
}

export interface KeymapEntry {
  /** Unique action identifier (e.g. "spreadsheet.moveUp", "app.togglePanel") */
  action: string;
  /** Human-readable description shown in UI */
  description: string;
  /** Scope where this binding is active */
  scope: "global" | "spreadsheet" | "sqlEditor" | "commandPalette";
  /** The key combination */
  binding: KeyBinding;
}

/** Serialize a KeyBinding to a display string like "Ctrl+Shift+P" */
export function formatBinding(b: KeyBinding): string {
  const parts: string[] = [];
  if (b.ctrl) parts.push("Ctrl");
  if (b.shift) parts.push("Shift");
  if (b.alt) parts.push("Alt");
  parts.push(b.key.length === 1 ? b.key.toUpperCase() : b.key);
  return parts.join("+");
}

/** Parse a display string like "Ctrl+Shift+P" back to a KeyBinding */
export function parseBinding(s: string): KeyBinding {
  const parts = s.split("+");
  const key = parts[parts.length - 1];
  return {
    key: key.length === 1 ? key.toLowerCase() : key,
    ctrl: parts.includes("Ctrl"),
    shift: parts.includes("Shift"),
    alt: parts.includes("Alt"),
  };
}

/** Check if a KeyboardEvent matches a KeyBinding */
export function matchesBinding(event: KeyboardEvent, binding: KeyBinding): boolean {
  const ctrlOrMeta = event.ctrlKey || event.metaKey;
  if ((binding.ctrl ?? false) !== ctrlOrMeta) return false;
  if ((binding.shift ?? false) !== event.shiftKey) return false;
  if ((binding.alt ?? false) !== event.altKey) return false;
  // Case-insensitive single-char comparison; exact match for named keys
  if (binding.key.length === 1) {
    return event.key.toLowerCase() === binding.key.toLowerCase();
  }
  return event.key === binding.key;
}

// ─── Default keymap ────────────────────────────────────────────────

const DEFAULT_KEYMAP: KeymapEntry[] = [
  // Global (BedevereApp)
  { action: "app.togglePanel",       description: "Toggle control panel",       scope: "global",  binding: { key: "b", ctrl: true } },
  { action: "app.toggleSqlEditor",   description: "Toggle SQL editor",          scope: "global",  binding: { key: "e", ctrl: true } },
  { action: "app.toggleFullscreen",  description: "Toggle fullscreen",          scope: "global",  binding: { key: "F11" } },
  { action: "help.toggle",           description: "Toggle help panel",          scope: "global",  binding: { key: "/", ctrl: true } },
  { action: "shell.focus",           description: "Focus the shell",            scope: "global",  binding: { key: "`", ctrl: true } },
  { action: "tabs.next",             description: "Switch to next tab",         scope: "global",  binding: { key: "ArrowRight", ctrl: true, alt: true } },
  { action: "tabs.prev",             description: "Switch to previous tab",     scope: "global",  binding: { key: "ArrowLeft", ctrl: true, alt: true } },

  // Spreadsheet navigation
  { action: "spreadsheet.moveUp",        description: "Move selection up",             scope: "spreadsheet", binding: { key: "ArrowUp" } },
  { action: "spreadsheet.moveDown",      description: "Move selection down",           scope: "spreadsheet", binding: { key: "ArrowDown" } },
  { action: "spreadsheet.moveLeft",      description: "Move selection left",           scope: "spreadsheet", binding: { key: "ArrowLeft" } },
  { action: "spreadsheet.moveRight",     description: "Move selection right",          scope: "spreadsheet", binding: { key: "ArrowRight" } },
  { action: "spreadsheet.extendUp",      description: "Extend selection up",           scope: "spreadsheet", binding: { key: "ArrowUp", ctrl: true } },
  { action: "spreadsheet.extendDown",    description: "Extend selection down",         scope: "spreadsheet", binding: { key: "ArrowDown", ctrl: true } },
  { action: "spreadsheet.extendLeft",    description: "Extend selection left",         scope: "spreadsheet", binding: { key: "ArrowLeft", ctrl: true } },
  { action: "spreadsheet.extendRight",   description: "Extend selection right",        scope: "spreadsheet", binding: { key: "ArrowRight", ctrl: true } },
  { action: "spreadsheet.scrollUp",      description: "Scroll viewport up",            scope: "spreadsheet", binding: { key: "ArrowUp", shift: true } },
  { action: "spreadsheet.scrollDown",    description: "Scroll viewport down",          scope: "spreadsheet", binding: { key: "ArrowDown", shift: true } },
  { action: "spreadsheet.scrollLeft",    description: "Scroll viewport left",          scope: "spreadsheet", binding: { key: "ArrowLeft", shift: true } },
  { action: "spreadsheet.scrollRight",   description: "Scroll viewport right",         scope: "spreadsheet", binding: { key: "ArrowRight", shift: true } },
  { action: "spreadsheet.enter",         description: "Start cell selection",           scope: "spreadsheet", binding: { key: "Enter" } },
  { action: "spreadsheet.copy",          description: "Copy selection to clipboard",    scope: "spreadsheet", binding: { key: "c", ctrl: true } },
  { action: "spreadsheet.cancelSelection", description: "Cancel selection",             scope: "spreadsheet", binding: { key: "Escape" } },

  // SQL Editor
  { action: "sqlEditor.execute",    description: "Execute query",      scope: "sqlEditor", binding: { key: "Enter", ctrl: true } },
  { action: "sqlEditor.collapse",   description: "Collapse editor",    scope: "sqlEditor", binding: { key: "Escape" } },
  { action: "sqlEditor.saveQuery",  description: "Save query as…",     scope: "sqlEditor", binding: { key: "s", ctrl: true } },
];

// ─── KeymapService ─────────────────────────────────────────────────

export class KeymapService {
  private entries: KeymapEntry[];

  constructor() {
    this.entries = this.loadKeymap();
  }

  /** Get all entries, optionally filtered by scope */
  public getEntries(scope?: string): KeymapEntry[] {
    if (!scope) return [...this.entries];
    return this.entries.filter((e) => e.scope === scope);
  }

  /** Get the binding for a specific action */
  public getBinding(action: string): KeyBinding | null {
    return this.entries.find((e) => e.action === action)?.binding ?? null;
  }

  /** Find which action (if any) matches a keyboard event within a given scope */
  public matchEvent(event: KeyboardEvent, scope: string): string | null {
    for (const entry of this.entries) {
      if (entry.scope === scope && matchesBinding(event, entry.binding)) {
        return entry.action;
      }
    }
    return null;
  }

  /** Update a single binding and persist */
  public setBinding(action: string, binding: KeyBinding): void {
    const entry = this.entries.find((e) => e.action === action);
    if (entry) {
      entry.binding = binding;
      this.saveKeymap();
    }
  }

  /** Reset all bindings to defaults */
  public resetToDefaults(): void {
    this.entries = DEFAULT_KEYMAP.map((e) => ({ ...e, binding: { ...e.binding } }));
    persistenceService.saveKeymapOverrides({});
  }

  /** Get the default binding for comparison / reset */
  public getDefaultBinding(action: string): KeyBinding | null {
    return DEFAULT_KEYMAP.find((e) => e.action === action)?.binding ?? null;
  }

  private loadKeymap(): KeymapEntry[] {
    // Start with a deep copy of defaults, then layer the user's
    // overrides (loaded via PersistenceService) on top.
    const keymap = DEFAULT_KEYMAP.map((e) => ({ ...e, binding: { ...e.binding } }));
    const overrides = persistenceService.loadKeymapOverrides();
    for (const entry of keymap) {
      if (overrides[entry.action]) {
        entry.binding = overrides[entry.action];
      }
    }
    return keymap;
  }

  private saveKeymap(): void {
    // Only save entries that differ from defaults — the rest are
    // recovered from DEFAULT_KEYMAP on load. PersistenceService deletes
    // the storage key when the overrides map is empty.
    const overrides: Record<string, KeyBinding> = {};
    for (const entry of this.entries) {
      const def = DEFAULT_KEYMAP.find((d) => d.action === entry.action);
      if (def && JSON.stringify(def.binding) !== JSON.stringify(entry.binding)) {
        overrides[entry.action] = entry.binding;
      }
    }
    persistenceService.saveKeymapOverrides(overrides);
  }
}

export const keymapService = new KeymapService();
