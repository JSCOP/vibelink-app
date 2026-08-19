/** Screen-content agent state detection, ported from herdr's detect engine
 *  (https://github.com/herdrdev/herdr, Apache-2.0 — see NOTICE.md).
 *
 *  A manifest is an ordered rule list per agent CLI. Each rule matches one
 *  screen region (or the OSC title) with substring/regex gates and claims a
 *  state; the highest-priority match wins. This is what turns "Claude is
 *  showing `esc to cancel · enter to confirm`" into a `blocked` badge without
 *  any agent-side integration. */

export type AgentScreenState = 'working' | 'blocked' | 'idle'

type Gate = {
  contains?: string[]
  regex?: RegExp[]
  lineRegex?: RegExp[]
  all?: Gate[]
  any?: Gate[]
  not?: Gate[]
}

type Rule = Gate & {
  id: string
  state: AgentScreenState | 'unknown'
  priority: number
  region: string
  /** Menu/viewer overlays that hide the real state: keep the previous state. */
  skipStateUpdate?: boolean
}

export type AgentManifest = { id: string; rules: Rule[] }

export type ScreenDetection = { state: AgentScreenState; ruleId: string } | { state: 'hold'; ruleId: string } | null

export function detectAgentScreenState(agentKind: string, screen: string, oscTitle: string): ScreenDetection {
  const manifest = MANIFESTS[agentKind]
  if (!manifest) return null
  let matched: Rule | null = null
  for (const rule of manifest.rules) {
    if (matched && matched.priority >= rule.priority) continue
    const text = region(rule.region, screen, oscTitle)
    if (gateMatches(rule, text, text.toLowerCase())) matched = rule
  }
  if (!matched) return null
  if (matched.skipStateUpdate || matched.state === 'unknown') return { state: 'hold', ruleId: matched.id }
  return { state: matched.state, ruleId: matched.id }
}

function gateMatches(gate: Gate, text: string, lowerText: string): boolean {
  if (gate.contains && !gate.contains.every((needle) => lowerText.includes(needle.toLowerCase()))) return false
  if (gate.regex && !gate.regex.every((pattern) => pattern.test(text))) return false
  if (gate.lineRegex && !gate.lineRegex.every((pattern) => text.split('\n').some((line) => pattern.test(line)))) return false
  if (gate.all && !gate.all.every((nested) => gateMatches(nested, text, lowerText))) return false
  if (gate.any && gate.any.length > 0 && !gate.any.some((nested) => gateMatches(nested, text, lowerText))) return false
  if (gate.not && gate.not.some((nested) => gateMatches(nested, text, lowerText))) return false
  return true
}

// ---------------------------------------------------------------- regions

function region(spec: string, screen: string, oscTitle: string): string {
  const trimmed = spec.trim()
  if (trimmed === 'osc_title') return oscTitle
  const content = screen
  if (trimmed === 'whole_recent') return content
  if (trimmed === 'prompt_box_body') return promptBoxBody(content) ?? ''
  if (trimmed === 'after_last_horizontal_rule') return afterLastHorizontalRule(content)
  if (trimmed === 'after_last_prompt_marker') return afterLastPromptMarker(content)
  const bottom = regionCount(trimmed, 'bottom_non_empty_lines')
  if (bottom !== null) return bottomNonEmptyLines(content, bottom)
  const bottomAll = regionCount(trimmed, 'bottom_lines')
  if (bottomAll !== null) return content.split('\n').slice(-bottomAll).join('\n')
  const top = regionCount(trimmed, 'top_non_empty_lines')
  if (top !== null) return topNonEmptyLines(content, top)
  return ''
}

function regionCount(spec: string, name: string): number | null {
  if (!spec.startsWith(name + '(') || !spec.endsWith(')')) return null
  const count = Number.parseInt(spec.slice(name.length + 1, -1), 10)
  return Number.isFinite(count) && count > 0 ? count : null
}

function bottomNonEmptyLines(content: string, count: number): string {
  const lines = content.split('\n')
  let seen = 0
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lines[index].trim().length > 0) {
      seen += 1
      if (seen === count) return lines.slice(index).join('\n')
    }
  }
  return content
}

function topNonEmptyLines(content: string, count: number): string {
  const lines = content.split('\n')
  let seen = 0
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].trim().length > 0) {
      seen += 1
      if (seen === count) return lines.slice(0, index + 1).join('\n')
    }
  }
  return content
}

function isHorizontalRule(line: string): boolean {
  const trimmed = line.trim()
  if (trimmed.length === 0) return false
  let ruleChars = 0
  for (const ch of trimmed) {
    if (ch === '─') ruleChars += 1
    else break
  }
  return ruleChars >= 3
}

