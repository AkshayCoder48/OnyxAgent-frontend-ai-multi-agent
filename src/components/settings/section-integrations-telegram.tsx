"use client";

import * as React from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import {
  AtSign,
  Bot,
  CheckCircle2,
  Copy,
  Eye,
  EyeOff,
  ExternalLink,
  Hash,
  KeyRound,
  Loader2,
  MessageCircle,
  MessageSquare,
  Paperclip,
  Plug,
  RefreshCw,
  Send,
  Trash2,
  XCircle,
  Zap,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

import { useAuth, useCopyToClipboard } from "@/hooks";
import { settingsService } from "@/lib/services";
import {
  getTelegramChatStatus,
  telegramChatApi,
  type TelegramChatStatusView,
  type TelegramWebhookStatusInfo,
} from "@/lib/scheduler/telegram-client";
import { ROUTES } from "@/lib/constants";

/**
 * Settings → Integrations → Telegram.
 *
 * The bot token lives in TWO places, both user-owned:
 *  1. the server-side scheduler KV (schedule:telegram) — powers unattended
 *     scheduled-run notifications + REMOTE CHAT (the webhook) + the
 *     sandbox-native telegram tools;
 *  2. the LOCAL encrypted vault (settingsService) — powers the in-browser
 *     telegram agent tools.
 * The token is typed into the connect dialog, sent once, stored encrypted,
 * and cleared from the form — it is never rendered or logged.
 *
 * REMOTE CHAT (unified-3b): with the bot connected + chat discovered,
 * "Enable chat" registers a webhook (secret token) on the bot. A Telegram
 * message then runs through the SAME agent runtime (E2B sandbox, workspace,
 * tools) and the response streams back into Telegram; the conversation also
 * lands in the linked OnyxAgent chat. The webhook secret is generated
 * server-side and never leaves the KV + Telegram's webhook registration.
 */

function formatSince(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "—";
    return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  } catch {
    return "—";
  }
}

