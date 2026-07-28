import { invoke } from '@tauri-apps/api/core'
import { CheckCircle2, Circle, Palette, Type } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { terminalThemeDefinitionById, type TerminalThemeId } from '../state/terminalThemes'
import { applyThemeToDocument } from '../state/themePreview'
import { useWorkspaceStore } from '../state/store'
import { TerminalManager } from '../terminal/TerminalManager'
import { AccountSignIn } from './AccountSignIn'
import { FontPicker } from './FontPicker'
import { ThemePicker } from './ThemePicker'
import { isSetupStepId, setupStepAutoPass, setupStepIds, setupStepTitle, type SetupStepId } from './setupWizardSteps'

export type SetupWizardProps = {
  onComplete: () => void
  onOpenSettings?: () => void
}


export function SetupWizard({ onComplete, onOpenSettings }: SetupWizardProps) {
  const settings = useWorkspaceStore((state) => state.settings)
  const license = useWorkspaceStore((state) => state.license)
  const updateSettings = useWorkspaceStore((state) => state.updateSettings)
  const [stepIndex, setStepIndex] = useState(0)
  const [skippedSteps, setSkippedSteps] = useState<SetupStepId[]>(() => settings.setupWizard.skippedSteps.filter(isSetupStepId))
  const [installedFonts, setInstalledFonts] = useState<string[]>([])
  const [picker, setPicker] = useState<'theme' | 'font' | null>(null)
  const entitled = Boolean(license.status?.entitled)
  const developmentMode = license.status?.state === 'development'
  const step = setupStepIds[stepIndex]
  const selectedTheme = terminalThemeDefinitionById(settings.terminalThemeId)
  const autoPass = useMemo(() => setupStepAutoPass({ entitled }), [entitled])

  useEffect(() => {
    let cancelled = false
    void invoke<string[]>('list_installed_fonts')
      .then((fonts) => { if (!cancelled) setInstalledFonts(fonts) })
      .catch(() => { if (!cancelled) setInstalledFonts([]) })
    return () => { cancelled = true }
  }, [])

  const skipCurrent = () => {
    if (!skippedSteps.includes(step)) setSkippedSteps((current) => [...current, step])
    if (step === 'finish') finish()
    else setStepIndex((index) => Math.min(setupStepIds.length - 1, index + 1))
  }

  const next = () => {
    let nextIndex = Math.min(setupStepIds.length - 1, stepIndex + 1)
    while (nextIndex < setupStepIds.length - 1 && autoPass[setupStepIds[nextIndex]]) nextIndex += 1
    setStepIndex(nextIndex)
  }

  const finish = () => {
    updateSettings({
      setupWizard: {
        ...settings.setupWizard,
        completedAt: new Date().toISOString(),
        skippedSteps,
      },
    })
    onComplete()
  }

  const finishAndOpenSettings = () => {
    finish()
    onOpenSettings?.()
  }

  const skipEverything = () => {
    updateSettings({
      setupWizard: {
        ...settings.setupWizard,
        completedAt: new Date().toISOString(),
        skippedSteps: setupStepIds.filter((id) => id !== 'finish'),
      },
    })
    onComplete()
  }

  const previewTheme = (themeId: TerminalThemeId) => {
    applyThemeToDocument(themeId, settings.selectedPaneHighlightColor, settings.alarmHighlightColor, settings.reviewedPaneHighlightColor)
    TerminalManager.previewTheme(themeId)
  }

  const selectTheme = (themeId: TerminalThemeId) => {
    updateSettings({ terminalThemeId: themeId })
    previewTheme(themeId)
    setPicker(null)
  }

  const cancelThemePicker = () => {
    applyThemeToDocument(settings.terminalThemeId, settings.selectedPaneHighlightColor, settings.alarmHighlightColor, settings.reviewedPaneHighlightColor)
    TerminalManager.previewTheme(null)
    setPicker(null)
  }

  const selectFont = (fontFamily: string) => {
    updateSettings({ fontFamily })
    TerminalManager.previewFont(fontFamily)
    setPicker(null)
  }

  return (
    <div className="setup-wizard-backdrop" role="presentation">
      <section className="setup-wizard" role="dialog" aria-modal="true" aria-labelledby="setup-wizard-title">
        <aside className="setup-wizard-steps" aria-label="Setup progress">
          <p className="settings-eyebrow">First-run setup</p>
          {setupStepIds.map((id, index) => {
            const complete = index < stepIndex || Boolean(autoPass[id])
            return (
              <div key={id} className={index === stepIndex ? 'active' : undefined}>
                {complete ? <CheckCircle2 size={15} /> : <Circle size={15} />}
                <span>{setupStepTitle(id)}</span>
              </div>
            )
          })}
        </aside>
        <main className="setup-wizard-content">
          <header>
            <div>
              <p className="settings-eyebrow">Step {stepIndex + 1} of {setupStepIds.length}</p>
              <h2 id="setup-wizard-title">{setupStepTitle(step)}</h2>
            </div>
            {step !== 'finish' ? <button type="button" className="setup-skip-link" onClick={skipCurrent}>Skip setup</button> : null}
          </header>

          {step === 'welcome' ? (
            <div className="setup-wizard-panel">
              <h3>Make VibeLink yours in a few quick steps.</h3>
              <p>Connect your account and choose a theme and terminal font. Agent CLI sign-in, Hermes, and MCP checks can wait until you need them.</p>
              <div className="setup-wizard-actions">
                <button type="button" className="primary-action" onClick={next}>Start setup</button>
                <button type="button" onClick={skipEverything}>Skip everything</button>
              </div>
            </div>
          ) : null}

          {step === 'account' ? (
            <div className="setup-wizard-panel">
              {developmentMode ? (
                <>
                  <h3>Development entitlement is active.</h3>
                  <p>Account and trial checks are skipped only in this debug build. Release builds still require a Moobang account entitlement.</p>
                </>
              ) : (
                <>
                  <AccountSignIn onActivated={next} />
                  <p>Sign in with your Moobang account to start your 7-day free trial. Every feature is unlocked during the trial.</p>
                </>
              )}
              <div className="setup-wizard-actions">
                <button type="button" className="primary-action" disabled={!entitled} onClick={next}>Continue</button>
              </div>
            </div>
          ) : null}

          {step === 'appearance' ? (
            <div className="setup-wizard-panel">
              <p>Choose the color theme and terminal font you want to start with. Selections apply immediately across VibeLink.</p>
              <div className="setup-appearance-grid">
                <section>
                  <Palette size={18} aria-hidden="true" />
                  <div>
                    <span>Color theme</span>
                    <strong>{selectedTheme.name}</strong>
                    <small>{selectedTheme.description}</small>
                  </div>
                  <button type="button" onClick={() => { previewTheme(settings.terminalThemeId); setPicker('theme') }}>Choose theme…</button>
                </section>
                <section>
                  <Type size={18} aria-hidden="true" />
                  <div>
                    <span>Terminal font</span>
                    <strong>{settings.fontFamily}</strong>
                    <small>Used by every terminal pane.</small>
                  </div>
                  <button type="button" onClick={() => { TerminalManager.previewFont(settings.fontFamily); setPicker('font') }}>Choose font…</button>
                </section>
              </div>
              <div className="setup-wizard-actions">
                <button type="button" className="primary-action" onClick={next}>Continue</button>
              </div>
            </div>
          ) : null}

          {step === 'finish' ? (
            <div className="setup-wizard-panel">
              <h3>VibeLink is ready.</h3>
              <ul className="setup-finish-summary">
                <li>{developmentMode ? 'Development entitlement active' : entitled ? 'Moobang account connected' : 'Account setup skipped'}</li>
                <li>Theme: {selectedTheme.name}</li>
                <li>Terminal font: {settings.fontFamily}</li>
              </ul>
              <p>Advanced setup for Agent CLI sign-in, Hermes models and authentication, and MCP checks is available later in Settings.</p>
              <div className="setup-wizard-actions">
                <button type="button" className="primary-action" onClick={finish}>Finish</button>
                {onOpenSettings ? <button type="button" onClick={finishAndOpenSettings}>Open Settings</button> : null}
              </div>
            </div>
          ) : null}
        </main>
      </section>
      {picker === 'theme' ? (
        <ThemePicker
          value={settings.terminalThemeId}
          onPreview={previewTheme}
          onSelect={selectTheme}
          onCancel={cancelThemePicker}
        />
      ) : null}
      {picker === 'font' ? (
        <FontPicker
          value={settings.fontFamily}
          installedFonts={installedFonts}
          onPreview={(fontFamily) => TerminalManager.previewFont(fontFamily)}
          onSelect={selectFont}
          onCancel={() => {
            TerminalManager.previewFont(null)
            setPicker(null)
          }}
        />
      ) : null}
    </div>
  )
}
