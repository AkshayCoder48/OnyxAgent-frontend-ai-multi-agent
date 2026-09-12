"use client";

import { useTranslations } from "next-intl";
import { Send } from "lucide-react";

import { SectionCard } from "@/components/settings/settings-section";
import { SectionIntegrationsTelegram } from "@/components/settings/section-integrations-telegram";

/**
 * Settings → Integrations route — external services the agent can talk to.
 *
 * Telegram: a real Bot API connection (validated via getMe, chat discovered
 * via getUpdates). The bot token is stored encrypted in the user's own
 * storage — server-side KV for unattended scheduled runs + the local vault
 * for in-browser agent tools — and is NEVER rendered or model-visible.
 */
export default function IntegrationsSettingsPage() {
  const t = useTranslations("telegram");
  return (
    <div className="space-y-6">
      <SectionCard
        title={t("title")}
        description={t("sectionDescription")}
        action={
          <span className="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground">
            <Send className="size-3.5" />
            Bot API
          </span>
        }
      >
        <SectionIntegrationsTelegram />
      </SectionCard>
    </div>
  );
}