export function SectionIntegrationsTelegram() {
  const t = useTranslations("telegram");
  // useAuth (not the raw store) — its mount effect runs authStore.init(),
  // which rehydrates the real user + vault on a cold direct navigation to
  // /settings/integrations (same auth-hydration race as Cloud Workspace).
  const { user } = useAuth();
  const userId = user?.id;

  const [status, setStatus] = React.useState<TelegramChatStatusView | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [notConfigured, setNotConfigured] = React.useState(false);

  // Connect dialog state — the token is TRANSIENT: typed, submitted once,
  // stored encrypted, then wiped from the form. Never rendered (password
  // field) and never logged.
  const [connectOpen, setConnectOpen] = React.useState(false);
  const [token, setToken] = React.useState("");
  const [showToken, setShowToken] = React.useState(false);
  const [connecting, setConnecting] = React.useState(false);

  const [testing, setTesting] = React.useState(false);
  const [discovering, setDiscovering] = React.useState(false);
  const [disconnectOpen, setDisconnectOpen] = React.useState(false);

  // Remote chat (unified-3b) state.
  const [enablingChat, setEnablingChat] = React.useState(false);
  const [disablingChat, setDisablingChat] = React.useState(false);
  const [disableChatOpen, setDisableChatOpen] = React.useState(false);
  const [webhookInfo, setWebhookInfo] = React.useState<TelegramWebhookStatusInfo | null>(null);
  const [checkingWebhook, setCheckingWebhook] = React.useState(false);
  // "Mirror web runs to Telegram" — a LOCAL vault flag (the runtime source of
  // truth; the KV config's mirrorRuns copy is informational only).
  const [mirror, setMirror] = React.useState(false);
  const [mirrorLoading, setMirrorLoading] = React.useState(true);

  const { copy, copied } = useCopyToClipboard();

  const refresh = React.useCallback(async () => {
    if (!userId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const res = await getTelegramChatStatus(userId);
      if (res.error === "NOT_CONFIGURED") {
        setNotConfigured(true);
        setStatus(null);
      } else if (res.ok) {
        setNotConfigured(false);
        setStatus((res.telegram as TelegramChatStatusView | undefined) ?? null);
      }
    } finally {
      setLoading(false);
    }
  }, [userId]);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  // Load the mirror flag from the local vault (defaults off).
  React.useEffect(() => {
    if (!userId) {
      setMirrorLoading(false);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const v = await settingsService.getTelegramMirrorEnabled(userId);
        if (!cancelled) setMirror(v);
      } catch {
        /* stays off */
      } finally {
        if (!cancelled) setMirrorLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [userId]);

  const chatEnabled = !!status?.chatEnabled;
  const webhookUrl = status?.webhookUrl ?? null;
  const providerModel = status?.providerModel ?? null;

  async function handleConnect(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = token.trim();
    if (!trimmed) {
      toast.error("Paste the bot token from @BotFather first");
      return;
    }
    if (!userId) {
      toast.error("Sign in first");
      return;
    }
    setConnecting(true);
    try {
      const res = await telegramChatApi(userId, "connect", { botToken: trimmed });
      if (!res.ok) {
        toast.error(res.message ?? "Telegram rejected the token", {
          icon: <XCircle className="size-4" />,
        });
        return;
      }
      // Mirror the token into the LOCAL encrypted vault so the in-browser
      // telegram agent tools work too (server copy powers unattended runs).
      try {
        await settingsService.setTelegramBotToken(userId, trimmed);
      } catch {
        toast("Stored server-side; the local vault copy failed", {
          description: "Reconnect later to enable in-browser telegram tools.",
        });
      }
      setToken(""); // wipe — transient by contract
      setConnectOpen(false);
      setStatus((res.telegram as TelegramChatStatusView | undefined) ?? null);
      toast.success("Telegram bot connected", {
        description: res.message ?? "Now send /start to your bot and press Discover Chat.",
        icon: <CheckCircle2 className="size-4" />,
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Connection failed");
    } finally {
      setConnecting(false);
    }
  }

  async function handleDiscover() {
    if (!userId) return;
    setDiscovering(true);
    try {
      const res = await telegramChatApi(userId, "discover", {});
      if (!res.ok) {
        toast.error(res.message ?? "No chat found", {
          description: "Send /start to your bot in Telegram first, then try again.",
          icon: <XCircle className="size-4" />,
        });
        return;
      }
      const tg = (res.telegram as TelegramChatStatusView | undefined) ?? null;
      // Mirror the chat id into the local vault (plain — ids aren't secrets).
      if (userId && tg?.chatId) {
        try {
          await settingsService.setTelegramChatId(userId, tg.chatId);
        } catch {
          /* best-effort — the server copy is authoritative */
        }
      }
      setStatus(tg);
      toast.success("Chat discovered", {
        description: res.message ?? "Telegram notifications are ready.",
        icon: <CheckCircle2 className="size-4" />,
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Discovery failed");
    } finally {
      setDiscovering(false);
    }
  }

  async function handleTest() {
    if (!userId) return;
    setTesting(true);
    try {
      const res = await telegramChatApi(userId, "test", {});
      if (!res.ok) {
        toast.error(res.message ?? "Test message failed", { icon: <XCircle className="size-4" /> });
        return;
      }
      toast.success("Test message sent", {
        description: "Check your Telegram — scheduled results will arrive there.",
        icon: <CheckCircle2 className="size-4" />,
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Test failed");
    } finally {
      setTesting(false);
    }
  }

  // ── Remote chat (unified-3b) ──────────────────────────────────────────────

  async function handleEnableChat() {
    if (!userId) return;
    setEnablingChat(true);
    try {
      // Provider snapshot resolved CLIENT-side (the same resolution the
      // scheduled-tasks create flow uses — never model-visible).
      const { resolveProviderSnapshot } = await import("@/lib/scheduler/client");
      const provider = await resolveProviderSnapshot();
      if (!provider) {
        toast("No AI provider/model is configured", {
          description:
            "Telegram replies will show a configuration warning until you re-enable chat with a provider selected.",
          icon: <XCircle className="size-4" />,
        });
      }
      const res = await telegramChatApi(userId, "enable_chat", { provider, mirrorRuns: mirror });
      if (!res.ok) {
        toast.error(res.message ?? "Failed to enable remote chat", {
          icon: <XCircle className="size-4" />,
        });
        return;
      }
      await refresh();
      toast.success("Telegram remote chat enabled", {
        description:
          res.webhookUrl ? `Webhook: ${res.webhookUrl}` : (res.message ?? "Send your bot a message in Telegram."),
        icon: <CheckCircle2 className="size-4" />,
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to enable remote chat");
    } finally {
      setEnablingChat(false);
    }
  }

  async function handleDisableChat() {
    if (!userId) return;
    setDisablingChat(true);
    try {
      const res = await telegramChatApi(userId, "disable_chat", {});
      if (!res.ok) {
        toast.error(res.message ?? "Failed to disable remote chat");
        return;
      }
      if (res.warning) {
        toast(res.warning, { icon: <XCircle className="size-4" /> });
      }
      setWebhookInfo(null);
      await refresh();
      toast.success("Remote chat disabled", {
        description: "Your bot no longer launches agent runs from Telegram.",
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to disable remote chat");
    } finally {
      setDisablingChat(false);
      setDisableChatOpen(false);
    }
  }

  async function handleWebhookStatus() {
    if (!userId) return;
    setCheckingWebhook(true);
    try {
      const res = await telegramChatApi(userId, "webhook_status", {});
      if (!res.ok || !res.info) {
        toast.error(res.message ?? "Could not read the webhook status");
        return;
      }
      setWebhookInfo(res.info);
      if (res.info.lastErrorMessage) {
        toast("Telegram reported a delivery problem", {
          description: res.info.lastErrorMessage,
          icon: <XCircle className="size-4" />,
        });
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not read the webhook status");
    } finally {
      setCheckingWebhook(false);
    }
  }

  async function handleMirrorToggle(next: boolean) {
    if (!userId || mirrorLoading) return;
    setMirror(next); // optimistic
    try {
      await settingsService.setTelegramMirrorEnabled(userId, next);
      toast.success(next ? "Web-app runs will stream to Telegram" : "Web-app run mirroring turned off");
    } catch {
      setMirror(!next); // revert
      toast.error("Could not save the mirror setting");
    }
  }

  async function handleDisconnect() {
    if (!userId) return;
    try {
      const res = await telegramChatApi(userId, "disconnect", {});
      if (!res.ok) {
        toast.error(res.message ?? "Disconnect failed");
        return;
      }
      // Clear the LOCAL vault copies (token + chat id) as well.
      try {
        await settingsService.setTelegramBotToken(userId, null);
        await settingsService.setTelegramChatId(userId, null);
      } catch {
        /* best-effort */
      }
      setStatus(null);
      setWebhookInfo(null);
      toast.success("Telegram disconnected", {
        description: "Remote chat is off and scheduled tasks no longer send Telegram notifications.",
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Disconnect failed");
    } finally {
      setDisconnectOpen(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  // ── OnyxBase key missing → the telegram route can't even authenticate.
  if (notConfigured) {
    return (
      <Alert>
        <KeyRound className="size-4" />
        <AlertTitle>Connect your OnyxBase key first</AlertTitle>
        <AlertDescription>
          Telegram integration (and scheduled tasks) live in your OnyxBase KV account. Add the
          API key in{" "}
          <Link
            href={ROUTES.SETTINGS_CLOUD}
            className="font-medium underline underline-offset-2"
          >
            Settings → Cloud Workspace
          </Link>{" "}
          and return here.
        </AlertDescription>
      </Alert>
    );
  }

  // ── Not connected: hero CTA + step guide.
  if (!status?.connected) {
    return (
      <div className="space-y-6">
        <Alert>
          <Plug className="size-4" />
          <AlertTitle>Telegram delivery for your agent</AlertTitle>
          <AlertDescription>
            Connect a Telegram bot and scheduled-task results (plus anything the agent sends with
            the telegram tools) arrive right in your chat — the run finishes, you get the message.
          </AlertDescription>
        </Alert>

        <div className="space-y-3">
          <ol className="space-y-2.5 text-[13px] leading-relaxed text-foreground/80">
            <li className="flex gap-2.5">
              <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-primary/10 font-mono text-[11px] font-semibold text-primary">
                1
              </span>
              <span>
                In Telegram, message{" "}
                <a
                  href="https://t.me/BotFather"
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-0.5 font-medium text-primary underline underline-offset-2"
                >
                  @BotFather
                  <ExternalLink className="size-3" />
                </a>{" "}
                <code className="rounded bg-muted px-1 font-mono text-[12px]">/newbot</code> and
                follow the prompts.
              </span>
            </li>
            <li className="flex gap-2.5">
              <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-primary/10 font-mono text-[11px] font-semibold text-primary">
                2
              </span>
              <span>Paste the token BotFather gives you below.</span>
            </li>
            <li className="flex gap-2.5">
              <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-primary/10 font-mono text-[11px] font-semibold text-primary">
                3
              </span>
              <span>
                Send <code className="rounded bg-muted px-1 font-mono text-[12px]">/start</code> to
                your new bot in Telegram (it cannot message you first).
              </span>
            </li>
            <li className="flex gap-2.5">
              <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-primary/10 font-mono text-[11px] font-semibold text-primary">
                4
              </span>
              <span>Press “Discover Chat” to link your chat.</span>
            </li>
          </ol>

          <Button type="button" size="sm" onClick={() => setConnectOpen(true)} className="h-11">
            <Plug className="size-4" />
            {t("connect")}
          </Button>
        </div>

        {/* Connect dialog — token is password-masked + wiped after submit */}
        <Dialog open={connectOpen} onOpenChange={setConnectOpen}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle className="font-display tracking-tight">Connect Telegram bot</DialogTitle>
              <DialogDescription>
                Paste the token from{" "}
                <a
                  href="https://t.me/BotFather"
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-0.5 font-medium text-primary underline underline-offset-2"
                >
                  @BotFather
                  <ExternalLink className="size-3" />
                </a>
                . It is stored encrypted — the agent never sees it.
              </DialogDescription>
            </DialogHeader>
            <form onSubmit={handleConnect} className="space-y-3">
              <div className="space-y-2">
                <Label htmlFor="tg-bot-token">Bot token</Label>
                <div className="relative">
                  <Bot className="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    id="tg-bot-token"
                    type={showToken ? "text" : "password"}
                    value={token}
                    onChange={(e) => setToken(e.target.value)}
                    placeholder="123456789:AAE…"
                    autoComplete="off"
                    spellCheck={false}
                    className="pr-10 pl-9 font-mono"
                  />
                  <button
                    type="button"
                    onClick={() => setShowToken((s) => !s)}
                    className="absolute top-1/2 right-2 -translate-y-1/2 rounded-md p-1 text-muted-foreground transition-colors hover:text-foreground"
                    aria-label={showToken ? "Hide token" : "Show token"}
                  >
                    {showToken ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                  </button>
                </div>
                <p className="text-xs text-muted-foreground">
                  Validated live via Telegram&apos;s getMe — invalid tokens are rejected immediately.
                </p>
              </div>
              <DialogFooter className="gap-2">
                <Button type="button" variant="outline" onClick={() => setConnectOpen(false)} className="h-11">
                  Cancel
                </Button>
                <Button type="submit" disabled={connecting} className="h-11">
                  {connecting ? <Loader2 className="size-4 animate-spin" /> : <Plug className="size-4" />}
                  {t("connectAction")}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      </div>
    );
  }

  // ── Connected: identity tiles + remote chat + actions.
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="rounded-lg border bg-muted/30 p-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-muted-foreground">Bot</span>
            <Badge variant="secondary" className="gap-1">
              <CheckCircle2 className="size-3 text-emerald-500" />
              Connected
            </Badge>
          </div>
          <p className="mt-1 flex items-center gap-1.5 text-sm font-medium">
            <Bot className="size-4 text-primary/70" aria-hidden />
            {status.botName ?? "Your bot"}
          </p>
          {status.botUsername && (
            <a
              href={`https://t.me/${status.botUsername}`}
              target="_blank"
              rel="noreferrer"
              className="mt-0.5 inline-flex items-center gap-0.5 text-xs text-primary underline underline-offset-2"
            >
              <AtSign className="size-3" aria-hidden />
              {status.botUsername}
            </a>
          )}
          <p className="mt-1 text-xs text-muted-foreground">
            Connected {formatSince(status.connectedAt)} · token stored encrypted, never shown.
          </p>
        </div>

        <div className="rounded-lg border bg-muted/30 p-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-muted-foreground">Chat</span>
            {status.chatId ? (
              <Badge variant="outline" className="gap-1">
                <MessageCircle className="size-3" />
                {status.chatName ?? "Private chat"}
              </Badge>
            ) : (
              <Badge variant="outline" className="gap-1 text-amber-600 dark:text-amber-400">
                <Paperclip className="size-3" />
                Not discovered
              </Badge>
            )}
          </div>
          {status.chatId ? (
            <p className="mt-1 flex items-center gap-1.5 font-mono text-sm">
              <Hash className="size-3.5 text-muted-foreground" aria-hidden />
              {status.chatId}
            </p>
          ) : (
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              Send /start to your bot in Telegram, then press Discover Chat to link it.
            </p>
          )}
        </div>
      </div>

      {/* ── Remote chat (unified-3b): Telegram as a real agent chat client ── */}
      {status.chatId && (
        <div className="rounded-lg border bg-muted/20 p-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h4 className="flex items-center gap-1.5 text-sm font-semibold">
                <MessageSquare className="size-4 text-primary/70" aria-hidden />
                Remote chat
              </h4>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                Chat with your agent directly in Telegram — full agent runtime, E2B sandbox,
                workspace, tools; conversations appear in your chat list.
              </p>
            </div>
            {chatEnabled ? (
              <Badge className="gap-1 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400" variant="secondary">
                <CheckCircle2 className="size-3" aria-hidden />
                Enabled
              </Badge>
            ) : (
              <Badge variant="outline" className="gap-1 shrink-0 text-muted-foreground">
                Off
              </Badge>
            )}
          </div>

          {!chatEnabled ? (
            <div className="mt-3 space-y-2">
              <Button
                type="button"
                size="sm"
                onClick={handleEnableChat}
                disabled={enablingChat}
                className="h-11"
              >
                {enablingChat ? <Loader2 className="size-4 animate-spin" /> : <Zap className="size-4" />}
                Enable chat
              </Button>
              <p className="text-xs leading-relaxed text-muted-foreground">
                Enabling registers a webhook on your bot (Telegram requires a public HTTPS URL —
                enable this from the deployed site, not localhost) and stores your currently
                selected provider + model for unattended replies.
              </p>
            </div>
          ) : (
            <div className="mt-3 space-y-3">
              <div className="space-y-1.5">
                <span className="text-xs font-medium text-muted-foreground">Webhook URL</span>
                <div className="flex items-center gap-2">
                  <code className="min-w-0 flex-1 truncate rounded bg-muted px-2 py-2 font-mono text-[12px]">
                    {webhookUrl ?? "—"}
                  </code>
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    onClick={() => webhookUrl && void copy(webhookUrl)}
                    disabled={!webhookUrl}
                    className="size-11 shrink-0"
                    aria-label="Copy webhook URL"
                  >
                    {copied ? (
                      <CheckCircle2 className="size-4 text-emerald-500" />
                    ) : (
                      <Copy className="size-4" />
                    )}
                  </Button>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                {status.botUsername && (
                  <a
                    href={`https://t.me/${status.botUsername}`}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-0.5 rounded-md border border-border px-2 py-1 text-xs text-primary underline underline-offset-2"
                  >
                    <AtSign className="size-3" aria-hidden />
                    {status.botUsername}
                  </a>
                )}
                {providerModel ? (
                  <Badge variant="secondary" className="gap-1.5 font-mono text-[11px]">
                    <Bot className="size-3" aria-hidden />
                    {providerModel}
                  </Badge>
                ) : (
                  <Badge variant="outline" className="gap-1 text-amber-600 dark:text-amber-400">
                    <XCircle className="size-3" aria-hidden />
                    No provider
                  </Badge>
                )}
                <span className="text-xs text-muted-foreground">
                  Enabled {formatSince(status.enabledAt)}
                </span>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs text-muted-foreground">
                  Pending updates:{" "}
                  {webhookInfo ? <span className="font-mono">{webhookInfo.pendingUpdateCount}</span> : "—"}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={handleWebhookStatus}
                  disabled={checkingWebhook}
                  className="size-11"
                  aria-label="Refresh webhook status"
                  title="Refresh pending updates from Telegram"
                >
                  {checkingWebhook ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <RefreshCw className="size-4" />
                  )}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setDisableChatOpen(true)}
                  className="h-11 text-destructive hover:text-destructive"
                >
                  <Trash2 className="size-4" />
                  Disable chat
                </Button>
              </div>
              {webhookInfo?.lastErrorMessage && (
                <p className="text-xs leading-relaxed text-amber-600 dark:text-amber-400">
                  Telegram delivery problem: {webhookInfo.lastErrorMessage}
                </p>
              )}
            </div>
          )}

          {/* Mirror web runs — local vault flag, the runtime source of truth */}
          <div className="mt-4 flex items-center justify-between gap-4 border-t pt-3">
            <div className="min-w-0">
              <p className="text-sm font-medium">Mirror web runs</p>
              <p className="text-xs leading-relaxed text-muted-foreground">
                Also stream web-app runs to Telegram — progress and results from chats you start
                in the app appear in this Telegram chat too.
              </p>
            </div>
            <Switch
              checked={mirror}
              onCheckedChange={(v) => void handleMirrorToggle(v)}
              disabled={mirrorLoading}
              aria-label="Mirror web-app runs to Telegram"
            />
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={handleTest}
          disabled={testing || !status.chatId}
          className="h-11 min-w-[44px]"
        >
          {testing ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
          {t("test")}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={handleDiscover}
          disabled={discovering || chatEnabled}
          className="h-11 min-w-[44px]"
          title={
            chatEnabled
              ? "Discover is unavailable while remote chat is enabled — Telegram routes updates to the webhook"
              : undefined
          }
        >
          {discovering ? <Loader2 className="size-4 animate-spin" /> : <MessageCircle className="size-4" />}
          {t("discover")}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => setDisconnectOpen(true)}
          className="h-11 min-w-[44px] text-destructive hover:text-destructive"
        >
          <Trash2 className="size-4" />
          {t("disconnect")}
        </Button>
      </div>

      {chatEnabled && (
        <p className="text-xs text-amber-600 dark:text-amber-400">
          Discover Chat is unavailable while remote chat is enabled — Telegram routes updates to
          the webhook instead of getUpdates. Disable chat first if you need to re-discover.
        </p>
      )}

      <p className="text-xs text-muted-foreground">
        Scheduled tasks deliver their results to this chat after every run; the agent can also send
        messages and files through the telegram tools. Disconnecting disables remote chat and
        clears the stored token and chat link everywhere (server KV + this browser&apos;s vault).
      </p>

      {/* Disable-chat confirmation */}
      <AlertDialog open={disableChatOpen} onOpenChange={setDisableChatOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Disable remote chat?</AlertDialogTitle>
            <AlertDialogDescription>
              Your bot stops launching agent runs from Telegram and the webhook is removed. The
              bot connection, discovered chat and scheduled-task notifications stay — you can
              enable chat again anytime.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDisableChat}
              disabled={disablingChat}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {disablingChat ? <Loader2 className="size-4 animate-spin" /> : null}
              Disable chat
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Disconnect confirmation */}
      <AlertDialog open={disconnectOpen} onOpenChange={setDisconnectOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Disconnect Telegram?</AlertDialogTitle>
            <AlertDialogDescription>
              Remote chat is disabled, scheduled tasks stop sending Telegram notifications and the
              agent&apos;s telegram tools stop working until you reconnect. Existing tasks and
              history are untouched.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDisconnect}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Disconnect
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
