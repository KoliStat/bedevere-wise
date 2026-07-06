// Event system types for centralized event handling

export interface EventHandler {
  // Mouse events
  handleMouseDown?(event: MouseEvent): Promise<boolean>;
  handleMouseMove?(event: MouseEvent): Promise<boolean>;
  handleMouseUp?(event: MouseEvent): Promise<boolean>;
  handleMouseLeave?(event: MouseEvent): Promise<boolean>;
  handleWheel?(event: WheelEvent): Promise<boolean>;
  handleContextMenu?(event: MouseEvent): Promise<boolean>;
  handleDoubleClick?(event: MouseEvent): Promise<boolean>;

  // Keyboard events
  handleKeyDown?(event: KeyboardEvent): Promise<boolean>;
  handleKeyUp?(event: KeyboardEvent): Promise<boolean>;

  // Focus events
  handleFocus?(event: FocusEvent): Promise<boolean>;
  handleBlur?(event: FocusEvent): Promise<boolean>;

  // Drag and drop events
  handleDragEnter?(event: DragEvent): Promise<boolean>;
  handleDragOver?(event: DragEvent): Promise<boolean>;
  handleDragLeave?(event: DragEvent): Promise<boolean>;
  handleDrop?(event: DragEvent): Promise<boolean>;

  // Window events
  handleResize?(event: Event): Promise<boolean | void>;
}

export interface FocusableComponent extends EventHandler {
  readonly componentId: string;
  readonly canReceiveFocus: boolean;
  readonly focusableElement?: HTMLElement;

  // Focus management
  focus(): void;
  blur(): void;
  isFocused(): boolean;
}

export interface EventDispatcher {
  // Component registration
  registerComponent(component: FocusableComponent): void;
  unregisterComponent(componentId: string): void;

  // Focus management
  setFocus(componentId: string): void;
  popFocus(): void;
  getFocusedComponent(): FocusableComponent | null;

  // Event handling
  dispatchEvent(event: Event): Promise<boolean>;

  // Global event handlers (for events that should always be handled)
  addGlobalEventHandler(handler: EventHandler): void;
  removeGlobalEventHandler(handler: EventHandler): void;
}

export interface FocusManager {
  // Focus tracking
  setFocus(component: FocusableComponent): void;
  getFocusedComponent(): FocusableComponent | null;

  // Focus stack (for nested focus scenarios)
  pushFocus(component: FocusableComponent): void;
  popFocus(): FocusableComponent | null;

  // Focus events
  onFocusChange(callback: (component: FocusableComponent | null, previousId: FocusableComponent | null) => void): void;
}

// Event dispatch result
export interface EventDispatchResult {
  handled: boolean;
  component?: FocusableComponent;
  stopPropagation?: boolean;
  preventDefault?: boolean;
}
