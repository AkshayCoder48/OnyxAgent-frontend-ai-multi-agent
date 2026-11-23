import "@testing-library/jest-dom/vitest";

/**
 * Vitest global setup.
 * - Loads the jest-dom matchers (toBeInTheDocument, etc.) for component tests.
 * - jsdom doesn't implement matchMedia, which theme-aware components rely on.
 * - jsdom doesn't implement IntersectionObserver either, which framer-motion's
 *   inView relies on (BorderBeam's off-screen unmount — the composer dock and
 *   todo plan beams). The stub never fires its callback, so inView stays
 *   false and the beam simply renders nothing in tests (its documented
 *   off-screen behavior) instead of crashing the component tree.
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

if (
  typeof window !== "undefined" &&
  typeof window.IntersectionObserver === "undefined"
) {
  class IntersectionObserverStub {
    readonly root: Element | null = null;
    readonly rootMargin: string = "";
    readonly thresholds: ReadonlyArray<number> = [];
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
    takeRecords(): IntersectionObserverEntry[] {
      return [];
    }
  }
  const stub = IntersectionObserverStub as unknown as typeof IntersectionObserver;
  window.IntersectionObserver = stub;
  // The bare `new IntersectionObserver(...)` reference framer-motion makes
  // resolves through the global scope, not `window.` — define it there too.
  (globalThis as { IntersectionObserver?: typeof IntersectionObserver }).IntersectionObserver = stub;
}