/** The body between the last TWO horizontal rules — a bordered prompt box. */
function promptBoxBody(content: string): string | null {
  const lines = content.split('\n')
  let borderCount = 0
  let top = -1
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (isHorizontalRule(lines[index])) {
      borderCount += 1
      if (borderCount === 2) {
        top = index
        break
      }
    }
  }
  if (top < 0) return null
  const body: string[] = []
  for (let index = top + 1; index < lines.length; index += 1) {
    if (isHorizontalRule(lines[index])) break
    body.push(lines[index])
  }
  return body.join('\n')
}

function afterLastHorizontalRule(content: string): string {
  const lines = content.split('\n')
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (isHorizontalRule(lines[index])) return lines.slice(index + 1).join('\n')
  }
  return content
}

/** Codex renders its live prompt as a `›` line. */
function afterLastPromptMarker(content: string): string {
  const lines = content.split('\n')
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lines[index] === '›' || lines[index].startsWith('› ')) return lines.slice(index + 1).join('\n')
  }
  return content
}

// ---------------------------------------------------------------- manifests
// Ported from herdr's src/detect/manifests/*.toml. Keep rule ids identical so
// upstream fixes are easy to diff back in.

const claude: AgentManifest = {
  id: 'claude',
  rules: [
    { id: 'osc_title_working', state: 'working', priority: 1100, region: 'osc_title', regex: [/^[\u{2800}-\u{28FF}\u{25D0}-\u{25D3}] /u] },
    { id: 'btw_overlay_working', state: 'working', priority: 975, region: 'bottom_non_empty_lines(5)', lineRegex: [/^\s*\/btw(?:\s|$)/, /esc to close\s*$/i] },
    {
      id: 'transcript_viewer', state: 'unknown', priority: 1000, region: 'bottom_non_empty_lines(3)', skipStateUpdate: true,
      contains: ['showing detailed transcript'],
      any: [
        { contains: ['ctrl+o', 'to toggle'] },
        { contains: ['ctrl+e', 'show all'] },
        { contains: ['ctrl+e', 'collapse'] },
        { contains: ['↑↓ scroll'] },
        { contains: ['? for shortcuts'] },
      ],
    },
    {
      id: 'live_blocked_form', state: 'blocked', priority: 980, region: 'after_last_horizontal_rule',
      contains: ['esc to cancel'],
      any: [
        { contains: ['enter to confirm'] },
        {
          contains: ['enter to select'],
          any: [
            { contains: ['tab/arrow keys to navigate'] },
            { contains: ['arrow keys to navigate'] },
            { contains: ['arrows to navigate'] },
            { contains: ['↑/↓ to navigate'] },
            { contains: ['↑↓ to navigate'] },
          ],
        },
      ],
    },
    { id: 'dynamic_workflow_prompt', state: 'blocked', priority: 980, region: 'whole_recent', contains: ['run a dynamic workflow?', 'esc to cancel'] },
    {
      id: 'live_prompt_box', state: 'idle', priority: 950, region: 'prompt_box_body',
      lineRegex: [/^\s*❯/],
      not: [
        { contains: ['enter to select'] },
        { contains: ['esc to cancel'] },
        { contains: ['tab/arrow keys'] },
        { contains: ['arrow keys to navigate'] },
        { contains: ['↑/↓ to navigate'] },
      ],
    },
    {
      id: 'model_picker_menu', state: 'unknown', priority: 900, region: 'whole_recent', skipStateUpdate: true,
      contains: ['select model', 'enter to set as default', 'esc to cancel'],
      not: [{ contains: ['do you want to proceed?'] }, { contains: ['enter to select'] }],
    },
    {
      id: 'bash_permission_prompt', state: 'blocked', priority: 850, region: 'whole_recent',
      contains: ['do you want to proceed?'],
      any: [
        { contains: ['bash command'] },
        { contains: ['bash('] },
        { contains: ['contains expansion'] },
        { contains: ['tab to amend'] },
        { contains: ['ctrl+e to explain'] },
      ],
      all: [{ any: [{ lineRegex: [/^\s*❯?\s*yes\b/i] }, { lineRegex: [/^\s*1\.\s*yes\b/i] }, { lineRegex: [/^\s*2\.\s*no\b/i] }] }],
    },
    {
      id: 'generic_permission_prompt', state: 'blocked', priority: 840, region: 'after_last_horizontal_rule',
      contains: ['do you want to proceed?', 'esc to cancel'],
      all: [{
        any: [
          { lineRegex: [/^\s*❯?\s*1\.\s*yes\b/i] },
          { lineRegex: [/^\s*2\.\s*yes\b/i] },
          { lineRegex: [/^\s*2\.\s*no\b/i] },
          { lineRegex: [/^\s*3\.\s*no\b/i] },
        ],
      }],
    },
    {
      id: 'legacy_no_prompt_blocker', state: 'blocked', priority: 300, region: 'whole_recent',
      any: [
        { contains: ['do you want to'], any: [{ contains: ['yes'] }, { contains: ['❯'] }] },
        { contains: ['would you like to'], any: [{ contains: ['yes'] }, { contains: ['❯'] }] },
        { contains: ['waiting for permission'] },
        { contains: ['do you want to allow this connection?'] },
        { contains: ['tab to amend'] },
        { contains: ['ctrl+e to explain'] },
        { contains: ['do you want to proceed?', 'esc to cancel'] },
        { contains: ['review your answers'] },
        { contains: ['skip interview and plan immediately'] },
      ],
      not: [{ regex: [/^\s*❯\s*$/m] }],
    },
    { id: 'osc_title_idle', state: 'idle', priority: 250, region: 'osc_title', regex: [/^\u{2733} /u] },
  ],
}

