"use client";

import * as React from "react";
import { formatDistanceToNow } from "date-fns";
import {
  Bot,
  Plus,
  Search,
  MoreHorizontal,
  Pencil,
  Archive,
  Trash2,
  Settings,
  LogOut,
  MessageSquare,
  X,
} from "lucide-react";
import { toast } from "sonner";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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

import { useConversations } from "@/hooks/use-conversations";
import { useChatStore } from "@/stores/chat-store";
import { useAuthStore } from "@/stores/auth-store";
import type { Conversation, ID } from "@/types";

export interface ConversationSidebarProps {
  /** Invoked when the user clicks "New Chat". */
  onNewChat?: () => void;
  /** Invoked when the user clicks the Settings button in the footer. */
  onSelectSettings?: () => void;
  /** Optional className merged into the root container. */
  className?: string;
}

/**
 * Conversation sidebar — header, search, scrollable list, footer.
 *
 * The component itself renders the inner column. The parent decides how to
 * mount it: on desktop it lives inside a fixed-width `<aside>`; on mobile it
 * is mounted inside a `<SheetContent side="left">`. The sidebar is
 * `h-full flex flex-col`, so it fills whatever wrapper it is placed in.
 */
export function ConversationSidebar({
  onNewChat,
  onSelectSettings,
  className,
}: ConversationSidebarProps) {
  const { conversations, loading, create, rename, archive, remove, select, refetch } =
    useConversations();
  const activeConversationId = useChatStore((s) => s.activeConversationId);
  const { user, logout } = useAuthStore();

  const [query, setQuery] = React.useState("");

  // Rename dialog state
  const [renaming, setRenaming] = React.useState<Conversation | null>(null);
  const [renameValue, setRenameValue] = React.useState("");
  const [renameBusy, setRenameBusy] = React.useState(false);

  // Delete confirm state
  const [deleting, setDeleting] = React.useState<Conversation | null>(null);
  const [deleteBusy, setDeleteBusy] = React.useState(false);

  const filtered = React.useMemo(() => {
    if (!query.trim()) return conversations;
    const q = query.toLowerCase();
    return conversations.filter((c) => c.title.toLowerCase().includes(q));
  }, [conversations, query]);

  async function handleNewChat() {
    try {
      const conv = await create(undefined);
      select(conv.id);
      onNewChat?.();
    } catch (e) {
      toast.error("Failed to create a new chat", {
        description: e instanceof Error ? e.message : undefined,
      });
    }
  }

  function openRename(conv: Conversation) {
    setRenaming(conv);
    setRenameValue(conv.title);
  }

  async function submitRename() {
    if (!renaming) return;
    const title = renameValue.trim();
    if (!title) {
      toast.error("Title cannot be empty");
      return;
    }
    setRenameBusy(true);
    try {
      await rename({ id: renaming.id, title });
      toast.success("Conversation renamed");
      setRenaming(null);
    } catch (e) {
      toast.error("Failed to rename", {
        description: e instanceof Error ? e.message : undefined,
      });
    } finally {
      setRenameBusy(false);
    }
  }

  async function handleArchive(conv: Conversation) {
    try {
      await archive({ id: conv.id, archived: !conv.is_archived });
      toast.success(conv.is_archived ? "Conversation restored" : "Conversation archived");
    } catch (e) {
      toast.error("Failed to update conversation", {
        description: e instanceof Error ? e.message : undefined,
      });
    }
  }

  async function confirmDelete() {
    if (!deleting) return;
    setDeleteBusy(true);
    try {
      const wasActive = activeConversationId === deleting.id;
      await remove(deleting.id);
      if (wasActive) select(null);
      toast.success("Conversation deleted");
      setDeleting(null);
    } catch (e) {
      toast.error("Failed to delete conversation", {
        description: e instanceof Error ? e.message : undefined,
      });
    } finally {
      setDeleteBusy(false);
    }
  }

  function handleSelect(id: ID) {
    select(id);
  }

  return (
    <div
      className={cn(
        "bg-sidebar text-sidebar-foreground flex h-full w-full flex-col border-r",
        className,
      )}
    >
      {/* Header */}
      <div className="flex items-center justify-between gap-2 px-4 pt-4 pb-3">
        <div className="flex min-w-0 items-center gap-2">
          <div className="flex size-8 items-center justify-center rounded-md bg-primary text-primary-foreground">
            <Bot className="size-4" aria-hidden="true" />
          </div>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold">Agent Chat</p>
            <p className="truncate text-xs text-muted-foreground">Backendless</p>
          </div>
        </div>
        <Button
          type="button"
          size="icon"
          variant="default"
          aria-label="New chat"
          onClick={handleNewChat}
        >
          <Plus className="size-4" aria-hidden="true" />
        </Button>
      </div>

      {/* Search */}
      <div className="px-3 pb-3">
        <div className="relative">
          <Search
            className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search conversations…"
            aria-label="Search conversations"
            className="h-9 pl-8 pr-8"
          />
          {query ? (
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => setQuery("")}
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded-sm p-0.5 text-muted-foreground hover:text-foreground"
            >
              <X className="size-3.5" aria-hidden="true" />
            </button>
          ) : null}
        </div>
      </div>

      <Separator />

      {/* Conversation list */}
      <div
        className={cn(
          "min-h-0 flex-1 overflow-y-auto px-2 py-2",
          // thin custom scrollbar
          "[&::-webkit-scrollbar]:w-2 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-border [&::-webkit-scrollbar-track]:transparent",
          "[scrollbar-width:thin]",
        )}
      >
        {loading ? (
          <div className="space-y-1.5 p-1">
            {Array.from({ length: 5 }).map((_, i) => (
              <div
                key={i}
                className="bg-accent/60 h-12 animate-pulse rounded-md"
                aria-hidden="true"
              />
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 px-4 py-10 text-center">
            <div className="flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
              <MessageSquare className="size-5" aria-hidden="true" />
            </div>
            <p className="text-sm font-medium text-foreground">
              {query ? "No matches found" : "No conversations yet"}
            </p>
            <p className="text-xs text-muted-foreground">
              {query
                ? "Try a different search term."
                : "Start a new chat!"}
            </p>
            {!query ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="mt-1"
                onClick={handleNewChat}
              >
                <Plus className="size-4" aria-hidden="true" />
                New chat
              </Button>
            ) : null}
          </div>
        ) : (
          <ul className="space-y-0.5">
            {filtered.map((conv) => {
              const isActive = conv.id === activeConversationId;
              return (
                <li key={conv.id}>
                  <div
                    role="button"
                    tabIndex={0}
                    onClick={() => handleSelect(conv.id)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        handleSelect(conv.id);
                      }
                    }}
                    aria-current={isActive ? "page" : undefined}
                    className={cn(
                      "group relative flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-2 text-sm transition-colors",
                      "hover:bg-accent hover:text-accent-foreground",
                      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      isActive && "bg-accent text-accent-foreground",
                    )}
                  >
                    <MessageSquare
                      className="size-4 shrink-0 text-muted-foreground"
                      aria-hidden="true"
                    />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium leading-tight">
                        {conv.title}
                      </p>
                      <p className="truncate text-xs text-muted-foreground">
                        {formatDistanceToNow(new Date(conv.updated_at), {
                          addSuffix: true,
                        })}
                      </p>
                    </div>
                    {conv.is_archived ? (
                      <Badge variant="secondary" className="shrink-0 text-[10px]">
                        Archived
                      </Badge>
                    ) : null}
                    {/* Hover actions */}
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          type="button"
                          size="icon"
                          variant="ghost"
                          aria-label="Conversation actions"
                          // Stop click bubbling so the row doesn't select
                          onClick={(e) => e.stopPropagation()}
                          onKeyDown={(e) => e.stopPropagation()}
                          className={cn(
                            "size-7 shrink-0 text-muted-foreground",
                            "opacity-0 group-hover:opacity-100 focus-visible:opacity-100",
                            "data-[state=open]:opacity-100",
                            isActive && "opacity-100",
                          )}
                        >
                          <MoreHorizontal className="size-4" aria-hidden="true" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent
                        align="end"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <DropdownMenuItem onSelect={() => openRename(conv)}>
                          <Pencil className="size-4" aria-hidden="true" />
                          Rename
                        </DropdownMenuItem>
                        <DropdownMenuItem onSelect={() => handleArchive(conv)}>
                          <Archive className="size-4" aria-hidden="true" />
                          {conv.is_archived ? "Unarchive" : "Archive"}
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          variant="destructive"
                          onSelect={() => setDeleting(conv)}
                        >
                          <Trash2 className="size-4" aria-hidden="true" />
                          Delete
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        {/* Hidden retry helper for accessibility — surfaced when refetch fails */}
        <span className="sr-only" aria-live="polite">
          {loading ? "Loading conversations" : `${filtered.length} conversations`}
        </span>
      </div>

      <Separator />

      {/* Footer */}
      <div className="flex items-center gap-2 px-3 py-3">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold text-muted-foreground">
            {user?.email ? user.email.charAt(0).toUpperCase() : "?"}
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-xs font-medium text-foreground">
              {user?.email ?? "Unknown user"}
            </p>
            <p className="truncate text-[11px] text-muted-foreground">
              {user?.full_name ?? "Local account"}
            </p>
          </div>
        </div>
        {onSelectSettings ? (
          <Button
            type="button"
            size="icon"
            variant="ghost"
            aria-label="Settings"
            onClick={onSelectSettings}
          >
            <Settings className="size-4" aria-hidden="true" />
          </Button>
        ) : null}
        <Button
          type="button"
          size="icon"
          variant="ghost"
          aria-label="Log out"
          onClick={async () => {
            try {
              await logout();
              toast.success("Logged out");
            } catch {
              toast.error("Failed to log out");
            }
          }}
        >
          <LogOut className="size-4" aria-hidden="true" />
        </Button>
      </div>

      {/* Hidden refresh action — allow retry via keyboard shortcut for power users */}
      <button
        type="button"
        aria-label="Refresh conversations"
        onClick={() => refetch()}
        className="sr-only"
      >
        Refresh
      </button>

      {/* Rename dialog */}
      <Dialog
        open={renaming !== null}
        onOpenChange={(open) => {
          if (!open) {
            setRenaming(null);
            setRenameValue("");
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rename conversation</DialogTitle>
            <DialogDescription>
              Choose a new title for this conversation. This only affects how it
              appears in your sidebar.
            </DialogDescription>
          </DialogHeader>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              submitRename();
            }}
            className="space-y-3"
          >
            <Input
              autoFocus
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              placeholder="Conversation title"
              aria-label="Conversation title"
              maxLength={120}
            />
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setRenaming(null)}
                disabled={renameBusy}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={renameBusy || !renameValue.trim()}>
                {renameBusy ? "Saving…" : "Save"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Delete confirm */}
      <AlertDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this conversation?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently removes “{deleting?.title}” and all of its
              messages from your local IndexedDB. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteBusy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={(e) => {
                e.preventDefault();
                confirmDelete();
              }}
              disabled={deleteBusy}
            >
              {deleteBusy ? "Deleting…" : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

export default ConversationSidebar;
