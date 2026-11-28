// @vitest-environment jsdom
// SectionApiKeys — the CloakBrowser license row (Task 55: "in setting api
// key field add cloak input"). The critical contract is the same as the
// route Browser card's: settingsService.update({env_vars}) REPLACES the
// whole dict, so the save must load the existing vars first and write the
// merged dict back — a naive save would wipe every other env var. The row
// also reads the SAME CLOAKBROWSER_LICENSE_KEY entry the other two
// surfaces use, so all three stay in sync through one vault value.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import React from "react";

const getDecryptedEnvVars = vi.fn();
const settingsUpdate = vi.fn();
const setSandboxKey = vi.fn();
const setOnyxBaseApiKey = vi.fn();
const setComposioApiKey = vi.fn();

vi.mock("@/lib/services", () => ({
  settingsService: {
    getDecryptedEnvVars: (...a: unknown[]) => getDecryptedEnvVars(...a),
    update: (...a: unknown[]) => settingsUpdate(...a),
    getDecryptedSandboxKey: vi.fn().mockResolvedValue(null),
    getDecryptedOnyxBaseApiKey: vi.fn().mockResolvedValue(null),
    setLangSearchKey: vi.fn(),
    setSkillsMPApiKey: vi.fn(),
  },
}));

vi.mock("@/hooks", () => ({
  useAuth: () => ({ user: { id: "user-1" } }),
}));

vi.mock("@/hooks/use-data", () => ({
  useSettings: () => ({
    settings: {
      sandbox_api_key_present: true,
      onyxbase_api_key_present: false,
      composio_api_key_present: false,
    },
    loading: false,
    setSandboxKey,
    setOnyxBaseApiKey,
    setComposioApiKey,
    update: vi.fn(),
  }),
  useProviders: () => ({ providers: [], update: vi.fn(), test: vi.fn() }),
}));

vi.mock("@/lib/pollinations/store", () => ({
  usePollinationsStore: () => ({
    connectionStatus: "off",
    connectionMeta: null,
    disconnect: vi.fn(),
    connect: vi.fn(),
  }),
}));

// The OnyxBase KV import only happens on Test — stub it so the module
// graph never pulls the real client.
vi.mock("@/lib/onyxbase/kv-client", () => ({
  OnyxBaseKV: class {},
  resolveOnyxBaseUrl: () => "https://example.invalid",
}));

import { SectionApiKeys } from "./section-api-keys";

function setup() {
  return render(React.createElement(SectionApiKeys));
}

describe("SectionApiKeys — CloakBrowser license row (Task 55)", () => {
  beforeEach(() => {
    cleanup();
    getDecryptedEnvVars.mockReset();
    settingsUpdate.mockReset();
  });

  it("renders the row with its own input, next to the other platform keys", async () => {
    getDecryptedEnvVars.mockResolvedValue({});
    setup();
    const input = await screen.findByLabelText(/CloakBrowser/i, { selector: "input" });
    expect(input.type).toBe("password");
    // The badge explains the ladder (license → patchright → chromium).
    expect(screen.getByText(/stealth engine/i)).toBeTruthy();
    expect(screen.getByText(/patchright/i)).toBeTruthy();
    // The row sits in the platform-keys card with its own get-a-key link
    // (every row has one — scope to the CloakBrowser row).
    const row = input.closest("li")!;
    const link = [...row.querySelectorAll("a")].find((a) => /get a key/i.test(a.textContent ?? ""))!;
    expect(link.getAttribute("href")).toContain("cloakbrowser.dev");
  });

  it("prefills the SAVED key from env_vars.CLOAKBROWSER_LICENSE_KEY and badges licensed", async () => {
    getDecryptedEnvVars.mockResolvedValue({
      CLOAKBROWSER_LICENSE_KEY: "cb_saved_key",
      OTHER_VAR: "keepme",
    });
    setup();
    const input = (await screen.findByLabelText(/CloakBrowser/i, {
      selector: "input",
    })) as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe("cb_saved_key"));
    expect(await screen.findByText("licensed")).toBeTruthy();
    // A saved key shows the Clear affordance.
    expect(screen.getByRole("button", { name: /^clear$/i })).toBeTruthy();
  });

  it("saving MERGES the license into the existing env vars (never wipes them)", async () => {
    getDecryptedEnvVars.mockResolvedValue({
      OPENWEATHER_KEY: "weather",
      GITHUB_TOKEN: "gh",
    });
    settingsUpdate.mockResolvedValue(undefined);
    setup();
    const input = (await screen.findByLabelText(/CloakBrowser/i, {
      selector: "input",
    })) as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe(""));
    fireEvent.change(input, { target: { value: "cb_new_key" } });
    // The Cloak row's Save (the input's row — the only enabled one next to it).
    const row = input.closest("li")!;
    const save = [...row.querySelectorAll("button")].find((b) => /save/i.test(b.textContent ?? ""))!;
    fireEvent.click(save);
    await waitFor(() => expect(settingsUpdate).toHaveBeenCalledTimes(1));
    const [userId, patch] = settingsUpdate.mock.calls[0];
    expect(userId).toBe("user-1");
    expect(patch.env_vars).toEqual({
      OPENWEATHER_KEY: "weather",
      GITHUB_TOKEN: "gh",
      CLOAKBROWSER_LICENSE_KEY: "cb_new_key",
    });
    // (The success toast needs a mounted <Toaster> to assert on; the
    // update() call above IS the contract.)
  });

  it("Clear REMOVES only the license entry (other env vars preserved)", async () => {
    // Load read, then the save-time merge read — both see the same dict.
    getDecryptedEnvVars.mockResolvedValue({
      CLOAKBROWSER_LICENSE_KEY: "cb_old",
      KEEP_ME: "yes",
    });
    settingsUpdate.mockResolvedValue(undefined);
    setup();
    const input = (await screen.findByLabelText(/CloakBrowser/i, {
      selector: "input",
    })) as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe("cb_old"));
    fireEvent.click(screen.getByRole("button", { name: /^clear$/i }));
    await waitFor(() => expect(settingsUpdate).toHaveBeenCalledTimes(1));
    const [, patch] = settingsUpdate.mock.calls[0];
    expect(patch.env_vars).toEqual({ KEEP_ME: "yes" });
    expect(patch.env_vars.CLOAKBROWSER_LICENSE_KEY).toBeUndefined();
  });

  it("a vault read error leaves save gated (never saves a blank as removal)", async () => {
    getDecryptedEnvVars.mockRejectedValue(new Error("vault locked"));
    setup();
    const input = (await screen.findByLabelText(/CloakBrowser/i, {
      selector: "input",
    })) as HTMLInputElement;
    await waitFor(() => expect(input.disabled).toBe(false));
    fireEvent.change(input, { target: { value: "cb_x" } });
    const row = input.closest("li")!;
    const save = [...row.querySelectorAll("button")].find((b) => /save/i.test(b.textContent ?? ""))!;
    fireEvent.click(save);
    // The gate blocks the save: update never fires (the gate toast needs a
    // mounted <Toaster>; the not-called assertion is the contract).
    await new Promise((r) => setTimeout(r, 50));
    expect(settingsUpdate).not.toHaveBeenCalled();
  });
});
