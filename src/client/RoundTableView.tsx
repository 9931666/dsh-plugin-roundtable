/**
 * RoundTable topology tab: the "圆桌会议" conversation view.
 *
 * Minimal two-column layout:
 *   - main: meeting header (title/badges/budget) → topology canvas (captain
 *     anchor, ring of expert nodes with brand avatars, directed edges) →
 *     collapsible aggregation-gateway digest.
 *   - sidebar: expert status list, role breakdown, knowledge-base skeleton,
 *     recent-utterance activity log, and file outputs (none yet).
 *
 * The tab lists ALL meetings in the workspace (no session filter), so past
 * meetings stay visible across session switches, plugin updates and restarts;
 * a switcher dropdown is shown when more than one meeting exists.
 *
 * @module dsh-plugin-roundtable/client/RoundTableView
 */

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import type { SessionId } from '@deepseek-ai/dsh-client-connection/client'
import type { RpcCaller, WireEdge, WireKbListing, WireMeeting, WireNode, WireProviderOption } from './wire.ts'
import { fetchMeetings } from './wire.ts'
import { BRAND_LOGOS } from './brand-logos.generated.ts'
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
  meetingId: string
  x: number
  y: number
}

const NODE_RADIUS = 34

/** Provider → brand avatar (logo image if bundled, else abbreviation + brand color). */
const PROVIDER_BRAND: Array<{ key: string; match: RegExp; abbr: string; color: string }> = [
  { key: 'deepseek', match: /deepseek/i, abbr: 'DS', color: '#4D6BFE' },
  { key: 'glm', match: /glm|zhipu|z\.ai|智谱/i, abbr: 'GLM', color: '#3859FF' },
  { key: 'openai', match: /openai|gpt/i, abbr: 'GPT', color: '#10A37F' },
  { key: 'claude', match: /anthropic|claude/i, abbr: 'CLD', color: '#D97757' },
  { key: 'qwen', match: /qwen|通义/i, abbr: 'QW', color: '#6E56CF' },
  { key: 'kimi', match: /moonshot|kimi/i, abbr: 'KM', color: '#16181D' },
  { key: 'gemini', match: /gemini/i, abbr: 'GM', color: '#4285F4' },
  { key: 'minimax', match: /minimax/i, abbr: 'MX', color: '#0A0A0A' },
]

