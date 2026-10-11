"use client";

/**
 * Pollinations store — the single client-side source of truth for the
 * integration: connection (BYOP key, vault-encrypted at rest), live model
 * catalogue, per-modality defaults, generation prefs, generation jobs,
 * activity log, and the pending two-step confirmation payload the chat UI
 * renders.
 *
 * Persistence goes through the app's existing settings architecture
 * (settingsService → Dexie `user_settings.extra` + the crypto vault):
 *   pollinations_api_key_encrypted  (vault)   the user's scoped key
 *   pollinations_meta               (extra)   method/expiry/scope/profile
 *   pollinations_defaults           (extra)   per-modality default model ids
 *   pollinations_prefs              (extra)   generation preferences
 *   pollinations_activity_log       (extra)   capped activity history
 */
import { create } from "zustand";
import { nanoid } from "nanoid";
import { settingsService } from "@/lib/services";
import {
  accountCall,
  fetchPollinationsModels,
  PollinationsApiError,
  type BalanceResult,
} from "./api";
import {
  DEFAULT_PREFS,
  type ActivityLogEntry,
  type ConfirmAction,
  type ConfirmRequestPayload,
  type ConnectionStatus,
  type GenerationJob,
  type ModalityKey,
  type PollenBalance,
  type PollinationsConnectionMeta,
  type PollinationsModel,
  type PollinationsPrefs,
} from "./types";

const MAX_JOBS = 50;
const MAX_LOG = 200;

interface PollinationsState {
  /** Active user (set via init — the same id the tool context carries). */
  userId: string | null;
  /** True once init() has completed (prevents flicker on boot). */
  initialized: boolean;

  // Connection
  connectionStatus: ConnectionStatus;
  connectionMeta: PollinationsConnectionMeta | null;
  /** Decrypted BYOP key — in-memory only (vault-encrypted at rest). */
  token: string | null;

  // Pollen balance
  balance: PollenBalance | null;
  balanceError: string | null;
  balanceLoading: boolean;

  // Live catalogue (always refetched — never trust a stale list)
  models: PollinationsModel[];
  modelsLoading: boolean;
  modelsError: string | null;
  modelsFetchedAt: string | null;

  // Defaults + prefs (persisted)
  defaults: Partial<Record<ModalityKey, string>>;
  prefs: PollinationsPrefs;

  // Jobs + activity log
  jobs: GenerationJob[];
  activityLog: ActivityLogEntry[];

  // Two-step confirmation (tool ⇄ dialog)
  pendingConfirmation: ConfirmRequestPayload | null;

  // Actions
  init: (userId: string) => Promise<void>;
  connect: (token: string, meta: PollinationsConnectionMeta) => Promise<void>;
  disconnect: () => Promise<void>;
  getToken: () => string | null;
  refreshBalance: () => Promise<void>;
  refreshModels: () => Promise<PollinationsModel[]>;
  setDefaultModel: (modality: ModalityKey, modelId: string, opts?: { persist?: boolean }) => Promise<void>;
  setPrefs: (patch: Partial<PollinationsPrefs>) => Promise<void>;
  logActivity: (entry: Omit<ActivityLogEntry, "id" | "ts">) => Promise<void>;
  createJob: (job: Omit<GenerationJob, "id" | "createdAt" | "status"> & { status?: GenerationJob["status"] }) => string;
  updateJob: (id: string, patch: Partial<GenerationJob>) => void;
  getJob: (id: string) => GenerationJob | null;
  setPendingConfirmation: (payload: ConfirmRequestPayload | null) => void;
}

