# Testing Setup

This directory contains the testing infrastructure for the Bedevere Wise project.

## Testing Framework

We use **Vitest** as our testing framework, which provides:

- Fast execution with Vite integration
- TypeScript support out of the box
- Jest-compatible API
- Built-in UI for test development

## Test Structure

```
src/test/
├── setup.ts                 # Global test setup and mocks
├── mocks/                   # Mock implementations
│   └── DataProviderMock.ts  # Mock DataProvider for testing
├── utils/                   # Test utility functions
│   └── testHelpers.ts       # Common test helpers
└── README.md               # This file
```

## Running Tests

### Development Mode

```bash
bun run test
```

Runs tests in watch mode, re-running when files change.

### Run Once

```bash
bun run test:run
```

Runs all tests once and exits.

### UI Mode

```bash
bun run test:ui
```

Opens the Vitest UI for interactive test development.

### Coverage Report

```bash
bun run test:coverage
```

Generates a coverage report for all tests.

## Writing Tests

### Test File Naming

- Test files should be named `*.test.ts` or `*.spec.ts`
- Place test files in `__tests__` directories alongside the source files

### Test Structure

```typescript
import { describe, it, expect, beforeEach, vi } from "vitest";

describe("ClassName", () => {
  let instance: ClassName;

  beforeEach(() => {
    // Setup before each test
  });

  it("should do something", () => {
    // Test implementation
    expect(result).toBe(expected);
  });
});
```

### Mocking

- Use `vi.fn()` to create mock functions
- Use `vi.mock()` to mock modules
- Use the provided mock classes (e.g., `DataProviderMock`)

### Async Testing

```typescript
it("should handle async operations", async () => {
  const result = await asyncFunction();
  expect(result).toBe(expected);
});
```

## Test Utilities

### createTestData(rows, columns)

Creates test data arrays with realistic content.

### createDefaultOptions()

Creates default SpreadsheetOptions for testing.

### createCustomOptions(overrides)

Creates custom options with overrides.

### sleep(ms)

Utility for adding delays in tests when needed.

## Mock Classes

### DataProviderMock

Implements the `DataProvider` interface for testing:

- Configurable test data
- Simulated async behavior
- Helper methods for test setup

## Best Practices

1. **Isolation**: Each test should be independent and not rely on other tests
2. **Setup/Teardown**: Use `beforeEach` and `afterEach` for common setup
3. **Descriptive Names**: Test names should clearly describe what they're testing
4. **Edge Cases**: Include tests for boundary conditions and error scenarios
5. **Performance**: Test both functionality and performance characteristics
6. **Coverage**: Aim for high test coverage, especially for critical paths

## Debugging Tests

- Use `console.log` in tests (will be captured by test runner)
- Use the Vitest UI for interactive debugging
- Set breakpoints in your IDE
- Use `vi.debug()` for detailed logging

## Adding New Tests

1. Create test file in appropriate `__tests__` directory
2. Import necessary dependencies and mocks
3. Write descriptive test cases
4. Ensure tests pass before committing
5. Update this README if adding new testing utilities
