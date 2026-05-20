import { environmentService } from "../../data/environments/EnvironmentService";
import type { Environment } from "../../data/environments/types";

export interface EnvironmentSwitcherOptions {
  /**
   * Fired when the user picks a different environment from the list.
   * Receives the new env id; the consumer is responsible for closing
   * tabs / reloading state — the switcher only updates the active id
   * via `environmentService.setActive`.
   */
  onSwitch?: (envId: string) => void | Promise<void>;
}

/**
 * Compact dropdown at the top of the ControlPanel:
 *   - The button shows the active env's name with a "▾" affordance.
 *   - Click opens a popover listing every environment. Active env is
 *     highlighted. Non-default envs offer rename (pencil) and delete
 *     (×) inline actions; the default env shows neither.
 *   - "+ New environment" creates an empty env and switches to it.
 *   - Click outside the popover, or Escape, dismisses.
 *
 * The component owns its DOM and its subscription to
 * `environmentService.onChange`, so external mutations (the
 * folder-import hook creating an env, the shell `.env new` command,
 * …) reflect immediately. It does NOT close tabs or restore workspace
 * state — that's the consumer's job via `onSwitch`.
 */
export class EnvironmentSwitcher {
  private root: HTMLDivElement;
  private trigger: HTMLButtonElement;
  private label: HTMLSpanElement;
  private popover: HTMLDivElement | null = null;
  private renamingEnvId: string | null = null;
  private readonly options: EnvironmentSwitcherOptions;
  private readonly unsubscribeFromService: () => void;
  private readonly onDocPointerDown: (e: PointerEvent) => void;
  private readonly onDocKeyDown: (e: KeyboardEvent) => void;

  constructor(parent: HTMLElement, options: EnvironmentSwitcherOptions = {}) {
    this.options = options;

    this.root = document.createElement("div");
    this.root.className = "env-switcher";

    this.trigger = document.createElement("button");
    this.trigger.type = "button";
    this.trigger.className = "env-switcher__trigger";
    this.trigger.setAttribute("aria-haspopup", "listbox");
    this.trigger.setAttribute("aria-expanded", "false");

    const icon = document.createElement("span");
    icon.className = "env-switcher__icon";
    icon.textContent = "🌐";
    icon.setAttribute("aria-hidden", "true");
    this.trigger.appendChild(icon);

    this.label = document.createElement("span");
    this.label.className = "env-switcher__label";
    this.trigger.appendChild(this.label);

    const chevron = document.createElement("span");
    chevron.className = "env-switcher__chevron";
    chevron.textContent = "▾";
    chevron.setAttribute("aria-hidden", "true");
    this.trigger.appendChild(chevron);

    this.trigger.addEventListener("click", (e) => {
      e.stopPropagation();
      this.toggle();
    });

    this.root.appendChild(this.trigger);
    parent.appendChild(this.root);

    // Listeners installed once, only active while the popover is open.
    // Capture-phase pointerdown so we close even if the click lands on
    // an element that calls stopPropagation on itself.
    this.onDocPointerDown = (e) => this.handleDocPointerDown(e);
    this.onDocKeyDown = (e) => this.handleDocKeyDown(e);

    this.unsubscribeFromService = environmentService.onChange(() => this.render());
    this.render();
  }

  public destroy(): void {
    this.unsubscribeFromService();
    this.close();
    this.root.remove();
  }

  // ---- Rendering -----------------------------------------------------

  private render(): void {
    const active = environmentService.getActive();
    this.label.textContent = active?.name ?? "default";
    this.label.title = active?.name ?? "default";
    if (this.popover) this.renderPopoverList();
  }

