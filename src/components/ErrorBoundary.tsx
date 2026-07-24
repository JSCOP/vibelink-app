import { Component, type CSSProperties, type ErrorInfo, type ReactNode } from 'react'

type ErrorBoundaryProps = {
  children: ReactNode
  fallback?: (error: Error) => ReactNode
  label?: string
  resetKey?: string | number | null
}

type ErrorBoundaryState = {
  error: Error | null
}

const fallbackStyle: CSSProperties = {
  display: 'grid',
  gap: 6,
  alignContent: 'start',
  padding: 12,
  color: 'var(--vibelink-text)',
  background: 'var(--vibelink-panel)',
  font: '12px/1.4 var(--vibelink-sans)',
}

const fallbackMessageStyle: CSSProperties = {
  color: 'var(--vibelink-muted)',
  overflowWrap: 'anywhere',
}

const retryButtonStyle: CSSProperties = {
  justifySelf: 'start',
  marginTop: 4,
  padding: '5px 10px',
  color: 'var(--vibelink-text)',
  background: 'var(--vibelink-input)',
  border: '1px solid var(--vibelink-border)',
  borderRadius: 4,
  cursor: 'pointer',
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('VibeLink panel crashed', error, info)
  }

  componentDidUpdate(previousProps: ErrorBoundaryProps): void {
    if (this.state.error && previousProps.resetKey !== this.props.resetKey) {
      this.setState({ error: null })
    }
  }

  private retry = (): void => {
    this.setState({ error: null })
  }

  render(): ReactNode {
    if (this.state.error) return this.props.fallback?.(this.state.error) ?? this.renderDefaultFallback(this.state.error)
    return this.props.children
  }

  private renderDefaultFallback(error: Error): ReactNode {
    const label = this.props.label ?? 'Panel'
    return (
      <div role="alert" style={fallbackStyle}>
        <strong>{label} crashed</strong>
        <span style={fallbackMessageStyle}>{error.message || String(error)}</span>
        <button type="button" style={retryButtonStyle} aria-label={`Retry ${label}`} onClick={this.retry}>Retry</button>
      </div>
    )
  }
}
