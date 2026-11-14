// @vitest-environment jsdom
/**
 * platform-logos tests (task 2026-11-14) — the API Keys tab identifies each
 * credential row by its platform mark. resolvePlatformMark is the mapping
 * every provider row and key row goes through, so its contract is pinned
 * here: free-form provider names (case-insensitive, substring) resolve to
 * the right mark, unknown names fall back to the generic key, and the logo
 * tile renders an accessible, aria-hidden mark.
 */

import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import {
  PlatformLogo,
  resolvePlatformMark,
} from "./platform-logos";

describe("resolvePlatformMark", () => {
  it("maps the known AI provider families by name fragments", () => {
    expect(resolvePlatformMark("OpenAI")).toBe("openai");
    expect(resolvePlatformMark("openai-compatible gateway")).toBe("openai");
    expect(resolvePlatformMark("Anthropic Claude 4")).toBe("anthropic");
    expect(resolvePlatformMark("claude-3-7")).toBe("anthropic");
    expect(resolvePlatformMark("Google Gemini Flash")).toBe("gemini");
    expect(resolvePlatformMark("Groq Cloud")).toBe("groq");
    expect(resolvePlatformMark("Mistral Large")).toBe("mistral");
    expect(resolvePlatformMark("DeepSeek Reasoner")).toBe("deepseek");
    expect(resolvePlatformMark("xAI Grok")).toBe("xai");
    expect(resolvePlatformMark("OpenRouter (all models)")).toBe("openrouter");
  });

  it("maps the platform key surfaces", () => {
    expect(resolvePlatformMark("E2B Sandbox")).toBe("e2b");
    expect(resolvePlatformMark("Trigger.dev Cloud")).toBe("triggerdev");
    expect(resolvePlatformMark("Pollinations")).toBe("pollinations");
    expect(resolvePlatformMark("OnyxBase")).toBe("onyxbase");
    expect(resolvePlatformMark("Composio")).toBe("composio");
    expect(resolvePlatformMark("LangSearch")).toBe("langsearch");
    expect(resolvePlatformMark("SkillsMP")).toBe("skillsmp");
  });

  it("falls back to the generic key for unknown or empty names", () => {
    expect(resolvePlatformMark("Totally Unknown Vendor")).toBe("generic");
    expect(resolvePlatformMark("")).toBe("generic");
    expect(resolvePlatformMark(null)).toBe("generic");
    expect(resolvePlatformMark(undefined)).toBe("generic");
  });
});

describe("PlatformLogo", () => {
  it("renders a known platform as a decorative SVG tile (aria-hidden)", () => {
    const { container } = render(<PlatformLogo platform="e2b" />);
    const tile = container.firstElementChild as HTMLElement;
    expect(tile.getAttribute("aria-hidden")).toBe("true");
    expect(tile.querySelector("svg")).not.toBeNull();
  });

  it("renders the generic mark as the muted key tile", () => {
    const { container } = render(<PlatformLogo platform="generic" />);
    expect(container.firstElementChild?.getAttribute("aria-hidden")).toBe("true");
    // The generic mark carries the lucide KeyRound glyph (not a platform SVG).
    const svg = container.querySelector("svg");
    expect(svg?.getAttribute("class")).toContain("lucide-key-round");
  });
});
