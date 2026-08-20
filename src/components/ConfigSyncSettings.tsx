import { invoke } from '@tauri-apps/api/core'
import { useEffect, useState } from 'react'
import { CloudDownload, CloudUpload, FolderSync, RefreshCw } from 'lucide-react'
import { SettingsButton, SettingsCard, SettingsIconButton, SettingsMessage, SettingsPill, SettingsRow, SettingsValue } from './settings/controls'

type ConfigSyncStatus = {
  signedIn: boolean
  remoteRevision: number | null
  remoteUpdatedBy: string | null
  lastPushedRevision: number | null
  lastPulledRevision: number | null
  vars: Record<string, string>
  pins: Record<string, string[]>
  entries: Array<{ id: string; target: string; exists: boolean }>
}

/** Account-scoped agent-config sync: one click to publish this machine's
 *  Claude/Codex/Hermes/OMP configs to the signed-in account and one click to
 *  apply them on another machine. Machine-specific values (proxy address,
 *  home paths) stay per machine; the templates merge by structure. */
export function ConfigSyncSettings() {
  const [status, setStatus] = useState<ConfigSyncStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [proxyBase, setProxyBase] = useState('')

  const refresh = async () => {
    try {
      const next = await invoke<ConfigSyncStatus>('config_sync_status')
      setStatus(next)
      setProxyBase(next.vars.PROXY_BASE ?? '')
    } catch (error) {
      setMessage(String(error))
    }
  }

  useEffect(() => {
    // Defer the initial status fetch out of the effect body so setState runs
    // from the async continuation, not synchronously inside the effect.
    const timer = window.setTimeout(() => { void refresh() }, 0)
    return () => window.clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const run = async (task: () => Promise<string>) => {
    setBusy(true)
    setMessage(null)
    try {
      setMessage(await task())
    } catch (error) {
      setMessage(String(error))
    } finally {
      setBusy(false)
      void refresh()
    }
  }

  const push = () => void run(async () => {
    const revision = await invoke<number>('config_sync_push')
    return `이 PC의 설정을 계정에 올렸습니다 (revision ${revision}). 다른 PC에서 "가져와 적용"을 누르세요.`
  })

  const pull = () => void run(async () => {
    const result = await invoke<{ revision: number; applied: string[] }>('config_sync_pull')
    return result.applied.length > 0
      ? `revision ${result.revision} 적용: ${result.applied.join(', ')} (이전 파일은 .bak). 에이전트 CLI를 재시작하세요.`
      : `이미 최신 상태입니다 (revision ${result.revision}).`
  })

  const saveProxy = () => void run(async () => {
    await invoke('config_sync_set_var', { name: 'PROXY_BASE', value: proxyBase })
    return '이 PC의 PROXY_BASE를 저장했습니다.'
  })

  const syncedCount = status?.entries.filter((entry) => entry.exists).length ?? 0

  return (
    <SettingsCard
      icon={FolderSync}
      title="설정 동기화 (계정)"
      hint="Claude Code · Codex · Hermes · OMP 설정을 계정에 저장하고 다른 PC에서 그대로 적용합니다. 프록시 주소·홈 경로 같은 머신별 값은 PC마다 유지되고, 템플릿 변경은 구조(JSON 경로) 기준으로 병합되며 적용 전에 무결성 검사를 통과해야 합니다. API 키는 절대 서버로 가지 않습니다."
      status={<SettingsIconButton icon={RefreshCw} label="동기화 상태 새로고침" disabled={busy} onClick={() => void refresh()} />}
    >
      <SettingsRow
        icon={CloudUpload}
        label="계정 상태"
        control={status
          ? status.signedIn
            ? <SettingsPill tone="ok">로그인됨 · 서버 revision {status.remoteRevision ?? '없음'}{status.remoteUpdatedBy ? ` (${status.remoteUpdatedBy}에서 올림)` : ''}</SettingsPill>
            : <SettingsPill tone="warn">Account 섹션에서 먼저 로그인하세요</SettingsPill>
          : <SettingsValue value="확인 중…" />}
      />
      <SettingsRow
        icon={CloudUpload}
        label="이 PC 설정 올리기"
        sub={`감지된 설정 ${syncedCount}개 (Claude/Codex/Hermes/OMP)`}
        control={<SettingsButton disabled={busy || !status?.signedIn} label="올리기" onClick={push} />}
      />
      <SettingsRow
        icon={CloudDownload}
        label="계정 설정 가져와 적용"
        sub="적용 전 형식 검사, 기존 파일은 .bak으로 백업"
        control={<SettingsButton disabled={busy || !status?.signedIn} label="가져와 적용" onClick={pull} />}
      />
      <SettingsRow
        icon={FolderSync}
        label="이 PC의 프록시 주소 (PROXY_BASE)"
        sub="모델 프로바이더가 바라보는 CLIProxyAPI 주소 — PC마다 다르게 유지됩니다"
        control={(
          <span className="config-sync-var">
            <input
              className="vl-set-input"
              disabled={busy}
              onBlur={saveProxy}
              onChange={(event) => setProxyBase(event.target.value)}
              onKeyDown={(event) => { if (event.key === 'Enter') saveProxy() }}
              placeholder="http://127.0.0.1:8317"
              value={proxyBase}
            />
          </span>
        )}
      />
      {message ? <SettingsMessage>{message}</SettingsMessage> : null}
    </SettingsCard>
  )
}
