// ============================================================================
// Background Task Execution Framework — Prisma client singleton (server).
//
// Standard globalThis-guarded PrismaClient: Next.js dev HMR reloads modules
// on every edit, and an unguarded `new PrismaClient()` per reload exhausts
// SQLite's connection pool ("Too many connections"). The cached instance is
// reused across hot reloads and across every route handler in
// src/app/api/tasks/** (each route gets its own module graph entry otherwise).
//
// NOTE: src/lib/db/** is the CLIENT-side Dexie database — a completely
// different storage layer owned by another task. This file is the only
// server-side Prisma entry point for the task framework.
// ============================================================================

import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as {
  prisma?: PrismaClient;
};

export const prisma: PrismaClient =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: ["error", "warn"],
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
