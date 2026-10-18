"use client";

/**
 * Default skill-repositories + MCP-Market catalog (Skills PRD).
 *
 * A STATIC, always-available registry of:
 *   1. The default skill repositories — GitHub repos the agent can pull
 *      additional SKILL.md skills from on demand. Two kinds:
 *        - "skill-collection": repos that contain SKILL.md folders. Indexed
 *          metadata-first (name + one-liner per skill); the full instructions
 *          are fetched ONLY when a task actually needs that skill
 *          (`manage_skill` catalog → install_from_repository → read).
 *        - "npm-cli": repos that are CLI tools, not SKILL.md collections —
 *          they are installed and run INSIDE the E2B sandbox via
 *          `run_terminal` when a task needs them (never via manage_skill).
 *   2. The MCP-Market catalog — curated MCPMarket servers. Entries carry the
 *      marketplace page URL; the agent fetches that page (`web_fetch`) for
 *      the exact connection details and then wires the server per the MCP
 *      decision order (remote HTTP/SSE → `manage_mcp` create; stdio/npm →
 *          MCP client script inside the sandbox).
 *
 * This registry is surfaced through `analyze_workspace` (the skill-repository
 * index the PRD requires) and the `manage_skill` "catalog" action. It is pure
 * static data — zero round trips, safe to include in every workspace scan.
 */

// ---------------------------------------------------------------------------
// Skill repositories.
// ---------------------------------------------------------------------------

export type RepositoryKind = "skill-collection" | "npm-cli";

/** Metadata-only entry for one skill inside a repository. */
export interface RepoSkillMeta {
  /** Skill name (kebab-case — the name it installs under). */
  name: string;
  /** One-line description (from the skill's front-matter / the PRD). */
  description: string;
  /** Repo-relative directory containing the SKILL.md ("" = repo root). */
  dir: string;
}

/** How to install + run an npm-cli repository inside the E2B sandbox. */
export interface SandboxUsage {
  /** Install commands (run inside the sandbox via run_terminal). */
  install: string;
  /** How to invoke once installed. */
  run: string;
  /** A concrete example invocation. */
  example?: string;
  /** Security / correctness requirement from the PRD. */
  caution?: string;
}

export interface SkillRepository {
  /** Stable id used by manage_skill (repository parameter). */
  id: string;
  /** Display name. */
  name: string;
  kind: RepositoryKind;
  owner: string;
  repo: string;
  /** Subdirectory holding the skills ("" = whole repo). */
  subpath: string;
  /** Fallback branch when the GitHub API default-branch lookup fails. */
  branch?: string;
  /** Public repository URL. */
  url: string;
  description: string;
  /** Static per-skill metadata index. [] → browse live with GitHub. */
  skills: RepoSkillMeta[];
  /** Present only for npm-cli repositories. */
  sandboxUsage?: SandboxUsage;
}

const addhumanitySkills: RepoSkillMeta[] = [
  { name: "doubt", description: "Companion guidance for working through persistent self-doubt.", dir: "doubt" },
  { name: "anxiety", description: "Grounding techniques and support framing for anxious states.", dir: "anxiety" },
  { name: "psychotic-decompensation", description: "Calm, safe-response guidance for acute distress episodes.", dir: "psychotic-decompensation" },
  { name: "2-beers", description: "Honest-talk framing for tipsy late-night conversations.", dir: "2-beers" },
  { name: "paranoia", description: "Reality-anchoring support for paranoid thinking.", dir: "paranoia" },
  { name: "melancholy", description: "Gentle presence and reflection for melancholic moods.", dir: "melancholy" },
  { name: "insomnia", description: "Wind-down and sleep-hygiene companion guidance.", dir: "insomnia" },
  { name: "impostor-syndrome", description: "Evidence-based reframing for impostor feelings.", dir: "impostor-syndrome" },
  { name: "fury", description: "De-escalation and venting structure for anger.", dir: "fury" },
  { name: "dissociation", description: "Reconnection and grounding for dissociative moments.", dir: "dissociation" },
];

const threejsSkills: RepoSkillMeta[] = [
  { name: "threejs-game-director", description: "Game design direction: scope, loop, pillars for Three.js games.", dir: "threejs-game-director" },
  { name: "threejs-gameplay-systems", description: "Gameplay systems: input, physics, state machines, game loops.", dir: "threejs-gameplay-systems" },
  { name: "threejs-aaa-graphics-builder", description: "High-end rendering: materials, lighting, post-processing pipelines.", dir: "threejs-aaa-graphics-builder" },
  { name: "threejs-game-ui-designer", description: "In-game UI/HUD design systems for Three.js projects.", dir: "threejs-game-ui-designer" },
  { name: "threejs-debug-profiler", description: "Debugging and profiling Three.js scenes (draw calls, memory, FPS).", dir: "threejs-debug-profiler" },
  { name: "threejs-qa-release", description: "QA passes and release readiness checklists for Three.js games.", dir: "threejs-qa-release" },
  { name: "threejs-3d-generator", description: "Procedural 3D asset and scene generation workflows.", dir: "threejs-3d-generator" },
  { name: "threejs-image-generator", description: "Texture and concept image generation workflows for 3D projects.", dir: "threejs-image-generator" },
  { name: "threejs-audio-generator", description: "Sound and music generation pipelines for games.", dir: "threejs-audio-generator" },
];

