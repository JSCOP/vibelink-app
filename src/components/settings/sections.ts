import {
  Archive,
  Bell,
  Blocks,
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
import { profileIcons } from '../../state/profileIcons'
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
      { id: 'model', label: 'Model', icon: profileIcons.hermes as SettingsIcon, keywords: 'hermes provider acp runtime version' },
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

export type SettingsSearchEntry = {
  section: SettingsSectionId
  /** Which setting it is — matches the visible row/card label. */
  label: string
  /** Extra match words; Korean aliases live here, never rendered. */
  keywords: string
}

/**
 * Curated row-level index for the settings search. One entry per visible row or
 * card group, co-located with the section definitions so a regrouped section
 * keeps its rows. Add/remove entries with the rows they describe; the tests
 * require every section to keep at least one entry.
 */
export const settingsSearchEntries: SettingsSearchEntry[] = [
  { section: 'account', label: 'Sign in / account status', keywords: 'log in login moobang sign out session 로그인 로그아웃 계정' },
  { section: 'account', label: 'Plan & trial', keywords: 'license pro trial price entitlement 라이선스 플랜 트라이얼 결제' },
  { section: 'account', label: 'Registered devices', keywords: 'device slots deactivate 기기 등록 해제' },
  { section: 'appearance', label: 'Color theme', keywords: 'theme palette dark 테마 색상' },
  { section: 'appearance', label: 'Font family / size / weight', keywords: 'terminal font 폰트 글꼴 글자 크기' },
  { section: 'appearance', label: 'UI scale', keywords: 'zoom interface density 배율 확대' },
  { section: 'appearance', label: 'Selected pane highlight', keywords: 'orange outline focus 선택 테두리' },
  { section: 'appearance', label: 'Reviewed pane highlight', keywords: 'blue outline review 검토 테두리' },
  { section: 'appearance', label: 'Alarm highlight', keywords: 'completion color alert 완료 색상' },
  { section: 'appearance', label: 'Cursor style', keywords: 'block underline bar 커서' },
  { section: 'appearance', label: 'Pane header height', keywords: 'tab title bar 탭 높이 제목' },
  { section: 'notifications', label: 'Completion alert', keywords: 'response complete highlight 완료 알림' },
  { section: 'notifications', label: 'Completion sound & volume', keywords: 'play audio sound volume 소리 볼륨' },
  { section: 'notifications', label: 'Custom sound file', keywords: 'add file mp3 wav 파일' },
  { section: 'notifications', label: 'Desktop notification', keywords: 'windows toast os banner background 윈도우 알림 데스크톱' },
  { section: 'agents', label: 'Installed agents', keywords: 'claude codex omp opencode gemini cursor 설치 에이전트' },
  { section: 'agents', label: 'Agent hooks', keywords: 'install completion hooks 후크 설치' },
  { section: 'model', label: 'Hermes runtime', keywords: 'hermes-acp path command override override 헤르메스 경로' },
  { section: 'model', label: 'Model & provider', keywords: 'provider model acp 모델 프로바이더' },
  { section: 'chat', label: 'Personality', keywords: 'chat personality 말투 성격' },
  { section: 'chat', label: 'Show thinking / reasoning', keywords: 'thinking reasoning 사고 과정' },
  { section: 'chat', label: 'Show tool call contents', keywords: 'tool calls 도구 호출' },
  { section: 'chat', label: 'Image attachments', keywords: 'images paste 이미지 첨부' },
  { section: 'mcp', label: 'MCP server & self-check', keywords: 'server bridge tools self check 서버 점검' },
  { section: 'memory', label: 'Persistent memory', keywords: 'memory context compression 메모리 압축' },
  { section: 'workspace', label: 'Workspace ordering', keywords: 'sort mode smart manual 정렬 순서' },
  { section: 'workspace', label: 'When reopening (session restore)', keywords: 'resume clean restart exit restore 재시작 복원 종료' },
  { section: 'workspace', label: 'Close button minimizes to tray', keywords: 'tray minimize quit 닫기 트레이' },
  { section: 'workspace', label: 'Confirm when agents are still working', keywords: 'confirm exit busy 종료 확인' },
  { section: 'workspace', label: 'Scrollback / word wrap', keywords: 'scrollback lines wrap 스크롤백 줄바꿈' },
  { section: 'workspace', label: 'Pane roles & resize snap', keywords: 'role snap resize 역할 스냅' },
  { section: 'terminals', label: 'Profiles', keywords: 'profile shell powershell wsl ssh 프로필 셸' },
  { section: 'terminals', label: 'Default profile', keywords: 'default startup 기본 프로필' },
  { section: 'terminals', label: 'Profile command & icon', keywords: 'command args icon color 명령 아이콘' },
  { section: 'worktrees', label: 'Storage mode & folder', keywords: 'drive folder custom root 저장 위치' },
  { section: 'worktrees', label: 'Group by repository', keywords: 'repository grouping 레포 그룹' },
  { section: 'gitHosting', label: 'GitHub / GitLab credentials', keywords: 'token credential scopes 깃헙 토큰' },
  { section: 'gitHosting', label: 'Git status presentation', keywords: 'words letters icons 상태 표시' },
  { section: 'remote', label: 'Remote access & pairing', keywords: 'mobile phone pairing qr 모바일 페어링' },
  { section: 'remote', label: 'LAN & firewall', keywords: 'lan port firewall 방화벽 포트' },
  { section: 'integrations', label: 'Editor command', keywords: 'external editor code 편집기 명령' },
  { section: 'messaging', label: 'Telegram / Discord gateways', keywords: 'telegram discord slack whatsapp 게이트웨이' },
  { section: 'apiKeys', label: 'Provider credentials', keywords: 'api key auth provider 인증 키' },
  { section: 'advanced', label: 'Capture folder & ffmpeg', keywords: 'capture ffmpeg recording 캡처 녹화' },
  { section: 'advanced', label: 'Keybindings', keywords: 'shortcuts hotkeys 단축키 키바인딩' },
  { section: 'advanced', label: 'Android device lab', keywords: 'android adb device 안드로이드' },
  { section: 'safety', label: 'Scoped process cleanup', keywords: 'process kill exact pid policy 프로세스 종료 정책' },
  { section: 'voice', label: 'Voice input / output', keywords: 'speech voice 음성' },
  { section: 'archived', label: 'Archived chats', keywords: 'history sessions 보관 대화' },
  { section: 'about', label: 'Version & setup wizard', keywords: 'version product wizard setup 버전 마법사 설정' },
]

export type SettingsSearchResult = SettingsSearchEntry & { score: number }

const entrySearchText = (entry: SettingsSearchEntry): string => {
  const section = settingsSectionById(entry.section)
  return `${section.label} ${section.keywords} ${entry.label} ${entry.keywords}`.toLowerCase()
}

/**
 * Row-level settings search: every whitespace token must match the combined
 * section+row+keyword text (AND). Row-label hits outrank keyword-only hits,
 * which outrank section-only hits. Capped so the nav stays glanceable.
 */
export function searchSettingsEntries(query: string, limit = 30): SettingsSearchResult[] {
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return []
  return settingsSearchEntries
    .map((entry) => {
      const haystack = entrySearchText(entry)
      if (!tokens.every((token) => haystack.includes(token))) return null
      const label = entry.label.toLowerCase()
      const labelHits = tokens.filter((token) => label.includes(token)).length
      const keywordHits = tokens.filter((token) => entry.keywords.includes(token)).length
      return { ...entry, score: labelHits * 10 + keywordHits * 4 }
    })
    .filter((entry): entry is SettingsSearchResult => entry !== null)
    .sort((left, right) => right.score - left.score || left.label.localeCompare(right.label))
    .slice(0, limit)
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
