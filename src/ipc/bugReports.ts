import { invoke } from '@tauri-apps/api/core'

export type BugReportInput = {
  category: 'crash' | 'terminal' | 'agent' | 'account' | 'billing' | 'remote' | 'other'
  title: string
  description: string
  stepsToReproduce: string | null
  contactAllowed: boolean
}

export type BugReportCreated = {
  id: string
  createdAt: string
}

export function submitBugReport(input: BugReportInput): Promise<BugReportCreated> {
  return invoke<BugReportCreated>('bug_report_submit', { input })
}