export const SKILL_REPOSITORIES: readonly SkillRepository[] = [
  {
    id: "api-anything",
    name: "API Anything",
    kind: "npm-cli",
    owner: "goodnight000",
    repo: "api-anything",
    subpath: "",
    url: "https://github.com/goodnight000/api-anything",
    description:
      "CLI that calls any REST API through service/action identifiers (Hacker News, search APIs, and many more).",
    skills: [],
    sandboxUsage: {
      install:
        'git clone https://github.com/goodnight000/api-anything.git && cd api-anything && npm ci && npm install -g "$(npm pack --silent)"',
      run: "api-anything call <service> <action> [key=value ...]",
      example: "api-anything call hacker-news search query=sqlite",
      caution:
        "Discover the EXACT service and action identifiers before invoking — if an identifier is unknown, search the relevant documentation (web_fetch / web_search) instead of guessing.",
    },
  },
  {
    id: "silk-design",
    name: "Silk Design",
    kind: "skill-collection",
    owner: "bendrape1-byte",
    repo: "silk-design",
    subpath: "",
    branch: "main",
    url: "https://github.com/bendrape1-byte/silk-design",
    description:
      "Design-craft skill collection (silk-smooth UI/design guidance with a rich component-asset library). Installs into OnyxAgent's own skill registry — never the upstream Claude-specific path.",
    skills: [
      {
        name: "silk-design",
        description: "Design fundamentals and tasteful UI guidance (the whole repo is one skill).",
        dir: "",
      },
    ],
  },
  {
    id: "everything-ai",
    name: "Everything AI",
    kind: "npm-cli",
    owner: "mitunmanav",
    repo: "everything-ai",
    subpath: "",
    url: "https://github.com/mitunmanav/everything-ai",
    description: "npx-runnable AI agent toolkit that orchestrates many AI tasks end-to-end.",
    skills: [],
    sandboxUsage: {
      install: "npx --yes github:mitunmanav/everything-ai -- --dry-run",
      run: "npx --yes github:mitunmanav/everything-ai",
      caution:
        "ALWAYS dry-run first and review the package and its proposed actions before allowing real execution.",
    },
  },
  {
    id: "addhumanity",
    name: "Addhumanity",
    kind: "skill-collection",
    owner: "olivierlesnicki",
    repo: "addhumanity",
    subpath: "skills",
    url: "https://github.com/olivierlesnicki/addhumanity",
    description: "Human-support companion skills for difficult emotional states.",
    skills: addhumanitySkills,
  },
  {
    id: "threejs-game-skills",
    name: "Three.js Game Skills",
    kind: "skill-collection",
    owner: "majidmanzarpour",
    repo: "threejs-game-skills",
    subpath: "skills",
    url: "https://github.com/majidmanzarpour/threejs-game-skills",
    description: "Full Three.js game-production skill set (design → graphics → audio → QA).",
    skills: threejsSkills,
  },
  {
    id: "mengto-skills",
    name: "MengTo Agent Skills",
    kind: "skill-collection",
    owner: "MengTo",
    repo: "Skills",
    subpath: "agent-skills",
    branch: "main",
    url: "https://github.com/MengTo/Skills/tree/main/agent-skills",
    description: "MengTo's agent-skills collection (design/3D/dev focused, nested by category). Live-indexed — browse to see the skills.",
    skills: [], // no static index — browse_repository fetches it from GitHub
  },
];

// ---------------------------------------------------------------------------
// MCP Market catalog.
// ---------------------------------------------------------------------------

export interface McpMarketServer {
  /** Stable id. */
  id: string;
  name: string;
  /** Marketplace detail page — fetch it for the exact connection details. */
  url: string;
  description: string;
  /**
   * Connection hint: how the server is typically deployed. The marketplace
   * page is always the source of truth for the exact transport/command.
   */
  hint?: string;
}

