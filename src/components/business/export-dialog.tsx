"use client";

/**
 * Business Mode — ExportDialog (Task 4-c).
 *
 * Scope-filtered export of real business data (plan / agents / tasks /
 * drafts / activity) as JSON or an assembled Markdown document. Everything
 * is read from Dexie via the business services and downloaded as a Blob —
 * no server round-trip, sensitive data stays on the device.
 */

import { useState } from "react";
import { useParams } from "next/navigation";
import { toast } from "sonner";
import { Download } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Separator } from "@/components/ui/separator";
import { Spinner } from "@/components/ui/spinner";

import {
  businessAgentService,
  businessDraftService,
  businessEventService,
  businessService,
  businessTaskService,
} from "@/lib/business/data";
import { bt } from "@/lib/business/ui-text";
import type { BusinessEventRow } from "@/lib/business/types";
import { useBusinessStore } from "@/stores/business-store";

type ExportFormat = "md" | "json";
type ExportScope = "plan" | "agents" | "tasks" | "drafts" | "activity";

const SCOPES: { key: ExportScope; labelKey: string }[] = [
  { key: "plan", labelKey: "export.scope.plan" },
  { key: "agents", labelKey: "export.scope.agents" },
  { key: "tasks", labelKey: "export.scope.tasks" },
  { key: "drafts", labelKey: "export.scope.drafts" },
  { key: "activity", labelKey: "export.scope.activity" },
];

/** Local labels for exported event types (mirrors activity-view). */
const EVENT_LABELS: Record<string, string> = {
  "business.created": "Business created",
  "business.updated": "Business updated",
  "agent.created": "Agent created",
  "agent.updated": "Agent updated",
  "agent.status_changed": "Agent status changed",
  "agent.deleted": "Agent deleted",
  "task.created": "Task created",
  "task.started": "Task started",
  "task.progress": "Task progress",
  "task.blocked": "Task blocked",
  "task.awaiting_approval": "Task awaiting approval",
  "task.completed": "Task completed",
  "task.failed": "Task failed",
  "task.cancelled": "Task cancelled",
  "task.retried": "Task retried",
  "agent.message": "Agent message",
  "draft.created": "Draft created",
  "draft.updated": "Draft updated",
  "approval.requested": "Approval requested",
  "approval.completed": "Approval completed",
  "decision.completed": "Decision recorded",
  "browser.activity": "Web research",
  "chat.message": "Chat message",
  "turn.started": "Turn started",
  "turn.completed": "Turn completed",
  "turn.cancelled": "Turn cancelled",
  "memory.updated": "Memory updated",
  notification: "Notification",
};

function payloadDetail(payload: Record<string, unknown>): string {
  for (const key of ["title", "name", "query", "error", "status", "decision", "label", "kind"]) {
    const v = payload?.[key];
    if (typeof v === "string" && v) return v;
  }
  return "";
}

function eventLine(e: BusinessEventRow): string {
  const label = EVENT_LABELS[e.event_type] ?? e.event_type;
  const detail = payloadDetail(e.payload);
  const time = new Date(e.created_at).toISOString();
  return `- \`${time}\` **${label}**${detail ? ` — ${detail}` : ""}`;
}

