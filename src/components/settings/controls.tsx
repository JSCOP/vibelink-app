import { CircleHelp, type LucideProps } from 'lucide-react'
import type { ComponentType, ReactNode } from 'react'
import './settings.css'

export type SettingsIcon = ComponentType<LucideProps>

/**
 * One settings card: icon + short title, optional status slot on the right.
 * Explanations belong in `hint` (a tooltip), never as a paragraph of body copy —
 * the whole point of this surface is that a row is scannable at a glance.
 */
export function SettingsCard({
  icon: Icon,
  title,
  hint,
  status,
  children,
}: {
  icon: SettingsIcon
  title: string
  hint?: string
  status?: ReactNode
  children: ReactNode
}) {
  return (
    <section className="vl-set-card">
      <header className="vl-set-card-head">
        <Icon size={14} strokeWidth={1.9} aria-hidden="true" />
        <h3>
          <span>{title}</span>
          {hint ? (
            <span className="vl-set-hint" title={hint} aria-label={hint} role="note">
              <CircleHelp size={12} strokeWidth={1.9} aria-hidden="true" />
            </span>
          ) : null}
        </h3>
        {status ?? <span />}
      </header>
      <div className="vl-set-card-body">{children}</div>
    </section>
  )
}

/**
 * A labelled row. `control` is right-aligned so a column of rows reads as one
 * vertical strip of on/off states and values. `stacked` gives wide controls
 * (sliders, long inputs) the full row width instead.
 */
export function SettingsRow({
  icon: Icon,
  label,
  sub,
  subMono,
  hint,
  stacked,
  control,
}: {
  icon: SettingsIcon
  label: string
  sub?: string
  subMono?: boolean
  hint?: string
  stacked?: boolean
  control: ReactNode
}) {
  return (
    <div className={stacked ? 'vl-set-row vl-set-row-stacked' : 'vl-set-row'}>
      <span className="vl-set-row-icon">
        <Icon size={14} strokeWidth={1.9} aria-hidden="true" />
      </span>
      <span className="vl-set-row-label">
        <span>{label}</span>
        {hint ? (
          <span className="vl-set-hint" title={hint} aria-label={hint} role="note">
            <CircleHelp size={11} strokeWidth={1.9} aria-hidden="true" />
          </span>
        ) : null}
      </span>
      <span className="vl-set-row-control">{control}</span>
      {sub ? <span className={subMono ? 'vl-set-row-sub mono' : 'vl-set-row-sub'} title={sub}>{sub}</span> : null}
    </div>
  )
}

/**
 * ON/OFF switch. The literal state word is rendered beside the track because a
 * bare checkbox forces users to decode "checked" — the request was that on/off
 * be readable at a glance.
 */
export function SettingsSwitch({
  label,
  checked,
  disabled,
  onChange,
}: {
  label: string
  checked: boolean
  disabled?: boolean
  onChange?: (checked: boolean) => void
}) {
  return (
    <span className="vl-set-switch" data-on={checked ? 'true' : 'false'}>
      <span className="vl-set-switch-state" aria-hidden="true">{checked ? 'ON' : 'OFF'}</span>
      <span className="vl-set-switch-box">
        <input
          type="checkbox"
          role="switch"
          aria-label={label}
          checked={checked}
          disabled={disabled || !onChange}
          onChange={(event) => onChange?.(event.target.checked)}
        />
        <span className="vl-set-switch-track" aria-hidden="true">
          <span className="vl-set-switch-thumb" />
        </span>
      </span>
    </span>
  )
}

export type SegmentedOption<T extends string> = {
  value: T
  label: string
  icon?: SettingsIcon
  hint?: string
}

/**
 * Two-to-four mutually exclusive choices rendered as one visible strip. Use a
 * `<select>` instead once the list is long enough to need scrolling.
 */
