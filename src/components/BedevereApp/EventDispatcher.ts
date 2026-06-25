import { EventDispatcher as IEventDispatcher, FocusableComponent, EventHandler, EventDispatchResult } from "./types";
import { FocusManager } from "./FocusManager";

export class EventDispatcher implements IEventDispatcher {
  private components: Map<string, FocusableComponent> = new Map();
  private globalEventHandlers: Set<EventHandler> = new Set();
  private focusManager: FocusManager;
  private debugMode: boolean = false;

  constructor(focusManager: FocusManager, options: { debugMode?: boolean } = {}) {
    this.focusManager = focusManager;
    this.debugMode = options.debugMode || false;
    this.setupGlobalEventListeners();
  }

  public registerComponent(component: FocusableComponent): void {
    if (this.components.has(component.componentId)) {
      console.warn(`Component with id "${component.componentId}" is already registered`);
      return;
    }

    this.components.set(component.componentId, component);

    if (this.debugMode) {
      console.log(`EventDispatcher: Registered component "${component.componentId}"`);
    }
  }

  public unregisterComponent(componentId: string): void {
    if (!this.components.has(componentId)) {
      console.warn(`Component with id "${componentId}" is not registered`);
      return;
    }

    this.components.delete(componentId);

    if (this.debugMode) {
      console.log(`EventDispatcher: Unregistered component "${componentId}"`);
    }
  }

  public setFocus(componentId: string): void {
    const component = this.components.get(componentId);
    if (!component) {
      console.warn(`Cannot set focus to unregistered component "${componentId}"`);
      return;
    }

    if (!component.canReceiveFocus) {
      console.warn(`Component "${componentId}" cannot receive focus`);
      return;
    }

    this.focusManager.setFocus(component);
  }

  public popFocus(): void {
    this.focusManager.popFocus();
  }

  public getFocusedComponent(): FocusableComponent | null {
    const focusedComponent = this.focusManager.getFocusedComponent();
    return focusedComponent ? this.components.get(focusedComponent.componentId) || null : null;
  }

  public async dispatchEvent(event: Event): Promise<boolean> {
    const result = await this.dispatchEventInternal(event);
    return result.handled;
  }

  public addGlobalEventHandler(handler: EventHandler): void {
    this.globalEventHandlers.add(handler);
  }

  public removeGlobalEventHandler(handler: EventHandler): void {
    this.globalEventHandlers.delete(handler);
  }

  private async dispatchEventInternal(event: Event): Promise<EventDispatchResult> {
    if (this.debugMode) {
      console.log(`EventDispatcher: Dispatching ${event.type} event`);
    }

    // First, try global handlers for critical events
    const globalResult = await this.dispatchToGlobalHandlers(event);
    if (globalResult.handled && globalResult.stopPropagation) {
      return globalResult;
    }

    // Then, try focused component
    const focusedComponent = this.getFocusedComponent();
    if (focusedComponent) {
      const componentResult = await this.dispatchToComponent(focusedComponent, event);
      if (componentResult.handled) {
        return componentResult;
      }
    }

    // Finally, try global handlers for non-critical events
    if (!globalResult.handled) {
      return await this.dispatchToGlobalHandlers(event);
    }

    return globalResult;
  }

  private async dispatchToGlobalHandlers(event: Event): Promise<EventDispatchResult> {
    for (const handler of this.globalEventHandlers) {
      const result = await this.dispatchToEventHandler(handler, event);
      if (result.handled) {
        return result;
      }
    }
    return { handled: false };
  }

  private async dispatchToComponent(component: FocusableComponent, event: Event): Promise<EventDispatchResult> {
    return this.dispatchToEventHandler(component, event);
  }

  private async dispatchToEventHandler(handler: EventHandler, event: Event): Promise<EventDispatchResult> {
    try {
      let handled = false;

      switch (event.type) {
        case "mousedown":
          handled = (await handler.handleMouseDown?.(event as MouseEvent)) === true;
          break;
        case "mousemove":
          handled = (await handler.handleMouseMove?.(event as MouseEvent)) === true;
          break;
        case "mouseup":
          handled = (await handler.handleMouseUp?.(event as MouseEvent)) === true;
          break;
        case "mouseleave":
          handled = (await handler.handleMouseLeave?.(event as MouseEvent)) === true;
          break;
        case "wheel":
          handled = (await handler.handleWheel?.(event as WheelEvent)) === true;
          break;
        case "contextmenu":
          handled = (await handler.handleContextMenu?.(event as MouseEvent)) === true;
          break;
        case "dblclick":
          handled = (await handler.handleDoubleClick?.(event as MouseEvent)) === true;
          break;
        case "keydown":
          handled = (await handler.handleKeyDown?.(event as KeyboardEvent)) === true;
          break;
        case "keyup":
          handled = (await handler.handleKeyUp?.(event as KeyboardEvent)) === true;
          break;
        case "focus":
          handled = (await handler.handleFocus?.(event as FocusEvent)) === true;
          break;
        case "blur":
          handled = (await handler.handleBlur?.(event as FocusEvent)) === true;
          break;
        case "dragenter":
          handled = (await handler.handleDragEnter?.(event as DragEvent)) === true;
          break;
        case "dragover":
          handled = (await handler.handleDragOver?.(event as DragEvent)) === true;
          break;
        case "dragleave":
          handled = (await handler.handleDragLeave?.(event as DragEvent)) === true;
          break;
        case "drop":
          handled = (await handler.handleDrop?.(event as DragEvent)) === true;
          break;
        case "resize":
          handled = (await handler.handleResize?.(event)) === true;
          break;
        default:
          // Unknown event type
          break;
      }

      if (this.debugMode && handled) {
        console.log(`EventDispatcher: Event ${event.type} handled by ${(handler as any).componentId || "global handler"}`);
      }

      return { handled };
    } catch (error) {
      console.error(`Error dispatching ${event.type} event:`, error);
      return { handled: false };
    }
  }

  private setupGlobalEventListeners(): void {
    // Mouse events
    document.addEventListener("mousedown", (e) => this.dispatchEvent(e).catch(console.error));
    document.addEventListener("mousemove", (e) => this.dispatchEvent(e).catch(console.error));
    document.addEventListener("mouseup", (e) => this.dispatchEvent(e).catch(console.error));
    document.addEventListener("mouseleave", (e) => this.dispatchEvent(e).catch(console.error));
    document.addEventListener("wheel", (e) => this.dispatchEvent(e).catch(console.error), { passive: false });
    document.addEventListener("contextmenu", (e) => this.dispatchEvent(e).catch(console.error));
    document.addEventListener("dblclick", (e) => this.dispatchEvent(e).catch(console.error));

    // Keyboard events
    document.addEventListener("keydown", (e) => this.dispatchEvent(e));
    document.addEventListener("keyup", (e) => this.dispatchEvent(e));

    // Focus events
    document.addEventListener("focus", (e) => this.dispatchEvent(e), true);
    document.addEventListener("blur", (e) => this.dispatchEvent(e), true);

    // Drag and drop events
    document.addEventListener("dragenter", (e) => this.dispatchEvent(e));
    document.addEventListener("dragover", (e) => this.dispatchEvent(e));
    document.addEventListener("dragleave", (e) => this.dispatchEvent(e));
    document.addEventListener("drop", (e) => this.dispatchEvent(e));

    // Window events
    window.addEventListener("resize", (e) => this.dispatchEvent(e));
  }
}
