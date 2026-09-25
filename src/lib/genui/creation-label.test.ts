import { describe, expect, it } from "vitest";
import { deriveCreationPhrase } from "./creation-label";
import type { GenUINode, GenUISpec } from "./types";

function spec(...nodes: Partial<GenUINode>[]): GenUISpec {
  return {
    nodes: nodes.map((n, i) => ({
      id: `n${i}`,
      type: "card",
      ...n,
    })) as GenUINode[],
  };
}

describe("deriveCreationPhrase (PRD §21)", () => {
  it("falls back to 'this UI' for empty/undefined specs", () => {
    expect(deriveCreationPhrase(undefined)).toBe("this UI");
    expect(deriveCreationPhrase(null)).toBe("this UI");
    expect(deriveCreationPhrase({ nodes: [] })).toBe("this UI");
  });

  it("maps node types to friendly phrases", () => {
    expect(deriveCreationPhrase(spec({ type: "card_grid" }))).toBe("a card grid");
    expect(deriveCreationPhrase(spec({ type: "timeline" }))).toBe("a flow chart");
    expect(deriveCreationPhrase(spec({ type: "stats_row" }))).toBe("a stats dashboard");
    expect(deriveCreationPhrase(spec({ type: "comparison_table" }))).toBe("a comparison table");
    expect(deriveCreationPhrase(spec({ type: "weather_card" }))).toBe("a weather card");
    expect(deriveCreationPhrase(spec({ type: "custom_html" }))).toBe("an interactive app");
    expect(deriveCreationPhrase(spec({ type: "code_block" }))).toBe("a code block");
  });

  it("prefers an explicit AI-provided label", () => {
    expect(
      deriveCreationPhrase(spec({ type: "custom_html", props: { label: "a fun flow chart" } })),
    ).toBe("a fun flow chart");
    expect(
      deriveCreationPhrase(spec({ type: "card", props: { title: "Weather Dashboard" } })),
    ).toBe("Weather Dashboard");
  });

  it("prepends an article to bare lowercase labels", () => {
    expect(deriveCreationPhrase(spec({ type: "custom_html", props: { label: "minigame" } }))).toBe(
      "a minigame",
    );
    expect(deriveCreationPhrase(spec({ type: "image_grid", props: { title: "image gallery" } }))).toBe(
      "an image gallery",
    );
  });

  it("never renders parentheses (user rule: 'Creating a minigame…' not 'Creating (a minigame)…')", () => {
    expect(deriveCreationPhrase(spec({ type: "card", props: { label: "(a minigame)" } }))).toBe(
      "a minigame",
    );
    expect(deriveCreationPhrase(spec({ type: "card", props: { title: "Snake (canvas game)" } }))).not.toContain(
      "(",
    );
  });

  it("detects game-like custom blocks → 'a minigame'", () => {
    expect(
      deriveCreationPhrase(
        spec({ type: "custom_html", props: { html: "<canvas id=game></canvas><script>let score=0</script>" } }),
      ),
    ).toBe("a minigame");
    expect(deriveCreationPhrase(spec({ type: "custom_card", props: { body: "player vs player arcade" } }))).toBe(
      "a minigame",
    );
  });

  it("descends into containers for a more specific phrase", () => {
    const columns: Partial<GenUINode> = {
      type: "columns",
      children: [{ id: "c0", type: "weather_card", props: { title: "" } }],
    };
    expect(deriveCreationPhrase(spec(columns))).toBe("a weather card");
  });

  it("reads the first card of a card_grid cards prop", () => {
    expect(
      deriveCreationPhrase(
        spec({ type: "card_grid", props: { cards: [{ title: "Q3 Revenue" }] } }),
      ),
    ).toBe("Q3 Revenue");
  });

  it("caps long labels without mid-word cuts and ignores junk labels", () => {
    const long = deriveCreationPhrase(
      spec({ type: "card", props: { title: "A".repeat(80) } }),
    );
    expect(long.length).toBeLessThanOrEqual(48);
    expect(deriveCreationPhrase(spec({ type: "card", props: { title: "   " } }))).toBe("a card");
    expect(deriveCreationPhrase(spec({ type: "card", props: { title: 42 } }))).toBe("a card");
  });

  it("respects a kind prop over the node type", () => {
    expect(deriveCreationPhrase(spec({ type: "custom_card", props: { kind: "timeline" } }))).toBe(
      "a flow chart",
    );
  });

  it("unknown types fall back to 'this UI'", () => {
    expect(deriveCreationPhrase(spec({ type: "holo_deck" }))).toBe("this UI");
  });
});
