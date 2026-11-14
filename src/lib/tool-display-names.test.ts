/**
 * tool-display-names tests — the UI-only plain-label contract.
 *
 * USER DIRECTIVE (2026-11-01): "replace code-ish name like manage_custom_tool,
 * edit_tool … to plain, UI only not in background where it execs, and using
 * custom tools are saying custom_tools at name looking too ugly".
 *
 * What's pinned here:
 *   - the called-out family (`custom_tools` / `manage_custom_tool` /
 *     `edit_tool` …) renders as the plain noun "Custom Tools";
 *   - the other manage_* umbrellas render as plain nouns;
 *   - UNKNOWN names (user-created custom tools with snake_case names)
 *     humanize — never a raw code identifier;
 *   - empty/garbage inputs pass through safely.
 */
import { describe, expect, it } from "vitest";
import { toolDisplayName } from "./tool-display-names";

describe("toolDisplayName — the called-out custom-tools family", () => {
  it("renders the umbrella and every granular as the plain noun", () => {
    expect(toolDisplayName("custom_tools")).toBe("Custom Tools");
    expect(toolDisplayName("manage_custom_tool")).toBe("Custom Tools");
    expect(toolDisplayName("create_custom_tool")).toBe("Custom Tools");
    expect(toolDisplayName("edit_tool")).toBe("Custom Tools");
    expect(toolDisplayName("create_tool")).toBe("Custom Tools");
    expect(toolDisplayName("delete_tool")).toBe("Custom Tools");
  });
});

describe("toolDisplayName — merged manage_* families get plain nouns", () => {
  it("maps the multi-function families", () => {
    expect(toolDisplayName("manage_skill")).toBe("Skills");
    expect(toolDisplayName("manage_mcp")).toBe("MCP Servers");
    expect(toolDisplayName("manage_memory")).toBe("Memory");
    expect(toolDisplayName("manage_env_var")).toBe("Environment Variables");
    expect(toolDisplayName("manage_chats")).toBe("Past Chats");
    expect(toolDisplayName("manage_subagent_chat")).toBe("Subagent Chats");
    expect(toolDisplayName("show_todo")).toBe("Todos");
    expect(toolDisplayName("manage_todo")).toBe("Todos");
  });
});

describe("toolDisplayName — unknown names humanize, never raw identifiers", () => {
  it("snake_case user-created custom tools become Title Case words", () => {
    expect(toolDisplayName("my_weather_widget")).toBe("My Weather Widget");
    expect(toolDisplayName("stock_price_lookup")).toBe("Stock Price Lookup");
  });

  it("strips the _tool/_tools suffix and title-cases what's left", () => {
    expect(toolDisplayName("deploy_tool")).toBe("Deploy");
    expect(toolDisplayName("audit_tools")).toBe("Audit");
  });

  it("single words just get a capital", () => {
    expect(toolDisplayName("counterfactual")).toBe("Counterfactual");
  });

  it("passes empty and weird inputs through safely", () => {
    expect(toolDisplayName("")).toBe("");
    expect(toolDisplayName("___")).toBe("___");
  });
});
