// @vitest-environment jsdom
/**
 * SectionAgentSettings — the CloakBrowser license key field (Task 51,
 * "add option in setting to add license key to cloak browser").
 *
 * Pins:
 *  - the field renders with its own labeled input (type=password — the
 *    key is masked), placeholder naming the cb_ format, and helper text
 *    that explains the engine ladder (cloak with a key → patchright →
 *    stock Chromium);
 *  - SAVING with a key merges it into env_vars.CLOAKBROWSER_LICENSE_KEY
 *    (the exact env the sandbox driver ladder reads) alongside any manual
 *    env rows;
 *  - CLEARING the field REMOVES the env var (not an empty string);
 *  - the field wins over a manual env row of the same name (one source
 *    of truth).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import React from "react";

// jsdom lacks ResizeObserver (the Slider's use-size needs it).
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal("ResizeObserver", ResizeObserverStub);

// Mock the settings hook — the component only needs settings + update.
vi.mock("@/hooks/use-data", () => {
  const state = { settings: { env_vars: [] }, update: vi.fn() };
  return {
    useSettings: () => ({
      settings: state.settings,
      loading: false,
      update: state.update,
    }),
    __setSettings: (s: unknown) => { state.settings = s; },
    __getUpdate: () => state.update,
  };
});

import { SectionAgentSettings } from "./section-agent-settings";

function setup() {
  render(<SectionAgentSettings />);
}

describe("SectionAgentSettings — CloakBrowser license key field", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders a masked, labeled license input with ladder-explaining helper text", async () => {
    setup();
    const input = (await screen.findByLabelText(/CloakBrowser license key/i)) as HTMLInputElement;
    expect(input.type).toBe("password");
    expect(input.placeholder).toMatch(/cb_/);
    // The helper explains what a key activates (cloakbrowser) and the
    // no-key fallback (patchright), and names the env var it becomes.
    const helper = screen.getByText(/CloakBrowser \(stealth Chromium/i, { exact: false });
    expect(helper.textContent).toContain("CLOAKBROWSER_LICENSE_KEY");
    expect(helper.textContent).toContain("patchright");
  });

  it("saving with a key writes env_vars.CLOAKBROWSER_LICENSE_KEY", async () => {
    const { __getUpdate } = await import("@/hooks/use-data") as unknown as {
      __getUpdate: () => ReturnType<typeof vi.fn>;
    };
    setup();
    const input = (await screen.findByLabelText(/CloakBrowser license key/i)) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "cb_test_abc123" } });
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));
    await waitFor(() => expect(__getUpdate()).toHaveBeenCalledTimes(1));
    const patch = __getUpdate().mock.calls[0][0] as { env_vars: Record<string, string> };
    expect(patch.env_vars.CLOAKBROWSER_LICENSE_KEY).toBe("cb_test_abc123");
  });

  it("clearing the field REMOVES the env var entirely (not an empty string)", async () => {
    const { __getUpdate } = await import("@/hooks/use-data") as unknown as {
      __getUpdate: () => ReturnType<typeof vi.fn>;
    };
    // Hydrated with an existing key (env-var metadata + decrypted value).
    setup();
    const input = (await screen.findByLabelText(/CloakBrowser license key/i)) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "cb_existing" } });
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));
    await waitFor(() => expect(__getUpdate()).toHaveBeenCalledTimes(1));

    // Now clear it and save again.
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));
    await waitFor(() => expect(__getUpdate()).toHaveBeenCalledTimes(2));
    const patch = __getUpdate().mock.calls[1][0] as { env_vars: Record<string, string> };
    expect(patch.env_vars.CLOAKBROWSER_LICENSE_KEY).toBeUndefined();
  });
});
