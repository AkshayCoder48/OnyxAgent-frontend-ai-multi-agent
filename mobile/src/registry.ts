/**
 * Registry — pure data describing the 27 clone screens in 7 groups.
 * No React imports here, so it stays unit-testable.
 */
export type ScreenKindStr = 'home' | 'tools' | 'chat' | 'side' | 'plain' | 'onboard';

export interface ScreenDef {
  id: string;
  route: string;
  title: string;
  kind: ScreenKindStr;
}
export interface GroupDef {
  label: string;
  sub: string;
  screens: ScreenDef[];
}

export const APP = {
  name: 'OnyxAgent',
  version: '2.4.0',
  tagline: "The repo's full mobile app — 27 screens · 50+ tools · subagents · every settings tab — re-skinned in orange glass.",
};

export const GROUPS: GroupDef[] = [
  {
    label: 'Chat experience',
    sub: 'Home · tool batches · thread · history drawer',
    screens: [
      { id: 'home', route: '/', title: 'Home', kind: 'home' },
      { id: 'chat-tools', route: '/chat-tools', title: 'Tool batch', kind: 'tools' },
      { id: 'chat', route: '/chat', title: 'Chat', kind: 'chat' },
      { id: 'sidebar', route: '/sidebar', title: 'History drawer', kind: 'side' },
    ],
  },
  {
    label: 'Onboarding & input',
    sub: 'Welcome · expanded tool run · chat search · slash commands',
    screens: [
      { id: 'onboarding', route: '/onboarding', title: 'Onboarding', kind: 'onboard' },
      { id: 'ipython', route: '/ipython', title: 'iPython run', kind: 'plain' },
      { id: 'search', route: '/search', title: 'Search', kind: 'plain' },
      { id: 'slash', route: '/slash', title: 'Slash palette', kind: 'chat' },
    ],
  },
  {
    label: 'Subagent orchestration',
    sub: 'The AI spawns & steers its own helpers — spawn_subagent · query_subagent · steer',
    screens: [
      { id: 'orchestrator', route: '/orchestrator', title: 'Orchestrator', kind: 'plain' },
      { id: 'subagent-chat', route: '/subagent-chat', title: '@mention chat', kind: 'chat' },
      { id: 'subagents', route: '/subagents', title: 'Subagent settings', kind: 'plain' },
    ],
  },
  {
    label: 'Files & knowledge',
    sub: 'OPFS file sidebar · previews · knowledge base with citations',
    screens: [
      { id: 'files', route: '/files', title: 'File drawer', kind: 'side' },
      { id: 'file-preview', route: '/file-preview', title: 'File preview', kind: 'plain' },
      { id: 'kb', route: '/kb', title: 'Knowledge base', kind: 'plain' },
    ],
  },
  {
    label: 'Tool results, made pretty',
    sub: 'Raw outputs rendered as proper UI — search, reader, browser, images, charts',
    screens: [
      { id: 'web-results', route: '/web-results', title: 'Web results', kind: 'plain' },
      { id: 'reader', route: '/reader', title: 'Reader', kind: 'plain' },
      { id: 'browser', route: '/browser', title: 'Browser', kind: 'plain' },
      { id: 'imagegen', route: '/imagegen', title: 'Image gen', kind: 'plain' },
      { id: 'charts', route: '/charts', title: 'Charts & todos', kind: 'plain' },
    ],
  },
  {
    label: 'Library',
    sub: 'All 50+ tools · SkillsMP marketplace · MCP servers',
    screens: [
      { id: 'tools', route: '/tools', title: 'Tools', kind: 'plain' },
      { id: 'skills', route: '/skills', title: 'Skills', kind: 'plain' },
      { id: 'mcp', route: '/mcp', title: 'MCP servers', kind: 'plain' },
    ],
  },
  {
    label: 'Settings',
    sub: 'Every tab from the repo — appearance recolors this whole page',
    screens: [
      { id: 'settings', route: '/settings', title: 'Settings', kind: 'plain' },
      { id: 'appearance', route: '/appearance', title: 'Appearance', kind: 'plain' },
      { id: 'providers', route: '/providers', title: 'AI providers', kind: 'plain' },
      { id: 'custom-tools', route: '/custom-tools', title: 'Custom tools', kind: 'plain' },
      { id: 'automation', route: '/automation', title: 'Automation', kind: 'plain' },
    ],
  },
];

export const ALL_SCREENS: ScreenDef[] = GROUPS.flatMap((g) => g.screens);
