import {
  Terminal,
  TerminalSquare,
  SquareTerminal,
  Command,
  Code,
  GitBranch,
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

type IconComponent = typeof Terminal

export const profileIcons: Record<string, IconComponent> = {
  terminal: Terminal,
  'terminal-square': TerminalSquare,
  'square-terminal': SquareTerminal,
  command: Command,
  code: Code,
  'git-branch': GitBranch,
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
