import { SpreadsheetVisualizer } from "../SpreadsheetVisualizer/SpreadsheetVisualizer";
import {
  Column,
  ColumnStats,
  DataType,
  isBooleanType,
  isDateType,
  isNumericType,
  isStringType,
  isTemporalType,
  isTimeType,
  isTimestampType,
} from "../../data/types";
import { ColumnFilterManager, ColumnFilter } from "../../data/ColumnFilterManager";
import { ColumnInternal } from "../SpreadsheetVisualizer/internals";
import { formatValue } from "../SpreadsheetVisualizer/utils/formatting";
import { SpreadsheetOptions } from "../SpreadsheetVisualizer/types";
import { escapeHtml } from "../../utils/html";

export class ColumnStatsVisualizer {
  private container: HTMLElement;
  private spreadsheetVisualizer: SpreadsheetVisualizer | null = null;
  private currentColumn: Column | null = null;
  private filterManager: ColumnFilterManager | null = null;
  private datasetName: string = "";
  public onFilterChangeCallback?: () => void;
  private onShowStatsCallback?: () => void;
  // Search state for the categorical filter's value list. Survives
  // the apply-filter re-render so the user doesn't have to retype
  // their query after each apply; resets to empty / off when the
  // user picks a different column (see showStats).
  private valueSearchQuery: string = "";
  private valueSearchUseRegex: boolean = false;
  // Server-side search results when a query is active. `null` =
  // no search → render the static top-N from `stats.valueCounts`.
  private valueSearchResults: Array<{ value: string; count: number }> | null = null;
  // Monotonic token to drop stale async results when the user keeps
  // typing or toggles regex mode mid-flight.
  private valueSearchSeq: number = 0;
  private valueSearchDebounceTimer: number | null = null;
  // Categorical filter "explicit exclusion" set. Surviving across
  // searches lets the user uncheck a value found via search, then
  // clear the search and have that exclusion still apply. Reset on
  // column change; pre-populated from an existing exclude-type filter
  // so the panel reflects what's already filtered.
  private excludedValues: Set<string> = new Set();
  // Per-column-session result cap from searchColumnValues. Lifted up
  // so the "results capped" hint matches what the provider was asked
  // for; a future setting could expose this.
  private static readonly VALUE_SEARCH_LIMIT = 500;

  constructor(parent: HTMLElement, spreadsheetVisualizer: SpreadsheetVisualizer | null) {
    this.container = document.createElement("div");
    this.spreadsheetVisualizer = spreadsheetVisualizer;

    this.container.id = "column-stats-container";
    parent.appendChild(this.container);
  }

  public async setSpreadsheetVisualizer(spreadsheetVisualizer: SpreadsheetVisualizer) {
    this.spreadsheetVisualizer = spreadsheetVisualizer;

    if (this.spreadsheetVisualizer.getSelectedColumns().length > 0) {
      await this.showStats(this.spreadsheetVisualizer.getSelectedColumns()[0]);
    } else {
      this.hide();
    }
  }

  public async showStats(column: Column) {
    // Reset the value-list search when switching to a different
    // column — the value space changed completely so a query carried
    // over from the previous column would be confusing. Pre-load the
    // exclusion set from any existing exclude-type filter so the
    // checkbox UI matches what's already filtered.
    if (this.currentColumn?.name !== column.name) {
      this.valueSearchQuery = "";
      this.valueSearchUseRegex = false;
      this.valueSearchResults = null;
      this.valueSearchSeq++;
      if (this.valueSearchDebounceTimer !== null) {
        window.clearTimeout(this.valueSearchDebounceTimer);
        this.valueSearchDebounceTimer = null;
      }
      this.excludedValues = new Set();
      if (this.filterManager) {
        const existing = this.filterManager
          .getFilters(this.datasetName)
          .find((f) => f.columnName === column.name);
        if (existing?.filterType === "exclude" && existing.values) {
          this.excludedValues = new Set(existing.values);
        }
      }
    }
    this.currentColumn = column;
    this.container.style.display = "block";
    this.container.classList.add("visible");
    this.onShowStatsCallback?.();

    // Two passes: filtered stats drive the display (mean / median /
    // histogram move with the visible rows), unfiltered stats drive
    // the filter UI controls (slider bounds + categorical value list)
    // so the user can broaden the filter from the panel.
    const provider = this.spreadsheetVisualizer!.getDataProvider();
    const [filtered, unfiltered] = await Promise.all([
      provider.getColumnStatsFiltered(column),
      provider.getColumnStats(column),
    ]);
    // Bail if the selection changed while we were awaiting — avoids
    // racing renders when handleFilterChange fires a refresh while
    // the user is clicking a different column.
    if (this.currentColumn !== column) return;
    this.render(filtered ?? unfiltered, unfiltered ?? filtered);
  }

