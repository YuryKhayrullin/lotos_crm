'use client'

import { Component, type ReactNode } from 'react'
import { RecoveryPanel } from './RecoveryPanel'

export class WorkspaceBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  render() {
    if (this.state.failed) {
      return <RecoveryPanel title="Не удалось открыть раздел" onRetry={() => this.setState({ failed: false })} />
    }
    return this.props.children
  }
}