/** Brand avatar for a provider: bundled logo (data URL) when available, else abbr + color. */
function providerBrand(provider: string): { abbr: string; color: string; logo?: string } {
  for (const brand of PROVIDER_BRAND) {
    if (!brand.match.test(provider)) continue
    return { abbr: brand.abbr, color: brand.color, logo: BRAND_LOGOS[brand.key] }
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
  // Fall back to a sane canvas when the host container has not measured yet
  // (flex under a still-unsized slot reports 0 box). Without this, the ring
  // is empty on first paint and stays blank until a resize tick arrives —
  // the classic "topology is a big empty box" bug. A fixed default means the
  // nodes always have coordinates and the real size corrects them on the
  // next measure, mirroring the subagent-tree view which never goes blank.
  const w = size.w > 0 ? size.w : 900
  const h = size.h > 0 ? size.h : 480
  positions.set('captain', { x: Math.max(64, w * 0.10), y: h * 0.5 })
  positions.set('aggregator', { x: Math.max(150, w * 0.33), y: h * 0.5 })
  const nodes = meeting.nodes
  const centerX = w * 0.78
  const centerY = h * 0.5
  const radius = Math.min(w * 0.20, h * 0.36)
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

/** Quadratic-bezier geometry for one edge, shared by the renderer (which
 *  draws the path) and the delete dot (which must sit on the curve's true
 *  midpoint, i.e. the point at t=0.5 — not the control point). */
function edgeCurveGeometry(
  edge: WireEdge,
  meeting: WireMeeting,
  positions: Map<string, Point>,
): { x1: number; y1: number; x2: number; y2: number; cx: number; cy: number; path: string; mx: number; my: number } | null {
  const from = positions.get(edge.from)
  const to = positions.get(edge.to)
  if (from === undefined || to === undefined) return null
  const synthetic = edge.id.startsWith('synthetic:')
  const dx = to.x - from.x
  const dy = to.y - from.y
  const len = Math.max(1, Math.hypot(dx, dy))
  const ux = dx / len
  const uy = dy / len
  const fromDegree = meeting.edges.reduce((n, e) => n + (e.from === edge.from ? 1 : 0), 0)
  const fromIndex = meeting.edges.filter((e) => e.from === edge.from).findIndex((e) => e.id === edge.id)
  const toDegree = meeting.edges.reduce((n, e) => n + (e.to === edge.to ? 1 : 0), 0)
  const toIndex = meeting.edges.filter((e) => e.to === edge.to).findIndex((e) => e.id === edge.id)
  const hubFrom = edge.from === 'captain' || edge.from === 'aggregator'
  const hubTo = edge.to === 'captain' || edge.to === 'aggregator'
  const baseAngle = Math.atan2(uy, ux)
  const startAngle = baseAngle
    + (hubFrom ? (fromIndex - (fromDegree - 1) / 2) * 0.09 : fromDegree > 1 ? (fromIndex - (fromDegree - 1) / 2) * 0.16 : 0)
  const endAngle = baseAngle
    + (hubTo ? (toIndex - (toDegree - 1) / 2) * 0.09 : toDegree > 1 ? (toIndex - (toDegree - 1) / 2) * 0.16 : 0)
  const x1 = from.x + Math.cos(startAngle) * NODE_RADIUS
  const y1 = from.y + Math.sin(startAngle) * NODE_RADIUS
  const x2 = to.x + Math.cos(endAngle) * NODE_RADIUS
  const y2 = to.y + Math.sin(endAngle) * NODE_RADIUS
  const midX = (x1 + x2) / 2
  const midY = (y1 + y2) / 2
  const nx = -(y2 - y1)
  const ny = x2 - x1
  const nlen = Math.max(1, Math.hypot(nx, ny))
  const bow = synthetic ? 0.2 : 0.24
  const cx = midX + (nx / nlen) * nlen * bow
  const cy = midY + (ny / nlen) * nlen * bow
  const path = `M ${x1} ${y1} Q ${cx} ${cy} ${x2} ${y2}`
  // Point on the curve at t=0.5 — the visual midpoint the delete dot should sit on.
  const mx = 0.25 * x1 + 0.5 * cx + 0.25 * x2
  const my = 0.25 * y1 + 0.5 * cy + 0.25 * y2
  return { x1, y1, x2, y2, cx, cy, path, mx, my }
}

function nodeStatusLabel(node: WireNode, translate: (key: string) => string): string {
  if (node.status === 'removed' || node.activity === 'removed') return translate('activityRemoved')
  if (node.activity === 'running') return translate('activityRunning')
  if (node.activity === 'idle') return translate('activityIdle')
  return translate('activityReady')
}

/** 来源对话短号前缀（显示在会议切换下拉里，区分不同对话开的会议）。 */
function sourcePrefix(captainSessionId: string): string {
  if (captainSessionId === '') return '对话'
  return `对话-${captainSessionId.slice(0, 4)}`
}

/** 与 host 端 sanitizeKey 一致：把显示名转成会议内稳定的节点 key。 */
function sanitizeKey(value: string): string {
  const cleaned = value.trim().toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-').replace(/^-+|-+$/g, '')
  return cleaned === '' ? '' : cleaned
}

/** 人类可读的文件大小（B/KB/MB）。 */
function formatKbSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`
  return `${bytes} B`
}

/** 品牌头像：有 logo 图片则圆形显示，否则品牌色块 + 缩写。 */
function brandAvatar(brand: { abbr: string; color: string; logo?: string }, size: 'node' | 'list'): JSX.Element {
  const cls = size === 'node' ? styles.avatar : styles.agentAvatar
  return (
    <div className={cls} style={brand.logo === undefined ? { background: brand.color } : undefined}>
      {brand.logo !== undefined
        ? <img className={styles.avatarImg} src={brand.logo} alt={brand.abbr} title={brand.abbr} />
        : size === 'node'
          ? <span className={styles.avatarAbbr}>{brand.abbr}</span>
          : <span className={styles.agentAbbr}>{brand.abbr}</span>}
    </div>
  )
}

export function RoundTableView(props: RoundTableViewProps): JSX.Element {
  const { sessionId, rpc, t: translate } = props
  // The `sessionId` prop is kept for slot-interface compatibility, but the
  // tab queries ALL meetings in the workspace (no session filter): past
  // meetings stay visible across session switches, updates and restarts.
  const [meetings, setMeetings] = useState<WireMeeting[]>([])
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined)
  const [expandedTask, setExpandedTask] = useState<string | null>(null)
  const [manageOpen, setManageOpen] = useState(false)
  const [providers, setProviders] = useState<WireProviderOption[]>([])
  const [modelsLoaded, setModelsLoaded] = useState(false)
  const [form, setForm] = useState<{ name: string; role: string; provider: string; model: string }>({ name: '', role: '', provider: '', model: '' })
  const [kbOpen, setKbOpen] = useState(false)
  const [kbPathInput, setKbPathInput] = useState('')
  const [kbListing, setKbListing] = useState<WireKbListing | null>(null)
  const [kbContentChanged, setKbContentChanged] = useState(false)
  const [fetchFailed, setFetchFailed] = useState(false)
  const [menu, setMenu] = useState<EdgeMenuState | null>(null)
  const [drag, setDrag] = useState<DragState | null>(null)
  const [toast, setToast] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  const [hoverEdgeId, setHoverEdgeId] = useState<string | null>(null)
  const [showAll, setShowAll] = useState(true)
  const [size, setSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 })
  const containerRef = useRef<HTMLDivElement | null>(null)
  const hoverTimer = useRef<number | null>(null)

  // Reveal an edge's delete dot and KEEP it revealed briefly after the pointer
  // leaves the edge path, so the user can glide from the line onto the dot
  // (which sits at the curve's midpoint) without it vanishing. Entering the
  // dot cancels the pending clear.
  const setHoverEdge = useCallback((id: string): void => {
    if (hoverTimer.current !== null) {
      window.clearTimeout(hoverTimer.current)
      hoverTimer.current = null
    }
    setHoverEdgeId(id)
  }, [])
  const clearHoverEdge = useCallback((id: string): void => {
    if (hoverTimer.current !== null) window.clearTimeout(hoverTimer.current)
    hoverTimer.current = window.setTimeout(() => {
      setHoverEdgeId((current) => (current === id ? null : current))
      hoverTimer.current = null
    }, 180)
  }, [])

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const next = await fetchMeetings(showAll ? undefined : String(sessionId))
      setMeetings(next)
      setFetchFailed(false)
    } catch {
      setFetchFailed(true)
    }
  }, [sessionId, showAll])

  // Load the 互通 preference once; it decides whether this tab lists every
  // meeting in the workspace (on) or only meetings this conversation started.
  useEffect(() => {
    void rpc<{ showAllMeetings?: boolean }>('roundtable/prefs.get', {})
      .then((result) => {
        if (result.ok && typeof result.value?.showAllMeetings === 'boolean') {
          setShowAll(result.value.showAllMeetings)
        }
      })
      .catch(() => undefined)
  }, [rpc])

  // Poll the snapshot every second.
  useEffect(() => {
    let alive = true
    let inflight = false
    const tick = async (): Promise<void> => {
      if (inflight) return
      inflight = true
      try {
        const next = await fetchMeetings(showAll ? undefined : String(sessionId))
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
  }, [sessionId, showAll])

  // Measure the canvas with a hard fallback. Some host containers report a
  // 0 box on first paint (flex under a yet-unsized slot), which would leave
  // the topology empty; we fall back to a sane default so nodes always have
  // coordinates, then correct to the real size once the layout settles.
  useEffect(() => {
    const container = containerRef.current
    if (container === null) return
    const measure = (): void => {
      const w = container.clientWidth
      const h = container.clientHeight
      const next = { w: w > 0 ? w : 900, h: h > 0 ? h : 480 }
      setSize((previous) => (previous.w === next.w && previous.h === next.h ? previous : next))
    }
    measure()
    const raf = window.requestAnimationFrame(measure)
    const observer = new ResizeObserver(measure)
    observer.observe(container)
    return () => {
      window.cancelAnimationFrame(raf)
      observer.disconnect()
    }
  }, [])

  // Close the context menu on any click elsewhere.
  useEffect(() => {
    if (menu === null) return
    const close = (): void => setMenu(null)
    window.addEventListener('click', close)
    return () => window.removeEventListener('click', close)
  }, [menu])

  // Auto-dismiss the connect-result toast after a short beat.
  useEffect(() => {
    if (toast === null) return
    const timer = window.setTimeout(() => setToast(null), 3000)
    return () => window.clearTimeout(timer)
  }, [toast])

  // Selected meeting (kept stable while the polled list refreshes), falling
  // back to the first meeting when the selection is missing or unset.
  const meeting = meetings.find((candidate) => candidate.id === selectedId) ?? meetings[0]

  const positions = useMemo(
    () => meeting === undefined ? new Map<string, Point>() : layoutPositions(size, meeting),
    [meeting, size],
  )

  // Top-layer delete dots for REAL edges: positioned at each edge's bezier
  // midpoint but rendered ABOVE the nodes (the SVG layer sits under the nodes,
  // so a dot at a midpoint that lands inside a node would be hidden). Shown
  // while that edge is hovered, and never for synthetic implied edges.
  const edgeRemoveDots = useMemo(() => {
    if (meeting === undefined) return []
    const dots: { id: string; cx: number; cy: number }[] = []
    for (const edge of meeting.edges) {
      if (edge.id.startsWith('synthetic:')) continue
      const geo = edgeCurveGeometry(edge, meeting, positions)
      if (geo === null) continue
      dots.push({ id: edge.id, cx: geo.mx, cy: geo.my })
    }
    return dots
  }, [meeting, positions])

  // Drag-to-connect: follow the pointer and drop on a target node. All drag
  // coordinates are canvas-relative (node positions are canvas-relative too),
  // so the free end tracks the cursor exactly instead of drifting to a
  // self-chosen endpoint.
  //
  // Drop targeting is COORDINATE-based: we pick the nearest node position to
  // the release point (within a radius). This is robust against the cursor
  // landing on an edge path or port dot — DOM closest()/elementFromPoint can
  // miss the node under a line, which is exactly why user↔pm wiring failed
  // silently before. Coordinate hit-testing cannot be blocked by a line.
  useEffect(() => {
    if (drag === null) return
    const move = (event: MouseEvent): void => {
      const rect = containerRef.current?.getBoundingClientRect()
      const x = rect === undefined ? event.clientX : event.clientX - rect.left
      const y = rect === undefined ? event.clientY : event.clientY - rect.top
      setDrag((previous) => previous === null ? null : { ...previous, x, y })
    }
    const up = (event: MouseEvent): void => {
      const from = drag.from
      const meetingId = drag.meetingId
      const x = drag.x
      const y = drag.y
      setDrag(null)
      // Find the nearest node to the release point within a generous radius.
      let bestKey: string | null = null
      let bestDist = Number.POSITIVE_INFINITY
      const hitRadius = 70
      for (const [key, point] of positions) {
        const dist = Math.hypot(point.x - x, point.y - y)
        if (dist < bestDist) {
          bestDist = dist
          bestKey = key
        }
      }
      const to = bestKey
      if (to === null || to === from || bestDist > hitRadius) return
      void rpc<unknown>('roundtable/edge.add', { meetingId, from, to, direction: 'forward' })
        .then((result) => {
          if (result.ok) {
            setToast({ kind: 'ok', text: `已连接 ${from} → ${to}` })
            void refresh()
          } else {
            setToast({ kind: 'err', text: result.error?.message ?? '连线失败' })
          }
        })
        .catch(() => setToast({ kind: 'err', text: '连线失败：无法连接会议服务' }))
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
    return () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
  }, [drag, refresh, rpc, positions])

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

  // ---- Knowledge-base (阅览版) -----------------------------------------
  // The KB is a plain folder on disk: the UI only shows the path and lists
  // the first level (names/formats/sizes). File contents are never opened in
  // the UI — the captain reads and relays them to experts on demand.
  const loadKbList = useCallback((path: string): void => {
    if (meeting === undefined || path === '') return
    void rpc<WireKbListing>('roundtable/kb.list', { meetingId: meeting.id })
      .then((result) => {
        if (result.ok) {
          setKbListing(result.value)
        } else {
          setKbListing({ path: '', configured: false, error: result.error?.message ?? 'kb list failed', files: [] })
        }
      })
      .catch(() => setKbListing({ path: '', configured: false, error: 'kb list failed', files: [] }))
  }, [meeting, rpc])

  const openKb = (): void => {
    setKbOpen(true)
    setKbPathInput(meeting?.kbPath ?? '')
    setKbContentChanged(false)
    setKbListing(null)
    if (meeting !== undefined && meeting.kbPath !== '') loadKbList(meeting.kbPath)
  }

  const closeKb = (): void => {
    setKbOpen(false)
    setKbListing(null)
  }

  // Save the KB path (validated on the host), record the change for the
  // captain (user-action kb-path), then refresh the listing. Checking
  // "已修改知识库部分内容" additionally records that file contents changed so
  // the captain re-browses to refresh its understanding.
  const saveKbPath = (): void => {
    if (meeting === undefined) return
    const path = kbPathInput.trim()
    if (path === '') {
      setToast({ kind: 'err', text: translate('kbPathRequired') })
      return
    }
    void rpc<{ path: string }>('roundtable/kb.path.set', { meetingId: meeting.id, path })
      .then((result) => {
        if (!result.ok) {
          setToast({ kind: 'err', text: result.error?.message ?? translate('kbSaveFailed') })
          return
        }
        const saved = result.value.path
        const actions: { kind: 'kb-path'; text: string }[] = [{ kind: 'kb-path', text: `修改了知识库路径为 ${saved}` }]
        if (kbContentChanged) actions.push({ kind: 'kb-path', text: '已修改知识库部分内容，请重新阅览以更新认知' })
        const queue = actions.map((action) => rpc<unknown>('roundtable/user-actions.append', {
          meetingId: meeting.id,
          kind: action.kind,
          text: action.text,
        }))
        void Promise.allSettled(queue).then(() => {
          setToast({ kind: 'ok', text: translate('kbSaved') })
          setKbPathInput(saved)
          setKbContentChanged(false)
          loadKbList(saved)
          void refresh()
        })
      })
      .catch(() => setToast({ kind: 'err', text: translate('kbSaveFailed') }))
  }

  // Pending expert edits derived from the meeting's user-actions file: keys
  // queued for removal (still in the roster, awaiting the captain) and keys
  // queued for addition (not yet in the roster). The UI marks both so the
  // user sees "下一轮生效" instead of the action silently doing nothing.
  const pendingAddKeys = useMemo(() => {
    const keys = new Set<string>()
    for (const action of meeting?.pendingActions ?? []) {
      if (action.kind === 'add-node' && action.nodeKey !== '') keys.add(action.nodeKey)
    }
    return keys
  }, [meeting])
  const pendingRemoveKeys = useMemo(() => {
    const keys = new Set<string>()
    for (const action of meeting?.pendingActions ?? []) {
      if (action.kind === 'remove-node' && action.nodeKey !== '') keys.add(action.nodeKey)
    }
    return keys
  }, [meeting])
  const pendingActionCount = (meeting?.pendingActions ?? []).length

  const openManage = (): void => {
    setManageOpen(true)
    setModelsLoaded(false)
    void rpc<{ providers: WireProviderOption[] }>('roundtable/models.list', {})
      .then((result) => {
        if (result.ok && Array.isArray(result.value.providers)) setProviders(result.value.providers)
        setModelsLoaded(true)
      })
      .catch(() => setModelsLoaded(true))
  }

  const closeManage = (): void => {
    setManageOpen(false)
    setForm({ name: '', role: '', provider: '', model: '' })
  }

  // Queue an expert removal: only the user-actions file is written; the
  // captain performs roundtable_remove_node next round.
  const queueRemove = (node: WireNode): void => {
    const confirmed = window.confirm(translate('manageRemoveConfirm').replace('{name}', node.key))
    if (!confirmed) return
    const text = `删除了专家 ${node.key}`
    void rpc<unknown>('roundtable/user-actions.append', {
      meetingId: meeting?.id,
      kind: 'remove-node',
      nodeKey: node.key,
      text,
    })
      .then((result) => {
        if (result.ok) {
          setToast({ kind: 'ok', text: translate('manageRemovedSoon').replace('{name}', node.key) })
          void refresh()
        } else {
          setToast({ kind: 'err', text: result.error?.message ?? translate('manageQueueFailed') })
        }
      })
      .catch(() => setToast({ kind: 'err', text: translate('manageQueueFailed') }))
  }

  // Queue an expert addition: written to the user-actions file; the captain
  // spawns the node (roundtable_add_node) next round. Empty model = inherit
  // the captain's current route.
  const submitAdd = (): void => {
    if (meeting === undefined) return
    const key = sanitizeKey(form.name)
    if (key === '') {
      setToast({ kind: 'err', text: translate('manageNameRequired') })
      return
    }
    const exists = meeting.nodes.some((node) => node.key === key && node.status !== 'removed')
    const queued = pendingAddKeys.has(key)
    if (exists || queued) {
      setToast({ kind: 'err', text: translate('manageNameTaken').replace('{name}', key) })
      return
    }
    const role = form.role.trim()
    const provider = form.provider
    const model = form.model
    const text = `新增了专家 ${key}${role !== '' ? `（角色：${role}）` : ''}${provider !== '' ? `，模型 ${provider}/${model}` : '，使用主持人默认模型'}`
    void rpc<unknown>('roundtable/user-actions.append', {
      meetingId: meeting.id,
      kind: 'add-node',
      nodeKey: key,
      role,
      provider,
      model,
      text,
    })
      .then((result) => {
        if (result.ok) {
          setToast({ kind: 'ok', text: translate('manageAddedSoon').replace('{name}', key) })
          setForm({ name: '', role: '', provider: '', model: '' })
          void refresh()
        } else {
          setToast({ kind: 'err', text: result.error?.message ?? translate('manageQueueFailed') })
        }
      })
      .catch(() => setToast({ kind: 'err', text: translate('manageQueueFailed') }))
  }

  const handleProviderChange = (provider: string): void => {
    setForm((previous) => ({ ...previous, provider, model: '' }))
  }

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

    // Bundle edges by shared origin so a hub's outgoing wires fan out like
    // ribs from the same rim point instead of stabbing every direction; this
    // is the "start from one anchor, split toward many ends" look. We offset
    // each edge's start tangent by its index within the origin's bundle.
    const fromDegree = meeting.edges.reduce((n, e) => n + (e.from === edge.from ? 1 : 0), 0)
    const fromIndex = meeting.edges.filter((e) => e.from === edge.from).findIndex((e) => e.id === edge.id)
    const toDegree = meeting.edges.reduce((n, e) => n + (e.to === edge.to ? 1 : 0), 0)
    const toIndex = meeting.edges.filter((e) => e.to === edge.to).findIndex((e) => e.id === edge.id)

    // Directional unit vector source -> target.
    const dx = to.x - from.x
    const dy = to.y - from.y
    const len = Math.max(1, Math.hypot(dx, dy))
    const ux = dx / len
    const uy = dy / len
    // Start tangent: base direction plus a per-index fan offset (radians).
    // For the big hubs (captain/aggregator) we COLLAPSE the outlet into a
    // narrow band pointed toward the target instead of fanning all around the
    // node — that is the "one bus, splitting outward" look the cap wants, so
    // five lines leave the captain as a clean radiated bundle rather than
    // stabbing in five directions. Expert↔expert edges keep the small fan.
    const hubFrom = edge.from === 'captain' || edge.from === 'aggregator'
    const hubTo = edge.to === 'captain' || edge.to === 'aggregator'
    const startAngle = Math.atan2(uy, ux)
      + (hubFrom ? (fromIndex - (fromDegree - 1) / 2) * 0.09 : fromDegree > 1 ? (fromIndex - (fromDegree - 1) / 2) * 0.16 : 0)
    const endAngle = Math.atan2(uy, ux)
      + (hubTo ? (toIndex - (toDegree - 1) / 2) * 0.09 : toDegree > 1 ? (toIndex - (toDegree - 1) / 2) * 0.16 : 0)

    // Pull the two anchors back to the node rim (NODE_RADIUS).
    const x1 = from.x + Math.cos(startAngle) * NODE_RADIUS
    const y1 = from.y + Math.sin(startAngle) * NODE_RADIUS
    const x2 = to.x + Math.cos(endAngle) * NODE_RADIUS
    const y2 = to.y + Math.sin(endAngle) * NODE_RADIUS

    const head = arrowPoints(x2, y2, endAngle)
    const tail = edge.direction === 'bidirectional' ? arrowPoints(x1, y1, startAngle + Math.PI) : null

    // Quadratic bezier with a larger bow so the mid-point clears other nodes,
    // reducing the "line hidden behind a node" clutter.
    const midX = (x1 + x2) / 2
    const midY = (y1 + y2) / 2
    const nx = -(y2 - y1)
    const ny = x2 - x1
    const nlen = Math.max(1, Math.hypot(nx, ny))
    const bow = synthetic ? 0.2 : 0.24
    const cx = midX + (nx / nlen) * nlen * bow
    const cy = midY + (ny / nlen) * nlen * bow
    const path = `M ${x1} ${y1} Q ${cx} ${cy} ${x2} ${y2}`

    // Role-based coloring: captain-outbound wires use a warm accent so the
    // captain reads as the single source "all lines come from here" (a bus),
    // aggregator wires a cool accent, and expert↔expert wires stay neutral.
    const involvesCaptain = edge.from === 'captain' || edge.to === 'captain'
    const involvesAggregator = edge.from === 'aggregator' || edge.to === 'aggregator'
    const roleClass = synthetic
      ? (involvesCaptain ? styles.edgeSyntheticCaptain : involvesAggregator ? styles.edgeSyntheticAggregator : styles.edgeSynthetic)
      : (involvesCaptain ? styles.edgeCaptain : involvesAggregator ? styles.edgeAggregator : edge.direction === 'bidirectional' ? styles.edgeBidirectional : styles.edgeForward)
    const arrowClass = synthetic
      ? (involvesCaptain ? styles.edgeArrowSyntheticCaptain : involvesAggregator ? styles.edgeArrowSyntheticAggregator : styles.edgeArrowSynthetic)
      : (involvesCaptain ? styles.edgeArrowCaptain : involvesAggregator ? styles.edgeArrowAggregator : styles.edgeArrow)
    return (
      <g
        key={edge.id}
        className={styles.edgeGroup}
        onMouseEnter={() => setHoverEdge(edge.id)}
        onMouseLeave={() => clearHoverEdge(edge.id)}
        onContextMenu={(event) => {
          if (synthetic) return
          event.preventDefault()
          setMenu({ x: event.clientX, y: event.clientY, meetingId: meeting.id, edge })
        }}
      >
        <path d={path} fill="none" className={roleClass} />
        <polygon points={head} className={arrowClass} />
        {tail !== null ? <polygon points={tail} className={arrowClass} /> : null}
      </g>
    )
  }

  const renderNode = (key: string, label: string, kind: 'captain' | 'aggregator' | 'node'): JSX.Element | null => {
    const point = positions.get(key)
    if (point === undefined) return null
    const node = kind === 'node' ? meeting.nodes.find((candidate) => candidate.key === key) : undefined
    const removed = kind === 'node' && (node?.status === 'removed' || node?.activity === 'removed')
    const breathing = kind === 'node' && !removed && node?.activity === 'running'
    const brand = kind === 'node' && node !== undefined ? providerBrand(node.provider) : null
    // Convert a screen-space pointer to canvas-relative coordinates. The
    // topology canvas is absolutely-positioned inside the conversation slot, so
    // `clientX/clientY` must be offset by the canvas bounding rect — otherwise
    // the free end of a dragged connector flies off on its own instead of
    // tracking the cursor. This is the bug that made "拉线终点不跟鼠标".
    const startDrag = (clientX: number, clientY: number): void => {
      const rect = containerRef.current?.getBoundingClientRect()
      const x = rect === undefined ? clientX : clientX - rect.left
      const y = rect === undefined ? clientY : clientY - rect.top
      setDrag({ from: key, meetingId: meeting.id, x, y })
    }
    return (
      <div
        key={key}
        data-rt-key={key}
        data-rt-meeting={meeting.id}
        className={[
          styles.node,
          kind === 'captain' ? styles.captainNode : '',
          kind === 'aggregator' ? styles.aggregatorNode : '',
          removed ? styles.nodeRemoved : '',
          breathing ? styles.breathing : '',
        ].filter(Boolean).join(' ')}
        style={{ left: point.x, top: point.y }}
        title={node === undefined ? label : `${label}${node.role !== '' ? ` · ${node.role}` : ''}`}
      >
        {brand !== null ? brandAvatar(brand, 'node') : null}
        <div className={styles.nodeLabel}>{label}</div>
        {kind === 'node' ? (
          <div className={styles.nodeMeta}>
            {node?.activity === 'running' ? translate('activityRunning') : ''}
          </div>
        ) : null}
        {/* Connection ports: a small hit-dot on each side of the node, like a
            Dify workflow port. Drag from one to wire a directed edge. The dots
            sit on the node rim so the wire visibly "grows out of" the expert. */}
        {(['n', 'e', 's', 'w'] as const).map((dir) => (
          <div
            key={dir}
            className={`${styles.port} ${styles[`port${dir.toUpperCase()}`]}`}
            role="button"
            tabIndex={0}
            aria-label="connect"
            data-port-dir={dir}
            onMouseDown={(event) => {
              event.preventDefault()
              event.stopPropagation()
              startDrag(event.clientX, event.clientY)
            }}
          />
        ))}
      </div>
    )
  }

  return (
    <div className={styles.root}>
      <div className={styles.main}>
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
                    {sourcePrefix(candidate.captainSessionId)} · {candidate.name}
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
        <div ref={containerRef} className={[styles.canvas, drag !== null ? styles.canvasDragging : ''].filter(Boolean).join(' ')}>
          <svg className={styles.edgeLayer} width={size.w > 0 ? size.w : 900} height={size.h > 0 ? size.h : 480}>
            {meeting.edges.map(renderEdge)}
            {drag !== null && positions.get(drag.from) !== undefined ? (
              (() => {
                const start = positions.get(drag.from)
                if (start === undefined) return null
                const end = { x: drag.x, y: drag.y }
                const midX = (start.x + end.x) / 2
                const midY = (start.y + end.y) / 2
                const nx = -(end.y - start.y)
                const ny = end.x - start.x
                const len = Math.max(1, Math.hypot(nx, ny))
                const bow = 0.14
                const cx = midX + (nx / len) * len * bow
                const cy = midY + (ny / len) * len * bow
                const d = `M ${start.x} ${start.y} Q ${cx} ${cy} ${end.x} ${end.y}`
                return <path d={d} fill="none" className={styles.dragLine} />
              })()
            ) : null}
          </svg>
          {renderNode('captain', 'DeepSeek · 主持', 'captain')}
          {renderNode('aggregator', '汇聚网关', 'aggregator')}
          {meeting.nodes.map((node) => renderNode(node.key, node.key, 'node'))}
          {edgeRemoveDots.map((dot) => (
            <button
              key={dot.id}
              type="button"
              className={[styles.edgeRemove, hoverEdgeId === dot.id ? styles.edgeRemoveActive : ''].filter(Boolean).join(' ')}
              style={{ left: dot.cx, top: dot.cy }}
              aria-label="delete edge"
              onMouseEnter={() => setHoverEdge(dot.id)}
              onMouseLeave={() => clearHoverEdge(dot.id)}
              onClick={() => {
                void rpc<unknown>('roundtable/edge.remove', { meetingId: meeting.id, edgeId: dot.id })
                  .then(() => refresh())
                  .catch(() => undefined)
              }}
            >
              ×
            </button>
          ))}
          {activeMessages.map((message) => {
            const from = positions.get(message.from)
            const to = positions.get(message.to)
            if (from === undefined || to === undefined) return null
            return <div key={message.id} className={styles.msgPulse} style={flowStyle(from, to)} />
          })}
          {toast !== null ? (
            <div className={styles.toast}>
              <span className={toast.kind === 'ok' ? styles.toastOk : styles.toastErr}>{toast.text}</span>
            </div>
          ) : null}
        </div>
        <details className={styles.digest}>
          <summary>{translate('gatewayDigest')}</summary>
          <pre className={styles.digestBody}>{meeting.digest || translate('noDigest')}</pre>
        </details>
      </div>

      <aside className={styles.sidebar}>
        <div className={styles.sidebarActions}>
          {pendingActionCount > 0 ? (
            <span className={styles.pendingBadge}>{translate('pendingBadge').replace('{n}', String(pendingActionCount))}</span>
          ) : null}
          <button
            type="button"
            className={styles.meetingDelete}
            aria-label={translate('meetingDelete')}
            title={translate('meetingDelete')}
            onClick={() => {
              const confirmed = window.confirm(translate('meetingDeleteConfirm').replace('{name}', meeting.name))
              if (!confirmed) return
              void rpc<unknown>('roundtable/meeting.delete', { meetingId: meeting.id })
                .then(() => { setSelectedId(undefined); void refresh() })
                .catch(() => undefined)
            }}
          >
            🗑 {translate('meetingDelete')}
          </button>
        </div>
        <section className={styles.panel}>
          <div className={styles.panelTitleRow}>
            <span className={styles.panelTitle}>{translate('agents')}</span>
            <button
              type="button"
              className={styles.panelAdd}
              aria-label={translate('editAgents')}
              title={translate('editAgents')}
              onClick={openManage}
            >
              ＋
            </button>
          </div>
          <div className={styles.panelBody}>
            {meeting.nodes.map((node) => {
              const brand = providerBrand(node.provider)
              const removed = node.status === 'removed' || node.activity === 'removed'
              const queuedRemove = pendingRemoveKeys.has(node.key)
              return (
                <div className={[styles.agentRow, removed ? styles.agentRowRemoved : ''].filter(Boolean).join(' ')} key={node.key}>
                  {brandAvatar(brand, 'list')}
                  <div className={styles.agentInfo}>
                    <div className={styles.agentName}>{node.key}</div>
                    <div className={styles.agentRole}>{node.role}</div>
                  </div>
                  {queuedRemove ? (
                    <span className={styles.agentQueuedRemove}>{translate('managePendingRemove')}</span>
                  ) : (
                    <span className={node.activity === 'running' ? styles.agentStatusWorking : removed ? styles.agentStatusRemoved : styles.agentStatus}>
                      {nodeStatusLabel(node, translate)}
                    </span>
                  )}
                </div>
              )
            })}
          </div>
        </section>

        <section className={styles.panel}>
          <div className={styles.panelTitleRow}>
            <span className={styles.panelTitle}>{translate('tasks')}</span>
            <button
              type="button"
              className={styles.panelAdd}
              aria-label={translate('editAgents')}
              title={translate('editAgents')}
              onClick={openManage}
            >
              ＋
            </button>
          </div>
          <div className={styles.panelBody}>
            {meeting.nodes.map((node) => {
              const expanded = expandedTask === node.key
              return (
                <div className={styles.taskRow} key={node.key}>
                  <button
                    type="button"
                    className={styles.taskToggle}
                    onClick={() => setExpandedTask(expanded ? null : node.key)}
                  >
                    <span className={styles.taskChevron}>{expanded ? '▾' : '▸'}</span>
                    <span className={styles.taskKey}>{node.key}</span>
                  </button>
                  <div className={expanded ? styles.taskRoleExpanded : styles.taskRole}>
                    {node.role || '—'}
                  </div>
                </div>
              )
            })}
          </div>
        </section>

        <section className={styles.panel}>
          <div className={styles.panelTitleRow}>
            <span className={styles.panelTitle}>{translate('kb')}</span>
            <button
              type="button"
              className={styles.panelAdd}
              aria-label={translate('editKb')}
              title={translate('editKb')}
              onClick={openKb}
            >
              ＋
            </button>
          </div>
          <div className={styles.panelBody}>
            {meeting.kbPath !== '' ? (
              <div className={styles.kbPathRow} title={meeting.kbPath}>{meeting.kbPath}</div>
            ) : (
              <div className={styles.panelEmpty}>{translate('kbNotSet')}</div>
            )}
          </div>
        </section>

        <section className={styles.panel}>
          <div className={styles.panelTitleRow}>
            <span className={styles.panelTitle}>{translate('activity')}</span>
          </div>
          <div className={styles.panelBody}>
            {(meeting.recent ?? []).length === 0 ? (
              <div className={styles.panelEmpty}>{translate('noActivity')}</div>
            ) : (meeting.recent ?? []).map((utterance) => (
              <div className={styles.logRow} key={utterance.id}>
                <div className={styles.logHead}>
                  <span className={styles.logFrom}>{utterance.from} → {utterance.to}</span>
                  <span className={styles.logTime}>
                    {new Date(utterance.ts).toLocaleTimeString('zh-CN', { hour12: false })}
                  </span>
                </div>
                <div className={styles.logText}>{utterance.text}</div>
              </div>
            ))}
          </div>
        </section>

        <section className={styles.panel}>
          <div className={styles.panelTitleRow}>
            <span className={styles.panelTitle}>{translate('files')}</span>
          </div>
          <div className={styles.panelBody}>
            <div className={styles.panelEmpty}>{translate('filesEmpty')}</div>
          </div>
        </section>
      </aside>

      {kbOpen ? (
        <div className={styles.manageOverlay} onClick={closeKb}>
          <div
            className={styles.manageModal}
            onClick={(event) => event.stopPropagation()}
            role="dialog"
            aria-label={translate('kbTitle')}
          >
            <div className={styles.manageTitle}>
              {translate('kbTitle')} · {meeting.name}
            </div>

            <div className={styles.kbPathForm}>
              <div className={styles.manageFormRow}>
                <label className={styles.manageLabel}>{translate('kbPathLabel')}</label>
                <input
                  className={styles.manageInput}
                  value={kbPathInput}
                  placeholder={translate('kbPathPlaceholder')}
                  onChange={(event) => setKbPathInput(event.target.value)}
                />
              </div>
              <label className={styles.kbChangedRow}>
                <input
                  type="checkbox"
                  className={styles.switchInput}
                  checked={kbContentChanged}
                  onChange={(event) => setKbContentChanged(event.target.checked)}
                />
                <span>{translate('kbContentChanged')}</span>
              </label>
              <button type="button" className={styles.manageAddBtn} onClick={saveKbPath}>
                {translate('kbSave')}
              </button>
            </div>

            <div className={styles.manageSectionTitle}>{translate('kbFiles')}</div>
            <div className={styles.kbList}>
              {kbListing === null ? (
                <div className={styles.panelEmpty}>{translate('kbLoadHint')}</div>
              ) : kbListing.error !== '' ? (
                <div className={styles.kbError}>{kbListing.error}</div>
              ) : kbListing.files.length === 0 ? (
                <div className={styles.panelEmpty}>{translate('kbEmpty')}</div>
              ) : (
                kbListing.files.map((entry) => (
                  <div className={styles.kbRow} key={entry.name}>
                    <span className={entry.kind === 'dir' ? styles.kbKindDir : styles.kbKindFile}>
                      {entry.kind === 'dir' ? '📁' : '📄'}
                    </span>
                    <span className={styles.kbName} title={entry.name}>{entry.name}</span>
                    {entry.kind === 'file' ? (
                      <span className={styles.kbMeta}>
                        {entry.ext !== '' ? `.${entry.ext}` : ''}
                        {entry.size > 0 ? ` · ${formatKbSize(entry.size)}` : ''}
                      </span>
                    ) : null}
                  </div>
                ))
              )}
            </div>

            <div className={styles.manageFooter}>
              <span className={styles.manageHint}>{translate('kbBrowseHint')}</span>
              <button type="button" className={styles.manageCloseBtn} onClick={closeKb}>
                {translate('manageClose')}
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {manageOpen ? (
        <div className={styles.manageOverlay} onClick={closeManage}>
          <div
            className={styles.manageModal}
            onClick={(event) => event.stopPropagation()}
            role="dialog"
            aria-label={translate('manageTitle')}
          >
            <div className={styles.manageTitle}>
              {translate('manageTitle')} · {meeting.name}
            </div>
            {pendingActionCount > 0 ? (
              <div className={styles.managePendingNote}>{translate('managePendingNote')}</div>
            ) : null}

            <div className={styles.manageSectionTitle}>{translate('manageExisting')}</div>
            <div className={styles.manageList}>
              {meeting.nodes.map((node) => {
                const brand = providerBrand(node.provider)
                const removed = node.status === 'removed' || node.activity === 'removed'
                const queuedRemove = pendingRemoveKeys.has(node.key)
                return (
                  <div className={[styles.manageRow, removed ? styles.agentRowRemoved : ''].filter(Boolean).join(' ')} key={node.key}>
                    {brandAvatar(brand, 'list')}
                    <div className={styles.agentInfo}>
                      <div className={styles.agentName}>{node.key}</div>
                      <div className={styles.agentRole}>
                        {node.role !== '' ? `${node.role} · ` : ''}{node.provider !== '' ? `${node.provider}/${node.model}` : '（未指定模型）'}
                      </div>
                    </div>
                    {removed ? (
                      <span className={styles.manageStatusTag}>{translate('activityRemoved')}</span>
                    ) : queuedRemove ? (
                      <span className={styles.managePendingTag}>{translate('managePendingRemove')}</span>
                    ) : (
                      <button
                        type="button"
                        className={styles.manageRemoveBtn}
                        onClick={() => queueRemove(node)}
                      >
                        {translate('manageRemove')}
                      </button>
                    )}
                  </div>
                )
              })}
              {meeting.nodes.length === 0 && pendingAddKeys.size === 0 ? (
                <div className={styles.panelEmpty}>{translate('manageNoExperts')}</div>
              ) : null}
              {[...pendingAddKeys].map((key) => (
                <div className={styles.manageRow} key={`pending-${key}`}>
                  <div className={styles.managePendingAvatar}>＋</div>
                  <div className={styles.agentInfo}>
                    <div className={styles.agentName}>{key}</div>
                    <div className={styles.agentRole}>{translate('managePendingAddRole')}</div>
                  </div>
                  <span className={styles.managePendingTag}>{translate('managePendingAdd')}</span>
                </div>
              ))}
            </div>

            <div className={styles.manageSectionTitle}>{translate('manageAddTitle')}</div>
            <div className={styles.manageForm}>
              <div className={styles.manageFormRow}>
                <label className={styles.manageLabel}>{translate('manageName')}</label>
                <input
                  className={styles.manageInput}
                  value={form.name}
                  placeholder={translate('manageNamePlaceholder')}
                  onChange={(event) => setForm((previous) => ({ ...previous, name: event.target.value }))}
                />
              </div>
              <div className={styles.manageFormRow}>
                <label className={styles.manageLabel}>{translate('manageRole')}</label>
                <input
                  className={styles.manageInput}
                  value={form.role}
                  placeholder={translate('manageRolePlaceholder')}
                  onChange={(event) => setForm((previous) => ({ ...previous, role: event.target.value }))}
                />
              </div>
              <div className={styles.manageFormRow}>
                <label className={styles.manageLabel}>{translate('manageModel')}</label>
                <select
                  className={styles.manageSelect}
                  value={form.provider}
                  onChange={(event) => handleProviderChange(event.target.value)}
                >
                  <option value="">{translate('manageModelInherit')}</option>
                  {providers.map((provider) => (
                    <option key={provider.id} value={provider.id}>{provider.name || provider.id}</option>
                  ))}
                </select>
                <select
                  className={styles.manageSelect}
                  value={form.model}
                  disabled={form.provider === '' || !modelsLoaded}
                  onChange={(event) => setForm((previous) => ({ ...previous, model: event.target.value }))}
                >
                  <option value="">{translate('manageModelInherit')}</option>
                  {(providers.find((provider) => provider.id === form.provider)?.models ?? []).map((model) => (
                    <option key={model.id} value={model.id}>{model.name || model.id}</option>
                  ))}
                </select>
              </div>
              <button type="button" className={styles.manageAddBtn} onClick={submitAdd}>
                {translate('manageAddBtn')}
              </button>
            </div>

            <div className={styles.manageFooter}>
              <span className={styles.manageHint}>{translate('manageEffectiveHint')}</span>
              <button type="button" className={styles.manageCloseBtn} onClick={closeManage}>
                {translate('manageClose')}
              </button>
            </div>
          </div>
        </div>
      ) : null}
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
