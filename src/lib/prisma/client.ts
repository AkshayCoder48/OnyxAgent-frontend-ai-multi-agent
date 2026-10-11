import { PrismaClient } from "@prisma/client";

/**
 * Server-side Prisma client (SQLite) — the Prisma REST surface
 * (/api/sync, /api/code/database) uses this. NOTE: the app's canonical
 * client-side data layer is the Dexie db at `src/lib/db/index.ts`
 * (`@/lib/db`); this module exists so SERVER routes that want Prisma have a
 * non-colliding import path (a Prisma stub at `src/lib/db.ts` used to shadow
 * the Dexie db and broke the whole app).
 */
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: ["error", "warn"],
  });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
