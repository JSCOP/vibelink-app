import { invoke } from '@tauri-apps/api/core'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import {
  AutomationRpcError,
  cancelAutomationRun,
  cancelAutomationDraft,
  createAutomation,
  createAutomationDraftRequestId,
  deleteAutomation,
  importAutomationJobs,
  listAutomationRuns,
  listAutomations,
  normalizeAutomationRpcError,
  precheckAutomation,
  previewAutomationDraft,
  previewAutomationImport,
  previewAutomationSchedule,
  runAutomation,
  updateAutomation,
  type AutomationRecord,
  type AutomationRunRecord,
  type CreateAutomationInput,
  type ImportAutomationJobsInput,
  type UpdateAutomationInput,
} from './automations'

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}))

const AUTOMATION_RECORD_FIXTURE: AutomationRecord = {
  id: 'auto-1',
  sessionId: 'sess-1',
  name: 'Job 1',
  prompt: 'Run test',
  agent: 'hermes',
  provider: null,
  model: null,
  useAgentDefaultModel: true,
  toolsets: ['hermes-acp'],
  skills: [],
  maxTurns: 10,
  timeoutSeconds: 1_800,
  scheduleKind: 'daily',
  scheduleValue: '09:00',
  timezone: 'UTC',
  dtstart: 100,
  nextRunAt: 200,
  lastRunAt: null,
  enabled: true,
  requiresReview: false,
  missedRunGraceMinutes: 720,
  missedRunPolicy: 'run_once_within_grace',
  workspaceMode: 'new_per_run',
  worktreeStorage: { mode: 'appData', drive: '', folderName: 'VibeLinkWorktrees', customRoot: '', groupByRepository: true },
  baseRef: null,
  precheck: { command: null, timeoutSeconds: 60, requireWorkspace: true, requireGit: false },
  source: null,
  createdAt: 100,
  updatedAt: 100,
}

