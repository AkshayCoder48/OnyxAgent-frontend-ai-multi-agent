import type { Server } from "node:http";

/** Options for startRelayServer (see scripts/ddg-relay.mjs for semantics). */
export interface RelayOptions {
  port?: number;
  host?: string;
  /** Upstream origin; defaults to https://duckduckgo.com. Tests point this at a stub. */
  upstream?: string;
  /** Optional bearer-token shared secret (DDG_RELAY_TOKEN). */
  token?: string;
}

/** Starts the relay and resolves once the listener is ready. */
export function startRelayServer(opts?: RelayOptions): Promise<Server>;
