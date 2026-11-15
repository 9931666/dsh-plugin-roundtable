/**
 * 圆桌全局面板（宿主 `main` keyed 槽，key = `roundtable`）。
 *
 * 与 `conversation.view` 的「圆桌会议」标签页互补：标签页只活在某个对话里，
 * 而这里是**跨对话、跨工作区**的只读入口 —— 左侧列出全部会议（可按工作区
 * 收窄），右侧复用同一个 `RoundTableView` 渲染拓扑。
 *
 * 三条刻意约束：
 *   1. **只读**：左侧列表没有删除 / 导出 / 跳转对话，点击只切换右侧视图。
 *   2. **不碰会话**：主面板的 key 不是 `conversation`，宿主不给它会话绑定，
 *      所以这里绝不调用任何会话级服务，只读 `fetchMeetings()` 与插件自己的 RPC。
 *   3. **不复制拓扑实现**：右侧就是 `RoundTableView`，用 `key` + `initialMeetingId`
 *      让切换生效，避免两套画布各自漂移。
 *
 * @module @y9931666/dsh-plugin-roundtable/client/RoundTablePanel
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { SessionId } from '@deepseek-ai/dsh-client-connection/client'
import type { RpcCaller, WireMeeting } from './wire.ts'
import { fetchMeetings } from './wire.ts'
import { RoundTableView, sourcePrefix } from './RoundTableView.tsx'
import styles from './RoundTablePanel.module.css'

export interface RoundTablePanelInjected {
  rpc: RpcCaller
  /** Locale-bound translator for the roundtable namespace. */
  t: (key: string) => string
}

export interface RoundTablePanelProps extends RoundTablePanelInjected {}

/**
 * 左侧列表的轮询间隔。
 *
 * 面板是**唯一的轮询者**：它把拿到的整份快照通过 `providedMeetings` 下传给
 * 右侧的 `RoundTableView`，后者不再自己拉全量（M3 —— 早先面板 2s + 内嵌视图
 * 1s 各拉一份跨工作区全量快照，等于双倍负载，而明细视图其实只需要同一份数据）。
 */
const POLL_MS = 2000

/** 范围选择的哨兵值：全部工作区。 */
const ALL_WORKSPACES = '__all__'

/** 一场会议"最近活动"的时间戳：取最新发言，没有发言则退回 0。 */
function lastActivityAt(meeting: WireMeeting): number {
  let latest = 0
  for (const utterance of meeting.recent ?? []) {
    if (typeof utterance.ts === 'number' && utterance.ts > latest) latest = utterance.ts
  }
  return latest
}

/** 会议状态文案：宿主只有 active / ended 两种稳定值，其余一律按"进行中"显示。 */
function statusKey(meeting: WireMeeting): string {
  return meeting.status === 'ended' ? 'panelStatusEnded' : 'panelStatusActive'
}