describe('automations IPC wrapper', () => {
  const mockInvoke = vi.mocked(invoke)

  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('simple actions using correct CLI argv', () => {
    test('listAutomations without sessionId passes []', async () => {
      const records: AutomationRecord[] = [AUTOMATION_RECORD_FIXTURE]
      mockInvoke.mockResolvedValueOnce(records)

      const res = await listAutomations()
      expect(mockInvoke).toHaveBeenCalledTimes(1)
      expect(mockInvoke).toHaveBeenCalledWith('cli_request', {
        args: ['automation', 'list'],
      })
      expect(res).toEqual(records)
    })

    test('listAutomations with sessionId passes --workspace', async () => {
      mockInvoke.mockResolvedValueOnce([])

      const res = await listAutomations('sess-123')
      expect(mockInvoke).toHaveBeenCalledWith('cli_request', {
        args: ['automation', 'list', '--workspace', 'sess-123'],
      })
      expect(res).toEqual([])
    })

    test('deleteAutomation passes --id', async () => {
      const expectedResult = { id: 'auto-1', deleted: true }
      mockInvoke.mockResolvedValueOnce(expectedResult)

      const res = await deleteAutomation('auto-1')
      expect(mockInvoke).toHaveBeenCalledWith('cli_request', {
        args: ['automation', 'delete', '--id', 'auto-1'],
      })
      expect(res).toEqual(expectedResult)
    })

    test('runAutomation passes --id', async () => {
      const runRecord: Partial<AutomationRunRecord> = {
        id: 'run-1',
        automationId: 'auto-1',
        status: 'pending',
      }
      mockInvoke.mockResolvedValueOnce(runRecord)

      const res = await runAutomation('auto-1')
      expect(mockInvoke).toHaveBeenCalledWith('cli_request', {
        args: ['automation', 'run', '--id', 'auto-1'],
      })
      expect(res).toEqual(runRecord)
    })

    test('listAutomationRuns passes --id and optional --limit', async () => {
      mockInvoke.mockResolvedValueOnce([])

      await listAutomationRuns('auto-1')
      expect(mockInvoke).toHaveBeenCalledWith('cli_request', {
        args: ['automation', 'runs', '--id', 'auto-1'],
      })

      mockInvoke.mockResolvedValueOnce([])
      await listAutomationRuns('auto-1', 10)
      expect(mockInvoke).toHaveBeenCalledWith('cli_request', {
        args: ['automation', 'runs', '--id', 'auto-1', '--limit', '10'],
      })
    })

    test('precheckAutomation passes --id', async () => {
      const precheckRes = {
        stdout: 'ok',
        stderr: '',
        exitCode: 0,
        timedOut: false,
        durationMs: 120,
        truncated: false,
      }
      mockInvoke.mockResolvedValueOnce(precheckRes)

      const res = await precheckAutomation('auto-1')
      expect(mockInvoke).toHaveBeenCalledWith('cli_request', {
        args: ['--request-timeout-seconds', '600', 'automation', 'precheck', '--id', 'auto-1'],
      })
      expect(res).toEqual(precheckRes)
    })

    test('cancelAutomationRun passes --id', async () => {
      const runRecord: Partial<AutomationRunRecord> = {
        id: 'run-1',
        automationId: 'auto-1',
        status: 'cancelled',
      }
      mockInvoke.mockResolvedValueOnce(runRecord)

      const res = await cancelAutomationRun('run-1')
      expect(mockInvoke).toHaveBeenCalledWith('cli_request', {
        args: ['automation', 'cancel', '--id', 'run-1'],
      })
      expect(res).toEqual(runRecord)
    })

    test('cancelAutomationDraft cancels the exact request id', async () => {
      const requestId = '33e7e588-9842-44c1-94e7-c77819718d11'
      const expectedResult = { id: requestId, cancelled: true }
      mockInvoke.mockResolvedValueOnce(expectedResult)

      const res = await cancelAutomationDraft(requestId)
      expect(mockInvoke).toHaveBeenCalledWith('cli_request', {
        args: ['automation', 'draft-cancel', '--id', requestId],
      })
      expect(res).toEqual(expectedResult)
    })

    test('createAutomationDraftRequestId creates a UUID for preview ownership', () => {
      expect(createAutomationDraftRequestId()).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      )
    })

    test('previewAutomationImport passes --workspace', async () => {
      const previewRes = { candidates: [], warnings: [] }
      mockInvoke.mockResolvedValueOnce(previewRes)

      const res = await previewAutomationImport('sess-1')
      expect(mockInvoke).toHaveBeenCalledWith('cli_request', {
        args: ['automation', 'import-preview', '--workspace', 'sess-1'],
      })
      expect(res).toEqual(previewRes)
    })
  })

  describe('complex actions passing exactly one serialized --json payload', () => {
    test('createAutomation passes --workspace and --json payload', async () => {
      const input: CreateAutomationInput = {
        name: 'New Job',
        prompt: 'Check build',
        scheduleKind: 'daily',
        scheduleValue: '08:00',
        timezone: 'Asia/Seoul',
      }
      const record: Partial<AutomationRecord> = { id: 'auto-new', name: 'New Job' }
      mockInvoke.mockResolvedValueOnce(record)

      const res = await createAutomation('sess-99', input)
      expect(mockInvoke).toHaveBeenCalledTimes(1)
      expect(mockInvoke).toHaveBeenCalledWith('cli_request', {
        args: [
          'automation',
          'create',
          '--workspace',
          'sess-99',
          '--json',
          JSON.stringify(input),
        ],
      })
      expect(res).toEqual(record)
    })

    test('updateAutomation passes --id and --json payload', async () => {
      const input: UpdateAutomationInput = {
        name: 'Updated Job',
        enabled: false,
      }
      const record: Partial<AutomationRecord> = { id: 'auto-1', name: 'Updated Job', enabled: false }
      mockInvoke.mockResolvedValueOnce(record)

      const res = await updateAutomation('auto-1', input)
      expect(mockInvoke).toHaveBeenCalledWith('cli_request', {
        args: [
          'automation',
          'update',
          '--id',
          'auto-1',
          '--json',
          JSON.stringify(input),
        ],
      })
      expect(res).toEqual(record)
    })

    test('previewAutomationSchedule sends one JSON payload', async () => {
      const input = {
        scheduleKind: 'weekdays' as const,
        scheduleValue: '09:00',
        timezone: 'Asia/Seoul',
        count: 5,
      }
      const occurrences = [100, 200, 300, 400, 500]
      mockInvoke.mockResolvedValueOnce(occurrences)

      expect(await previewAutomationSchedule(input)).toEqual(occurrences)
      expect(mockInvoke).toHaveBeenCalledWith('cli_request', {
        args: ['automation', 'schedule-preview', '--json', JSON.stringify(input)],
      })
    })

    test('importAutomationJobs passes --workspace and --json payload', async () => {
      const input: ImportAutomationJobsInput = {
        jobs: [{ sourceId: 'src-1', sourceHash: 'hash-1' }],
      }
      const importRes = { imported: 1, skipped: 0, warnings: [] }
      mockInvoke.mockResolvedValueOnce(importRes)

      const res = await importAutomationJobs('sess-1', input)
      expect(mockInvoke).toHaveBeenCalledWith('cli_request', {
        args: [
          'automation',
          'import',
          '--workspace',
          'sess-1',
          '--json',
          JSON.stringify(input),
        ],
      })
      expect(res).toEqual(importRes)
    })

    test('previewAutomationDraft passes requestId in exactly one --json payload', async () => {
      const requestId = '33e7e588-9842-44c1-94e7-c77819718d11'
      const input = {
        requestId,
        request: 'Run daily check',
        current: {
          name: 'Old',
          prompt: 'Old prompt',
          schedule: { kind: 'daily' as const, value: '09:00', timezone: 'UTC' },
          precheckCommand: null,
        },
      }
      const draftRes = {
        requestId,
        name: 'Daily Check',
        prompt: 'Run daily check',
        schedule: { kind: 'daily', value: '09:00', timezone: 'UTC' as const },
        precheckCommand: null,
        notes: [],
      }
      mockInvoke.mockResolvedValueOnce(draftRes)

      const res = await previewAutomationDraft('sess-1', input)
      expect(mockInvoke).toHaveBeenCalledTimes(1)
      expect(mockInvoke).toHaveBeenCalledWith('cli_request', {
        args: [
          '--request-timeout-seconds',
          '180',
          'automation',
          'draft-preview',
          '--workspace',
          'sess-1',
          '--json',
          JSON.stringify(input),
        ],
      })
      expect(res).toEqual(draftRes)
      expect(res.requestId).toBe(requestId)
    })
  })

  describe('CLI request timeout', () => {
    test('only the long daemon actions raise it above the 10s CLI default', async () => {
      for (let index = 0; index < 6; index += 1) mockInvoke.mockResolvedValueOnce({})

      await previewAutomationDraft('sess-1', { request: 'Run daily check' })
      await precheckAutomation('auto-1')
      await listAutomations('sess-1')
      await createAutomation('sess-1', {
        name: 'New Job',
        prompt: 'Check build',
        scheduleKind: 'daily',
        scheduleValue: '08:00',
        timezone: 'UTC',
      })
      await updateAutomation('auto-1', { enabled: false })
      await deleteAutomation('auto-1')

      const argvOf = (payload: unknown): string[] => {
        if (!payload || typeof payload !== 'object' || !('args' in payload) || !Array.isArray(payload.args)) {
          throw new Error('cli_request was invoked without an argv payload')
        }
        return payload.args
      }
      const argv = mockInvoke.mock.calls.map((call) => argvOf(call[1]))
      expect(argv[0].slice(0, 3)).toEqual(['--request-timeout-seconds', '180', 'automation'])
      expect(argv[1].slice(0, 3)).toEqual(['--request-timeout-seconds', '600', 'automation'])
      for (const args of argv.slice(2)) {
        expect(args).not.toContain('--request-timeout-seconds')
        expect(args[0]).toBe('automation')
      }
    })
  })

  describe('returned camelCase data is passed through', () => {
    test('passes returned backend object without modification', async () => {
      const backendResponse: AutomationRecord[] = [{
        ...AUTOMATION_RECORD_FIXTURE,
        id: 'auto-100',
        sessionId: 'sess-abc',
        name: 'Camel Case Test',
        prompt: 'do work',
        model: 'hermes-model',
        useAgentDefaultModel: false,
        skills: ['skill-1'],
        maxTurns: 5,
        timeoutSeconds: 300,
        scheduleKind: 'hourly',
        scheduleValue: '1',
        timezone: 'America/New_York',
        workspaceMode: 'existing',
        createdAt: 1000,
        updatedAt: 2000,
      }]
      mockInvoke.mockResolvedValueOnce(backendResponse)

      const res = await listAutomations('sess-abc')
      expect(res).toEqual(backendResponse)
      expect(res[0]?.sessionId).toBe('sess-abc')
      expect(res[0]?.workspaceMode).toBe('existing')
    })
  })

  describe('native failure normalization to AutomationRpcError', () => {
    test('normalizes raw JSON error string from Tauri invoke', async () => {
      const jsonErr = JSON.stringify({
        code: 'invalid_schedule',
        message: 'Cron expression invalid',
        details: { field: 'schedule.value' },
      })
      mockInvoke.mockRejectedValueOnce(jsonErr)

      try {
        await runAutomation('auto-1')
        expect.unreachable('Should have thrown')
      } catch (err) {
        expect(err).toBeInstanceOf(AutomationRpcError)
        const rpcErr = err as AutomationRpcError
        expect(rpcErr.code).toBe('invalid_schedule')
        expect(rpcErr.message).toBe('Cron expression invalid')
        expect(rpcErr.details).toEqual({ field: 'schedule.value' })
      }
    })

    test('normalizes plain Error object from Tauri invoke', async () => {
      mockInvoke.mockRejectedValueOnce(new Error('Tauri connection failed'))

      try {
        await listAutomations()
        expect.unreachable('Should have thrown')
      } catch (err) {
        expect(err).toBeInstanceOf(AutomationRpcError)
        const rpcErr = err as AutomationRpcError
        expect(rpcErr.code).toBe('internal_failure')
        expect(rpcErr.message).toBe('Tauri connection failed')
      }
    })

    test('normalizes plain string failure from Tauri invoke', async () => {
      mockInvoke.mockRejectedValueOnce('Something went wrong')

      try {
        await precheckAutomation('auto-1')
        expect.unreachable('Should have thrown')
      } catch (err) {
        expect(err).toBeInstanceOf(AutomationRpcError)
        const rpcErr = err as AutomationRpcError
        expect(rpcErr.code).toBe('internal_failure')
        expect(rpcErr.message).toBe('Something went wrong')
      }
    })

    test('normalizes non-error objects gracefully', async () => {
      const errObj = { code: 'custom_code', message: 'Custom message', details: [1, 2] }
      mockInvoke.mockRejectedValueOnce(errObj)

      try {
        await deleteAutomation('auto-1')
        expect.unreachable('Should have thrown')
      } catch (err) {
        expect(err).toBeInstanceOf(AutomationRpcError)
        const rpcErr = err as AutomationRpcError
        expect(rpcErr.code).toBe('custom_code')
        expect(rpcErr.message).toBe('Custom message')
        expect(rpcErr.details).toEqual([1, 2])
      }
    })

    test('re-throws AutomationRpcError directly without double wrapping', () => {
      const original = new AutomationRpcError('already_normalized', 'Already fine', { key: 'val' })
      const normalized = normalizeAutomationRpcError(original)
      expect(normalized).toBe(original)
    })
  })
})
