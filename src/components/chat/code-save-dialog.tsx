"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { FolderInput, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
import { cn } from "@/lib/utils";
import { useAuthStore } from "@/stores/auth-store";
import { settingsService } from "@/lib/services";

/**
 * Save-to-Files — the code-block "Save" affordance ("add a save to files
 * button on raw generated code markdown block; after tapping it asks to
 * choose location and name and extension").
 *
 * `SaveCodeButton` rides in the code-block header next to Copy. Tapping it
 * opens `SaveCodeDialog`, which asks for exactly three things:
 *
 *   - LOCATION — one of the sandbox workspace's folders (listed live; the
 *     root "/" and the last-used choice are always offered). With no E2B
 *     sandbox key configured the dialog degrades to saving into the LOCAL
 *     Uploads registry (OPFS — the same place chat attachments live), so
 *     the button always works.
 *   - NAME — free text, path separators stripped.
 *   - EXTENSION — prefilled from the block's language (py / ts / md …),
 *     freely editable, leading dots normalized away.
 *
 * Saving writes the file through the same E2B client the Files sidebar
 * uses, then fires the `tool_result` window event (tool_name
 * "create_file") so the Files panel refreshes immediately.
 */

/** Where the last-used location persists. */
const LOCATION_KEY = "onyx-code-save-location";

/** Language slug → default file extension. */
const LANG_EXT: Record<string, string> = {
  python: "py",
  py: "py",
  typescript: "ts",
  ts: "ts",
  tsx: "tsx",
  javascript: "js",
  js: "js",
  jsx: "jsx",
  mjs: "mjs",
  cjs: "cjs",
  json: "json",
  html: "html",
  xml: "xml",
  css: "css",
  scss: "scss",
  sql: "sql",
  markdown: "md",
  md: "md",
  mdx: "mdx",
  yaml: "yml",
  yml: "yml",
  toml: "toml",
  ini: "ini",
  csv: "csv",
  tsv: "tsv",
  bash: "sh",
  sh: "sh",
  shell: "sh",
  zsh: "zsh",
  powershell: "ps1",
  dockerfile: "dockerfile",
  makefile: "mk",
  graphql: "graphql",
  go: "go",
  rust: "rs",
  rs: "rs",
  java: "java",
  kotlin: "kt",
  swift: "swift",
  c: "c",
  cpp: "cpp",
  "c++": "cpp",
  cs: "cs",
  csharp: "cs",
  php: "php",
  ruby: "rb",
  r: "r",
  lua: "lua",
  perl: "pl",
  dart: "dart",
  scala: "scala",
  haskell: "hs",
  elixir: "ex",
  text: "txt",
  txt: "txt",
  plaintext: "txt",
  diff: "patch",
  pythonrepl: "py",
};

/** Default file name stem — neutral, editable in the dialog. */
const DEFAULT_NAME = "snippet";

/** Normalize an extension: trim, strip leading dots, keep [A-Za-z0-9_-]. */
function normalizeExt(raw: string): string {
  return raw.trim().replace(/^[.]+/, "").replace(/[^A-Za-z0-9._-]/g, "");
}

/** Normalize a file name: strip path separators + surrounding dots/spaces. */
function normalizeName(raw: string): string {
  return raw.trim().replace(/[\\/]+/g, "_").replace(/^[.\s]+|[.\s]+$/g, "");
}

/* ── The dialog ──────────────────────────────────────────────────────── */

