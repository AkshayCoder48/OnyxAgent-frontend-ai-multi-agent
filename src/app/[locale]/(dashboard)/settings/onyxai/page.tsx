"use client";

import { Cpu } from "lucide-react";

import { SectionCard } from "@/components/settings/settings-section";
import { SectionOnyxAI } from "@/components/settings/section-onyxai";

/**
 * Settings → OnyxAI — the app's optional default local-inference provider,
 * powered by QVAC (Tether's local-first AI runtime).
 *
 * The user runs `qvac serve --openai` on their own device (phone → server);
 * OnyxAgent talks to it directly from the browser at localhost:11434/v1.
 * The model catalog shows the latest tool-calling models per device tier and
 * any Hugging Face model can be loaded via an explicit serve.models src —
 * with a clear warning that NON-TOOL-CALLING MODELS WON'T WORK WELL as the
 * agent brain (OnyxAgent is agent-first).
 */
export default function OnyxAiSettingsPage() {
  return (
    <div className="space-y-6">
      <SectionCard
        title="OnyxAI — local inference"
        description="QVAC-powered models running on your own device — private, offline-capable, free."
        action={
          <span className="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground">
            <Cpu className="size-3.5" />
            QVAC · localhost:11434
          </span>
        }
      >
        <SectionOnyxAI />
      </SectionCard>
    </div>
  );
}
