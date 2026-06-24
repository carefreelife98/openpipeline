// Vitest setup for DOM-based tests (jsdom-env files only — node-env tests are
// unaffected). Registers @testing-library/jest-dom matchers and auto-cleans the
// rendered DOM after every test so component tests don't leak into each other.
import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

afterEach(() => {
  cleanup();
});
