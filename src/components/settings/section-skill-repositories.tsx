"use client";

/**
 * Settings → Skills → "Default skill repositories" panel (Skills PRD).
 *
 * Lists the default repositories from `catalog-registry`:
 *   - skill-collections: Browse (metadata index — static or live from GitHub)
 *     → per-skill Install (repo-browser's installSkillFromRepository).
 *   - npm-cli repos: their sandbox install/run commands shown read-only
 *     (they are run inside the E2B sandbox by the agent, not installed here).
 *
 * The same repositories are indexed agent-side via `analyze_workspace` and
 * `manage_skill` (catalog / browse_repository / install_from_repository) —
 * this panel is the human-facing mirror of that flow.
 */

import * as React from "react";
import { toast } from "sonner";
import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  FolderGit2,
  Loader2,
  Package,
  TerminalSquare,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { SectionCard as SettingsSectionCard } from "@/components/settings/settings-section";
import {
  SKILL_REPOSITORIES,
  type SkillRepository,
} from "@/lib/skills/catalog-registry";
import {
  fetchRepositoryIndex,
  installSkillFromRepository,
  type RepositoryIndex,
} from "@/lib/skills/repo-browser";

interface SectionSkillRepositoriesProps {
  userId: string;
  installedNames: string[];
  /** Called after a successful install so the page refreshes its list. */
  onInstalled: () => void;
  /** OPFS unavailable → installs disabled. */
  disabled?: boolean;
}

