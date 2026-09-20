/**
 * Render-failure boundary for the two RoundTable slot entries.
 *
 * WHY THIS EXISTS (v0.2.36): DSH retires a slot entry that throws during render
 * (`onEntryError` + abdication) — correct isolation, but for the user the 圆桌
 * 会议 tab simply is not there, with no message anywhere. That silent
 * disappearance is exactly the shape the "界面调不出来" reports arrived in, and
 * it is undiagnosable from the outside.
 *
 * Wrapping each entry in a boundary turns a crash into a readable panel naming
 * the error, and mirrors it to the browser console with the component stack.
 * The boundary deliberately renders NO data of its own, so it cannot become a
 * second failure source; the panel is swapped out as soon as React re-renders
 * a healthy tree after a reload.
 *
 * @module dsh-plugin-roundtable/client/slot-boundary
 */

import { Component, createElement, type ComponentType, type ErrorInfo, type ReactElement, type ReactNode } from 'react'

/** The inject face every RoundTable slot entry receives (see client/index.ts). */
export interface SlotEntryFace {
  /** Locale-bound translator for the `roundtable` namespace. */
  t?: (key: string) => string
}

interface SlotBoundaryProps {
  title: string
  hint: string
  children?: ReactNode
}

interface SlotBoundaryState {
  error: Error | null
}

/** Class-component boundary (React only catches render errors in class components). */
export class SlotBoundary extends Component<SlotBoundaryProps, SlotBoundaryState> {
  state: SlotBoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): SlotBoundaryState {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Second copy on purpose: the panel may be off-screen or localized, while
    // the console line is what a reporter can copy into an issue.
    console.error('[roundtable] slot entry render failed:', error, info.componentStack)
  }

  render(): ReactNode {
    const { error } = this.state
    if (error === null) return this.props.children
    return createElement(
      'div',
      {
        style: {
          margin: '16px',
          padding: '14px 16px',
          border: '1px solid var(--dsh-color-danger, #d9534f)',
          borderRadius: '8px',
          background: 'var(--dsh-color-surface, rgba(217, 83, 79, 0.06))',
          color: 'var(--dsh-color-text, inherit)',
          font: 'inherit',
          lineHeight: 1.6,
        },
      },
      createElement('div', { style: { fontWeight: 600, marginBottom: '6px' } }, this.props.title),
      createElement('pre', {
        style: {
          margin: '0 0 8px',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          fontFamily: 'var(--dsh-font-mono, ui-monospace, monospace)',
          fontSize: '12px',
          opacity: 0.9,
        },
      }, `${error.name}: ${error.message}`),
      createElement('div', { style: { fontSize: '12px', opacity: 0.75 } }, this.props.hint),
    )
  }
}

/**
 * Wrap one slot component so a render crash renders a report instead of
 * vanishing. The inner component keeps receiving every prop it got before
 * (owner share + standard seats + the inject face), so this is transparent on
 * the happy path.
 *
 * @param Inner - the registered slot component.
 * @returns a component with the same props contract.
 */
export function withSlotBoundary<P extends object>(Inner: ComponentType<P>): ComponentType<P> {
  const Wrapped = (props: P): ReactElement => {
    const face = props as SlotEntryFace
    const t = typeof face.t === 'function' ? face.t : (key: string): string => key
    return createElement(
      SlotBoundary,
      { title: t('renderFailed'), hint: t('renderFailedHint') },
      createElement(Inner, props),
    )
  }
  const named = Inner as { displayName?: string; name?: string }
  const name = named.displayName ?? named.name ?? 'Slot'
  Wrapped.displayName = `RoundTableBoundary(${name})`
  return Wrapped
}
