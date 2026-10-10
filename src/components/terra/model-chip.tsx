"use client";

import { Brain, Check, ChevronDown, Feather, Route, Zap } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { MODELS } from "./seed";
import { useTerra } from "./store";
import type { ModelOption } from "./types";

const PROFILE_ICONS: Record<ModelOption["id"], typeof Route> = {
  auto: Route,
  fast: Zap,
  balanced: Feather,
  deep: Brain,
};

export function ModelChip() {
  const modelId = useTerra((s) => s.modelId);
  const setModel = useTerra((s) => s.setModel);
  const active = MODELS.find((m) => m.id === modelId) ?? MODELS[0];
  const ActiveIcon = PROFILE_ICONS[active.id] ?? Route;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="flex min-h-9 items-center gap-2 rounded-full border border-hairline px-3 py-1.5 transition-colors hover:border-terra-soft-border hover:bg-terra-soft"
          aria-label={`Model: ${active.label}. Change model.`}
        >
          <ActiveIcon className="h-3.5 w-3.5 shrink-0 text-terra" aria-hidden />
          <span className="whitespace-nowrap text-[13px] text-ink-soft">{active.label}</span>
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-ink-muted" aria-hidden />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72">
        <DropdownMenuLabel className="text-[11px] font-medium uppercase tracking-[0.08em] text-ink-muted">
          Model router
        </DropdownMenuLabel>
        {MODELS.map((model) => {
          const selected = model.id === active.id;
          const Icon = PROFILE_ICONS[model.id] ?? Route;
          return (
            <DropdownMenuItem
              key={model.id}
              onSelect={() => setModel(model.id)}
              className="gap-3 py-2.5"
              aria-checked={selected}
            >
              <span
                className={cn(
                  "flex h-6 w-6 shrink-0 items-center justify-center rounded-md border",
                  selected
                    ? "border-terra-soft-border bg-terra-soft text-terra"
                    : "border-hairline bg-background text-ink-muted",
                )}
                aria-hidden
              >
                <Icon className="h-3.5 w-3.5" />
              </span>
              <span className="flex min-w-0 flex-col">
                <span className={cn("text-sm", selected ? "font-medium text-ink" : "text-ink")}>
                  {model.label}
                </span>
                <span className="text-[11px] leading-snug text-ink-muted">{model.description}</span>
              </span>
              {selected && <Check className="ml-auto h-4 w-4 shrink-0 text-terra" aria-hidden />}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
