import type {
  ModelPickerProvider,
  ThinkingEffort,
} from "@/components/ui/model-picker";
import type { ModelPreferenceId } from "./types";

/**
 * The Terra profiles expressed as ModelPicker providers — the same store
 * models, dressed with capability chips and thinking-effort tracks.
 */
export const TERRA_MODEL_PROVIDERS: readonly ModelPickerProvider[] = [
  {
    id: "terra",
    name: "Terra",
    models: [
      {
        id: "auto",
        name: "Auto Router",
        description: "Picks the best profile per message",
        capabilities: ["reasoning"],
        thinking: ["low", "medium", "high"],
        defaultThinking: "medium",
      },
      {
        id: "fast",
        name: "Terra Mini",
        description: "Short, quick answers — greetings and lookups",
      },
      {
        id: "balanced",
        name: "Terra 1.5",
        description: "The default editorial voice",
        thinking: ["low", "medium", "high"],
        defaultThinking: "medium",
      },
      {
        id: "deep",
        name: "Terra Deep",
        description: "Thinks step by step, shows its plan",
        capabilities: ["reasoning"],
        thinking: ["low", "medium", "high", "max"],
        defaultThinking: "high",
      },
    ],
  },
];

export function isModelPreferenceId(value: string): value is ModelPreferenceId {
  return value === "auto" || value === "fast" || value === "balanced" || value === "deep";
}

export type { ThinkingEffort };