export function SettingsSegmented<T extends string>({
  label,
  value,
  options,
  disabled,
  onChange,
}: {
  label: string
  value: T
  options: SegmentedOption<T>[]
  disabled?: boolean
  onChange: (value: T) => void
}) {
  return (
    <span className="vl-set-seg" role="group" aria-label={label}>
      {options.map((option) => {
        const Icon = option.icon
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={option.value === value}
            title={option.hint ?? option.label}
            disabled={disabled}
            onClick={() => onChange(option.value)}
          >
            {Icon ? <Icon size={13} strokeWidth={1.9} aria-hidden="true" /> : null}
            {option.label}
          </button>
        )
      })}
    </span>
  )
}

export function SettingsSelect({
  label,
  value,
  disabled,
  onChange,
  children,
}: {
  label: string
  value: string
  disabled?: boolean
  onChange: (value: string) => void
  children: ReactNode
}) {
  return (
    <select
      className="vl-set-select"
      aria-label={label}
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value)}
    >
      {children}
    </select>
  )
}

export function SettingsNumber({
  label,
  value,
  min,
  max,
  step,
  disabled,
  onChange,
}: {
  label: string
  value: number
  min?: number
  max?: number
  step?: number
  disabled?: boolean
  onChange: (value: number) => void
}) {
  return (
    <input
      className="vl-set-input vl-set-input-sm"
      type="number"
      aria-label={label}
      value={value}
      min={min}
      max={max}
      step={step}
      disabled={disabled}
      onChange={(event) => onChange(Number(event.target.value))}
    />
  )
}

export function SettingsText({
  label,
  value,
  placeholder,
  mono,
  disabled,
  onChange,
}: {
  label: string
  value: string
  placeholder?: string
  mono?: boolean
  disabled?: boolean
  onChange: (value: string) => void
}) {
  return (
    <input
      className={mono ? 'vl-set-input mono' : 'vl-set-input'}
      aria-label={label}
      value={value}
      placeholder={placeholder}
      spellCheck={false}
      autoComplete="off"
      disabled={disabled}
      onChange={(event) => onChange(event.target.value)}
    />
  )
}

export function SettingsValue({ value, mono, title }: { value: string; mono?: boolean; title?: string }) {
  return <span className={mono ? 'vl-set-row-value mono' : 'vl-set-row-value'} title={title ?? value}>{value}</span>
}

export function SettingsPill({ tone, icon: Icon, children }: { tone?: 'ok' | 'warn' | 'danger'; icon?: SettingsIcon; children: ReactNode }) {
  return (
    <span className="vl-set-pill" data-tone={tone}>
      {Icon ? <Icon size={11} strokeWidth={2} aria-hidden="true" /> : null}
      {children}
    </span>
  )
}

export function SettingsButton({
  icon: Icon,
  label,
  tone,
  title,
  disabled,
  onClick,
}: {
  icon?: SettingsIcon
  label: string
  tone?: 'accent' | 'danger'
  title?: string
  disabled?: boolean
  onClick: () => void
}) {
  return (
    <button type="button" className="vl-set-button" data-tone={tone} title={title ?? label} disabled={disabled} onClick={onClick}>
      {Icon ? <Icon size={13} strokeWidth={1.9} aria-hidden="true" /> : null}
      {label}
    </button>
  )
}

export function SettingsIconButton({
  icon: Icon,
  label,
  tone,
  disabled,
  onClick,
}: {
  icon: SettingsIcon
  label: string
  tone?: 'danger'
  disabled?: boolean
  onClick: () => void
}) {
  return (
    <button type="button" className="vl-set-button" data-tone={tone} title={label} aria-label={label} disabled={disabled} onClick={onClick} style={{ padding: '0 7px' }}>
      <Icon size={13} strokeWidth={1.9} aria-hidden="true" />
    </button>
  )
}

export function SettingsMessage({ tone, icon: Icon, children }: { tone?: 'ok' | 'danger'; icon?: SettingsIcon; children: ReactNode }) {
  return (
    <div className="vl-set-message" data-tone={tone} role="status">
      {Icon ? <Icon size={13} strokeWidth={1.9} aria-hidden="true" /> : <span />}
      <span>{children}</span>
    </div>
  )
}
