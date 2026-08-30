import "@testing-library/jest-dom/vitest";

/**
 * Vitest global setup.
 * - Loads the jest-dom matchers (toBeInTheDocument, etc.) for component tests.
 * - jsdom doesn't implement matchMedia, which theme-aware components rely on.
 */
if (typeof window !== "undefined" && !window.matchMedia) {
  window.matchMedia = (query: string): MediaQueryList =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }) as MediaQueryList;
}