const codex: AgentManifest = {
  id: 'codex',
  rules: [
    { id: 'osc_title_blocked', state: 'blocked', priority: 1100, region: 'osc_title', contains: ['action required'] },
    { id: 'osc_title_working', state: 'working', priority: 1050, region: 'osc_title', regex: [/(?:^| )[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏](?: |$)/] },
    {
      id: 'transcript_viewer', state: 'unknown', priority: 1000, region: 'after_last_prompt_marker', skipStateUpdate: true,
      contains: ['↑/↓ to scroll', 'pgup/pgdn to', 'home/end to jump', 'q to quit'],
      any: [{ contains: ['esc to edit prev'] }, { contains: ['esc/← to edit prev'] }],
    },
    {
      id: 'trust_directory', state: 'blocked', priority: 950, region: 'top_non_empty_lines(20)',
      all: [
        { regex: [/^> You are in [^\r\n]+(?:\r?\n|$)/] },
        { regex: [/Do\s+you\s+trust\s+the\s+contents\s+of\s+this\s+directory\?/s] },
      ],
    },
    {
      id: 'live_strong_blocker', state: 'blocked', priority: 900, region: 'after_last_prompt_marker',
      any: [
        { contains: ['press enter to confirm or esc to cancel'] },
        { contains: ['enter to submit answer'] },
        { contains: ['enter to submit all'] },
        { contains: ['allow command?'] },
      ],
    },
    {
      id: 'weak_blocker', state: 'blocked', priority: 600, region: 'whole_recent',
      any: [
        { contains: ['[y/n]'] },
        { contains: ['yes (y)'] },
        { contains: ['do you want to'], any: [{ contains: ['yes'] }, { contains: ['❯'] }] },
        { contains: ['would you like to'], any: [{ contains: ['yes'] }, { contains: ['❯'] }] },
      ],
    },
    {
      id: 'screen_working_fallback', state: 'working', priority: 500, region: 'bottom_non_empty_lines(3)',
      lineRegex: [/^[•◦]\s+Working \([^)]*esc to interrupt\)(?: · .*)?$/],
      not: [{ contains: ['■ conversation interrupted'] }],
    },
    {
      id: 'osc_title_idle', state: 'idle', priority: 100, region: 'osc_title',
      regex: [/\S/],
      not: [{ regex: [/(?:^| )[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏](?: |$)/] }, { contains: ['action required'] }],
    },
  ],
}

const gemini: AgentManifest = {
  id: 'gemini',
  rules: [
    {
      id: 'apply_or_allow_change', state: 'blocked', priority: 300, region: 'whole_recent',
      any: [
        { contains: ['│ apply this change'] },
        { contains: ['│ allow execution'] },
        { all: [{ contains: ['yes'] }, { any: [{ contains: ['waiting for user confirmation'] }, { contains: ['│ do you want to proceed'] }, { contains: ['do you want to proceed?'] }] }] },
        { lineRegex: [/^\s*❯.*(yes|allow)/i] },
      ],
    },
    { id: 'esc_cancel_working', state: 'working', priority: 100, region: 'whole_recent', contains: ['esc to cancel'] },
  ],
}