  private renderPopoverList(): void {
    if (!this.popover) return;
    this.popover.innerHTML = "";

    const list = document.createElement("div");
    list.className = "env-switcher__list";
    list.setAttribute("role", "listbox");

    const envs = environmentService.list();
    // Default env first, then others by lastUsedAt descending so the
    // most recently touched env sits near the top.
    envs.sort((a, b) => {
      if (a.kind === "default" && b.kind !== "default") return -1;
      if (b.kind === "default" && a.kind !== "default") return 1;
      return b.lastUsedAt - a.lastUsedAt;
    });

    const activeId = environmentService.getActiveId();
    for (const env of envs) {
      list.appendChild(this.buildRow(env, env.id === activeId));
    }
    this.popover.appendChild(list);

    const footer = document.createElement("div");
    footer.className = "env-switcher__footer";
    const newBtn = document.createElement("button");
    newBtn.type = "button";
    newBtn.className = "env-switcher__new";
    newBtn.textContent = "+ New environment";
    newBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.createNewEnv();
    });
    footer.appendChild(newBtn);
    this.popover.appendChild(footer);
  }

  private buildRow(env: Environment, isActive: boolean): HTMLElement {
    const row = document.createElement("div");
    row.className = "env-switcher__row";
    if (isActive) row.classList.add("env-switcher__row--active");
    row.setAttribute("role", "option");
    row.setAttribute("aria-selected", String(isActive));
    row.dataset.envId = env.id;

    if (this.renamingEnvId === env.id) {
      this.fillRenameRow(row, env);
    } else {
      this.fillNormalRow(row, env, isActive);
    }
    return row;
  }

  private fillNormalRow(row: HTMLElement, env: Environment, isActive: boolean): void {
    const name = document.createElement("span");
    name.className = "env-switcher__name";
    name.textContent = env.name;
    name.title = env.name;
    name.addEventListener("click", (e) => {
      e.stopPropagation();
      this.selectEnv(env.id);
    });
    name.addEventListener("dblclick", (e) => {
      // Default env is renameable too — its kind stays "default" but
      // the name field is purely cosmetic.
      e.stopPropagation();
      this.renamingEnvId = env.id;
      this.renderPopoverList();
    });
    row.appendChild(name);

    const actions = document.createElement("div");
    actions.className = "env-switcher__actions";

    // Rename (pencil). Available on all envs — the default's name is
    // editable too, only its kind/role is fixed.
    const renameBtn = document.createElement("button");
    renameBtn.type = "button";
    renameBtn.className = "env-switcher__action env-switcher__action--rename";
    renameBtn.setAttribute("aria-label", `Rename ${env.name}`);
    renameBtn.title = "Rename";
    renameBtn.textContent = "✎";
    renameBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.renamingEnvId = env.id;
      this.renderPopoverList();
    });
    actions.appendChild(renameBtn);

    // Delete (×). Hidden for the default env — the service refuses
    // to delete it; hiding the button keeps the UI honest.
    if (env.kind !== "default") {
      const deleteBtn = document.createElement("button");
      deleteBtn.type = "button";
      deleteBtn.className = "env-switcher__action env-switcher__action--delete";
      deleteBtn.setAttribute("aria-label", `Delete ${env.name}`);
      deleteBtn.title = "Delete";
      deleteBtn.textContent = "✕";
      deleteBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        this.deleteEnv(env);
      });
      actions.appendChild(deleteBtn);
    }

    row.appendChild(actions);
    if (isActive) {
      const dot = document.createElement("span");
      dot.className = "env-switcher__active-dot";
      dot.setAttribute("aria-hidden", "true");
      name.prepend(dot);
    }
  }

  private fillRenameRow(row: HTMLElement, env: Environment): void {
    const input = document.createElement("input");
    input.type = "text";
    input.className = "env-switcher__rename-input";
    input.value = env.name;
    input.spellcheck = false;

    const commit = (apply: boolean): void => {
      if (this.renamingEnvId !== env.id) return; // already cancelled
      const next = input.value.trim();
      this.renamingEnvId = null;
      if (apply && next && next !== env.name) {
        environmentService.rename(env.id, next);
        // service emits onChange → render picks up the new name
      } else {
        this.renderPopoverList();
      }
    };

    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        commit(true);
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        commit(false);
      }
      // Stop arrow / typing from leaking out and triggering global
      // shortcuts while the user is editing.
      e.stopPropagation();
    });
    input.addEventListener("blur", () => commit(true));
    input.addEventListener("click", (e) => e.stopPropagation());

    row.appendChild(input);
    // Defer focus until DOM settles
    setTimeout(() => {
      input.focus();
      input.select();
    }, 0);
  }

  // ---- Popover lifecycle --------------------------------------------

  private toggle(): void {
    if (this.popover) this.close();
    else this.open();
  }

  private open(): void {
    if (this.popover) return;
    this.popover = document.createElement("div");
    this.popover.className = "env-switcher__popover";
    this.popover.setAttribute("role", "dialog");
    this.popover.addEventListener("click", (e) => e.stopPropagation());

    this.renderPopoverList();
    this.root.appendChild(this.popover);
    this.trigger.setAttribute("aria-expanded", "true");

    document.addEventListener("pointerdown", this.onDocPointerDown, true);
    document.addEventListener("keydown", this.onDocKeyDown, true);
  }

  private close(): void {
    if (!this.popover) return;
    this.popover.remove();
    this.popover = null;
    this.renamingEnvId = null;
    this.trigger.setAttribute("aria-expanded", "false");
    document.removeEventListener("pointerdown", this.onDocPointerDown, true);
    document.removeEventListener("keydown", this.onDocKeyDown, true);
  }

  private handleDocPointerDown(e: PointerEvent): void {
    if (!this.popover) return;
    const target = e.target as Node | null;
    if (target && (this.popover.contains(target) || this.trigger.contains(target))) {
      return;
    }
    this.close();
  }

  private handleDocKeyDown(e: KeyboardEvent): void {
    if (e.key === "Escape") {
      // If a rename input is open, the input's own Escape handler
      // already ran (and stopPropagation'd) — by the time we see
      // this, the rename is cancelled and the next Escape closes
      // the popover.
      this.close();
    }
  }

  // ---- Actions ------------------------------------------------------

  private async selectEnv(envId: string): Promise<void> {
    const current = environmentService.getActiveId();
    this.close();
    if (envId === current) return;
    environmentService.setActive(envId);
    if (this.options.onSwitch) {
      try {
        await this.options.onSwitch(envId);
      } catch (err) {
        // Switch hooks may fail (e.g. folder permission denied); the
        // service has already moved the active id. Log so this is
        // debuggable; the consumer is responsible for any user-facing
        // toast.
        console.error("EnvironmentSwitcher onSwitch failed:", err);
      }
    }
  }

  private createNewEnv(): void {
    // Generate a default name that doesn't clash with existing envs.
    const taken = new Set(environmentService.list().map((e) => e.name.toLowerCase()));
    let base = "untitled";
    let candidate = base;
    let n = 1;
    while (taken.has(candidate.toLowerCase())) {
      n += 1;
      candidate = `${base}-${n}`;
    }
    const env = environmentService.create({ name: candidate, kind: "folder" });
    // Switch into it immediately and put rename mode in play so the
    // user can name it without an extra click.
    environmentService.setActive(env.id);
    this.renamingEnvId = env.id;
    this.renderPopoverList();
    if (this.options.onSwitch) {
      Promise.resolve(this.options.onSwitch(env.id)).catch((err: unknown) => {
        console.error("EnvironmentSwitcher onSwitch (new) failed:", err);
      });
    }
  }

  private deleteEnv(env: Environment): void {
    if (env.kind === "default") return;
    const ok = window.confirm(
      `Delete environment "${env.name}"?\n\n` +
      `This removes the workspace state (open tabs, saved queries) for this environment. ` +
      `Files on disk are not touched.`,
    );
    if (!ok) return;
    const wasActive = environmentService.getActiveId() === env.id;
    environmentService.delete(env.id);
    // Service has already fallen back to default if we deleted active.
    if (wasActive && this.options.onSwitch) {
      const next = environmentService.getActiveId();
      if (next) {
        Promise.resolve(this.options.onSwitch(next)).catch((err: unknown) => {
          console.error("EnvironmentSwitcher onSwitch (delete) failed:", err);
        });
      }
    }
  }
}
