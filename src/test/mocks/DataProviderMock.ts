import { DataProvider, DatasetMetadata, ColumnStats, Column } from "@/data/types";

export class DataProviderMock implements DataProvider {
  private mockData: any[][];
  private metadata: DatasetMetadata;
  private simulateAsync: boolean;

  constructor(mockData: any[][] = [], metadata?: Partial<DatasetMetadata>, simulateAsync: boolean = false) {
    this.mockData = mockData;
    this.metadata = {
      name: "Test Dataset",
      totalRows: mockData.length,
      totalColumns: mockData.length > 0 ? mockData[0].length : 0,
      columns: [],
      ...metadata,
    };

    this.simulateAsync = simulateAsync;
  }

  async getMetadata(): Promise<DatasetMetadata> {
    return this.metadata;
  }

  async fetchData(startRow: number, endRow: number): Promise<any[][]> {
    // Simulate async behavior
    if (this.simulateAsync) {
      const delay = Math.random() * 100;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
    return this.mockData.slice(startRow, endRow);
  }

  async fetchDataColumnRange(startRow: number, endRow: number, startCol: number, endCol: number): Promise<any[][]> {
    if (this.simulateAsync) {
      const delay = Math.random() * 100;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
    const rowSlice = this.mockData.slice(startRow, endRow);
    return rowSlice.map((row) => row.slice(startCol, endCol));
  }

  async getColumnStats(_: string | Column): Promise<ColumnStats | null> {
    if (this.simulateAsync) {
      const delay = Math.random() * 100;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
    return null;
  }

  async getColumnStatsFiltered(column: string | Column): Promise<ColumnStats | null> {
    return this.getColumnStats(column);
  }

  async searchColumnValues(
    _column: string | Column,
    _options: { query: string; mode: "substring" | "regex"; limit: number },
  ): Promise<Array<{ value: string; count: number }>> {
    return [];
  }

  setName(name: string): void {
    this.metadata.name = name;
  }

  setDescription(description: string): void {
    this.metadata.description = description;
  }

  setLabel(label: string): void {
    this.metadata.label = label;
  }

  // Test helper methods
  setMockData(data: any[][]): void {
    this.mockData = data;
    this.metadata.totalRows = data.length;
    this.metadata.totalColumns = data.length > 0 ? data[0].length : 0;
  }

  getMockData(): any[][] {
    return this.mockData;
  }
}
