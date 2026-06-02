/**
 * Central catalogue of every "verb" the app exposes — palette commands,
 * keymap actions, shell dot-commands, and future agent-facing endpoints all
 * resolve through this one registry. Individual surfaces (CommandPalette,
 * KeymapService, Shell) become thin front-ends over `list()` + `run()`.
 *
 * The design target is 0.9-era removal of CommandPalette, so this module
 * owns the canonical `Command` shape going forward. Existing palette
 * registrations continue to work unchanged via CommandPalette's wrapper.
 */

export interface CommandParameter {
  name: string;
  type: string;
  description?: string;
  required?: boolean;
  default?: string;
  options?: () => string[];
}

export interface Command {
  /** Dotted, lowercase identifier. Palette, keymap, and shell resolve by this. */
  id: string;
  /** Human-readable title for palette + .help rendering. */
  title: string;
  /** Shell token for dot-command access, e.g. "open" for `.open`. Omit to hide from shell. */
  shellName?: string;
  /** Extra shell tokens that resolve to this command (e.g. ["o"]). */
  aliases?: string[];
  /** Typed parameters accepted by the command (palette + shell). */
  parameters?: CommandParameter[];
  /** One-liner help text. */
  description?: string;
  /** Groups commands in the palette and in `.help`. */
  category?: string;
  /** Which input focus scope the command belongs to. Undefined = always available. */
  scope?: "global" | "spreadsheet" | "sqlEditor";
  /** Documentation-only string shown next to the command (e.g. "Ctrl+P"). */
  keybinding?: string;
  /** Glyph / icon name used by the palette. */
  icon?: string;
  /** Predicate guarding availability at dispatch time. */
  when?: () => boolean;
  /** Async-capable executor. May throw; callers are expected to surface errors. */
  execute: (params?: Record<string, any>) => void | Promise<void>;
}

export interface CommandRegistry {
  register(cmd: Command): void;
  unregister(id: string): void;
  has(id: string): boolean;
  get(id: string): Command | undefined;
  getByShellName(token: string): Command | undefined;
  list(filter?: { category?: string; scope?: Command["scope"]; shellOnly?: boolean }): Command[];
  run(id: string, params?: Record<string, any>): Promise<void>;
  /** Subscribe to register/unregister events so consumers (palette UI) can refresh. */
  onChange(listener: () => void): () => void;
}

class CommandRegistryImpl implements CommandRegistry {
  private commands: Map<string, Command> = new Map();
  private shellIndex: Map<string, string> = new Map(); // shellName/alias -> id
  private listeners: Set<() => void> = new Set();

  public register(cmd: Command): void {
    this.commands.set(cmd.id, cmd);
    if (cmd.shellName) this.shellIndex.set(cmd.shellName, cmd.id);
    if (cmd.aliases) {
      for (const alias of cmd.aliases) this.shellIndex.set(alias, cmd.id);
    }
    this.emit();
  }

  public unregister(id: string): void {
    const cmd = this.commands.get(id);
    if (!cmd) return;
    this.commands.delete(id);
    if (cmd.shellName) this.shellIndex.delete(cmd.shellName);
    if (cmd.aliases) {
      for (const alias of cmd.aliases) this.shellIndex.delete(alias);
    }
    this.emit();
  }

  public has(id: string): boolean {
    return this.commands.has(id);
  }

  public get(id: string): Command | undefined {
    return this.commands.get(id);
  }

  public getByShellName(token: string): Command | undefined {
    const id = this.shellIndex.get(token);
    return id ? this.commands.get(id) : undefined;
  }

  public list(filter?: { category?: string; scope?: Command["scope"]; shellOnly?: boolean }): Command[] {
    const out: Command[] = [];
    for (const cmd of this.commands.values()) {
      if (filter?.category && cmd.category !== filter.category) continue;
      if (filter?.scope !== undefined && cmd.scope !== filter.scope) continue;
      if (filter?.shellOnly && !cmd.shellName) continue;
      out.push(cmd);
    }
    return out;
  }

  public async run(id: string, params?: Record<string, any>): Promise<void> {
    const cmd = this.commands.get(id);
    if (!cmd) throw new Error(`Unknown command: ${id}`);
    if (cmd.when && !cmd.when()) throw new Error(`Command not available: ${id}`);
    await cmd.execute(params);
  }

  public onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    // One listener throwing must not stop the rest from being notified —
    // each listener is independent (palette, help panel, shell suggester,
    // …) and a failure in one shouldn't blackhole the others. Log so
    // the broken listener is debuggable; swallow so dispatch continues.
    for (const listener of this.listeners) {
      try { listener(); } catch (err) { console.error("CommandRegistry listener failed:", err); }
    }
  }
}

export const commandRegistry: CommandRegistry = new CommandRegistryImpl();