export function SectionSkillRepositories({
  userId,
  installedNames,
  onInstalled,
  disabled = false,
}: SectionSkillRepositoriesProps) {
  const [openRepo, setOpenRepo] = React.useState<string | null>(null);
  const [indexes, setIndexes] = React.useState<Record<string, RepositoryIndex | "loading" | "error">>({});
  const [installing, setInstalling] = React.useState<string | null>(null);

  const installedSet = React.useMemo(() => new Set(installedNames), [installedNames]);

  const toggleRepo = async (repo: SkillRepository) => {
    if (openRepo === repo.id) {
      setOpenRepo(null);
      return;
    }
    setOpenRepo(repo.id);
    if (repo.kind !== "skill-collection") return; // npm-cli panels need no fetch
    if (indexes[repo.id]) return; // already loaded (or loading/failed)
    setIndexes((prev) => ({ ...prev, [repo.id]: "loading" }));
    try {
      const index = await fetchRepositoryIndex(repo.id);
      setIndexes((prev) => ({ ...prev, [repo.id]: index }));
    } catch (err) {
      console.warn("[skill-repositories] browse failed:", err);
      setIndexes((prev) => ({ ...prev, [repo.id]: "error" }));
    }
  };

  const installOne = async (repo: SkillRepository, skillName: string) => {
    const key = `${repo.id}/${skillName}`;
    setInstalling(key);
    try {
      const meta = await installSkillFromRepository(userId, repo.id, skillName);
      toast.success(`Installed "${meta.name}" from ${repo.name}`);
      onInstalled();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : `Failed to install ${skillName}`);
    } finally {
      setInstalling(null);
    }
  };

  return (
    <SettingsSectionCard
      title="Default skill repositories"
      description="Curated GitHub skill repositories, indexed automatically for the agent (analyze_workspace / manage_skill catalog). Browse the metadata and install only what a task needs — the agent does the same."
    >
      <ul className="divide-y divide-border rounded-xl border border-border">
        {SKILL_REPOSITORIES.map((repo) => {
          const isOpen = openRepo === repo.id;
          const state = indexes[repo.id];
          return (
            <li key={repo.id} className="px-4">
              <div className="flex items-start gap-3 py-3">
                <button
                  type="button"
                  onClick={() => void toggleRepo(repo)}
                  className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
                  aria-label={isOpen ? `Collapse ${repo.name}` : `Expand ${repo.name}`}
                  aria-expanded={isOpen}
                >
                  {isOpen ? (
                    <ChevronDown className="h-4 w-4" />
                  ) : (
                    <ChevronRight className="h-4 w-4" />
                  )}
                </button>
                {repo.kind === "npm-cli" ? (
                  <TerminalSquare className="mt-1 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
                ) : (
                  <FolderGit2 className="mt-1 h-4 w-4 shrink-0 text-brand" />
                )}
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium">{repo.name}</span>
                    <Badge variant="secondary" className="h-5 px-1.5 text-[10px] font-normal">
                      {repo.kind === "npm-cli" ? "sandbox CLI" : `${repo.skills.length || "live"} skills`}
                    </Badge>
                  </div>
                  <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
                    {repo.description}
                  </p>
                </div>
                <a
                  href={repo.url}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="mt-1 shrink-0 text-muted-foreground transition-colors hover:text-foreground"
                  aria-label={`Open ${repo.name} on GitHub`}
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                </a>
              </div>

              {isOpen && repo.kind === "skill-collection" && (
                <div className="pb-3 pl-9">
                  {state === undefined || state === "loading" ? (
                    <p className="flex items-center gap-2 py-2 text-xs text-muted-foreground">
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      {repo.skills.length > 0 ? "Loading index…" : "Fetching skill index from GitHub…"}
                    </p>
                  ) : state === "error" ? (
                    <p className="py-2 text-xs text-destructive">
                      Failed to fetch the skill index (GitHub rate limit or network). Try again in a
                      minute — the agent-side catalog still lists this repository.
                    </p>
                  ) : (
                    <ul className="space-y-1.5">
                      {state.skills.map((skill) => {
                        const key = `${repo.id}/${skill.name}`;
                        const isInstalled = installedSet.has(skill.name);
                        return (
                          <li
                            key={skill.name}
                            className="flex items-start gap-3 rounded-lg border border-border/60 bg-background px-3 py-2"
                          >
                            <Package className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                            <div className="min-w-0 flex-1">
                              <p className="font-mono text-xs font-medium">{skill.name}</p>
                              <p className="mt-0.5 line-clamp-2 text-[11px] text-muted-foreground">
                                {skill.description}
                              </p>
                            </div>
                            {isInstalled ? (
                              <span className="mt-0.5 flex shrink-0 items-center gap-1 text-[11px] text-emerald-600 dark:text-emerald-400">
                                <CheckCircle2 className="h-3.5 w-3.5" /> Installed
                              </span>
                            ) : (
                              <Button
                                size="sm"
                                variant="outline"
                                className="h-7 shrink-0 px-2.5 text-[11px]"
                                disabled={disabled || installing === key}
                                onClick={() => void installOne(repo, skill.name)}
                              >
                                {installing === key ? (
                                  <Loader2 className="h-3 w-3 animate-spin" />
                                ) : (
                                  "Install"
                                )}
                              </Button>
                            )}
                          </li>
                        );
                      })}
                      {state.skills.length === 0 && (
                        <li className="py-2 text-xs text-muted-foreground">
                          {state.error ?? "No skills found in this repository."}
                        </li>
                      )}
                    </ul>
                  )}
                </div>
              )}

              {isOpen && repo.kind === "npm-cli" && repo.sandboxUsage && (
                <div className="space-y-2 pb-3 pl-9">
                  <p className="text-xs text-muted-foreground">
                    A CLI tool, not a skill install — the agent runs these inside the E2B sandbox
                    via <code className="font-mono">run_terminal</code> when a task needs them.
                  </p>
                  <div className="rounded-lg border border-border/60 bg-muted/40 p-2.5 font-mono text-[11px] leading-relaxed">
                    <p className="text-muted-foreground"># install (in the sandbox)</p>
                    <p className="break-all">{repo.sandboxUsage.install}</p>
                    <p className="mt-1.5 text-muted-foreground"># run</p>
                    <p className="break-all">{repo.sandboxUsage.run}</p>
                    {repo.sandboxUsage.example && (
                      <>
                        <p className="mt-1.5 text-muted-foreground"># example</p>
                        <p className="break-all">{repo.sandboxUsage.example}</p>
                      </>
                    )}
                  </div>
                  {repo.sandboxUsage.caution && (
                    <p className="text-[11px] text-amber-700 dark:text-amber-300">
                      ⚠ {repo.sandboxUsage.caution}
                    </p>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
      <p className="mt-3 text-[11px] text-muted-foreground">
        Also available agent-side: <code className="font-mono">manage_skill</code> actions{" "}
        <code className="font-mono">catalog</code> /{" "}
        <code className="font-mono">browse_repository</code> /{" "}
        <code className="font-mono">install_from_repository</code> — the agent reads the same
        metadata and installs skills on demand.
      </p>
    </SettingsSectionCard>
  );
}