  public setOnShowStatsCallback(callback: () => void): void {
    this.onShowStatsCallback = callback;
  }

  public hide() {
    this.container.style.display = "none";
    this.container.classList.remove("visible");
    this.currentColumn = null;
  }

  public getContainer(): HTMLElement {
    return this.container;
  }

  public setFilterManager(filterManager: ColumnFilterManager, datasetName: string): void {
    this.filterManager = filterManager;
    this.datasetName = datasetName;
  }

  public setDatasetName(datasetName: string): void {
    this.datasetName = datasetName;
  }

  public setOnFilterChangeCallback(callback: () => void): void {
    this.onFilterChangeCallback = callback;
  }

  /**
   * Format a raw value (as returned by the data provider) using the column's type.
   * Falls back to String(value) if formatting fails.
   */
  private displayValue(value: any): string {
    if (!this.currentColumn) return String(value);
    if (value === null || value === undefined) return "NULL";
    try {
      const opts = (this.spreadsheetVisualizer?.getOptions?.() ?? {}) as SpreadsheetOptions;
      const colInternal = this.currentColumn as ColumnInternal;
      return formatValue(value, colInternal, opts).formatted;
    } catch {
      return String(value);
    }
  }

  private render(filteredStats: ColumnStats | null, unfilteredStats: ColumnStats | null) {
    if (!this.currentColumn || !filteredStats || !unfilteredStats) return;

    const sortDirection = this.filterManager?.isColumnSorted(this.datasetName, this.currentColumn.name) ?? null;

    this.container.innerHTML = `
      <div class="column-stats">
        <div class="column-stats__header">
          <div class="column-stats__header-left">
            <h3>${escapeHtml(this.currentColumn.name)}</h3>
            ${this.currentColumn.label ? `<div class="column-stats__label">${escapeHtml(this.currentColumn.label)}</div>` : ""}
            <div class="column-stats__type">${escapeHtml((this.currentColumn as any).rawType || this.currentColumn.dataType)}</div>
          </div>
          <div class="column-stats__sort-stack">
            <button class="column-stats__sort-btn${sortDirection === "asc" ? " column-stats__sort-btn--active" : ""}" data-sort="asc" title="Sort Ascending">&#9650;</button>
            <button class="column-stats__sort-btn${sortDirection === "desc" ? " column-stats__sort-btn--active" : ""}" data-sort="desc" title="Sort Descending">&#9660;</button>
            ${sortDirection ? `<button class="column-stats__sort-btn column-stats__sort-btn--clear" data-sort="clear" title="Clear Sort">&#10005;</button>` : ""}
          </div>
        </div>
        <div class="column-stats__container">
          ${this.renderStats(filteredStats)}
        </div>
        ${this.renderFilterControls(unfilteredStats)}
        ${this.renderVisualization(filteredStats)}
      </div>
    `;

    this.attachEventListeners(unfilteredStats);
  }

  private renderFilterControls(stats: ColumnStats): string {
    if (!this.filterManager || !this.currentColumn) return "";

    const dt = this.currentColumn.dataType;
    const isFiltered = this.filterManager.isColumnFiltered(this.datasetName, this.currentColumn.name);
    const currentFilter = this.filterManager
      .getFilters(this.datasetName)
      .find((f) => f.columnName === this.currentColumn!.name);

    // Numeric range filter
    if (isNumericType(dt) && stats.numericStats) {
      return this.renderNumericRangeFilter(stats, isFiltered, currentFilter);
    }

    // Temporal range filter
    if (isTemporalType(dt) && stats.temporalStats) {
      return this.renderTemporalRangeFilter(dt, isFiltered, currentFilter);
    }

    // Boolean filter (TRUE/FALSE checkboxes)
    if (isBooleanType(dt) && stats.isCategorical) {
      return this.renderBooleanFilter(stats, isFiltered, currentFilter);
    }

    // Categorical filter (string)
    if (isStringType(dt) && stats.isCategorical && stats.valueCounts.size > 0) {
      return this.renderCategoricalFilter(stats, isFiltered, currentFilter);
    }

    return "";
  }

  private renderCategoricalFilter(stats: ColumnStats, isFiltered: boolean, _currentFilter?: ColumnFilter): string {
    const regexActive = this.valueSearchUseRegex;
    const query = this.valueSearchQuery;
    // Initial list comes from the static top-N (`valueCounts`). The
    // search handler later swaps this innerHTML out with server-side
    // results when a query is typed.
    const initialItems = Array.from(stats.valueCounts.entries()).map(([value, count]) => ({
      value,
      count,
    }));
    return `
      <div class="column-stats__filter">
        <div class="column-stats__filter-header">
          <span class="column-stats__filter-title">Filter Values</span>
          ${isFiltered ? `<button class="column-stats__filter-clear" data-action="clear-filter">Clear</button>` : ""}
        </div>
        <div class="column-stats__filter-search">
          <input
            type="search"
            class="column-stats__filter-search-input"
            placeholder="${regexActive ? "Regex\u2026" : "Search values\u2026"}"
            value="${escapeAttr(query)}"
            data-action="value-search"
          />
          <button
            class="column-stats__filter-regex-toggle${regexActive ? " column-stats__filter-regex-toggle--active" : ""}"
            data-action="toggle-regex"
            title="${regexActive ? "Regex match (case-insensitive)" : "Substring match (case-insensitive)"}. Click to switch."
          >.*</button>
        </div>
        <div class="column-stats__filter-list">
          ${this.buildCategoricalListItems(initialItems)}
        </div>
        <div class="column-stats__filter-search-summary"></div>
        <button class="column-stats__filter-apply" data-action="apply-filter">Apply Filter</button>
      </div>
    `;
  }

  /**
   * HTML for the `__filter-list` body. Shared between the initial
   * render (inlined into renderCategoricalFilter) and the search-result
   * re-render (set as innerHTML on the existing list element).
   * Checkbox state comes from `excludedValues` \u2014 checked iff the value
   * is NOT in the set \u2014 so re-renders keep prior selections intact.
   */
  private buildCategoricalListItems(items: Array<{ value: string; count: number }>): string {
    if (items.length === 0) {
      return `<div class="column-stats__filter-empty">No matching values.</div>`;
    }
    return items
      .map(({ value, count }) => {
        const checked = !this.excludedValues.has(value);
        const display = value.length > 24 ? value.substring(0, 24) + "\u2026" : value;
        return `
          <label class="column-stats__filter-item" data-value="${escapeAttr(value)}" title="${escapeAttr(value)}">
            <input type="checkbox" value="${escapeAttr(value)}" ${checked ? "checked" : ""} />
            <span>${escapeHtml(display)}</span>
            <span class="column-stats__filter-count">(${count.toLocaleString()})</span>
          </label>
        `;
      })
      .join("");
  }

  private renderBooleanFilter(stats: ColumnStats, isFiltered: boolean, currentFilter?: ColumnFilter): string {
    const selectedValues = new Set(currentFilter?.values || []);
    const entries = Array.from(stats.valueCounts.entries());
    return `
      <div class="column-stats__filter">
        <div class="column-stats__filter-header">
          <span class="column-stats__filter-title">Filter Values</span>
          ${isFiltered ? `<button class="column-stats__filter-clear" data-action="clear-filter">Clear</button>` : ""}
        </div>
        <div class="column-stats__filter-list">
          ${entries
            .map(([value, count]) => {
              const checked = selectedValues.size === 0 || selectedValues.has(value);
              return `
                <label class="column-stats__filter-item">
                  <input type="checkbox" value="${escapeAttr(value)}" ${checked ? "checked" : ""} />
                  <span>${escapeHtml(value)} <span class="column-stats__filter-count">(${count.toLocaleString()})</span></span>
                </label>
              `;
            })
            .join("")}
        </div>
        <button class="column-stats__filter-apply" data-action="apply-filter">Apply Filter</button>
      </div>
    `;
  }

  private renderNumericRangeFilter(stats: ColumnStats, isFiltered: boolean, currentFilter?: ColumnFilter): string {
    const s = stats.numericStats!;
    return `
      <div class="column-stats__filter">
        <div class="column-stats__filter-header">
          <span class="column-stats__filter-title">Filter Range</span>
          ${isFiltered ? `<button class="column-stats__filter-clear" data-action="clear-filter">Clear</button>` : ""}
        </div>
        <div class="column-stats__filter-range">
          <label>
            <span>Min</span>
            <input type="number" class="column-stats__filter-input" data-range="min"
              placeholder="${formatPlaceholder(s.min)}"
              value="${currentFilter?.min ?? ""}" />
          </label>
          <label>
            <span>Max</span>
            <input type="number" class="column-stats__filter-input" data-range="max"
              placeholder="${formatPlaceholder(s.max)}"
              value="${currentFilter?.max ?? ""}" />
          </label>
        </div>
        <button class="column-stats__filter-apply" data-action="apply-range-filter">Apply Filter</button>
      </div>
    `;
  }

  private renderTemporalRangeFilter(dt: DataType, isFiltered: boolean, currentFilter?: ColumnFilter): string {
    // Pick input type based on temporal subtype
    let inputType: string;
    if (isDateType(dt)) inputType = "date";
    else if (isTimeType(dt)) inputType = "time";
    else inputType = "datetime-local";

    const minVal = currentFilter?.minStr ?? "";
    const maxVal = currentFilter?.maxStr ?? "";

    return `
      <div class="column-stats__filter">
        <div class="column-stats__filter-header">
          <span class="column-stats__filter-title">Filter Range</span>
          ${isFiltered ? `<button class="column-stats__filter-clear" data-action="clear-filter">Clear</button>` : ""}
        </div>
        <div class="column-stats__filter-range column-stats__filter-range--stacked">
          <label>
            <span>From</span>
            <input type="${inputType}" class="column-stats__filter-input" data-range="min" value="${escapeAttr(minVal)}" />
          </label>
          <label>
            <span>To</span>
            <input type="${inputType}" class="column-stats__filter-input" data-range="max" value="${escapeAttr(maxVal)}" />
          </label>
        </div>
        <button class="column-stats__filter-apply" data-action="apply-temporal-filter">Apply Filter</button>
      </div>
    `;
  }

  private attachEventListeners(_stats: ColumnStats): void {
    const dt = this.currentColumn?.dataType;

    // Click-to-copy on the column header and each categorical-histogram
    // value label. Mouse drag-selecting still works because `click`
    // only fires when the press and release land on the same element
    // with no drag.
    this.container.querySelector(".column-stats__header h3")?.addEventListener("click", (e) => {
      const el = e.currentTarget as HTMLElement;
      const text = (el.textContent ?? "").trim();
      this.copyToClipboard(text, el);
    });

    // Click-to-copy on each categorical-histogram value label. The
    // numerical / temporal chart uses `histogram__numerical-bar` and
    // doesn't emit `histogram__label`, so this selector only ever
    // touches categorical rows. The cursor + hover styling lives in
    // SCSS (`.histogram__label`).
    this.container.querySelectorAll<HTMLElement>(".histogram__chart .histogram__label").forEach((label) => {
      const fullText = label.getAttribute("title") ?? label.textContent ?? "";
      label.title = `${fullText}\nClick to copy`;
      label.addEventListener("click", () => this.copyToClipboard(fullText.trim(), label));
    });

    // Sort buttons
    this.container.querySelectorAll(".column-stats__sort-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const action = (btn as HTMLElement).dataset.sort;
        if (!this.filterManager || !this.currentColumn) return;

        if (action === "clear") {
          this.filterManager.removeSort(this.datasetName, this.currentColumn.name);
        } else if (action === "asc" || action === "desc") {
          this.filterManager.setSort(this.datasetName, {
            columnName: this.currentColumn.name,
            direction: action,
          });
        }
      });
    });

    // Clear filter button
    this.container.querySelector("[data-action='clear-filter']")?.addEventListener("click", () => {
      if (!this.filterManager || !this.currentColumn) return;
      this.filterManager.removeFilter(this.datasetName, this.currentColumn.name);
    });

    // Apply filter — semantics depend on column type.
    //   - String (categorical):
    //       • Search active → write an *include* filter of
    //         (currently matching values) ∩ (checked). The search
    //         narrows the candidate set; checkboxes refine within it.
    //         This is what the user means by "show only the values
    //         matching the search and selected among them".
    //       • No search    → write an *exclude* filter of unchecks,
    //         so opening on a high-cardinality column and unchecking
    //         a few values doesn't accidentally collapse the filter
    //         to just the top-N.
    //   - Boolean: keep the legacy include semantics (small fixed
    //     value space — TRUE/FALSE — so the include list is trivial
    //     to read straight from the DOM).
    this.container.querySelector("[data-action='apply-filter']")?.addEventListener("click", () => {
      if (!this.filterManager || !this.currentColumn) return;

      if (dt && isStringType(dt)) {
        const searchActive = this.valueSearchQuery !== "";

        if (searchActive) {
          // "Visible" = the values currently rendered in the filter
          // list — either the server-side search results or, if the
          // debounced fetch hasn't resolved yet, the static top-N.
          const visible: string[] =
            this.valueSearchResults !== null
              ? this.valueSearchResults.map((r) => r.value)
              : Array.from(_stats.valueCounts.keys());
          const checked = visible.filter((v) => !this.excludedValues.has(v));

          if (checked.length === 0) {
            this.filterManager.removeFilter(this.datasetName, this.currentColumn.name);
          } else {
            const filter: ColumnFilter = {
              columnName: this.currentColumn.name,
              dataType: dt,
              filterType: "include",
              values: checked,
            };
            this.filterManager.setFilter(this.datasetName, filter);
          }
          return;
        }

        if (this.excludedValues.size === 0) {
          this.filterManager.removeFilter(this.datasetName, this.currentColumn.name);
        } else {
          const filter: ColumnFilter = {
            columnName: this.currentColumn.name,
            dataType: dt,
            filterType: "exclude",
            values: [...this.excludedValues],
          };
          this.filterManager.setFilter(this.datasetName, filter);
        }
        return;
      }

      // Boolean path (legacy include).
      const checkboxes = this.container.querySelectorAll<HTMLInputElement>(".column-stats__filter-item input[type='checkbox']");
      const selectedValues: string[] = [];
      let allChecked = true;
      checkboxes.forEach((cb) => {
        if (cb.checked) selectedValues.push(cb.value);
        else allChecked = false;
      });

      if (allChecked || selectedValues.length === 0) {
        this.filterManager.removeFilter(this.datasetName, this.currentColumn.name);
      } else {
        const filter: ColumnFilter = {
          columnName: this.currentColumn.name,
          dataType: dt,
          filterType: "include",
          values: selectedValues,
        };
        this.filterManager.setFilter(this.datasetName, filter);
      }
    });

    // Apply numeric range filter
    this.container.querySelector("[data-action='apply-range-filter']")?.addEventListener("click", () => {
      if (!this.filterManager || !this.currentColumn) return;

      const minInput = this.container.querySelector<HTMLInputElement>("[data-range='min']");
      const maxInput = this.container.querySelector<HTMLInputElement>("[data-range='max']");

      const min = minInput?.value ? parseFloat(minInput.value) : undefined;
      const max = maxInput?.value ? parseFloat(maxInput.value) : undefined;

      if (min === undefined && max === undefined) {
        this.filterManager.removeFilter(this.datasetName, this.currentColumn.name);
      } else {
        const filter: ColumnFilter = {
          columnName: this.currentColumn.name,
          dataType: dt,
          filterType: "range",
          min,
          max,
        };
        this.filterManager.setFilter(this.datasetName, filter);
      }
    });

    // Apply temporal range filter
    this.container.querySelector("[data-action='apply-temporal-filter']")?.addEventListener("click", () => {
      if (!this.filterManager || !this.currentColumn) return;

      const minInput = this.container.querySelector<HTMLInputElement>("[data-range='min']");
      const maxInput = this.container.querySelector<HTMLInputElement>("[data-range='max']");

      const minStr = minInput?.value || undefined;
      const maxStr = maxInput?.value || undefined;

      if (!minStr && !maxStr) {
        this.filterManager.removeFilter(this.datasetName, this.currentColumn.name);
      } else {
        const filter: ColumnFilter = {
          columnName: this.currentColumn.name,
          dataType: dt,
          filterType: "range",
          minStr,
          maxStr,
        };
        this.filterManager.setFilter(this.datasetName, filter);
      }
    });

    // Categorical value-list interactions live below — boolean filters
    // keep the legacy DOM-read path in the apply handler above.
    if (dt && isStringType(dt)) {
      const searchInput = this.container.querySelector<HTMLInputElement>("[data-action='value-search']");
      const regexToggle = this.container.querySelector<HTMLButtonElement>("[data-action='toggle-regex']");

      if (searchInput) {
        searchInput.addEventListener("input", () => {
          this.valueSearchQuery = searchInput.value;
          this.scheduleValueSearch(_stats);
        });
      }
      if (regexToggle) {
        regexToggle.addEventListener("click", () => {
          this.valueSearchUseRegex = !this.valueSearchUseRegex;
          regexToggle.classList.toggle("column-stats__filter-regex-toggle--active", this.valueSearchUseRegex);
          regexToggle.title = this.valueSearchUseRegex
            ? "Regex match (case-insensitive). Click to switch."
            : "Substring match (case-insensitive). Click to switch.";
          if (searchInput) {
            searchInput.placeholder = this.valueSearchUseRegex ? "Regex…" : "Search values…";
          }
          this.scheduleValueSearch(_stats);
        });
      }

      // Checkbox toggles update the running exclusion set. Delegated
      // because the value list re-renders on search and direct per-row
      // handlers would dangle. Reading dataset.value on the parent
      // label keeps the wiring simple even when the user clicks the
      // text instead of the box.
      const filterContainer = this.container.querySelector<HTMLElement>(".column-stats__filter");
      filterContainer?.addEventListener("change", (e) => {
        const target = e.target as HTMLInputElement;
        if (!target.matches(".column-stats__filter-item input[type='checkbox']")) return;
        const value = target.value;
        if (target.checked) this.excludedValues.delete(value);
        else this.excludedValues.add(value);
      });

      // If the user came back to this panel mid-search (e.g. apply
      // refetched stats and re-rendered), kick off the search again so
      // the list reflects the current query.
      if (this.valueSearchQuery) {
        this.scheduleValueSearch(_stats, /*immediate*/ true);
      }
    }
  }

  /**
   * Run a server-side `searchColumnValues` for the current query, then
   * swap the categorical filter's list contents with the matches. A
   * monotonic sequence number ensures stale responses (typed past) are
   * dropped on arrival. Invalid regex (in regex mode) is caught in the
   * provider and surfaced here as an empty result — we silently fall
   * back to substring so the field stays usable while the user types.
   */
  private scheduleValueSearch(unfilteredStats: ColumnStats, immediate: boolean = false): void {
    if (this.valueSearchDebounceTimer !== null) {
      window.clearTimeout(this.valueSearchDebounceTimer);
      this.valueSearchDebounceTimer = null;
    }

    const query = this.valueSearchQuery;
    if (!query) {
      // Clearing the query restores the static top-N from
      // `valueCounts` — drop in-flight searches and re-render.
      this.valueSearchSeq++;
      this.valueSearchResults = null;
      this.repaintCategoricalList(unfilteredStats);
      return;
    }

    const run = async () => {
      const seq = ++this.valueSearchSeq;
      const provider = this.spreadsheetVisualizer?.getDataProvider();
      const column = this.currentColumn;
      if (!provider || !column) return;
      let mode: "substring" | "regex" = this.valueSearchUseRegex ? "regex" : "substring";
      // Pre-validate regex client-side so we don't fire a query that
      // DuckDB will reject — fall back to substring while the user is
      // mid-typing a regex (e.g. just `[` without a close).
      if (mode === "regex") {
        try { new RegExp(query, "i"); }
        catch { mode = "substring"; }
      }
      try {
        const results = await provider.searchColumnValues(column, {
          query,
          mode,
          limit: ColumnStatsVisualizer.VALUE_SEARCH_LIMIT,
        });
        if (seq !== this.valueSearchSeq) return;
        this.valueSearchResults = results;
      } catch (err) {
        if (seq !== this.valueSearchSeq) return;
        console.error("searchColumnValues failed:", err);
        this.valueSearchResults = [];
      }
      this.repaintCategoricalList(unfilteredStats);
    };

    if (immediate) {
      run();
    } else {
      // 180ms — short enough to feel live, long enough to coalesce
      // bursts of keystrokes into one DB query.
      this.valueSearchDebounceTimer = window.setTimeout(run, 180);
    }
  }

  /**
   * Re-render only the categorical filter's value list (and its
   * summary line) without touching the rest of the panel. Preserves
   * focus on the search input across keystrokes.
   */
  private repaintCategoricalList(unfilteredStats: ColumnStats): void {
    const list = this.container.querySelector<HTMLElement>(".column-stats__filter-list");
    if (!list) return;

    let items: Array<{ value: string; count: number }>;
    if (this.valueSearchResults !== null) {
      items = this.valueSearchResults;
    } else {
      items = Array.from(unfilteredStats.valueCounts.entries()).map(([value, count]) => ({
        value,
        count,
      }));
    }
    list.innerHTML = this.buildCategoricalListItems(items);

    const summary = this.container.querySelector<HTMLElement>(".column-stats__filter-search-summary");
    if (!summary) return;
    if (this.valueSearchResults !== null) {
      const n = items.length;
      const capped = n >= ColumnStatsVisualizer.VALUE_SEARCH_LIMIT;
      summary.textContent = capped
        ? `${n} matches (capped at ${ColumnStatsVisualizer.VALUE_SEARCH_LIMIT}; narrow the query for more)`
        : `${n} match${n === 1 ? "" : "es"}`;
    } else {
      summary.textContent = "";
    }
  }

  private formatNum(n: number): string {
    if (n == null || !isFinite(n) || isNaN(n)) return "NULL";
    return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  private renderStats(stats: ColumnStats) {
    if (!stats) return "";
    const dt = this.currentColumn?.dataType;

    const rows: [string, string][] = [
      ["Total Count", stats.totalCount.toLocaleString()],
      ["Null Count", stats.nullCount.toLocaleString()],
      ["Distinct", stats.distinctCount.toLocaleString()],
    ];

    if (dt && isNumericType(dt) && stats.numericStats) {
      const s = stats.numericStats;
      rows.push(
        ["Min", this.formatNum(s.min)],
        ["Mean", this.formatNum(s.mean)],
        ["Median", this.formatNum(s.median)],
        ["Std", this.formatNum(s.stdDev)],
        ["Max", this.formatNum(s.max)],
      );
    } else if (dt && isTemporalType(dt) && stats.temporalStats) {
      // Use raw min/max converted through the column formatter
      const minRaw = temporalRawFromEpoch(stats.temporalStats.min, dt);
      const maxRaw = temporalRawFromEpoch(stats.temporalStats.max, dt);
      rows.push(
        ["Min", this.displayValue(minRaw)],
        ["Max", this.displayValue(maxRaw)],
      );
    }

    return `
      <table class="column-stats__table">
        <tbody>
          ${rows
            .map(
              ([label, value]) => `
            <tr>
              <td class="column-stats__table-label">${escapeHtml(label)}</td>
              <td class="column-stats__table-value">${escapeHtml(value)}</td>
            </tr>
          `,
            )
            .join("")}
        </tbody>
      </table>
    `;
  }

  private renderVisualization(stats: ColumnStats) {
    const dt = this.currentColumn?.dataType;

    if (dt && isNumericType(dt)) {
      return this.renderNumericalHistogram(stats);
    }
    if (dt && isTemporalType(dt)) {
      return this.renderTemporalHistogram(stats);
    }

    if (!stats.valueCounts || stats.valueCounts.size === 0) return "";

    const maxCount = Math.max(...Array.from(stats.valueCounts.values()));
    const shownCount = stats.valueCounts.size;
    const remaining = Math.max(0, stats.distinctCount - shownCount);

    return `
      <div class="histogram__container">
        <div class="histogram__title">Top ${shownCount} Most Frequent</div>
        <div class="histogram__chart">
          ${Array.from(stats.valueCounts.entries())
            .map(([value, count]: [string, number]) => {
              const raw = stats.valueCountsRaw?.get(value);
              const displayFull = raw !== undefined ? this.displayValue(raw) : value;
              const display = displayFull.length > 24 ? displayFull.substring(0, 24) + "\u2026" : displayFull;
              const pct = ((count / stats.totalCount) * 100).toFixed(1);
              const barWidth = (count / maxCount) * 100;
              return `
                <div class="histogram__row">
                  <div class="histogram__label" title="${escapeAttr(displayFull)}">${escapeHtml(display)}</div>
                  <div class="histogram__bar-track">
                    <div class="histogram__bar-fill" style="width: ${barWidth}%"></div>
                  </div>
                  <div class="histogram__count">${count.toLocaleString()} <span class="histogram__pct">${pct}%</span></div>
                </div>
              `;
            })
            .join("")}
        </div>
        ${remaining > 0 ? `<div class="histogram__footer">${remaining.toLocaleString()} more distinct values</div>` : ""}
      </div>
    `;
  }

  private renderNumericalHistogram(stats: ColumnStats) {
    if (!stats.valueCounts || stats.valueCounts.size === 0) return "";

    const entries = Array.from(stats.valueCounts.entries());
    const maxCount = Math.max(...entries.map(([, c]) => c));

    const minLabel = stats.numericStats ? this.formatNum(stats.numericStats.min) : "";
    const maxLabel = stats.numericStats ? this.formatNum(stats.numericStats.max) : "";

    return `
      <div class="histogram__container">
        <div class="histogram__title">Distribution</div>
        <div class="histogram__chart histogram__chart--numerical">
          ${entries
            .map(([label, count]: [string, number]) => {
              const height = maxCount > 0 ? (count / maxCount) * 100 : 0;
              return `
                <div class="histogram__numerical-bar" title="${escapeAttr(label + "\n" + count.toLocaleString())}">
                  <div class="histogram__numerical-bar-fill" style="height: ${height}%"></div>
                </div>
              `;
            })
            .join("")}
        </div>
        <div class="histogram__axis">
          <span>${escapeHtml(minLabel)}</span>
          <span>${escapeHtml(maxLabel)}</span>
        </div>
      </div>
    `;
  }

  private renderTemporalHistogram(stats: ColumnStats) {
    if (!stats.valueCounts || stats.valueCounts.size === 0) return "";

    const entries = Array.from(stats.valueCounts.entries());
    const maxCount = Math.max(...entries.map(([, c]) => c));
    const dt = this.currentColumn?.dataType;

    const minLabel =
      dt && stats.temporalStats ? this.displayValue(temporalRawFromEpoch(stats.temporalStats.min, dt)) : "";
    const maxLabel =
      dt && stats.temporalStats ? this.displayValue(temporalRawFromEpoch(stats.temporalStats.max, dt)) : "";

    return `
      <div class="histogram__container">
        <div class="histogram__title">Distribution</div>
        <div class="histogram__chart histogram__chart--numerical">
          ${entries
            .map(([label, count]: [string, number]) => {
              const height = maxCount > 0 ? (count / maxCount) * 100 : 0;
              return `
                <div class="histogram__numerical-bar" title="${escapeAttr(label + "\n" + count.toLocaleString())}">
                  <div class="histogram__numerical-bar-fill" style="height: ${height}%"></div>
                </div>
              `;
            })
            .join("")}
        </div>
        <div class="histogram__axis">
          <span>${escapeHtml(minLabel)}</span>
          <span>${escapeHtml(maxLabel)}</span>
        </div>
      </div>
    `;
  }

  /**
   * Best-effort copy + brief visual flash on the originating element.
   * The flash is the user-visible confirmation that the click did
   * something (no toast, no popover — the panel is already
   * information-dense and a transient inline state is cheaper to read).
   * The clipboard write is wrapped because some browsers / contexts
   * (insecure HTTP, permission denied) reject `navigator.clipboard`.
   */
  private copyToClipboard(text: string, sourceElement: HTMLElement): void {
    if (!text) return;
    const writer = navigator.clipboard?.writeText?.(text);
    if (writer) {
      writer.then(() => this.flashCopied(sourceElement)).catch((err) => {
        console.warn("ColumnStatsVisualizer: clipboard write failed", err);
      });
    } else {
      console.warn("ColumnStatsVisualizer: clipboard API unavailable");
    }
  }

  private flashCopied(element: HTMLElement): void {
    element.classList.add("column-stats__copied");
    window.setTimeout(() => element.classList.remove("column-stats__copied"), 700);
  }
}


function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/"/g, "&quot;");
}

function formatPlaceholder(n: number): string {
  if (!isFinite(n)) return "";
  return Number(n.toFixed(4)).toString();
}

/**
 * Convert an "epoch" representation (as used in getColumnStats for temporal
 * bucketing) back to the raw value that the column formatter expects.
 *
 * - DATE: days since 1970-01-01 → number of ms since epoch (what `new Date()` takes)
 * - TIME: micros since midnight → micros since midnight (formatter handles this directly)
 * - TIMESTAMP: micros since epoch → ms since epoch (what `new Date()` takes)
 */
function temporalRawFromEpoch(value: number, dt: DataType): any {
  if (!isFinite(value)) return null;
  if (isDateType(dt)) {
    return new Date(value * 86400 * 1000);
  }
  if (isTimeType(dt)) {
    return value;
  }
  if (isTimestampType(dt)) {
    return new Date(value / 1000);
  }
  return value;
}
