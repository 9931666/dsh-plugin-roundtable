/**
 * RoundTable topology tab: the "圆桌会议" conversation view.
 *
 * Renders one meeting per captain session: the captain anchor on the left, a
 * ring of expert nodes on the right, the aggregation gateway in the middle,
 * and directed edges with arrows. Nodes breathe while working; edges have a
 * right-click menu (set forward/bidirectional, remove); dragging from a
 * node's "+" handle creates a new channel.
 * @module dsh-plugin-roundtable/client/RoundTableView
 */

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import type { SessionId } from '@deepseek-ai/dsh-client-connection/client'
import type { RpcCaller, WireEdge, WireMeeting } from './wire.ts'
import { fetchMeetings } from './wire.ts'
import styles from './RoundTableView.module.css'

export interface RoundTableViewInjected {
  rpc: RpcCaller
  /** Locale-bound translator for the roundtable namespace. */
  t: (key: string) => string
}

export interface RoundTableViewProps extends RoundTableViewInjected {
  sessionId: SessionId
}

interface Point { x: number; y: number }

interface EdgeMenuState {
  x: number
  y: number
  meetingId: string
  edge: WireEdge
}

interface DragState {
  from: string
  x: number
  y: number
}

const NODE_RADIUS = 34

/** Provider → brand avatar (abbreviation + brand color), best-effort. */
const PROVIDER_BRAND: Array<{ match: RegExp; abbr: string; color: string }> = [
  { match: /deepseek/i, abbr: 'DS', color: '#4D6BFE' },
  { match: /glm|zhipu|z\.ai|智谱/i, abbr: 'GLM', color: '#3859FF' },
  { match: /openai|gpt/i, abbr: 'GPT', color: '#10A37F' },
  { match: /anthropic|claude/i, abbr: 'CLD', color: '#D97757' },
  { match: /qwen|通义/i, abbr: 'QW', color: '#6E56CF' },
  { match: /moonshot|kimi/i, abbr: 'KM', color: '#16181D' },
  { match: /gemini/i, abbr: 'GM', color: '#4285F4' },
]

function providerBrand(provider: string): { abbr: string; color: string } {
  for (const brand of PROVIDER_BRAND) {
    if (brand.match.test(provider)) return { abbr: brand.abbr, color: brand.color }
  }
  const abbr = provider.replace(/[^a-zA-Z0-9]/g, '').slice(0, 2).toUpperCase() || '?'
  return { abbr, color: '#8a8a8a' }
}

/** CSS custom properties driving one message pulse from `from` to `to`. */
function flowStyle(from: Point, to: Point): CSSProperties {
  return {
    '--rt-fx': `${from.x}px`,
    '--rt-fy': `${from.y}px`,
    '--rt-tx': `${to.x}px`,
    '--rt-ty': `${to.y}px`,
  } as CSSProperties
}

/** Ring layout for one meeting inside a canvas of the given size. */
function layoutPositions(size: { w: number; h: number }, meeting: WireMeeting): Map<string, Point> {
  const positions = new Map<string, Point>()
  const { w, h } = size
  if (w <= 0 || h <= 0) return positions
  positions.set('captain', { x: Math.max(64, w * 0.11), y: h * 0.5 })
  positions.set('aggregator', { x: w * 0.47, y: h * 0.5 })
  const nodes = meeting.nodes
  const centerX = w * 0.75
  const centerY = h * 0.5
  const radius = Math.min(w * 0.19, h * 0.36)
  nodes.forEach((node, index) => {
    const angle = -Math.PI / 2 + (index / Math.max(1, nodes.length)) * Math.PI * 2
    positions.set(node.key, {
      x: centerX + Math.cos(angle) * radius,
      y: centerY + Math.sin(angle) * radius,
    })
  })
  return positions
}

/** Shorten a segment by the node radius at both ends and return arrow tips. */
function edgeGeometry(from: Point, to: Point): { x1: number; y1: number; x2: number; y2: number; angle: number } {
  const dx = to.x - from.x
  const dy = to.y - from.y
  const length = Math.max(1, Math.hypot(dx, dy))
  const ux = dx / length
  const uy = dy / length
  return {
    x1: from.x + ux * NODE_RADIUS,
    y1: from.y + uy * NODE_RADIUS,
    x2: to.x - ux * NODE_RADIUS,
    y2: to.y - uy * NODE_RADIUS,
    angle: Math.atan2(dy, dx),
  }
}