export function RoundTablePanel(props: RoundTablePanelProps): JSX.Element {
  const { rpc, t } = props
  const [meetings, setMeetings] = useState<WireMeeting[]>([])
  const [scope, setScope] = useState<string>(ALL_WORKSPACES)
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined)
  const [failed, setFailed] = useState(false)
  // 快照路线慢时不要叠请求：轮询与手动刷新共用同一个 load。
  const inflight = useRef(false)

  const load = useCallback(async (): Promise<void> => {
    if (inflight.current) return
    inflight.current = true
    try {
      // 不带 session 参数 = 宿主返回全部工作区的会议（与「互通」开关无关：
      // 这个面板本身就是跨对话视图）。
      setMeetings(await fetchMeetings())
      setFailed(false)
    } catch {
      setFailed(true)
    } finally {
      inflight.current = false
    }
  }, [])

  // 轮询 + 手动刷新共用同一个 load；离开面板即停表。
  useEffect(() => {
    void load()
    const timer = window.setInterval(() => { void load() }, POLL_MS)
    return () => window.clearInterval(timer)
  }, [load])

  /** 工作区选项：来自会议数据的去重，空字符串（旧会议没有该字段）不参与。 */
  const workspaces = useMemo(() => {
    const seen = new Set<string>()
    for (const meeting of meetings) {
      const name = typeof meeting.workspace === 'string' ? meeting.workspace.trim() : ''
      if (name !== '') seen.add(name)
    }
    return [...seen].sort((a, b) => a.localeCompare(b))
  }, [meetings])

  // 选中的工作区消失（会议全被删了）时回退到"全部"，避免下拉出现空值。
  useEffect(() => {
    if (scope !== ALL_WORKSPACES && !workspaces.includes(scope)) setScope(ALL_WORKSPACES)
  }, [scope, workspaces])

  /** 范围过滤 + 排序：最近有发言的排前面，其余按名称（同一时间戳时按中文/英文名）。 */
  const visible = useMemo(() => {
    const filtered = scope === ALL_WORKSPACES
      ? meetings
      : meetings.filter((meeting) => (meeting.workspace ?? '').trim() === scope)
    return [...filtered].sort((a, b) => {
      const byActivity = lastActivityAt(b) - lastActivityAt(a)
      if (byActivity !== 0) return byActivity
      return a.name.localeCompare(b.name)
    })
  }, [meetings, scope])

  const selected = visible.find((meeting) => meeting.id === selectedId) ?? visible[0]

  return (
    <div className={styles.root}>
      <div className={styles.header}>
        <span className={styles.title}>{t('sidebarEntry')}</span>
        <select
          className={styles.scope}
          value={scope}
          aria-label={t('panelAllWorkspaces')}
          onChange={(event) => setScope(event.target.value)}
        >
          <option value={ALL_WORKSPACES}>{t('panelAllWorkspaces')}</option>
          {workspaces.map((workspace) => (
            <option key={workspace} value={workspace}>{workspace}</option>
          ))}
        </select>
        <button type="button" className={styles.refresh} onClick={() => { void load() }}>
          {t('panelRefresh')}
        </button>
        <span className={styles.hint}>{t('panelHint')}</span>
        {failed ? <span className={styles.failed}>{t('fetchFailed')}</span> : null}
      </div>
      <div className={styles.body}>
        <div className={styles.list}>
          {visible.length === 0 ? (
            <div className={styles.listEmpty}>{t('panelEmpty')}</div>
          ) : (
            visible.map((meeting) => {
              const active = selected !== undefined && meeting.id === selected.id
              const expertCount = meeting.nodes.filter((node) => node.status !== 'removed').length
              const workspace = (meeting.workspace ?? '').trim()
              return (
                <button
                  key={meeting.id}
                  type="button"
                  className={active ? `${styles.item} ${styles.itemActive}` : styles.item}
                  aria-current={active ? 'true' : undefined}
                  onClick={() => setSelectedId(meeting.id)}
                >
                  <span className={styles.itemName}>{meeting.name}</span>
                  <span className={meeting.status === 'ended' ? `${styles.status} ${styles.statusEnded}` : styles.status}>
                    {t(statusKey(meeting))}
                  </span>
                  <span className={styles.itemMeta}>
                    {sourcePrefix(meeting.captainSessionId)}
                    {workspace === '' ? '' : ` · ${workspace}`}
                  </span>
                  <span className={styles.itemMeta}>
                    {t('panelMeta')
                      .replace('{rounds}', String(meeting.round))
                      .replace('{experts}', String(expertCount))}
                  </span>
                </button>
              )
            })
          )}
        </div>
        <div className={styles.detail}>
          {selected === undefined ? null : (
            // key 让每次切换都重新挂载拓扑视图；initialMeetingId 保证挂载后
            // 首帧就选中这一场（而不是列表里的第一场）。
            <div className={styles.detailView}>
              <RoundTableView
                key={selected.id}
                sessionId={selected.captainSessionId as unknown as SessionId}
                rpc={rpc}
                t={t}
                initialMeetingId={selected.id}
                // 面板已经在轮询同一份全量快照：下传给它，视图**不再自己拉**
                // （M3：早先是 2s + 1s 两份跨工作区全量，重复且浪费）。
                providedMeetings={meetings}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
