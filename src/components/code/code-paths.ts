import type { CodeTab } from "@/components/terra/types";

/**
 * URL for each OnyxCode tab. The route is the source of truth for the active
 * tab while on /code* — the shared store mirrors it so the sidebar, tool
 * cards and settings all observe one truth.
 */
export const CODE_TAB_PATHS: Record<CodeTab, string> = {
  chat: "/code",
  database: "/code/database",
  preview: "/code/preview",
};

/** Map a pathname onto the OnyxCode tab it represents. */
export function tabFromPathname(pathname: string | null | undefined): CodeTab {
  if (pathname === "/code/database") return "database";
  if (pathname === "/code/preview") return "preview";
  return "chat";
}
