import { createElement, type ElementType } from 'react'
import {
  Terminal,
  TerminalSquare,
  SquareTerminal,
  Command,
  Code,
  FileCode2,
  FileSearch,
  FolderTree,
  GitBranch,
  GitCompareArrows,
  History,
  MessagesSquare,
  Server,
  Database,
  Cloud,
  Folder,
  Sparkles,
  Bot,
  Zap,
  Flame,
  Rocket,
  RadioTower,
  Play,
  Cpu,
  Bug,
  Globe,
  GitCompare,
  LayoutGrid,
  ListTodo,
  MonitorCog,
} from 'lucide-react'

type BrandIconProps = { size?: number | string; className?: string }

function brandIcon(src: string): ElementType {
  return function BrandProfileIcon({ size = 16, className }: BrandIconProps) {
    return createElement('img', {
      src,
      alt: '',
      draggable: false,
      width: size,
      height: size,
      className: ['profile-brand-icon', className].filter(Boolean).join(' '),
    })
  }
}

type IconComponent = ElementType

export const profileIcons: Record<string, IconComponent> = {
  'claude-code': brandIcon('/agent-icons/claude-code.svg'),
  claude: brandIcon('/agent-icons/claude-code.svg'),
  codex: brandIcon('/agent-icons/codex.svg'),
  openai: brandIcon('/agent-icons/codex.svg'),
  'oh-my-pi': brandIcon('/agent-icons/oh-my-pi.svg'),
  omp: brandIcon('/agent-icons/oh-my-pi.svg'),
  opencode: brandIcon('/agent-icons/opencode.svg'),
  powershell: brandIcon('/agent-icons/powershell.svg'),
  terminal: Terminal,
  'terminal-square': TerminalSquare,
  'square-terminal': SquareTerminal,
  command: Command,
  code: Code,
  'file-code': FileCode2,
  'file-search': FileSearch,
  'folder-tree': FolderTree,
  'git-branch': GitBranch,
  'git-compare-arrows': GitCompareArrows,
  history: History,
  'messages-square': MessagesSquare,
  server: Server,
  database: Database,
  cloud: Cloud,
  folder: Folder,
  sparkles: Sparkles,
  bot: Bot,
  zap: Zap,
  flame: Flame,
  rocket: Rocket,
  'radio-tower': RadioTower,
  play: Play,
  cpu: Cpu,
  bug: Bug,
  globe: Globe,
  'git-compare': GitCompare,
  'layout-grid': LayoutGrid,
  'list-todo': ListTodo,
  'monitor-cog': MonitorCog,
}

export const defaultProfileIconName = 'terminal'

export const profileIconNames = Object.keys(profileIcons)
