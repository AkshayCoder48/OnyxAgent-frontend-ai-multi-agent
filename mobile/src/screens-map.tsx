/** id → live screen component (imports everything; gallery + routes both use this). */
import type { ComponentType } from 'react';
import { S1Home, S2ChatTools, S3Chat, S4Sidebar } from './screens-chat';
import { S5Onboarding, S6IPython, S7Search, S8Slash } from './screens-input';
import { S9Orchestrator, S10SubagentChat, S11Subagents } from './screens-subs';
import { S12Files, S13FilePreview, S14KB } from './screens-files';
import { S15WebResults, S16Reader, S17Browser, S18ImageGen, S19Charts } from './screens-results';
import { S20Tools, S21Skills, S22MCP } from './screens-library';
import { S23Settings, S24Appearance, S25Providers, S26CustomTools, S27Automation } from './screens-settings';
import { ALL_SCREENS } from './registry';

export const SCREENS: Record<string, ComponentType> = {
  home: S1Home,
  'chat-tools': S2ChatTools,
  chat: S3Chat,
  sidebar: S4Sidebar,
  onboarding: S5Onboarding,
  ipython: S6IPython,
  search: S7Search,
  slash: S8Slash,
  orchestrator: S9Orchestrator,
  'subagent-chat': S10SubagentChat,
  subagents: S11Subagents,
  files: S12Files,
  'file-preview': S13FilePreview,
  kb: S14KB,
  'web-results': S15WebResults,
  reader: S16Reader,
  browser: S17Browser,
  imagegen: S18ImageGen,
  charts: S19Charts,
  tools: S20Tools,
  skills: S21Skills,
  mcp: S22MCP,
  settings: S23Settings,
  appearance: S24Appearance,
  providers: S25Providers,
  'custom-tools': S26CustomTools,
  automation: S27Automation,
};

export const screenFor = (id: string): ComponentType | undefined => SCREENS[id];
export const knownIds = ALL_SCREENS.map((s) => s.id);