export function ExportDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const params = useParams<{ businessId?: string }>();
  const activeBusinessId = useBusinessStore((s) => s.activeBusinessId);
  const businessId = params?.businessId ?? activeBusinessId ?? "";

  const [format, setFormat] = useState<ExportFormat>("md");
  const [scope, setScope] = useState<Record<ExportScope, boolean>>({
    plan: true,
    agents: true,
    tasks: true,
    drafts: true,
    activity: true,
  });
  const [exporting, setExporting] = useState(false);

  async function handleDownload() {
    if (!businessId || exporting) return;
    setExporting(true);
    try {
      const business = await businessService.get(businessId);
      if (!business) throw new Error(bt("export.subtitle"));

      const [agents, tasks, drafts, events] = await Promise.all([
        scope.agents ? businessAgentService.list(businessId) : Promise.resolve([]),
        scope.tasks ? businessTaskService.list(businessId) : Promise.resolve([]),
        scope.drafts ? businessDraftService.list(businessId) : Promise.resolve([]),
        scope.activity ? businessEventService.list(businessId, 500) : Promise.resolve([]),
      ]);

      const ext = format === "json" ? "json" : "md";
      let content: string;

      if (format === "json") {
        const payload: Record<string, unknown> = {
          business: {
            id: business.id,
            name: business.name,
            description: business.description,
            status: business.status,
            ...(scope.plan
              ? {
                  business_profile: business.business_profile,
                  goals: business.goals,
                  configuration: business.configuration,
                }
              : {}),
          },
        };
        if (scope.agents) payload.agents = agents;
        if (scope.tasks) payload.tasks = tasks;
        if (scope.drafts) payload.drafts = drafts;
        if (scope.activity) payload.activity = events;
        content = JSON.stringify(payload, null, 2);
      } else {
        const parts: string[] = [`# ${business.name}`, ""];
        if (business.description) parts.push(`_${business.description}_`, "");
        if (scope.plan) {
          parts.push(`## ${bt("export.scope.plan")}`, "");
          parts.push(business.business_profile || business.description || "—", "");
          if (business.goals.length > 0) {
            parts.push(
              ...business.goals.map((g) => `- **${g.title}**${g.description ? ` — ${g.description}` : ""} (${g.status})`),
              "",
            );
          }
        }
        if (scope.agents) {
          parts.push(`## ${bt("export.scope.agents")}`, "");
          parts.push("| Name | Role | Status | Model |", "| --- | --- | --- | --- |");
          for (const a of agents) {
            parts.push(
              `| ${a.name} | ${a.role} | ${a.status} | ${a.model_id || a.provider_id || bt("swarm.inheritModel")} |`,
            );
          }
          parts.push("");
        }
        if (scope.tasks) {
          parts.push(`## ${bt("export.scope.tasks")}`, "");
          parts.push("| Title | Status | Priority | Created |", "| --- | --- | --- | --- |");
          for (const t of tasks) {
            parts.push(
              `| ${t.title} | ${t.status} | ${t.priority} | ${t.created_at} |`,
            );
          }
          parts.push("");
        }
        if (scope.drafts) {
          parts.push(`## ${bt("export.scope.drafts")}`, "");
          for (const d of drafts) {
            parts.push(
              `### ${d.title} — ${bt("drafts.version", { version: d.version })} (${bt(`draftStatus.${d.status}`)})`,
              "",
              d.content,
              "",
            );
          }
        }
        if (scope.activity) {
          parts.push(`## ${bt("export.scope.activity")}`, "");
          for (const e of events) parts.push(eventLine(e));
          parts.push("");
        }
        content = parts.join("\n");
      }

      const blob = new Blob([content], {
        type: format === "json" ? "application/json" : "text/markdown" ,
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `onyx-business-${businessId}.${ext}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast.success(bt("export.exported"));
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setExporting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{bt("export.title")}</DialogTitle>
          <DialogDescription>{bt("export.subtitle")}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label>{bt("export.format")}</Label>
            <RadioGroup
              value={format}
              onValueChange={(v) => setFormat(v as ExportFormat)}
              className="flex gap-4"
            >
              <label className="flex min-h-11 flex-1 cursor-pointer items-center gap-2 rounded-lg border px-3">
                <RadioGroupItem value="md" id="export-format-md" />
                <span className="text-sm">{bt("export.format.md")}</span>
              </label>
              <label className="flex min-h-11 flex-1 cursor-pointer items-center gap-2 rounded-lg border px-3">
                <RadioGroupItem value="json" id="export-format-json" />
                <span className="text-sm">{bt("export.format.json")}</span>
              </label>
            </RadioGroup>
          </div>

          <Separator />

          <div className="flex flex-col gap-2">
            <Label>{bt("export.scope")}</Label>
            {SCOPES.map(({ key, labelKey }) => (
              <label
                key={key}
                className="flex min-h-11 cursor-pointer items-center gap-3 rounded-lg border px-3"
              >
                <Checkbox
                  checked={scope[key]}
                  onCheckedChange={(v) => setScope((s) => ({ ...s, [key]: v === true }))}
                  aria-label={bt(labelKey)}
                />
                <span className="text-sm">{bt(labelKey)}</span>
              </label>
            ))}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} className="h-11">
            {bt("common.cancel")}
          </Button>
          <Button
            onClick={() => void handleDownload()}
            disabled={exporting || !businessId}
            className="h-11"
          >
            {exporting ? <Spinner className="mr-2 size-4" /> : <Download className="mr-2 size-4" />}
            {bt("export.download")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
