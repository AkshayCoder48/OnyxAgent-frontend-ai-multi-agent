// @vitest-environment jsdom
// SectionBrowserLicense (Task 53: "add input in main setting page") — the
// CloakBrowser license field for the ROUTE settings page. The critical
// contract is the WRITE PATH: settingsService.update({env_vars}) REPLACES
// the whole dict, so the save must load the existing vars first and write
// the merged dict back — a naive save would wipe every other env var.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import React from "react";

const getDecryptedEnvVars = vi.fn();
const settingsUpdate = vi.fn();

vi.mock("@/lib/services", () => ({
  settingsService: {
    getDecryptedEnvVars: (...a: unknown[]) => getDecryptedEnvVars(...a),
    update: (...a: unknown[]) => settingsUpdate(...a),
  },
}));

vi.mock("@/hooks", () => ({
  useAuth: () => ({ user: { id: "user-1" } }),
}));

import { SectionBrowserLicense } from "./section-browser-license";

describe("SectionBrowserLicense (route settings)", () => {
  beforeEach(() => {
    cleanup();
    getDecryptedEnvVars.mockReset();
    settingsUpdate.mockReset();
  });

  it("loads the existing key into the field on mount", async () => {
    getDecryptedEnvVars.mockResolvedValue({
      CLOAKBROWSER_LICENSE_KEY: "cb_secret123",
      OTHER_VAR: "keepme",
    });
    render(React.createElement(SectionBrowserLicense));
    const input = await screen.findByLabelText(/CloakBrowser license key/i);
    await waitFor(() => expect((input as HTMLInputElement).value).toBe("cb_secret123"));
  });

  it("saving MERGES the license into the existing env vars (never wipes them)", async () => {
    getDecryptedEnvVars.mockResolvedValue({
      OPENWEATHER_KEY: "weather",
      GITHUB_TOKEN: "gh",
    });
    settingsUpdate.mockResolvedValue(undefined);
    render(React.createElement(SectionBrowserLicense));
    const input = await screen.findByLabelText(/CloakBrowser license key/i);
    await waitFor(() => expect((input as HTMLInputElement).value).toBe(""));
    fireEvent.change(input, { target: { value: "cb_new_key" } });
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));
    await waitFor(() => expect(settingsUpdate).toHaveBeenCalledTimes(1));
    const [userId, patch] = settingsUpdate.mock.calls[0];
    expect(userId).toBe("user-1");
    // The merged dict: existing vars PRESERVED + the license entry added.
    expect(patch.env_vars).toEqual({
      OPENWEATHER_KEY: "weather",
      GITHUB_TOKEN: "gh",
      CLOAKBROWSER_LICENSE_KEY: "cb_new_key",
    });
  });

  it("clearing the field REMOVES only the license entry (other vars survive)", async () => {
    getDecryptedEnvVars.mockResolvedValue({
      CLOAKBROWSER_LICENSE_KEY: "cb_old",
      KEEP_ME: "yes",
    });
    settingsUpdate.mockResolvedValue(undefined);
    render(React.createElement(SectionBrowserLicense));
    const input = await screen.findByLabelText(/CloakBrowser license key/i);
    await waitFor(() => expect((input as HTMLInputElement).value).toBe("cb_old"));
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));
    await waitFor(() => expect(settingsUpdate).toHaveBeenCalledTimes(1));
    const [, patch] = settingsUpdate.mock.calls[0];
    expect(patch.env_vars).toEqual({ KEEP_ME: "yes" });
    expect(patch.env_vars.CLOAKBROWSER_LICENSE_KEY).toBeUndefined();
  });

  it("blocks saving before the current value has loaded (vault error ≠ remove key)", async () => {
    // The dangerous case: the mount-load never resolves (vault locked /
    // slow). A click during that window must NOT write — an ungated save
    // would read an empty dict, "clear" the license, and wipe every env
    // var with it. (handleSave re-reads the dict, but the gate is what
    // makes even that safe to reason about.)
    getDecryptedEnvVars.mockImplementation(
      () => new Promise<Record<string, string>>(() => {}),
    );
    render(React.createElement(SectionBrowserLicense));
    const input = await screen.findByLabelText(/CloakBrowser license key/i);
    fireEvent.change(input, { target: { value: "cb_x" } });
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));
    // Load never resolved → save must NOT have fired (would have sent an
    // empty dict and wiped every env var).
    expect(settingsUpdate).not.toHaveBeenCalled();
  });

  it("reveal toggle switches the input type (show/hide the secret)", async () => {
    getDecryptedEnvVars.mockResolvedValue({ CLOAKBROWSER_LICENSE_KEY: "cb_s" });
    render(React.createElement(SectionBrowserLicense));
    const input = await screen.findByLabelText(/CloakBrowser license key/i);
    expect(input).toHaveAttribute("type", "password");
    fireEvent.click(screen.getByRole("button", { name: /show license key/i }));
    expect(input).toHaveAttribute("type", "text");
  });
});