export const usePollinationsStore = create<PollinationsState>((set, get) => ({
  userId: null,
  initialized: false,

  connectionStatus: "checking",
  connectionMeta: null,
  token: null,

  balance: null,
  balanceError: null,
  balanceLoading: false,

  models: [],
  modelsLoading: false,
  modelsError: null,
  modelsFetchedAt: null,

  defaults: {},
  prefs: { ...DEFAULT_PREFS },

  jobs: [],
  activityLog: [],

  pendingConfirmation: null,

  init: async (userId) => {
    if (get().userId === userId && get().initialized) return;
    set({ userId, initialized: true });
    try {
      const [{ token, meta }, config] = await Promise.all([
        settingsService.getPollinationsConnection(userId),
        settingsService.getPollinationsConfig(userId),
      ]);
      const expired =
        !!meta?.expiresAt && new Date(meta.expiresAt).getTime() <= Date.now();
      set({
        connectionStatus: token ? (expired ? "expired" : "connected") : "disconnected",
        connectionMeta: meta,
        token,
        defaults: (config.defaults ?? {}) as Partial<Record<ModalityKey, string>>,
        prefs: { ...DEFAULT_PREFS, ...(config.prefs as Partial<PollinationsPrefs> | undefined) },
        activityLog: (Array.isArray(config.activityLog) ? config.activityLog : []) as ActivityLogEntry[],
      });
      if (token && !expired) {
        void get().refreshBalance();
      }
    } catch {
      set({ connectionStatus: "disconnected" });
    }
  },

  connect: async (token, meta) => {
    const userId = get().userId;
    if (userId) {
      await settingsService.setPollinationsConnection(userId, token, meta);
    }
    set({ connectionStatus: "connected", connectionMeta: meta, token, balanceError: null });
    void get().refreshBalance();
  },

  disconnect: async () => {
    const userId = get().userId;
    if (userId) {
      await settingsService.clearPollinationsConnection(userId).catch(() => {});
    }
    set({
      connectionStatus: "disconnected",
      connectionMeta: null,
      token: null,
      balance: null,
      balanceError: null,
    });
  },

  getToken: () => get().token,

  refreshBalance: async () => {
    const { token, balanceLoading } = get();
    if (!token || balanceLoading) return;
    set({ balanceLoading: true, balanceError: null });
    try {
      const result: BalanceResult = await accountCall<BalanceResult>(token, "/account/balance");
      set({
        balance: {
          balance: typeof result.balance === "number" ? result.balance : Number(result.balance) || 0,
          accountBalance: result.accountBalance,
          checkedAt: new Date().toISOString(),
          source: "provider",
        },
        balanceLoading: false,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set({
        balanceLoading: false,
        balanceError:
          err instanceof PollinationsApiError && err.status === 403
            ? "The connected key lacks the usage scope — reconnect with usage access to see the balance."
            : message,
      });
    }
  },

  refreshModels: async () => {
    set({ modelsLoading: true, modelsError: null });
    try {
      const models = await fetchPollinationsModels();
      set({ models, modelsLoading: false, modelsFetchedAt: new Date().toISOString() });
      return models;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set({ modelsLoading: false, modelsError: message });
      return get().models;
    }
  },

  setDefaultModel: async (modality, modelId, opts) => {
    const persist = opts?.persist !== false;
    const userId = get().userId;
    const defaults = { ...get().defaults, [modality]: modelId };
    set({ defaults });
    if (persist && userId) {
      await settingsService
        .setPollinationsValue(userId, "pollinations_defaults", defaults)
        .catch(() => {});
    }
  },

  setPrefs: async (patch) => {
    const userId = get().userId;
    const prefs = { ...get().prefs, ...patch };
    set({ prefs });
    if (userId) {
      await settingsService.setPollinationsValue(userId, "pollinations_prefs", prefs).catch(() => {});
    }
  },

  logActivity: async (entry) => {
    const userId = get().userId;
    const logEntry: ActivityLogEntry = { ...entry, id: nanoid(10), ts: new Date().toISOString() };
    const activityLog = [logEntry, ...get().activityLog].slice(0, MAX_LOG);
    set({ activityLog });
    if (userId) {
      await settingsService.setPollinationsValue(userId, "pollinations_activity_log", activityLog).catch(() => {});
    }
  },

  createJob: (job) => {
    const id = `job_${nanoid(10)}`;
    const full: GenerationJob = { ...job, id, createdAt: new Date().toISOString(), status: job.status ?? "running" };
    set({ jobs: [full, ...get().jobs].slice(0, MAX_JOBS) });
    return id;
  },

  updateJob: (id, patch) => {
    set({
      jobs: get().jobs.map((j) => (j.id === id ? { ...j, ...patch } : j)),
    });
  },

  getJob: (id) => get().jobs.find((j) => j.id === id) ?? null,

  setPendingConfirmation: (payload) => set({ pendingConfirmation: payload }),
}));

/** Dispatch a confirmation response back to the waiting tool (CustomEvent —
 *  the exact mechanism ask_user uses). */
export function respondToPollinationsConfirm(action: ConfirmAction): void {
  window.dispatchEvent(new CustomEvent("pollinations:confirm-response", { detail: action }));
}

// Dev-only debugging handle — lets the browser console drive the exact same
// store the media_generation tool uses (e.g. to demo/verify the confirmation
// dialog): `__pollinations.getState().setPendingConfirmation(payload)`.
// Compiled out of production builds by the env check.
declare global {
  interface Window {
    __pollinations?: typeof usePollinationsStore;
  }
}
if (typeof window !== "undefined" && process.env.NODE_ENV !== "production") {
  window.__pollinations = usePollinationsStore;
}