export function SaveCodeDialog({
  open,
  onOpenChange,
  code,
  lang,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The code block's raw content. */
  code: string;
  /** The fenced language slug (may be null for plain blocks). */
  lang: string | null;
}) {
  const user = useAuthStore((s) => s.user);
  const [folders, setFolders] = useState<Array<{ value: string; label: string }>>([]);
  const [foldersLoaded, setFoldersLoaded] = useState(false);
  const [noSandbox, setNoSandbox] = useState(false);
  const [location, setLocation] = useState("/");
  const [name, setName] = useState(DEFAULT_NAME);
  const [ext, setExt] = useState("");
  const [saving, setSaving] = useState(false);

  // Prefill the extension from the block's language.
  useEffect(() => {
    if (open) setExt(lang ? (LANG_EXT[lang.toLowerCase()] ?? "txt") : "txt");
  }, [open, lang]);

  // Resolve the sandbox + list its folders once per open (best-effort — a
  // listing failure just leaves the root option; no key → local Uploads).
  useEffect(() => {
    if (!open || !user?.id) return;
    let cancelled = false;
    (async () => {
      try {
        const apiKey = await settingsService.getDecryptedSandboxKey(user.id);
        if (cancelled) return;
        if (!apiKey) {
          setNoSandbox(true);
          setFoldersLoaded(true);
          return;
        }
        const { getE2BClient } = await import("@/lib/e2b/client");
        const client = getE2BClient(apiKey, null, "shared");
        const entries = await client.listFiles(".");
        if (cancelled) return;
        const dirs = entries
          .filter((e) => (e as { type?: string }).type === "dir")
          .map((e) => e.name)
          .filter((n): n is string => typeof n === "string" && n.length > 0)
          .sort((a, b) => a.localeCompare(b));
        setFolders(dirs.map((d) => ({ value: d, label: `/${d}` })));
        setNoSandbox(false);
      } catch {
        // Sandbox unreachable — root-only listing, still writable.
        setFolders([]);
      } finally {
        if (!cancelled) setFoldersLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, user?.id]);

  // Restore the last-used location (when it still exists in the listing).
  useEffect(() => {
    if (!open || !foldersLoaded) return;
    try {
      const saved = localStorage.getItem(LOCATION_KEY);
      if (!saved) return;
      if (saved === "/" || folders.some((f) => f.value === saved)) setLocation(saved);
    } catch {
      /* ignore */
    }
  }, [open, foldersLoaded, folders]);

  const fullName = useMemo(() => {
    const n = normalizeName(name) || DEFAULT_NAME;
    const e = normalizeExt(ext);
    return e ? `${n}.${e}` : n;
  }, [name, ext]);

  const canSave = useMemo(
    () => !saving && normalizeName(name).length > 0 && fullName.length > 0,
    [saving, name, fullName],
  );

  const handleSave = useCallback(async () => {
    if (!canSave) return;
    setSaving(true);
    try {
      if (noSandbox || !user?.id) {
        // LOCAL FALLBACK — the uploads registry (OPFS + Dexie): the same
        // store chat attachments live in. Works with zero configuration.
        const { uploadFile } = await import("@/lib/file-api");
        await uploadFile(new File([code], fullName, { type: "text/plain" }));
        toast.success("Saved to Uploads", {
          description: `${fullName} · local files (no sandbox workspace configured)`,
        });
      } else {
        const apiKey = await settingsService.getDecryptedSandboxKey(user.id);
        if (!apiKey) throw new Error("No sandbox workspace key found.");
        const { getE2BClient } = await import("@/lib/e2b/client");
        const client = getE2BClient(apiKey, null, "shared");
        const path = location === "/" ? fullName : `${location}/${fullName}`;
        await client.writeFile(path, code);
        // Refresh the Files sidebar (same event workspace tool calls fire).
        window.dispatchEvent(
          new CustomEvent("tool_result", { detail: { tool_name: "create_file" } }),
        );
        try {
          localStorage.setItem(LOCATION_KEY, location);
        } catch {
          /* ignore */
        }
        toast.success("Saved to Files", {
          description: `~/${path}`,
        });
      }
      onOpenChange(false);
    } catch (e) {
      toast.error("Save failed", {
        description: e instanceof Error ? e.message : "Unknown error",
      });
    } finally {
      setSaving(false);
    }
  }, [canSave, noSandbox, user?.id, code, fullName, location, onOpenChange]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Save to Files</DialogTitle>
          <DialogDescription>
            Choose a location, name and extension for this code block.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-1">
          {/* Location */}
          <div className="space-y-1.5">
            <Label htmlFor="save-location">Location</Label>
            {noSandbox ? (
              <p className="bg-muted text-muted-foreground rounded-md px-3 py-2 text-xs">
                No sandbox workspace configured — the file will be saved to your local{" "}
                <span className="text-foreground font-medium">Uploads</span>.
              </p>
            ) : (
              <Select value={location} onValueChange={setLocation} disabled={saving}>
                <SelectTrigger id="save-location" className="w-full">
                  <SelectValue
                    placeholder={foldersLoaded ? "Workspace root" : "Loading folders…"}
                  />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="/">/ (workspace root)</SelectItem>
                  {folders.map((f) => (
                    <SelectItem key={f.value} value={f.value}>
                      {f.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>

          {/* Name + extension */}
          <div className="grid grid-cols-[1fr_7.5rem] gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="save-name">Name</Label>
              <Input
                id="save-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={DEFAULT_NAME}
                disabled={saving}
                autoComplete="off"
                spellCheck={false}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="save-ext">Extension</Label>
              <Input
                id="save-ext"
                value={ext}
                onChange={(e) => setExt(e.target.value)}
                placeholder="txt"
                disabled={saving}
                autoComplete="off"
                spellCheck={false}
                className="font-mono"
              />
            </div>
          </div>

          {/* Final path preview — what will actually be written. */}
          <p className="text-muted-foreground truncate font-mono text-[11px]">
            {noSandbox ? "uploads/" : location === "/" ? "/" : `/${location}/`}
            <span className="text-foreground font-semibold">{fullName}</span>
          </p>
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={!canSave}>
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : null}
            {saving ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ── The header button ───────────────────────────────────────────────── */

export function SaveCodeButton({
  code,
  lang,
  className,
}: {
  code: string;
  lang: string | null;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setOpen(true);
        }}
        title="Save to Files"
        aria-label="Save this code block to Files"
        className={cn(
          "inline-flex h-6 cursor-pointer items-center gap-1 rounded-md bg-transparent px-1.5 text-[11px] transition-colors hover:bg-white/5",
          className,
        )}
      >
        <FolderInput className="h-3.5 w-3.5" aria-hidden />
        <span className="leading-none">Save</span>
      </button>
      <SaveCodeDialog open={open} onOpenChange={setOpen} code={code} lang={lang} />
    </>
  );
}
