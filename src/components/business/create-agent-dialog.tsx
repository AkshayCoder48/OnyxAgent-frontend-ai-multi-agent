"use client";

/**
 * Business Mode — CreateAgentDialog (Task 4-c, internal to the Swarm view).
 *
 * Creates a specialist agent for the active business. All writes go through
 * businessAgentService + businessEventService and are mirrored into the
 * business store. No simulated state — the agent starts idle with zeroed
 * metrics (data-layer defaults).
 */

import { useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";

import { AGENT_LOGOS, AgentLogo, randomLogoForRole } from "@/components/business/agent-logos";
import {
  businessAgentService,
  businessEventService,
} from "@/lib/business/data";
import { bt } from "@/lib/business/ui-text";
import type { BusinessAgentPermissions } from "@/lib/business/types";
import { useBusinessStore } from "@/stores/business-store";
import { useAuthStore } from "@/stores/auth-store";
import { aiProviderService } from "@/lib/services";
import type { AIProviderRow } from "@/lib/db";
import { cn } from "@/lib/utils";

/** Common role keys (free-form roles are still allowed via the custom input). */
const COMMON_ROLES = [
  "research",
  "strategy",
  "marketing",
  "content",
  "finance",
  "operations",
  "developer",
  "quality",
  "support",
  "legal",
  "sales",
  "data",
  "creative",
  "growth",
] as const;

const ROLE_CUSTOM = "__custom__";
const PROVIDER_INHERIT = "__inherit__";

const DEFAULT_PERMISSIONS: BusinessAgentPermissions = {
  web_search: true,
  create_drafts: true,
  read_memory: true,
  write_memory: true,
};

function roleLabel(role: string): string {
  return role.charAt(0).toUpperCase() + role.slice(1);
}

export function CreateAgentDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const params = useParams<{ businessId?: string }>();
  const activeBusinessId = useBusinessStore((s) => s.activeBusinessId);
  const businessId = params?.businessId ?? activeBusinessId ?? "";
  const upsertAgent = useBusinessStore((s) => s.upsertAgent);
  const userId = useAuthStore((s) => s.user?.id) ?? "local-user";

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [roleChoice, setRoleChoice] = useState<string>("research");
  const [customRole, setCustomRole] = useState("");
  const [logo, setLogo] = useState("research");
  const [logoTouched, setLogoTouched] = useState(false);
  const [providerId, setProviderId] = useState<string>(PROVIDER_INHERIT);
  const [modelId, setModelId] = useState("");
  const [permissions, setPermissions] = useState<BusinessAgentPermissions>(DEFAULT_PERMISSIONS);
  const [providers, setProviders] = useState<AIProviderRow[]>([]);
  const [creating, setCreating] = useState(false);

  // Load the user's AI providers while the dialog is open (model select).
  useEffect(() => {
    if (!open) return;
    let alive = true;
    (async () => {
      try {
        const rows = await aiProviderService.list(userId);
        if (alive) setProviders(rows);
      } catch {
        // Provider list unavailable — the inherit option still works.
      }
    })();
    return () => {
      alive = false;
    };
  }, [open, userId]);

  // Reset the form each time the dialog opens.
  useEffect(() => {
    if (!open) return;
    setName("");
    setDescription("");
    setRoleChoice("research");
    setCustomRole("");
    setLogoTouched(false);
    setLogo(randomLogoForRole("research"));
    setProviderId(PROVIDER_INHERIT);
    setModelId("");
    setPermissions(DEFAULT_PERMISSIONS);
  }, [open]);

  const role = roleChoice === ROLE_CUSTOM ? customRole.trim() : roleChoice;
  // Follow the chosen role with an auto logo until the user picks one.
  useEffect(() => {
    if (!logoTouched && roleChoice !== ROLE_CUSTOM) {
      setLogo(randomLogoForRole(roleChoice));
    }
  }, [roleChoice, logoTouched]);

  const selectedProvider = useMemo(
    () => providers.find((p) => p.id === providerId),
    [providers, providerId],
  );

  async function handleCreate() {
    if (!businessId) return;
    const trimmedName = name.trim();
    if (!trimmedName) return;
    setCreating(true);
    try {
      const agent = await businessAgentService.create(businessId, {
        name: trimmedName,
        description: description.trim(),
        role: role || "specialist",
        svg_logo: logo,
        provider_id: providerId === PROVIDER_INHERIT ? undefined : providerId,
        model_id: providerId === PROVIDER_INHERIT ? undefined : modelId || undefined,
        permissions,
      });
      upsertAgent(agent);
      await businessEventService.append({
        business_id: businessId,
        agent_id: agent.id,
        event_type: "agent.created",
        payload: { name: agent.name, role: agent.role },
      });
      toast.success(bt("toast.agentCreated"));
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto scrollbar-thin sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{bt("swarm.createAgent")}</DialogTitle>
          <DialogDescription>{bt("swarm.emptySubtitle")}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="agent-create-name">{bt("agent.name")}</Label>
            <Input
              id="agent-create-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={bt("agent.name")}
              autoComplete="off"
            />
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="agent-create-description">{bt("agent.description")}</Label>
            <Textarea
              id="agent-create-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              placeholder={bt("agent.description")}
            />
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="agent-create-role">{bt("agent.role")}</Label>
            <Select
              value={roleChoice}
              onValueChange={(v) => {
                setRoleChoice(v);
                setCustomRole("");
              }}
            >
              <SelectTrigger id="agent-create-role" className="h-11">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {COMMON_ROLES.map((r) => (
                  <SelectItem key={r} value={r}>
                    {roleLabel(r)}
                  </SelectItem>
                ))}
                <SelectItem value={ROLE_CUSTOM}>Custom…</SelectItem>
              </SelectContent>
            </Select>
            {roleChoice === ROLE_CUSTOM && (
              <Input
                value={customRole}
                onChange={(e) => setCustomRole(e.target.value)}
                placeholder="e.g. pricing analyst"
                aria-label={bt("agent.role")}
                className="mt-1"
                autoComplete="off"
              />
            )}
          </div>

          <div className="flex flex-col gap-2">
            <Label>{bt("agent.logo")}</Label>
            <div
              className="grid grid-cols-8 gap-2"
              role="radiogroup"
              aria-label={bt("agent.logo")}
            >
              {AGENT_LOGOS.map((l) => (
                <button
                  key={l.key}
                  type="button"
                  role="radio"
                  aria-checked={logo === l.key}
                  aria-label={l.label}
                  onClick={() => {
                    setLogo(l.key);
                    setLogoTouched(true);
                  }}
                  className={cn(
                    "flex min-h-11 items-center justify-center rounded-lg border p-1.5 transition-colors",
                    logo === l.key
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-border text-muted-foreground hover:border-primary/40 hover:text-foreground",
                  )}
                >
                  <AgentLogo logo={l.key} className="size-7" />
                </button>
              ))}
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-2">
              <Label htmlFor="agent-create-provider">{bt("agent.provider")}</Label>
              <Select
                value={providerId}
                onValueChange={(v) => {
                  setProviderId(v);
                  setModelId("");
                }}
              >
                <SelectTrigger id="agent-create-provider" className="h-11">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={PROVIDER_INHERIT}>
                    {bt("agent.providerInherit")}
                  </SelectItem>
                  {providers.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="agent-create-model">{bt("agent.model")}</Label>
              <Select
                value={modelId || undefined}
                onValueChange={setModelId}
                disabled={providerId === PROVIDER_INHERIT || !selectedProvider}
              >
                <SelectTrigger id="agent-create-model" className="h-11">
                  <SelectValue
                    placeholder={
                      providerId === PROVIDER_INHERIT ? bt("swarm.inheritModel") : bt("agent.model")
                    }
                  />
                </SelectTrigger>
                <SelectContent>
                  {(selectedProvider?.models ?? []).map((m) => (
                    <SelectItem key={m} value={m}>
                      {m}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <Label>{bt("agent.permissions")}</Label>
            <div className="grid gap-2 sm:grid-cols-2">
              {(
                [
                  ["web_search", "agent.perm.webSearch"],
                  ["create_drafts", "agent.perm.createDrafts"],
                  ["read_memory", "agent.perm.readMemory"],
                  ["write_memory", "agent.perm.writeMemory"],
                ] as const
              ).map(([key, labelKey]) => (
                <label
                  key={key}
                  className="flex min-h-11 items-center justify-between gap-3 rounded-lg border px-3 py-2"
                >
                  <span className="text-sm">{bt(labelKey)}</span>
                  <Switch
                    checked={permissions[key]}
                    onCheckedChange={(v) =>
                      setPermissions((prev) => ({ ...prev, [key]: v }))
                    }
                    aria-label={bt(labelKey)}
                  />
                </label>
              ))}
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} className="h-11">
            {bt("common.cancel")}
          </Button>
          <Button onClick={handleCreate} disabled={creating || !name.trim()} className="h-11">
            {creating && <Spinner className="mr-2 size-4" />}
            {bt("common.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
