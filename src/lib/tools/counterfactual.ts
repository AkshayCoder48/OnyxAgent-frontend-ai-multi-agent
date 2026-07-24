"use client";

import { registerTool } from "./registry";

/**
 * Counterfactual reasoning tool.
 * Lets the agent explore "what if X had been different?" scenarios.
 * Accepts a structured analysis and returns it as a card for the user.
 */

registerTool(
  "counterfactual",
  "Explore a counterfactual ('what if?') scenario. Use this when the user asks 'what if X had been different?' or wants to explore alternative outcomes. Produces a structured analysis with observed facts, hypothetical change, alternative branches, and a recommendation.",
  {
    type: "object",
    properties: {
      observed: { type: "string", description: "The actual scenario / observed facts" },
      hypothetical: { type: "string", description: "The counterfactual change being explored (e.g., 'What if we used PostgreSQL instead of SQLite?')" },
      branches: {
        type: "array",
        description: "Alternative outcome branches",
        items: {
          type: "object",
          properties: {
            outcome: { type: "string", description: "Description of this alternative outcome" },
            plausibility: { type: "string", enum: ["low", "medium", "high"], description: "How plausible this outcome is" },
            pros: { type: "array", items: { type: "string" }, description: "Advantages of this outcome" },
            cons: { type: "array", items: { type: "string" }, description: "Disadvantages of this outcome" },
          },
        },
      },
      recommendation: { type: "string", description: "Overall synthesis / recommendation based on the analysis" },
    },
    required: ["observed", "hypothetical"],
    additionalProperties: false,
  },
  async (args) => {
    const branches = (args.branches as Array<Record<string, unknown>>) || [];

    return {
      kind: "counterfactual",
      observed: args.observed,
      hypothetical: args.hypothetical,
      branches: branches.map((b, i) => ({
        ...b,
        index: i + 1,
      })),
      recommendation: args.recommendation || "",
      summary: `Explored ${branches.length} alternative outcome(s) for: ${args.hypothetical}`,
    };
  },
  false,
  "reasoning",
);
