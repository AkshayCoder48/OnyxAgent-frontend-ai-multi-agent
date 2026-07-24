"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  ExternalLink,
  Loader2,
  Package,
  Plus,
  RefreshCw,
  Trash2,
  Upload,
  Wrench,
} from "lucide-react";
import { toast } from "sonner";

import { Button, Input } from "@/components/ui";
import { SectionCard as SettingsSectionCard } from "@/components/settings/settings-section";
import { cn } from "@/lib/utils";
import { useAuth } from "@/hooks";
import { skillService } from "@/lib/services";
import {
  fetchSkillsMPPage,
  searchSkillsMPSkills,
  installSkillsMPSkill,
  installSkillFile,
  uninstallSkill,
  type SkillsMPSkill,
} from "@/lib/skills/installer";
import { isOPFSAvailable } from "@/lib/storage/opfs";

interface InstalledSkill {
  id: string;
  name: string;
  description?: string;
  path: string;
}

type CatalogState =
  | { kind: "loading" }
  | { kind: "ready"; items: SkillsMPSkill[]; usedFallback: boolean; hasMore: boolean; loadingMore: boolean }
  | { kind: "error"; message: string; items: SkillsMPSkill[] };

export default function SkillsSettingsPage() {
  const { user } = useAuth();
  const [installed, setInstalled] = useState<InstalledSkill[]>([]);
  const [catalog, setCatalog] = useState<CatalogState>({ kind: "loading" });
  const [loadingInstalled, setLoadingInstalled] = useState(true);
  const [installing, setInstalling] = useState<string | null>(null);
  const [uninstalling, setUninstalling] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [search, setSearch] = useState("");
  const [searchResults, setSearchResults] = useState<SkillsMPSkill[] | null>(null);
  const [searching, setSearching] = useState(false);

  // Optional SkillsMP API key — loaded once on mount. When present, requests
  // use the 500 req/day authenticated quota instead of the 50 req/day
  // anonymous quota.
  const [skillsmpApiKey, setSkillsmpApiKey] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const searchAbortRef = useRef<AbortController | null>(null);
  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const opfsAvailable = typeof window !== "undefined" && isOPFSAvailable();

  // Check if E2B sandbox key is configured — skills require sandbox access for AI to use them.
  const [e2bAvailable, setE2BAvailable] = useState(false);
  const [checkingE2B, setCheckingE2B] = useState(true);
  useEffect(() => {
    if (!user) return;
    (async () => {
      try {
        const { settingsService } = await import("@/lib/services");
        const [sandboxKey, skillsmpKey] = await Promise.all([
          settingsService.getDecryptedSandboxKey(user.id),
          settingsService.getDecryptedSkillsMPApiKey(user.id),
        ]);
        setE2BAvailable(!!sandboxKey);
        setSkillsmpApiKey(skillsmpKey);
      } catch {
        setE2BAvailable(false);
      } finally {
        setCheckingE2B(false);
      }
    })();
  }, [user]);

  const loadInstalled = useCallback(async () => {
    if (!user) return;
    setLoadingInstalled(true);
    try {
      const rows = await skillService.list(user.id);
      setInstalled(
        rows.map((r) => ({
          id: r.id,
          name: r.name,
          description: r.description ?? undefined,
          path: r.dir_path,
        })),
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to load installed skills");
    } finally {
      setLoadingInstalled(false);
    }
  }, [user]);

  // Track the current page for incremental "Load More" pagination.
  const catalogPageRef = useRef(1);

  const loadCatalog = useCallback(async () => {
    // Cancel any in-flight catalog fetch before starting a new one.
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setCatalog({ kind: "loading" });
    catalogPageRef.current = 1;
    try {
      const { items, hasMore } = await fetchSkillsMPPage(1, {
        signal: controller.signal,
        apiKey: skillsmpApiKey,
      });
      // If the request was cancelled, don't overwrite state.
      if (controller.signal.aborted) return;
      const usedFallback = items.length > 0 && items.every((it) => it.isFallback);
      setCatalog({ kind: "ready", items, usedFallback, hasMore, loadingMore: false });
    } catch (err) {
      if (controller.signal.aborted) return;
      const message = err instanceof Error ? err.message : "Failed to load SkillsMP catalog";
      setCatalog({
        kind: "error",
        message,
        items: [],
      });
    }
  }, [skillsmpApiKey]);

  // Load the next page of skills (called by the "Load More" button).
  // Appends the new items to the existing catalog and tracks whether
  // there are more pages to load.
  const loadMoreCatalog = useCallback(async () => {
    if (catalog.kind !== "ready" || catalog.loadingMore || !catalog.hasMore) return;
    // Cancel any in-flight "load more" fetch.
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    // Set loadingMore flag so the button shows a spinner.
    setCatalog({ ...catalog, loadingMore: true });
    const nextPage = catalogPageRef.current + 1;
    try {
      const { items, hasMore } = await fetchSkillsMPPage(nextPage, {
        signal: controller.signal,
        apiKey: skillsmpApiKey,
      });
      if (controller.signal.aborted) return;
      // Deduplicate by id/name — the API may return overlapping entries
      // across pages (especially with `q=a` which matches many skills).
      const seen = new Set(catalog.items.map((it) => it.id || it.name || it.slug || ""));
      const newItems = items.filter((it) => {
        const key = it.id || it.name || it.slug || "";
        return key && !seen.has(key);
      });
      catalogPageRef.current = nextPage;
      setCatalog({
        kind: "ready",
        items: [...catalog.items, ...newItems],
        usedFallback: catalog.usedFallback,
        hasMore: hasMore && newItems.length > 0,
        loadingMore: false,
      });
    } catch (err) {
      if (controller.signal.aborted) return;
      console.warn("[skills] loadMore failed:", err);
      // Reset loadingMore flag but keep existing items.
      setCatalog({ ...catalog, loadingMore: false, hasMore: false });
    }
  }, [catalog, skillsmpApiKey]);

  useEffect(() => {
    void loadInstalled();
    void loadCatalog();
    return () => {
      abortRef.current?.abort();
    };
  }, [loadInstalled, loadCatalog]);

  // Debounced server-side search — when the user types in the search box,
  // wait 400ms then query the SkillsMP /api/v1/skills/search endpoint.
  useEffect(() => {
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    if (!search.trim()) {
      setSearchResults(null);
      setSearching(false);
      return;
    }
    setSearching(true);
    searchDebounceRef.current = setTimeout(async () => {
      searchAbortRef.current?.abort();
      const controller = new AbortController();
      searchAbortRef.current = controller;
      try {
        const results = await searchSkillsMPSkills(search.trim(), {
          signal: controller.signal,
          limit: 50,
          apiKey: skillsmpApiKey,
        });
        if (!controller.signal.aborted) {
          setSearchResults(results);
        }
      } catch {
        if (!controller.signal.aborted) setSearchResults([]);
      } finally {
        if (!controller.signal.aborted) setSearching(false);
      }
    }, 400);
    return () => {
      if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    };
  }, [search, skillsmpApiKey]);

  const installedNames = new Set(installed.map((s) => s.name));

  const installFromCatalog = async (skill: SkillsMPSkill) => {
    if (!user) return;
    if (!opfsAvailable) {
      toast.error("OPFS is not available in this browser — can't install skills.");
      return;
    }
    setInstalling(skill.slug);
    try {
      const meta = await installSkillsMPSkill(user.id, skill.slug, {
        nameOverride: skill.slug,
        descriptionOverride: skill.description,
        skill,
        apiKey: skillsmpApiKey,
      });
      const fileCount = meta.files?.length ?? 1;
      // Show the correct destination based on the file system mode.
      // Skills are ALWAYS written to OPFS. If cloud mode is active AND a
      // sandbox key is configured, they're ALSO uploaded to the sandbox.
      const destMsg = e2bAvailable
        ? `${fileCount} file${fileCount === 1 ? "" : "s"} written to OPFS + E2B sandbox.`
        : `${fileCount} file${fileCount === 1 ? "" : "s"} written to OPFS.`;
      toast.success(`Installed skill: ${meta.name}`, {
        description: destMsg,
      });
      await loadInstalled();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : `Failed to install ${skill.slug}`);
    } finally {
      setInstalling(null);
    }
  };

  const handleUninstall = async (skill: InstalledSkill) => {
    if (!user) return;
    setUninstalling(skill.name);
    try {
      await uninstallSkill(user.id, skill.name);
      toast.success(`Removed skill: ${skill.name}`);
      await loadInstalled();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Uninstall failed");
    } finally {
      setUninstalling(null);
    }
  };

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!user) return;
    if (!opfsAvailable) {
      toast.error("OPFS is not available in this browser — can't install skills.");
      if (fileInputRef.current) fileInputRef.current.value = "";
      return;
    }
    setUploading(true);
    try {
      const meta = await installSkillFile(user.id, file);
      const fileCount = meta.files?.length ?? 1;
      const destMsg = e2bAvailable
        ? `${fileCount} file${fileCount === 1 ? "" : "s"} written to OPFS + E2B sandbox.`
        : `${fileCount} file${fileCount === 1 ? "" : "s"} written to OPFS.`;
      toast.success(`Installed skill: ${meta.name}`, {
        description: destMsg,
      });
      await loadInstalled();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  // Use server-side search results when searching, otherwise show full catalog
  const catalogItems: SkillsMPSkill[] =
    catalog.kind === "loading" ? [] : catalog.items;
  const displayItems: SkillsMPSkill[] = searchResults !== null
    ? searchResults
    : catalogItems;

  // Server-side "has more pages" flag. When the catalog is ready and
  // `hasMore` is true, we show the "Load More" button which fetches the
  // next page from the SkillsMP API (not just revealing already-loaded items).
  const hasMorePages = catalog.kind === "ready" && catalog.hasMore;
  const loadingMore = catalog.kind === "ready" && catalog.loadingMore;

  return (
    <div className="space-y-6">
      <SettingsSectionCard
        title="Installed skills"
        description="Skills are contextual capabilities the AI uses automatically when your task matches. Install from the catalog below or upload a SKILL.md / .zip file."
      >
        {!opfsAvailable && (
          <div className="mb-4 rounded-xl border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-amber-700 dark:text-amber-300">
            Your browser doesn&apos;t support OPFS (Origin Private File System),
            so skill installation is disabled. Try Chrome, Edge, or Safari.
          </div>
        )}
        {opfsAvailable && !checkingE2B && !e2bAvailable && (
          <div className="mb-4 rounded-xl border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-amber-700 dark:text-amber-300">
            <strong>No E2B Sandbox API key configured.</strong> Skills require an E2B sandbox
            for the AI to read and use them. Add an E2B key in{" "}
            <a href="/settings/config" className="underline font-medium">Settings → Config</a>{" "}
            to enable skill installation.
          </div>
        )}
        {loadingInstalled ? (
          <div className="flex items-center gap-2 p-6 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
          </div>
        ) : installed.length === 0 ? (
          <div className="rounded-xl border border-dashed border-foreground/15 p-8 text-center">
            <Wrench className="mx-auto h-8 w-8 text-muted-foreground mb-3" />
            <p className="font-medium">No skills installed yet</p>
            <p className="text-sm text-muted-foreground mt-1 max-w-md mx-auto">
              Browse the catalog below and click <em>Install</em>, or upload a
              SKILL.md / .zip file from the section below.
            </p>
          </div>
        ) : (
          <ul className="max-h-96 divide-y divide-border overflow-y-auto scrollbar-thin">
            {installed.map((s) => (
              <li key={s.id} className="flex items-start gap-3 py-3">
                <Package className="mt-0.5 h-4 w-4 shrink-0 text-brand" />
                <div className="min-w-0 flex-1">
                  <p className="font-medium text-sm">{s.name}</p>
                  {s.description ? (
                    <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">
                      {s.description}
                    </p>
                  ) : null}
                  <p className="text-[10px] font-mono text-muted-foreground/60 mt-1">
                    {s.path}
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={uninstalling === s.name}
                  onClick={() => handleUninstall(s)}
                  className="h-7 text-xs text-muted-foreground hover:text-destructive"
                  title="Uninstall"
                >
                  {uninstalling === s.name ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Trash2 className="h-3.5 w-3.5" />
                  )}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </SettingsSectionCard>

      <SettingsSectionCard
        title="Upload a skill"
        description="Upload a SKILL.md file or a .zip archive. The skill will be extracted to OPFS and made available to the AI on the next chat turn."
      >
        <div className="rounded-xl border border-dashed border-foreground/15 p-8 text-center">
          <input
            ref={fileInputRef}
            type="file"
            accept=".zip,.md,.markdown"
            onChange={handleUpload}
            disabled={uploading || !opfsAvailable || !e2bAvailable}
            className="hidden"
            id="skill-upload-input"
          />
          <Upload className="mx-auto h-8 w-8 text-muted-foreground mb-3" />
          <p className="font-medium">
            {uploading ? "Installing…" : "Drop a .zip or SKILL.md here"}
          </p>
          <p className="text-sm text-muted-foreground mt-1 max-w-md mx-auto">
            The .zip may either contain <code>SKILL.md</code> at its root or a
            single top-level folder containing <code>SKILL.md</code>. YAML
            front-matter (<code>name:</code>, <code>description:</code>) is
            parsed automatically.
          </p>
          <Button
            size="sm"
            variant="outline"
            className="mt-3"
            disabled={uploading || !opfsAvailable || !e2bAvailable}
            onClick={() => fileInputRef.current?.click()}
          >
            {uploading ? (
              <>
                <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> Installing…
              </>
            ) : (
              <>
                <Plus className="h-4 w-4 mr-1.5" /> Choose file
              </>
            )}
          </Button>
        </div>
      </SettingsSectionCard>

      <SettingsSectionCard
        title="SkillsMP catalog"
        description="Browse community skills. Click Install to download and extract the skill to your workspace."
      >
        <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <Input
            placeholder="Search skills…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="max-w-sm"
          />
          {catalog.kind === "ready" && (
            <Button
              size="sm"
              variant="ghost"
              className="h-8 text-xs"
              onClick={() => void loadCatalog()}
            >
              <RefreshCw className="h-3.5 w-3.5 mr-1" /> Refresh
            </Button>
          )}
        </div>

        {catalog.kind === "loading" && (
          <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-foreground/15 p-12 text-center">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            <p className="text-sm text-muted-foreground">
              Fetching catalog from SkillsMP…
            </p>
          </div>
        )}

        {catalog.kind === "error" && (
          <div className="flex flex-col items-center gap-3 rounded-xl border border-destructive/30 bg-destructive/5 p-8 text-center">
            <AlertTriangle className="h-8 w-8 text-destructive" />
            <div>
              <p className="font-medium">Couldn&apos;t reach SkillsMP</p>
              <p className="text-sm text-muted-foreground mt-1 max-w-md">
                {catalog.message}
              </p>
            </div>
            <Button
              size="sm"
              variant="outline"
              className="mt-1"
              onClick={() => void loadCatalog()}
            >
              <RefreshCw className="h-4 w-4 mr-1.5" /> Retry
            </Button>
          </div>
        )}

        {catalog.kind === "ready" && catalog.usedFallback && (
          <div className="mb-4 rounded-xl border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-amber-700 dark:text-amber-300">
            <AlertTriangle className="inline h-3.5 w-3.5 mr-1 -mt-0.5" />
            Couldn&apos;t reach the SkillsMP API — showing a small fallback list.
            Click <RefreshCw className="inline h-3 w-3 mx-0.5" /> to retry; install
            buttons will still try the real SkillsMP download URL.
          </div>
        )}

        {catalog.kind === "ready" && (
          <>
            {searching ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                <span className="ml-2 text-sm text-muted-foreground">Searching SkillsMP…</span>
              </div>
            ) : displayItems.length === 0 ? (
              <div className="rounded-xl border border-dashed border-foreground/15 p-8 text-center">
                <Package className="mx-auto h-8 w-8 text-muted-foreground mb-3" />
                <p className="font-medium">{search.trim() ? "No skills match your search" : "No skills found"}</p>
              </div>
            ) : (
              <>
                <p className="text-xs text-muted-foreground mb-2">
                  Showing {displayItems.length} skill{displayItems.length === 1 ? "" : "s"}
                  {searchResults !== null && " (search results)"}
                  {hasMorePages && " · scroll down to load more"}
                </p>
                <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {displayItems.map((c) => {
                  const isInstalling = installing === c.slug;
                  // Installed skills are matched by slug → sanitized name.
                  // `sanitizeSkillName` lowercases + replaces non-alphanumerics,
                  // so we mirror that here for the lookup.
                  const matchName = c.slug
                    .trim()
                    .toLowerCase()
                    .replace(/[^a-z0-9._-]+/g, "-")
                    .replace(/^-+|-+$/g, "");
                  const isInstalled = installedNames.has(matchName) || installedNames.has(c.slug);
                  return (
                    <li
                      key={c.slug}
                      className={cn(
                        "flex flex-col gap-2 rounded-xl border border-border p-3 transition-colors",
                        isInstalled && "bg-emerald-500/5 border-emerald-500/30",
                      )}
                    >
                      <div className="flex items-start gap-2">
                        <Package className="mt-0.5 h-4 w-4 shrink-0 text-brand" />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <p className="font-mono text-sm font-medium truncate">{c.name}</p>
                            {c.isFallback && (
                              <span className="shrink-0 rounded bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-300">
                                fallback
                              </span>
                            )}
                          </div>
                          {c.description ? (
                            <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">
                              {c.description}
                            </p>
                          ) : null}
                          <div className="flex flex-wrap items-center gap-2 mt-1">
                            {c.author ? (
                              <p className="text-[10px] text-muted-foreground/70 flex items-center gap-1">
                                <ExternalLink className="h-3 w-3" /> {c.author}
                              </p>
                            ) : null}
                            {c.stars != null ? (
                              <p className="text-[10px] text-muted-foreground/70">
                                ★ {c.stars.toLocaleString()}
                              </p>
                            ) : null}
                            {c.downloads != null ? (
                              <p className="text-[10px] text-muted-foreground/70">
                                {c.downloads.toLocaleString()} downloads
                              </p>
                            ) : null}
                            {c.tags && c.tags.length > 0 ? (
                              <div className="flex flex-wrap gap-1">
                                {c.tags.slice(0, 3).map((t) => (
                                  <span
                                    key={t}
                                    className="rounded bg-secondary px-1.5 py-0.5 text-[10px] text-muted-foreground"
                                  >
                                    {t}
                                  </span>
                                ))}
                              </div>
                            ) : null}
                          </div>
                        </div>
                        {isInstalled && (
                          <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-500" />
                        )}
                      </div>
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-[10px] font-mono text-muted-foreground/60 truncate">
                          {c.slug}
                        </span>
                        {isInstalled ? (
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 text-xs"
                            onClick={() => {
                              const match = installed.find((s) => s.name === matchName || s.name === c.slug);
                              if (match) void handleUninstall(match);
                            }}
                            disabled={uninstalling === c.slug || uninstalling === matchName}
                          >
                            {uninstalling === c.slug || uninstalling === matchName ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                              <>
                                <Trash2 className="h-3.5 w-3.5 mr-1" /> Remove
                              </>
                            )}
                          </Button>
                        ) : (
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7 text-xs"
                            onClick={() => installFromCatalog(c)}
                            disabled={isInstalling || !opfsAvailable || !e2bAvailable}
                          >
                            {isInstalling ? (
                              <>
                                <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> Installing…
                              </>
                            ) : (
                              <>
                                <Download className="h-3.5 w-3.5 mr-1" /> Install
                              </>
                            )}
                          </Button>
                        )}
                      </div>
                    </li>
                  );
                })}
                </ul>
                {/* "Load More" button — fetches the next page from the SkillsMP
                    API. Shows a spinner while loading. Hidden when there are no
                    more pages, or when the user is searching (search results are
                    a separate query with its own limit). */}
                {loadingMore && (
                  <div className="flex justify-center pt-4">
                    <Button size="sm" variant="outline" disabled>
                      <Loader2 className="h-4 w-4 animate-spin mr-1.5" />
                      Loading more…
                    </Button>
                  </div>
                )}
                {hasMorePages && !loadingMore && !search && (
                  <div className="flex justify-center pt-4">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={loadMoreCatalog}
                    >
                      Load More
                    </Button>
                  </div>
                )}
                {!hasMorePages && !search && catalog.kind === "ready" && catalog.items.length > 0 && (
                  <p className="text-center text-xs text-muted-foreground pt-4">
                    You've reached the end of the catalog
                  </p>
                )}
              </>
            )}
          </>
        )}
      </SettingsSectionCard>
    </div>
  );
}