const opencode: AgentManifest = {
  id: 'opencode',
  rules: [
    {
      id: 'permission_required', state: 'blocked', priority: 300, region: 'whole_recent',
      any: [
        { contains: ['△ permission required'] },
        {
          contains: ['esc dismiss'],
          any: [{ contains: ['enter confirm'] }, { contains: ['enter submit'] }, { contains: ['enter toggle'] }],
          all: [{ any: [{ contains: ['↑↓ select'] }, { contains: ['⇆ tab'] }] }],
        },
      ],
    },
    {
      id: 'interrupt_hint_working', state: 'working', priority: 110, region: 'whole_recent',
      any: [
        { contains: ['esc to interrupt'] },
        { contains: ['ctrl+c to interrupt'] },
        { contains: ['press esc to interrupt'] },
        { lineRegex: [/.*opencode.*esc (again to )?interrupt/i] },
      ],
    },
    { id: 'progress_bar_working', state: 'working', priority: 100, region: 'whole_recent', regex: [/(■|⬝){4,}/] },
  ],
}

const copilot: AgentManifest = {
  id: 'github-copilot',
  rules: [
    {
      id: 'selection_blocker', state: 'blocked', priority: 300, region: 'whole_recent',
      all: [
        { any: [{ contains: ['esc to cancel'] }, { contains: ['esc cancel'] }] },
        { any: [{ contains: ['enter to select'] }, { contains: ['enter to confirm'] }, { contains: ['enter to submit'] }, { contains: ['enter accept'] }] },
      ],
    },
    {
      id: 'working_cancel_hint', state: 'working', priority: 100, region: 'whole_recent',
      any: [
        { contains: ['esc to cancel'] },
        { contains: ['esc cancel'] },
        { contains: ['esc again to cancel'] },
        { contains: ['esc interrupt'] },
      ],
    },
  ],
}

const hermes: AgentManifest = {
  id: 'hermes',
  rules: [
    { id: 'osc_title_blocked', state: 'blocked', priority: 1100, region: 'osc_title', regex: [/^⚠[︎️]?(?:\s|$)/] },
    { id: 'osc_title_working', state: 'working', priority: 1050, region: 'osc_title', regex: [/^⏳[︎️]?(?:\s|$)/] },
    {
      id: 'dangerous_command_approval', state: 'blocked', priority: 900, region: 'bottom_non_empty_lines(14)',
      any: [
        { contains: ['dangerous'] },
        { contains: ['approval'] },
        { contains: ['allow once', 'deny'] },
        { lineRegex: [/^\s*[▸>]?\s*1\.\s*allow/i] },
      ],
      all: [{ any: [{ contains: ['enter confirm'] }, { contains: ['enter to confirm'] }, { contains: ['↑/↓ to select'] }, { contains: ['show full command'] }] }],
    },
    {
      id: 'clarification_prompt', state: 'blocked', priority: 900, region: 'bottom_non_empty_lines(14)',
      any: [{ contains: ['hermes needs your'] }, { lineRegex: [/^\s*ask\s+\S/] }, { contains: ['type your answer'] }],
      all: [{ any: [{ contains: ['enter confirm'] }, { contains: ['enter to confirm'] }, { contains: ['enter send'] }, { contains: ['press enter'] }, { contains: ['↑/↓ select'] }, { contains: ['↑/↓ to select'] }, { contains: ['other (type'] }] }],
    },
    {
      id: 'credential_prompt', state: 'blocked', priority: 900, region: 'bottom_non_empty_lines(14)',
      any: [{ contains: ['sudo password'] }, { contains: ['skill setup'] }, { contains: ['🔑', 'for '] }],
    },
    {
      id: 'confirmation_prompt', state: 'blocked', priority: 900, region: 'bottom_non_empty_lines(14)',
      all: [
        { any: [{ contains: ['approve once', 'cancel'] }, { contains: ['start a new session', 'keep going'] }] },
        { any: [{ contains: ['enter to confirm'] }, { contains: ['enter confirm'] }, { contains: ['type 1/2/3'] }, { contains: ['y/n quick'] }] },
      ],
    },
    {
      id: 'interrupt_status_working', state: 'working', priority: 950, region: 'bottom_non_empty_lines(5)',
      any: [{ contains: ['msg=interrupt'] }, { contains: ['ctrl+c to interrupt'] }],
    },
    { id: 'classic_cancel_working', state: 'working', priority: 500, region: 'bottom_non_empty_lines(5)', contains: ['ctrl+c cancel'] },
    { id: 'osc_title_idle', state: 'idle', priority: 100, region: 'osc_title', regex: [/^✓[︎️]?(?:\s|$)/] },
  ],
}

const pi: AgentManifest = {
  id: 'pi',
  rules: [
    { id: 'working_literal', state: 'working', priority: 100, region: 'whole_recent', contains: ['working...'] },
  ],
}

const MANIFESTS: Record<string, AgentManifest> = {
  claude,
  codex,
  gemini,
  opencode,
  'github-copilot': copilot,
  hermes,
  pi,
}

export const SUPPORTED_AGENT_MANIFESTS = Object.keys(MANIFESTS)