export const MCP_MARKET_SERVERS: readonly McpMarketServer[] = [
  {
    id: "chrome-devtools",
    name: "Chrome DevTools",
    url: "https://mcpmarket.com/server/chrome-devtools-1",
    description: "Drive Chrome via CDP: navigate, screenshot, read console + network, capture performance traces.",
    hint: "Typically an npx/stdio package (chrome-devtools-mcp) — run it inside the E2B sandbox as the MCP client.",
  },
  {
    id: "serena",
    name: "Serena",
    url: "https://mcpmarket.com/server/serena",
    description: "Semantic code intelligence: LSP-powered symbols, references, edits and refactors over codebases.",
    hint: "Typically a Python (uvx/git) stdio server — run inside the E2B sandbox.",
  },
  {
    id: "2ools",
    name: "2ools",
    url: "https://mcpmarket.com/server/2ools",
    description: "A toolkit server exposing assorted utilities. Fetch the page for the tool list.",
  },
  {
    id: "superpowers",
    name: "Superpowers",
    url: "https://mcpmarket.com/server/superpowers",
    description: "Extended agent-capabilities toolkit. Fetch the page for the tool list.",
  },
  {
    id: "tubealfred-youtube",
    name: "TubeAlfred YouTube",
    url: "https://mcpmarket.com/server/tubealfred-youtube",
    description: "YouTube automation through TubeAlfred (search, playlists, channel actions).",
  },
  {
    id: "chatgpt-redis",
    name: "ChatGPT Redis",
    url: "https://mcpmarket.com/server/chatgpt-redis",
    description: "Redis-backed memory/context store for conversational agents.",
  },
  {
    id: "youtube-search-download",
    name: "YouTube Search & Download",
    url: "https://mcpmarket.com/server/youtube-search-download",
    description: "Search YouTube and download videos/audio programmatically.",
  },
  {
    id: "pdf-generator",
    name: "PDF Generator",
    url: "https://mcpmarket.com/server/pdf-generator-1",
    description: "Generate PDF documents from structured content.",
  },
  {
    id: "free-proxy-list",
    name: "Free Proxy List",
    url: "https://mcpmarket.com/server/free-proxy-list",
    description: "Fetch rotating lists of free proxy servers.",
  },
  {
    id: "site-shot",
    name: "Site Shot",
    url: "https://mcpmarket.com/server/site-shot",
    description: "Capture website screenshots on demand.",
  },
];

// ---------------------------------------------------------------------------
// Lookup + summary helpers.
// ---------------------------------------------------------------------------

export function getSkillRepository(id: string): SkillRepository | null {
  return SKILL_REPOSITORIES.find((r) => r.id === id) ?? null;
}

export function getMcpMarketServer(id: string): McpMarketServer | null {
  return MCP_MARKET_SERVERS.find((s) => s.id === id) ?? null;
}

/** Compact repo summary for `analyze_workspace` (metadata-only, no flooding). */
export interface SkillRepositorySummary {
  id: string;
  name: string;
  kind: RepositoryKind;
  description: string;
  url: string;
  skill_count: number;
  /** True when the skills are indexed statically; false → browse live. */
  indexed: boolean;
}

export function summarizeSkillRepositories(): SkillRepositorySummary[] {
  return SKILL_REPOSITORIES.map((r) => ({
    id: r.id,
    name: r.name,
    kind: r.kind,
    description: r.description,
    url: r.url,
    skill_count: r.skills.length,
    indexed: r.skills.length > 0,
  }));
}

/** MCP-Market summary for `analyze_workspace` (id + name + URL only). */
export function summarizeMcpMarket(): Array<Pick<McpMarketServer, "id" | "name" | "url">> {
  return MCP_MARKET_SERVERS.map((s) => ({ id: s.id, name: s.name, url: s.url }));
}

/** The catalog payload for `manage_skill` action "catalog" (metadata-first). */
export function buildSkillCatalogPayload() {
  return {
    repositories: SKILL_REPOSITORIES.map((r) => ({
      id: r.id,
      name: r.name,
      kind: r.kind,
      description: r.description,
      url: r.url,
      skill_count: r.skills.length,
      skills: r.skills.map((s) => ({ name: s.name, description: s.description })),
      ...(r.kind === "npm-cli" && r.sandboxUsage
        ? {
            sandbox_install: r.sandboxUsage.install,
            sandbox_run: r.sandboxUsage.run,
            ...(r.sandboxUsage.example ? { example: r.sandboxUsage.example } : {}),
            ...(r.sandboxUsage.caution ? { caution: r.sandboxUsage.caution } : {}),
          }
        : {}),
    })),
    mcp_market: MCP_MARKET_SERVERS.map((s) => ({
      id: s.id,
      name: s.name,
      url: s.url,
      description: s.description,
      ...(s.hint ? { hint: s.hint } : {}),
    })),
    usage:
      "Metadata-first: pick ONLY the skills relevant to the task, then manage_skill install_from_repository (skill-collections) or run the sandbox_install commands via run_terminal (npm-cli repos). After installing a skill, manage_skill read it. For MCP Market servers: web_fetch the marketplace URL for connection details, then wire per the MCP decision order (remote HTTP/SSE → manage_mcp create; stdio/npx → MCP client script inside the sandbox).",
  };
}
