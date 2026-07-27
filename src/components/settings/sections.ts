import {
  Archive,
  Bell,
  Blocks,
  Bot,
  Box,
  CircleUser,
  GitBranch,
  GitPullRequest,
  Info,
  KeyRound,
  MessageSquare,
  Mic,
  Palette,
  PanelsTopLeft,
  Plug,
  Shield,
  SlidersHorizontal,
  Smartphone,
  Sparkles,
} from 'lucide-react'
import type { SettingsIcon } from './controls'

export type SettingsSectionId =
  | 'account'
  | 'agents'
  | 'model'
  | 'chat'
  | 'appearance'
  | 'notifications'
  | 'workspace'
  | 'terminals'
  | 'integrations'
  | 'gitHosting'
  | 'remote'
  | 'worktrees'
  | 'messaging'
  | 'mcp'
  | 'apiKeys'
  | 'safety'
  | 'memory'
  | 'voice'
  | 'advanced'
  | 'archived'
  | 'about'

export type SettingsSectionDefinition = {
  id: SettingsSectionId
  label: string
  icon: SettingsIcon
  /** Extra words matched by the nav search box but never rendered. */
  keywords: string
}

export type SettingsSectionGroup = {
  id: string
  label: string
  sections: SettingsSectionDefinition[]
}

/**
 * Nav grouping mirrors scope, which is the question users actually ask: is this
 * about me, about the AI agents, about how the app looks, about this machine's
 * workspaces, or about an external service? A flat 19-item list forced them to
 * read every label.
 */
export const settingsSectionGroups: SettingsSectionGroup[] = [
  {
    id: 'you',
    label: 'You',
    sections: [
      { id: 'account', label: 'Account', icon: CircleUser, keywords: 'moobang license plan trial device sign in' },
      { id: 'appearance', label: 'Appearance', icon: Palette, keywords: 'theme font color cursor editor ui scale' },
      { id: 'notifications', label: 'Notifications', icon: Bell, keywords: 'sound alert completion volume hook' },
    ],
  },
  {
    id: 'ai',
    label: 'AI',
    sections: [
      { id: 'agents', label: 'Agents', icon: Sparkles, keywords: 'claude codex omp oh my pi opencode cli hook install login' },
      { id: 'model', label: 'Model', icon: Bot, keywords: 'hermes provider acp runtime version' },
      { id: 'chat', label: 'Chat', icon: MessageSquare, keywords: 'personality reasoning tool calls images' },
      { id: 'mcp', label: 'MCP', icon: Box, keywords: 'server bridge tools self check' },
      { id: 'memory', label: 'Memory', icon: Blocks, keywords: 'context compression persistent' },
    ],
  },
  {
    id: 'workspace',
    label: 'Workspace',
    sections: [
      { id: 'workspace', label: 'Workspaces', icon: PanelsTopLeft, keywords: 'layout pane header scrollback roles group default' },
      { id: 'terminals', label: 'Terminal profiles', icon: Blocks, keywords: 'profile shell ssh command icon color' },
      { id: 'worktrees', label: 'Worktrees', icon: GitBranch, keywords: 'git storage drive folder root' },
    ],
  },
  {
    id: 'connect',
    label: 'Connections',
    sections: [
      { id: 'gitHosting', label: 'Git hosting', icon: GitPullRequest, keywords: 'github gitlab token credential scopes discovery' },
      { id: 'remote', label: 'Remote', icon: Smartphone, keywords: 'mobile phone pairing lan qr firewall' },
      { id: 'integrations', label: 'Integrations', icon: Plug, keywords: 'external editor code command' },
      { id: 'messaging', label: 'Messaging', icon: MessageSquare, keywords: 'telegram discord slack whatsapp gateway' },
      { id: 'apiKeys', label: 'API keys', icon: KeyRound, keywords: 'auth provider credentials hermes' },
    ],
  },
  {
    id: 'system',
    label: 'System',
    sections: [
      { id: 'advanced', label: 'Advanced', icon: SlidersHorizontal, keywords: 'capture ffmpeg keybindings shortcuts android device lab' },
      { id: 'safety', label: 'Safety', icon: Shield, keywords: 'process cleanup policy kill' },
      { id: 'voice', label: 'Voice', icon: Mic, keywords: 'speech input output' },
      { id: 'archived', label: 'Archived chats', icon: Archive, keywords: 'history sessions hermes' },
      { id: 'about', label: 'About', icon: Info, keywords: 'version setup wizard product' },
    ],
  },
]

export const settingsSections: SettingsSectionDefinition[] = settingsSectionGroups.flatMap((group) => group.sections)

export function settingsSectionById(id: SettingsSectionId): SettingsSectionDefinition {
  return settingsSections.find((section) => section.id === id) ?? settingsSections[0]
}

/** Filters the nav by label or hidden keywords, dropping groups that empty out. */
export function filterSettingsSections(query: string): SettingsSectionGroup[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return settingsSectionGroups
  return settingsSectionGroups
    .map((group) => ({
      ...group,
      sections: group.sections.filter((section) =>
        section.label.toLowerCase().includes(needle) || section.keywords.includes(needle),
      ),
    }))
    .filter((group) => group.sections.length > 0)
}
