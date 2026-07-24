/**
 * @deprecated Backendless mode — this file is no longer used.
 *
 * The original `server-api.ts` was a server-side helper that proxied requests
 * from Next.js API routes (`src/app/api/*`) to the FastAPI backend. In
 * backendless mode there is no FastAPI backend and no API routes: every
 * client call goes directly to IndexedDB (Dexie) via the services in
 * `@/lib/services`.
 *
 * This file is kept as an empty stub so that any stray imports don't break
 * the build while the rest of the migration lands. It will be deleted once
 * all API routes have been removed.
 *
 * If you need data, use the client-side services:
 *   import { conversationService, authService, … } from "@/lib/services";
 */
export {};