/** SVG arrowhead polygon points at (x, y) pointing along `angle`. */
function arrowPoints(x: number, y: number, angle: number, size = 7): string {
  const tip = { x, y }
  const back = {
    x: x - Math.cos(angle) * size,
    y: y - Math.sin(angle) * size,
  }
  const spread = size * 0.62
  const left = {
    x: back.x - Math.sin(angle) * spread,
    y: back.y + Math.cos(angle) * spread,
  }
  const right = {
    x: back.x + Math.sin(angle) * spread,
    y: back.y - Math.cos(angle) * spread,
  }
  return `${tip.x},${tip.y} ${left.x},${left.y} ${right.x},${right.y}`
}

export function RoundTableView(props: RoundTableViewProps): JSX.Element {
  const { rpc, t: translate } = props
  // The `sessionId` prop is kept for slot-interface compatibility, but the
  // tab queries ALL meetings in the workspace (no session filter): past
  // meetings stay visible across session switches, updates and restarts.
  const [meetings, setMeetings] = useState<WireMeeting[]>([])
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined)
  const [fetchFailed, setFetchFailed] = useState(false)
  const [menu, setMenu] = useState<EdgeMenuState | null>(null)
  const [drag, setDrag] = useState<DragState | null>(null)
  const [size, setSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 })
  const containerRef = useRef<HTMLDivElement | null>(null)

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const next = await fetchMeetings()
      setMeetings(next)
      setFetchFailed(false)
    } catch {
      setFetchFailed(true)
    }
  }, [])

  useEffect(() => {
    let alive = true
    let inflight = false
    const tick = async (): Promise<void> => {
      if (inflight) return
      inflight = true
      try {
        const next = await fetchMeetings()
        if (alive) {
          setMeetings(next)
          setFetchFailed(false)
        }
      } catch {
        if (alive) setFetchFailed(true)
      } finally {
        inflight = false
      }
    }
    void tick()
    const timer = window.setInterval(() => { void tick() }, 1000)
    return () => {
      alive = false
      window.clearInterval(timer)
    }
  }, [])

  // Observe the canvas size.
  useEffect(() => {
    const container = containerRef.current
    if (container === null) return
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (entry === undefined) return
      const rect = entry.contentRect
      setSize({ w: rect.width, h: rect.height })
    })
    observer.observe(container)
    return () => observer.disconnect()
  }, [])

  // Close the context menu on any click elsewhere.
  useEffect(() => {
    if (menu === null) return
    const close = (): void => setMenu(null)
    window.addEventListener('click', close)
    return () => window.removeEventListener('click', close)
  }, [menu])

  // Drag-to-connect: follow the pointer and drop on a target node.
  useEffect(() => {
    if (drag === null) return
    const move = (event: MouseEvent): void => {
      setDrag((previous) => previous === null ? null : { ...previous, x: event.clientX, y: event.clientY })
    }
    const up = (event: MouseEvent): void => {
      const target = (event.target as HTMLElement | null)?.closest?.('[data-rt-key]') as HTMLElement | null
      const from = drag.from
      setDrag(null)
      if (target === null) return
      const to = target.getAttribute('data-rt-key')
      const meetingId = target.getAttribute('data-rt-meeting')
      if (to === null || meetingId === null || to === from) return
      void rpc<unknown>('roundtable/edge.add', { meetingId, from, to, direction: 'forward' })
        .then(() => refresh())
        .catch(() => undefined)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
    return () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
  }, [drag, refresh, rpc])

  // Selected meeting (kept stable while the polled list refreshes), falling
  // back to the first meeting when the selection is missing or unset.
  const meeting = meetings.find((candidate) => candidate.id === selectedId) ?? meetings[0]

  const positions = useMemo(
    () => meeting === undefined ? new Map<string, Point>() : layoutPositions(size, meeting),
    [meeting, size],
  )

  // Recent messages (≤3s old) drive a one-shot flow pulse along their edge.
  const activeMessages = useMemo(() => {
    if (meeting === undefined) return []
    const cutoff = Date.now() - 3000
    return (meeting.messages ?? []).filter((message) => message.ts >= cutoff).slice(0, 4)
  }, [meeting])

  const handleEdgeAction = useCallback((action: 'forward' | 'bidirectional' | 'remove'): void => {
    if (menu === null) return
    if (action === 'remove') {
      void rpc<unknown>('roundtable/edge.remove', { meetingId: menu.meetingId, edgeId: menu.edge.id })
        .then(() => refresh())
        .catch(() => undefined)
    } else {
      void rpc<unknown>('roundtable/edge.set', { meetingId: menu.meetingId, edgeId: menu.edge.id, direction: action })
        .then(() => refresh())
        .catch(() => undefined)
    }
    setMenu(null)
  }, [menu, refresh, rpc])

  if (meeting === undefined) {
    return (
      <div className={styles.emptyState}>
        <div className={styles.emptyTitle}>{translate('empty')}</div>
        <div className={styles.emptyHint}>{translate('emptyHint')}</div>
        {fetchFailed === true ? <div className={styles.fetchFailed}>{translate('fetchFailed')}</div> : null}
      </div>
    )
  }

  const modeLabel = meeting.mode === 'egalitarian' ? translate('modeEgalitarian') : translate('modeOrchestrated')
  const roundsPct = meeting.budget.maxRounds <= 0 ? 0
    : Math.min(100, (meeting.budget.usedRounds / meeting.budget.maxRounds) * 100)
  const tokensPct = meeting.budget.maxTokens <= 0 ? 0
    : Math.min(100, (meeting.budget.usedTokens / meeting.budget.maxTokens) * 100)

  const renderEdge = (edge: WireEdge): JSX.Element | null => {
    const from = positions.get(edge.from)
    const to = positions.get(edge.to)
    if (from === undefined || to === undefined) return null
    const synthetic = edge.id.startsWith('synthetic:')
    const geo = edgeGeometry(from, to)
    const head = arrowPoints(geo.x2, geo.y2, geo.angle)
    const tail = edge.direction === 'bidirectional' ? arrowPoints(geo.x1, geo.y1, geo.angle + Math.PI) : null
    return (
      <g
        key={edge.id}
        className={styles.edgeGroup}
        onContextMenu={(event) => {
          if (synthetic) return
          event.preventDefault()
          setMenu({ x: event.clientX, y: event.clientY, meetingId: meeting.id, edge })
        }}
      >
        <line
          x1={geo.x1}
          y1={geo.y1}
          x2={geo.x2}
          y2={geo.y2}
          className={synthetic ? styles.edgeSynthetic : edge.direction === 'bidirectional' ? styles.edgeBidirectional : styles.edgeForward}
        />
        <polygon points={head} className={synthetic ? styles.edgeArrowSynthetic : styles.edgeArrow} />
        {tail !== null ? <polygon points={tail} className={synthetic ? styles.edgeArrowSynthetic : styles.edgeArrow} /> : null}
      </g>
    )
  }

  const renderNode = (key: string, label: string, kind: 'captain' | 'aggregator' | 'node'): JSX.Element | null => {
    const point = positions.get(key)
    if (point === undefined) return null
    const node = kind === 'node' ? meeting.nodes.find((candidate) => candidate.key === key) : undefined
    const breathing = kind === 'node' && node?.activity === 'running'
    const activityLabel = node === undefined ? '' : (node.activity === 'running' ? 'activityRunning' : node.activity === 'idle' ? 'activityIdle' : 'activityReady')
    const brand = kind === 'node' && node !== undefined ? providerBrand(node.provider) : null
    return (
      <div
        key={key}
        data-rt-key={key}
        data-rt-meeting={meeting.id}
        className={[
          styles.node,
          kind === 'captain' ? styles.captainNode : '',
          kind === 'aggregator' ? styles.aggregatorNode : '',
          breathing ? styles.breathing : '',
        ].filter(Boolean).join(' ')}
        style={{ left: point.x, top: point.y }}
        title={node === undefined ? label : `${label}${node.role !== '' ? ` · ${node.role}` : ''}`}
      >
        {brand !== null ? (
          <div className={styles.avatar} style={{ background: brand.color }}>
            <span className={styles.avatarAbbr}>{brand.abbr}</span>
          </div>
        ) : null}
        <div className={styles.nodeLabel}>{label}</div>
        {kind === 'node' ? (
          <div className={styles.nodeMeta}>
            {node?.activity === 'running' ? translate(activityLabel) : ''}
          </div>
        ) : null}
        <div
          className={styles.plusHandle}
          role="button"
          tabIndex={0}
          aria-label="connect"
          onMouseDown={(event) => {
            event.preventDefault()
            event.stopPropagation()
            setDrag({ from: key, x: event.clientX, y: event.clientY })
          }}
        >
          +
        </div>
      </div>
    )
  }

  return (
    <div className={styles.root}>
      <div className={styles.header}>
        <div className={styles.titleRow}>
          <span className={styles.meetingName}>{meeting.name}</span>
          {meetings.length > 1 ? (
            <select
              className={styles.meetingSelect}
              value={meeting.id}
              onChange={(event) => setSelectedId(event.target.value)}
              aria-label={translate('meetingSelect')}
            >
              {meetings.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.name} · {candidate.mode === 'egalitarian' ? translate('modeEgalitarian') : translate('modeOrchestrated')} · {candidate.status}
                </option>
              ))}
            </select>
          ) : null}
          <span className={styles.badge}>{modeLabel}</span>
          <span className={styles.badge}>{meeting.status}</span>
          <span className={styles.round}>{translate('round')} {meeting.round}</span>
        </div>
        <div className={styles.budgetRow}>
          <span className={styles.budgetLabel}>{translate('roundsBudget')}</span>
          <div className={styles.budgetBar}>
            <div className={styles.budgetFill} style={{ width: `${roundsPct}%` }} />
          </div>
          <span className={styles.budgetValue}>{meeting.budget.usedRounds}/{meeting.budget.maxRounds}</span>
          <span className={styles.budgetLabel}>{translate('tokensBudget')}</span>
          <div className={styles.budgetBar}>
            <div className={styles.budgetFillTokens} style={{ width: `${tokensPct}%` }} />
          </div>
          <span className={styles.budgetValue}>{meeting.budget.usedTokens}/{meeting.budget.maxTokens}</span>
        </div>
        {meeting.pendingDecisions.length > 0 ? (
          <div className={styles.decisionBanner}>
            <span className={styles.decisionTag}>{translate('pendingDecision')}</span>
            {meeting.pendingDecisions.map((decision) => (
              <span key={decision.id} className={styles.decisionQuestion}>
                {decision.question}
                {decision.options.length > 0 ? `（${translate('pendingDecisionOptions')}：${decision.options.join(' / ')}）` : ''}
              </span>
            ))}
          </div>
        ) : null}
      </div>
      <div ref={containerRef} className={styles.canvas}>
        <svg className={styles.edgeLayer} width={size.w} height={size.h}>
          {meeting.edges.map(renderEdge)}
          {drag !== null && positions.get(drag.from) !== undefined ? (
            (() => {
              const start = positions.get(drag.from)
              if (start === undefined) return null
              const end = { x: drag.x, y: drag.y }
              return <line x1={start.x} y1={start.y} x2={end.x} y2={end.y} className={styles.dragLine} />
            })()
          ) : null}
        </svg>
        {renderNode('captain', 'DeepSeek · 主持', 'captain')}
        {renderNode('aggregator', '汇聚网关', 'aggregator')}
        {meeting.nodes.map((node) => renderNode(node.key, node.key, 'node'))}
        {activeMessages.map((message) => {
          const from = positions.get(message.from)
          const to = positions.get(message.to)
          if (from === undefined || to === undefined) return null
          return <div key={message.id} className={styles.msgPulse} style={flowStyle(from, to)} />
        })}
      </div>
      <details className={styles.digest}>
        <summary>{translate('gatewayDigest')}</summary>
        <pre className={styles.digestBody}>{meeting.digest || translate('noDigest')}</pre>
      </details>
      {menu !== null ? (
        <div
          className={styles.contextMenu}
          style={{ left: menu.x, top: menu.y }}
          onClick={(event) => event.stopPropagation()}
        >
          <div className={styles.contextMenuTitle}>
            {menu.edge.from} → {menu.edge.to}
          </div>
          <button type="button" className={styles.contextMenuItem} onClick={() => handleEdgeAction('forward')}>
            {translate('edgeSetForward')}
          </button>
          <button type="button" className={styles.contextMenuItem} onClick={() => handleEdgeAction('bidirectional')}>
            {translate('edgeSetBidirectional')}
          </button>
          <button type="button" className={styles.contextMenuItemDanger} onClick={() => handleEdgeAction('remove')}>
            {translate('edgeRemove')}
          </button>
        </div>
      ) : null}
      {fetchFailed === true ? <div className={styles.fetchFailed}>{translate('fetchFailed')}</div> : null}
    </div>
  )
}
