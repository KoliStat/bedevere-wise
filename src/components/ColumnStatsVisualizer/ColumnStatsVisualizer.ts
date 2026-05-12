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
    // column — the value space changed completely so a query
    // carried over from the previous column would be confusing.
    if (this.currentColumn?.name !== column.name) {
      this.valueSearchQuery = "";
      this.valueSearchUseRegex = false;
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

  private renderCategoricalFilter(stats: ColumnStats, isFiltered: boolean, currentFilter?: ColumnFilter): string {
    const selectedValues = new Set(currentFilter?.values || []);
    const regexActive = this.valueSearchUseRegex;
    const query = this.valueSearchQuery;
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
          ${Array.from(stats.valueCounts.entries())
            .map(([value]) => {
              const checked = selectedValues.size === 0 || selectedValues.has(value);
              const display = value.length > 24 ? value.substring(0, 24) + "\u2026" : value;
              return `
                <label class="column-stats__filter-item" data-value="${escapeAttr(value)}" title="${escapeAttr(value)}">
                  <input type="checkbox" value="${escapeAttr(value)}" ${checked ? "checked" : ""} />
                  <span>${escapeHtml(display)}</span>
                </label>
              `;
            })
            .join("")}
        </div>
        <div class="column-stats__filter-search-summary"></div>
        <button class="column-stats__filter-apply" data-action="apply-filter">Apply Filter</button>
      </div>
    `;
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

    // Apply categorical/boolean include filter
    this.container.querySelector("[data-action='apply-filter']")?.addEventListener("click", () => {
      if (!this.filterManager || !this.currentColumn) return;

      const checkboxes = this.container.querySelectorAll<HTMLInputElement>(".column-stats__filter-item input[type='checkbox']");
      const selectedValues: string[] = [];
      let allChecked = true;

      checkboxes.forEach((cb) => {
        if (cb.checked) {
          selectedValues.push(cb.value);
        } else {
          allChecked = false;
        }
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

    // Value-list search (categorical filter only). Hides / shows rows
    // in place — never alters checkbox state, so values hidden by the
    // search still contribute to Apply Filter's included set.
    const searchInput = this.container.querySelector<HTMLInputElement>("[data-action='value-search']");
    if (searchInput) {
      searchInput.addEventListener("input", () => {
        this.valueSearchQuery = searchInput.value;
        this.applyValueSearch();
      });
    }
    const regexToggle = this.container.querySelector<HTMLButtonElement>("[data-action='toggle-regex']");
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
        this.applyValueSearch();
      });
    }
    // Re-apply on every render so a search carried over from a
    // previous render (apply-filter re-renders the panel) shows the
    // same hidden rows.
    if (this.valueSearchQuery) this.applyValueSearch();
  }

  /**
   * Apply the current value-list search to the rendered categorical
   * filter's checkbox rows. Hidden rows keep their `checked` state
   * so Apply Filter respects values the user ticked before searching.
   * Invalid regex falls back to a literal-substring match so the
   * field stays usable mid-typing (e.g. while the user has `[` typed
   * but hasn't closed the bracket yet).
   */
  private applyValueSearch(): void {
    const query = this.valueSearchQuery;
    const useRegex = this.valueSearchUseRegex;
    let re: RegExp | null = null;
    if (query && useRegex) {
      try {
        re = new RegExp(query, "i");
      } catch {
        re = null;
      }
    }
    const lower = query.toLowerCase();
    const items = this.container.querySelectorAll<HTMLElement>(".column-stats__filter-item");
    let hidden = 0;
    items.forEach((item) => {
      const value = item.dataset.value ?? "";
      let match: boolean;
      if (!query) {
        match = true;
      } else if (re) {
        match = re.test(value);
      } else {
        match = value.toLowerCase().includes(lower);
      }
      item.style.display = match ? "" : "none";
      if (!match) hidden++;
    });
    const summary = this.container.querySelector<HTMLElement>(".column-stats__filter-search-summary");
    if (summary) {
      summary.textContent = hidden > 0 && query ? `${hidden} hidden by search` : "";
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
