import { Component, type CSSProperties, type ErrorInfo, type ReactNode } from 'react'

type ErrorBoundaryProps = {
  children: ReactNode
  fallback?: (error: Error) => ReactNode
  label?: string
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

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('VibeLink panel crashed', error, info)
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
      </div>
    )
  }
}
