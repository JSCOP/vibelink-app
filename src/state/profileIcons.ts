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
  Timer,
  Brain,
} from 'lucide-react'

/** Brand marks stand in for Lucide glyphs anywhere an icon component is taken,
 *  so `strokeWidth`/`color` may arrive from a caller styling a vector icon.
 *  They are dropped: an `<img>` would render them as invalid DOM attributes. */
type BrandIconProps = { size?: number | string; className?: string; strokeWidth?: number | string; color?: string }

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
  amp: brandIcon('/agent-icons/amp.svg'),
  antigravity: brandIcon('/agent-icons/antigravity.png'),
  'claude-code': brandIcon('/agent-icons/claude-code.svg'),
  claude: brandIcon('/agent-icons/claude-code.svg'),
  codex: brandIcon('/agent-icons/codex.svg'),
  openai: brandIcon('/agent-icons/codex.svg'),
  'command-code': brandIcon('/agent-icons/command-code.png'),
  copilot: brandIcon('/agent-icons/copilot.svg'),
  cursor: brandIcon('/agent-icons/cursor.svg'),
  devin: brandIcon('/agent-icons/devin.svg'),
  droid: brandIcon('/agent-icons/droid.svg'),
  gemini: brandIcon('/agent-icons/gemini.svg'),
  grok: brandIcon('/agent-icons/grok.svg'),
  hermes: brandIcon('/agent-icons/hermes.svg'),
  kimi: brandIcon('/agent-icons/kimi.svg'),
  'mimo-code': brandIcon('/agent-icons/mimo-code.svg'),
  'oh-my-pi': brandIcon('/agent-icons/oh-my-pi.svg'),
  omp: brandIcon('/agent-icons/oh-my-pi.svg'),
  opencode: brandIcon('/agent-icons/opencode.svg'),
  pi: brandIcon('/agent-icons/pi.svg'),
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
  timer: Timer,
  brain: Brain,
}

export const defaultProfileIconName = 'terminal'

export const profileIconNames = Object.keys(profileIcons)
