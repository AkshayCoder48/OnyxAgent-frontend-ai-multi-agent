"use client";

import * as React from "react";
import { toast } from "sonner";
import { Info, Loader2, Sparkles, Trash2, Upload } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

import { useSkills } from "@/hooks/use-data";
import type { Skill } from "@/types";

export function SectionSkills() {
  const { skills, loading, remove } = useSkills();
  const [deleteTarget, setDeleteTarget] = React.useState<Skill | null>(null);
  const fileInputRef = React.useRef<HTMLInputElement>(null);

  function handleUploadClick() {
    fileInputRef.current?.click();
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // reset for re-upload
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(".zip")) {
      toast.error("Only .zip skill bundles are supported");
      return;
    }
    toast.info("Skill upload coming soon", {
      description: `Selected: ${file.name} (${(file.size / 1024).toFixed(1)} KB).`,
    });
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    try {
      await remove(deleteTarget.id);
      toast.success("Skill uninstalled");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to uninstall skill");
    } finally {
      setDeleteTarget(null);
    }
  }

  return (
    <div className="space-y-4">
      <Alert>
        <Info className="size-4" />
        <AlertTitle>About skills</AlertTitle>
        <AlertDescription>
          Skills extend the agent with reusable prompts and tools. Coming soon: SkillsMP marketplace
          integration.
        </AlertDescription>
      </Alert>

      <div className="flex items-center justify-between gap-2">
        <p className="text-muted-foreground text-sm">
          Installed skills are stored locally and loaded into the agent at runtime.
        </p>
        <Button onClick={handleUploadClick} size="sm" className="shrink-0">
          <Upload className="size-4" /> Upload Skill
        </Button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".zip"
          className="hidden"
          onChange={handleFileChange}
        />
      </div>

      {loading ? (
        <div className="text-muted-foreground flex items-center gap-2 py-8 text-sm">
          <Loader2 className="size-4 animate-spin" /> Loading skills…
        </div>
      ) : skills.length === 0 ? (
        <div className="text-muted-foreground rounded-md border border-dashed p-8 text-center">
          <Sparkles className="mx-auto mb-2 size-6 opacity-50" />
          <p className="text-sm">No skills installed yet.</p>
          <p className="text-xs">Upload a .zip bundle to get started.</p>
        </div>
      ) : (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead className="hidden sm:table-cell">Description</TableHead>
                <TableHead>Version</TableHead>
                <TableHead>Source</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {skills.map((s) => (
                <TableRow key={s.id}>
                  <TableCell className="font-medium">{s.name}</TableCell>
                  <TableCell className="text-muted-foreground hidden max-w-[260px] truncate text-xs sm:table-cell">
                    {s.description}
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {s.version ?? "—"}
                  </TableCell>
                  <TableCell>
                    <Badge variant={s.source === "catalog" ? "default" : "secondary"}>
                      {s.source}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setDeleteTarget(s)}
                      className="text-destructive hover:text-destructive"
                    >
                      <Trash2 className="size-3.5" />
                      <span className="hidden sm:inline">Uninstall</span>
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <AlertDialog open={!!deleteTarget} onOpenChange={(o) => !o && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Uninstall skill?</AlertDialogTitle>
            <AlertDialogDescription>
              This will remove <strong>{deleteTarget?.name}</strong> and its files from local
              storage. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={handleDelete}
            >
              Uninstall
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

export default SectionSkills;
