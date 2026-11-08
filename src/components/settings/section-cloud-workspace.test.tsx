// @vitest-environment jsdom
/**
 * section-cloud-workspace tests (Task 21) — the simplified OnyxBase settings:
 * the custom base URL is a first-class field in the open (no MoreOptions
 * drawer), the effective endpoint is always visible, saving normalizes the
 * URL exactly like the app does at call time (resolveOnyxBaseUrl), and a
 * one-click reset returns to the default https://onyxbase-chi.vercel.app.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const update = vi.fn(async () => ({}));
const setOnyxBaseApiKey = vi.fn(async () => ({}));
const toastSuccess = vi.fn();
const toastError = vi.fn();

vi.mock("sonner", () => ({
  toast: {
    success: (...a: unknown[]) => toastSuccess(...a),
    error: (...a: unknown[]) => toastError(...a),
  },
}));

let storedBaseUrl: string | undefined;
let storedKeyPresent = false;

vi.mock("@/hooks/use-data", () => ({
  useSettings: () => ({
    settings: {
      onyxbase_api_key_present: storedKeyPresent,
      onyxbase_base_url: storedBaseUrl,
      onyxbase_workspace_id: "workspace_default",
    },
    loading: false,
    update,
    setOnyxBaseApiKey,
  }),
}));

vi.mock("@/hooks", () => ({
  useAuth: () => ({ user: { id: "u1" } }),
}));

vi.mock("@/lib/services", () => ({
  settingsService: {
    getDecryptedOnyxBaseApiKey: async () => "kv_live_test_key_123456",
    get: async () => null,
  },
}));

import { SectionCloudWorkspace } from "./section-cloud-workspace";
import { ONYXBASE_DEFAULT_BASE_URL } from "@/lib/onyxbase/kv-client";

describe("SectionCloudWorkspace — base URL, simple and in the open", () => {
  beforeEach(() => {
    storedBaseUrl = undefined;
    storedKeyPresent = false;
    update.mockClear();
    setOnyxBaseApiKey.mockClear();
    toastSuccess.mockClear();
    toastError.mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("the Base URL field renders WITHOUT opening any MoreOptions drawer", () => {
    render(<SectionCloudWorkspace />);
    // The field is directly in the document — no disclosure to expand.
    expect(screen.getByLabelText("Base URL")).toBeInTheDocument();
    expect(screen.getByText(/Effective endpoint:/)).toBeInTheDocument();
  });

  it("default state: shows the default endpoint, no reset button, Default badge", () => {
    render(<SectionCloudWorkspace />);
    expect(screen.getByText(/Effective endpoint: .*\(default\)/)).toBeInTheDocument();
    // No "Use default" affordance while already on the default.
    expect(screen.queryByRole("button", { name: /Use default/i })).not.toBeInTheDocument();
  });

  it("custom state: Custom badge, effective endpoint reflects it, reset offered", () => {
    storedBaseUrl = "https://my-onyx.example.com";
    render(<SectionCloudWorkspace />);
    expect(screen.getByText("https://my-onyx.example.com")).toBeInTheDocument();
    expect(screen.getByText(/Effective endpoint: .*\(custom\)/)).toBeInTheDocument();
    expect(screen.getByText("Custom")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Use default/i })).toBeInTheDocument();
  });

  it("saving normalizes exactly like the app does at call time", async () => {
    render(<SectionCloudWorkspace />);
    const input = screen.getByLabelText("Base URL");
    await userEvent.clear(input);
    await userEvent.type(input, "my-onyx.example.com/");
    await userEvent.click(screen.getByRole("button", { name: /^Save$/i }));
    await waitFor(() => expect(update).toHaveBeenCalled());
    expect(update).toHaveBeenCalledWith({ onyxbase_base_url: "https://my-onyx.example.com" });
  });

  it("an invalid URL is refused with an honest error and no update", async () => {
    render(<SectionCloudWorkspace />);
    const input = screen.getByLabelText("Base URL");
    await userEvent.clear(input);
    await userEvent.type(input, "not a url");
    await userEvent.click(screen.getByRole("button", { name: /^Save$/i }));
    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(update).not.toHaveBeenCalled();
  });

  it("saving the default value resets the stored override to undefined", async () => {
    storedBaseUrl = "https://my-onyx.example.com";
    render(<SectionCloudWorkspace />);
    const input = screen.getByLabelText("Base URL");
    await userEvent.clear(input);
    await userEvent.type(input, ONYXBASE_DEFAULT_BASE_URL);
    await userEvent.click(screen.getByRole("button", { name: /^Save$/i }));
    await waitFor(() => expect(update).toHaveBeenCalled());
    expect(update).toHaveBeenCalledWith({ onyxbase_base_url: undefined });
  });

  it("Use default resets to chi in one click", async () => {
    storedBaseUrl = "https://my-onyx.example.com";
    render(<SectionCloudWorkspace />);
    await userEvent.click(screen.getByRole("button", { name: /Use default/i }));
    await waitFor(() => expect(update).toHaveBeenCalled());
    expect(update).toHaveBeenCalledWith({ onyxbase_base_url: undefined });
  });

  it("Test Connection verifies against the effective endpoint and names it", async () => {
    // jsdom predates AbortSignal.timeout on some versions — the client only
    // uses it as the fetch signal, so a no-op stub is enough here.
    if (typeof (AbortSignal as unknown as { timeout?: unknown }).timeout !== "function") {
      vi.stubGlobal("AbortSignal", { ...AbortSignal, timeout: () => undefined });
    }
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: async () =>
          JSON.stringify({ ok: true, user: "usr_x", apiKey: { name: "Zai Test" } }),
      })),
    );
    render(<SectionCloudWorkspace />);
    await userEvent.click(screen.getByRole("button", { name: /Test Connection/i }));
    await waitFor(() => expect(toastSuccess).toHaveBeenCalled());
    expect(toastSuccess).toHaveBeenCalledWith(
      "Connected to OnyxBase",
      expect.objectContaining({ description: expect.stringContaining("onyxbase-chi.vercel.app") }),
    );
  });
});
