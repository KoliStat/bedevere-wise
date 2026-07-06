import { FocusableComponent, FocusManager as IFocusManager } from "./types";

export class FocusManager implements IFocusManager {
  private focusedComponent: FocusableComponent | null = null;
  private focusStack: FocusableComponent[] = [];
  private focusChangeCallbacks: Array<(componentId: FocusableComponent | null, previousId: FocusableComponent | null) => void> = [];
  private debugMode: boolean = false;

  constructor(options: { debugMode?: boolean } = {}) {
    this.debugMode = options.debugMode || false;
  }

  public setFocus(current: FocusableComponent): void {
    const previous = this.focusedComponent;

    if (previous?.componentId === current.componentId) {
      return; // Already focused
    }

    if (this.debugMode) {
      console.log(`FocusManager: Setting focus from "${previous?.componentId}" to "${current.componentId}"`);
    }

    if (previous) {
      previous.blur();
      this.focusStack.push(previous);
    }
    current.focus();

    this.focusedComponent = current;
    this.notifyFocusChange(current, previous);
  }

  public getFocusedComponent(): FocusableComponent | null {
    return this.focusedComponent;
  }

  public pushFocus(componentId: FocusableComponent): void {
    if (this.focusedComponent) {
      this.focusStack.push(this.focusedComponent);
    }
    this.setFocus(componentId);
  }

  public popFocus(): FocusableComponent | null {
    const previousComponent = this.focusStack.pop();
    if (previousComponent) {
      this.setFocus(previousComponent);
      return previousComponent;
    } else {
      this.clearFocus();
      return null;
    }
  }

  public clearFocus(): void {
    const previous = this.focusedComponent;
    if (previous) {
      this.focusedComponent = null;
      this.notifyFocusChange(null, previous);
    }
  }

  public onFocusChange(callback: (current: FocusableComponent | null, previous: FocusableComponent | null) => void): void {
    this.focusChangeCallbacks.push(callback);
  }

  public hasFocus(component: FocusableComponent): boolean {
    return this.focusedComponent?.componentId === component.componentId;
  }

  public getFocusStack(): FocusableComponent[] {
    return [...this.focusStack];
  }

  public clearFocusStack(): void {
    this.focusStack = [];
  }

  private notifyFocusChange(current: FocusableComponent | null, previous: FocusableComponent | null): void {
    if (this.debugMode) {
      console.log(`FocusManager: Focus changed from "${previous?.componentId}" to "${current?.componentId}"`);
    }

    for (const callback of this.focusChangeCallbacks) {
      try {
        callback(current, previous);
      } catch (error) {
        console.error("Error in focus change callback:", error);
      }
    }
  }
}
