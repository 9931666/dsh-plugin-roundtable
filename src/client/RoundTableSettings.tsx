/**
 * RoundTable preference page (settings.section): default collaboration mode
 * and budget defaults. Switching to egalitarian mode surfaces the safety
 * limits (max rounds / max tokens) with a warning-style hint.
 * @module dsh-plugin-roundtable/client/RoundTableSettings
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { RpcCaller, RoundTablePrefs, WireFeedbackEntry, WireProviderOption, WireRolePreset, WireRoleSquad } from './wire.ts'
import { InlineIcon } from './icons.tsx'
import styles from './RoundTableSettings.module.css'

export interface RoundTableSettingsInjected {
  rpc: RpcCaller
  t: (key: string) => string
}

export interface RoundTableSettingsProps extends RoundTableSettingsInjected {}

/** E1/E3 反馈的评分文案（列表元数据显示）。 */
const RATING_LABEL: Record<WireFeedbackEntry['rating'], string> = {
  good: '👍',
  meh: '😐',
  bad: '👎',
}

/** R3：右栏面板的稳定 id 与文案键（与 host `ROUNDTABLE_PANELS` 一一对应）。 */
const PANEL_KEYS: ReadonlyArray<{ id: string; labelKey: string }> = [
  { id: 'agents', labelKey: 'agents' },
  { id: 'tasks', labelKey: 'tasks' },
  { id: 'kb', labelKey: 'kb' },
  { id: 'skills', labelKey: 'skillsTitle' },
  { id: 'activity', labelKey: 'activity' },
  { id: 'review', labelKey: 'reviewPanelTitle' },
  { id: 'files', labelKey: 'files' },
]

/** B3：预设条数上限，与 host `rpc.ts` 的 `ROLE_PRESET_MAX` 保持一致
 *  （客户端提前拦截，服务端仍然会截断，两层都有）。 */
const ROLE_PRESET_LIMIT = 50

/** B3+：阵容条数与成员数上限，与 host `rpc.ts` 的 `SQUAD_MAX` /
 *  `SQUAD_MEMBER_MAX` 保持一致（客户端提前拦截，服务端仍然会截断）。 */
const SQUAD_LIMIT = 20
const SQUAD_MEMBER_LIMIT = 8

export function RoundTableSettings(props: RoundTableSettingsProps): JSX.Element {
  const { rpc, t } = props
  const [prefs, setPrefs] = useState<RoundTablePrefs | null>(null)
  /**
   * `prefs` 的同步镜像。
   *
   * 三个写入口（保存 / 预设 / 阵容）都要"以最新值为基础"组装整份提交，但它们
   * 都在 `async` 回调里工作 —— 闭包捕获的 `prefs` 往往是旧的。React 的
   * `setState` 不会立刻更新闭包，所以这里维护一份 ref 作为唯一可信基准。
   */
  const prefsRef = useRef<RoundTablePrefs | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  const [saveFailed, setSaveFailed] = useState(false)
  const [saved, setSaved] = useState(false)
  const [saving, setSaving] = useState(false)
  const [feedback, setFeedback] = useState<WireFeedbackEntry[]>([])
  const [feedbackLoadFailed, setFeedbackLoadFailed] = useState(false)
  const [feedbackCleared, setFeedbackCleared] = useState(false)
  // B3 角色预设：列表在 prefs 里，表单与"编辑中"是纯本地状态。
  const [providers, setProviders] = useState<WireProviderOption[]>([])
  const [presetFormOpen, setPresetFormOpen] = useState(false)
  const [editingPresetId, setEditingPresetId] = useState<string | null>(null)
  const [presetDraft, setPresetDraft] = useState<{ name: string; role: string; provider: string; model: string }>({
    name: '',
    role: '',
    provider: '',
    model: '',
  })
  const [presetNotice, setPresetNotice] = useState<'saved' | 'failed' | 'invalid' | 'limit' | null>(null)
  // B3+ 阵容预设：与角色预设同一套做法，只是每条含多位成员。
  const [squadFormOpen, setSquadFormOpen] = useState(false)
  const [editingSquadId, setEditingSquadId] = useState<string | null>(null)
  const [squadDraft, setSquadDraft] = useState<{ name: string; members: Array<{ key: string; role: string; provider: string; model: string }> }>({
    name: '',
    members: [{ key: '', role: '', provider: '', model: '' }],
  })
  const [squadNotice, setSquadNotice] = useState<'saved' | 'failed' | 'invalid' | 'limit' | null>(null)

  // 模型下拉复用与专家管理同一份主机模型目录。
  useEffect(() => {
    void rpc<{ providers: WireProviderOption[] }>('roundtable/models.list', {})
      .then((result) => {
        if (result.ok) setProviders(Array.isArray(result.value?.providers) ? result.value.providers : [])
      })
      .catch(() => undefined)
  }, [rpc])

  const loadFeedback = useCallback((): void => {
    void rpc<{ entries: WireFeedbackEntry[] }>('roundtable/feedback.list', {})
      .then((result) => {
        if (result.ok) {
          setFeedback(Array.isArray(result.value?.entries) ? result.value.entries : [])
          setFeedbackLoadFailed(false)
        } else {
          setFeedbackLoadFailed(true)
        }
      })
      .catch(() => setFeedbackLoadFailed(true))
  }, [rpc])

  /** 唯一的偏好写入口：同时更新 UI 状态与 ref 镜像，保证两者永不漂移。 */
  const applyPrefs = useCallback((next: RoundTablePrefs | null): void => {
    prefsRef.current = next
    setPrefs(next)
  }, [])

  const load = useCallback((): void => {
    void rpc<RoundTablePrefs>('roundtable/prefs.get', {})
      .then((result) => {
        if (result.ok) {
          applyPrefs(result.value)
          setLoadFailed(false)
        } else {
          setLoadFailed(true)
        }
      })
      .catch(() => setLoadFailed(true))
  }, [rpc, applyPrefs])

  useEffect(() => {
    load()
    loadFeedback()
  }, [load, loadFeedback])

  const patch = (next: Partial<RoundTablePrefs>): void => {
    const previous = prefsRef.current
    applyPrefs(previous === null ? null : { ...previous, ...next })
    setSaved(false)
  }

  /** R3：点亮/熄灭一个右栏面板（写入 hiddenPanels）。 */
  const togglePanel = (id: string): void => {
    const previous = prefsRef.current
    if (previous === null) return
    const hidden = Array.isArray(previous.hiddenPanels) ? previous.hiddenPanels : []
    const nextHidden = hidden.includes(id) ? hidden.filter((entry) => entry !== id) : [...hidden, id]
    applyPrefs({ ...previous, hiddenPanels: nextHidden })
    setSaved(false)
  }

  const save = (): void => {
    if (prefs === null || saving) return
    setSaving(true)
    setSaveFailed(false)
    // 走同一条串行队列：与预设/阵容的写入不会互相覆盖。
    enqueuePrefsWrite(
      // 保存按钮提交 UI 上此刻的全部字段。
      (current) => ({
        ...current,
        defaultMode: prefs.defaultMode,
        maxRounds: prefs.maxRounds,
        maxTokens: prefs.maxTokens,
        showAllMeetings: prefs.showAllMeetings,
        expertMaxTokens: prefs.expertMaxTokens,
        expertMaxOpinions: prefs.expertMaxOpinions,
        feedbackEnabled: prefs.feedbackEnabled,
        skillDelivery: prefs.skillDelivery === 'direct' ? 'direct' : 'relay',
        hiddenPanels: Array.isArray(prefs.hiddenPanels) ? prefs.hiddenPanels : [],
        legendHidden: prefs.legendHidden === true,
        sidebarEntryEnabled: prefs.sidebarEntryEnabled !== false,
        conversationTabEnabled: prefs.conversationTabEnabled !== false,
      }),
      (ok) => {
        setSaving(false)
        if (ok) {
          setSaved(true)
          // 两个入口的注册/注销在 client/index.ts（插件 apply 时只读一次偏好），
          // 所以保存成功后广播一次：宿主侧的注册表不在 React 树里，改不了。
          // 用 window 上的自定义事件而不是轮询，是为了让"保存即生效"没有延迟。
          if (typeof window !== 'undefined') {
            window.dispatchEvent(new CustomEvent('roundtable:prefs-changed'))
          }
        } else {
          setSaveFailed(true)
        }
      },
    )
  }

  const clearFeedback = (): void => {
    void rpc<{ cleared: number }>('roundtable/feedback.clear', {})
      .then((result) => {
        if (result.ok) {
          setFeedback([])
          setFeedbackCleared(true)
        } else {
          setFeedbackLoadFailed(true)
        }
      })
      .catch(() => setFeedbackLoadFailed(true))
  }

  /* ---------------- B3：角色预设（改动立即落库，不必等底部保存） ---------------- */

  /**
   * 写入整份偏好。
   *
   * 为什么仍然提交**完整对象**：服务端 `prefs.set` 是"只覆盖出现过的字段"的
   * 合并语义，但客户端不该依赖这一点去拼半个对象（历史上有过"保存成功但刷新
   * 后回退"）。完整对象在两种语义下都正确。
   *
   * 为什么还要排队（M5）：页面里有三个独立写入口（底部保存 / 预设 / 阵容），
   * 它们各自把"当前 UI 快照"整份提交。若用户连续操作（删一个预设的同时点了
   * 保存），两个请求会带着**同一份旧快照**先后落到服务端，后到的会把先到的
   * 覆盖掉 —— 表现为"设置随机回滚"，且极难复现。
   *
   * 这里用一条串行链把它们排成队列：每个任务在**上一个任务完成后**才用当时的
   * 最新 `prefs` 组装快照；并且把服务端返回的权威值写回状态，作为下一次的基准。
   */
  const writeChain = useRef<Promise<void>>(Promise.resolve())

  /**
   * 排队执行一次"整份偏好写入"。
   *
   * @param mutate - 在当前（已是最新）偏好的基础上算出要提交的完整对象
   * @param onSettled - 成功 / 失败回调（各自负责自己的提示文案）
   */
  const enqueuePrefsWrite = (
    mutate: (current: RoundTablePrefs) => RoundTablePrefs,
    onSettled: (ok: boolean, value?: RoundTablePrefs) => void,
  ): void => {
    writeChain.current = writeChain.current.then(async () => {
      // 用 ref 读最新值：闭包里的 `prefs` 可能是旧的。
      const current = prefsRef.current
      if (current === null) {
        onSettled(false)
        return
      }
      const payload = mutate(current)
      setPrefs(payload)
      try {
        const result = await rpc<RoundTablePrefs>('roundtable/prefs.set', { ...payload })
        if (result.ok) {
          // 写回权威值，作为下一次写的基础（避免用过期的 UI 快照覆盖别人的结果）。
          prefsRef.current = result.value
          setPrefs(result.value)
          onSettled(true, result.value)
          return
        }
        onSettled(false)
      } catch {
        onSettled(false)
      }
    })
  }

  /**
   * 新建预设的稳定 id；host 侧只在 id 缺失或重复时才重新分配。
   */
  const newPresetId = (): string =>
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `preset-${Date.now()}-${Math.floor(Math.random() * 1e6)}`

  /** 写入整份偏好（含新的 rolePresets），经队列串行化。 */
  const persistPresets = (next: WireRolePreset[]): void => {
    if (prefs === null) return
    enqueuePrefsWrite(
      (current) => ({ ...current, rolePresets: next }),
      (ok) => setPresetNotice(ok ? 'saved' : 'failed'),
    )
  }

  const openPresetForm = (preset?: WireRolePreset): void => {
    setPresetNotice(null)
    if (preset === undefined) {
      setEditingPresetId(null)
      setPresetDraft({ name: '', role: '', provider: '', model: '' })
    } else {
      setEditingPresetId(preset.id)
      setPresetDraft({
        name: preset.name,
        role: preset.role,
        provider: preset.provider ?? '',
        model: preset.model ?? '',
      })
    }
    setPresetFormOpen(true)
  }

  const closePresetForm = (): void => {
    setPresetFormOpen(false)
    setEditingPresetId(null)
    setPresetDraft({ name: '', role: '', provider: '', model: '' })
  }

  const submitPreset = (): void => {
    if (prefs === null) return
    const name = presetDraft.name.trim()
    const role = presetDraft.role.trim()
    if (name === '' || role === '') {
      setPresetNotice('invalid')
      return
    }
    const current = Array.isArray(prefs.rolePresets) ? prefs.rolePresets : []
    if (editingPresetId === null && current.length >= ROLE_PRESET_LIMIT) {
      setPresetNotice('limit')
      return
    }
    // provider/model 必须成对：只有两者都选好才算"指定路由"，否则继承主持人。
    const routed = presetDraft.provider !== '' && presetDraft.model !== ''
    const entry: WireRolePreset = {
      id: editingPresetId ?? newPresetId(),
      name,
      role,
      ...(routed ? { provider: presetDraft.provider, model: presetDraft.model } : {}),
    }
    const next = editingPresetId === null
      ? [...current, entry]
      : current.map((preset) => (preset.id === editingPresetId ? entry : preset))
    persistPresets(next)
    closePresetForm()
  }

  const deletePreset = (id: string): void => {
    if (prefs === null) return
    const current = Array.isArray(prefs.rolePresets) ? prefs.rolePresets : []
    persistPresets(current.filter((preset) => preset.id !== id))
    if (editingPresetId === id) closePresetForm()
  }

  /* ---------------- B3+：阵容预设（一次套用多位专家） ----------------
   *
   * 阵容只回答「谁来开会」：它是若干位专家的 key + 角色 + 模型。
   * 它**不描述会议怎么开** —— 没有节点顺序、没有连线、没有分支，因此与
   * 「会议模板 / 流程图」是两个概念（红队评审 gpt-2 认定过的边界）。
   * 套用时只是逐位提交 `add-node` user-action，链路与手填完全一致。 */

  const emptySquadMember = (): { key: string; role: string; provider: string; model: string } =>
    ({ key: '', role: '', provider: '', model: '' })

  /** 写入整份偏好（含新的 squads）；理由同 {@link persistPresets}。 */
  const persistSquads = (next: WireRoleSquad[]): void => {
    if (prefs === null) return
    const full: RoundTablePrefs = { ...prefs, squads: next }
    setPrefs(full)
    void rpc<RoundTablePrefs>('roundtable/prefs.set', { ...full })
      .then((result) => {
        if (result.ok) {
          setPrefs(result.value)
          setSquadNotice('saved')
        } else {
          setSquadNotice('failed')
        }
      })
      .catch(() => setSquadNotice('failed'))
  }

  const openSquadForm = (squad?: WireRoleSquad): void => {
    setSquadNotice(null)
    if (squad === undefined) {
      setEditingSquadId(null)
      setSquadDraft({ name: '', members: [emptySquadMember()] })
    } else {
      setEditingSquadId(squad.id)
      setSquadDraft({
        name: squad.name,
        members: squad.members.length === 0
          ? [emptySquadMember()]
          : squad.members.map((member) => ({
            key: member.key,
            role: member.role,
            provider: member.provider ?? '',
            model: member.model ?? '',
          })),
      })
    }
    setSquadFormOpen(true)
  }

  const closeSquadForm = (): void => {
    setSquadFormOpen(false)
    setEditingSquadId(null)
    setSquadDraft({ name: '', members: [emptySquadMember()] })
  }

  const patchSquadMember = (
    index: number,
    next: Partial<{ key: string; role: string; provider: string; model: string }>,
  ): void => {
    setSquadDraft((previous) => ({
      ...previous,
      members: previous.members.map((member, position) => (position === index ? { ...member, ...next } : member)),
    }))
  }

  const addSquadMember = (): void => {
    setSquadDraft((previous) => previous.members.length >= SQUAD_MEMBER_LIMIT
      ? previous
      : { ...previous, members: [...previous.members, emptySquadMember()] })
  }

  const removeSquadMember = (index: number): void => {
    setSquadDraft((previous) => previous.members.length <= 1
      ? previous
      : { ...previous, members: previous.members.filter((_, position) => position !== index) })
  }

  const submitSquad = (): void => {
    if (prefs === null) return
    const name = squadDraft.name.trim()
    const members = squadDraft.members.map((member) => ({ ...member, key: member.key.trim().toLowerCase() }))
    // 任何一位成员的 key 为空即整体不通过：静默丢成员会让"三人阵容"变成两人。
    if (name === '' || members.some((member) => member.key === '')) {
      setSquadNotice('invalid')
      return
    }
    const current = Array.isArray(prefs.squads) ? prefs.squads : []
    if (editingSquadId === null && current.length >= SQUAD_LIMIT) {
      setSquadNotice('limit')
      return
    }
    const entry: WireRoleSquad = {
      id: editingSquadId ?? newPresetId(),
      name,
      members: members.map((member) => {
        const routed = member.provider !== '' && member.model !== ''
        return {
          key: member.key,
          role: member.role.trim(),
          ...(routed ? { provider: member.provider, model: member.model } : {}),
        }
      }),
    }
    const next = editingSquadId === null
      ? [...current, entry]
      : current.map((squad) => (squad.id === editingSquadId ? entry : squad))
    persistSquads(next)
    closeSquadForm()
  }

  const deleteSquad = (id: string): void => {
    if (prefs === null) return
    const current = Array.isArray(prefs.squads) ? prefs.squads : []
    persistSquads(current.filter((squad) => squad.id !== id))
    if (editingSquadId === id) closeSquadForm()
  }

  const formatTs = (ts: number): string => {
    try {
      const date = new Date(ts)
      const pad = (value: number): string => String(value).padStart(2, '0')
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
    } catch {
      return String(ts)
    }
  }

  if (prefs === null) {
    return <div className={styles.note}>{loadFailed ? t('settingsLoadFailed') : '…'}</div>
  }

  const presets = Array.isArray(prefs.rolePresets) ? prefs.rolePresets : []
  const squads = Array.isArray(prefs.squads) ? prefs.squads : []

  return (
    <div className={styles.root}>
      <div className={styles.field}>
        <label className={styles.label}>{t('settingsDefaultMode')}</label>
        <select
          className={styles.select}
          value={prefs.defaultMode}
          onChange={(event) => patch({ defaultMode: event.target.value as RoundTablePrefs['defaultMode'] })}
        >
          <option value="orchestrated">{t('modeOrchestrated')}</option>
          <option value="egalitarian">{t('modeEgalitarian')}</option>
          <option value="redteam">{t('modeRedteam')}</option>
        </select>
        <div className={styles.hint}>{t('settingsDefaultModeHint')}</div>
        {prefs.defaultMode === 'egalitarian' ? (
          <div className={styles.warning}>{t('settingsEgalitarianWarning')}</div>
        ) : null}
      </div>
      <div className={styles.field}>
        <label className={styles.label}>{t('settingsMaxRounds')}</label>
        <input
          className={styles.input}
          type="number"
          min={1}
          value={prefs.maxRounds}
          onChange={(event) => {
            const value = Math.max(1, Math.floor(Number(event.target.value) || 1))
            patch({ maxRounds: value })
          }}
        />
      </div>
      <div className={styles.field}>
        <label className={styles.label}>{t('settingsMaxTokens')}</label>
        <input
          className={styles.input}
          type="number"
          min={1000}
          step={1000}
          value={prefs.maxTokens}
          onChange={(event) => {
            const value = Math.max(1000, Math.floor(Number(event.target.value) || 1000))
            patch({ maxTokens: value })
          }}
        />
      </div>
      <div className={styles.field}>
        <label className={styles.label}>{t('settingsShowAll')}</label>
        <label className={styles.switchRow}>
          <input
            type="checkbox"
            className={styles.switchInput}
            checked={prefs.showAllMeetings}
            onChange={(event) => patch({ showAllMeetings: event.target.checked })}
          />
          <span className={styles.switchTrack} aria-hidden="true" />
          <span className={styles.switchLabel}>{prefs.showAllMeetings ? t('settingsShowAllOn') : t('settingsShowAllOff')}</span>
        </label>
        <div className={styles.hint}>{t('settingsShowAllHint')}</div>
      </div>
      <div className={styles.sectionDivider} />
      <div className={styles.sectionTitle}><InlineIcon name="entry" />{t('settingsEntryTitle')}</div>
      <div className={styles.field}>
        <label className={styles.label}>{t('settingsSidebarEntry')}</label>
        <label className={styles.switchRow}>
          <input
            type="checkbox"
            className={styles.switchInput}
            checked={prefs.sidebarEntryEnabled !== false}
            onChange={(event) => patch({ sidebarEntryEnabled: event.target.checked })}
          />
          <span className={styles.switchTrack} aria-hidden="true" />
          <span className={styles.switchLabel}>
            {prefs.sidebarEntryEnabled !== false ? t('settingsShowAllOn') : t('settingsShowAllOff')}
          </span>
        </label>
        <div className={styles.hint}>{t('settingsSidebarEntryHint')}</div>
      </div>
      <div className={styles.field}>
        <label className={styles.label}>{t('settingsConversationTab')}</label>
        <label className={styles.switchRow}>
          <input
            type="checkbox"
            className={styles.switchInput}
            checked={prefs.conversationTabEnabled !== false}
            onChange={(event) => patch({ conversationTabEnabled: event.target.checked })}
          />
          <span className={styles.switchTrack} aria-hidden="true" />
          <span className={styles.switchLabel}>
            {prefs.conversationTabEnabled !== false ? t('settingsShowAllOn') : t('settingsShowAllOff')}
          </span>
        </label>
        <div className={styles.hint}>{t('settingsConversationTabHint')}</div>
      </div>
      <div className={styles.sectionDivider} />
      <div className={styles.sectionTitle}><InlineIcon name="panel" />{t('settingsPanelsTitle')}</div>
      <div className={styles.field}>
        <div className={styles.panelToggles}>
          {PANEL_KEYS.map((panel) => {
            const visible = !(Array.isArray(prefs.hiddenPanels) ? prefs.hiddenPanels : []).includes(panel.id)
            return (
              <button
                key={panel.id}
                type="button"
                className={visible ? styles.panelToggleOn : styles.panelToggleOff}
                aria-pressed={visible}
                title={`${t(panel.labelKey)} · ${visible ? t('panelOn') : t('panelOff')}`}
                onClick={() => togglePanel(panel.id)}
              >
                <span className={styles.panelDot} aria-hidden="true" />
                <span className={styles.panelToggleLabel}>{t(panel.labelKey)}</span>
              </button>
            )
          })}
        </div>
        <div className={styles.hint}>{t('settingsPanelsHint')}</div>
      </div>
      <div className={styles.sectionDivider} />
      <div className={styles.field}>
        <label className={styles.label}>{t('settingsLegend')}</label>
        <label className={styles.switchRow}>
          <input
            type="checkbox"
            className={styles.switchInput}
            checked={prefs.legendHidden !== true}
            onChange={(event) => patch({ legendHidden: !event.target.checked })}
          />
          <span className={styles.switchTrack} aria-hidden="true" />
          <span className={styles.switchLabel}>
            {prefs.legendHidden !== true ? t('settingsShowAllOn') : t('settingsShowAllOff')}
          </span>
        </label>
        <div className={styles.hint}>{t('settingsLegendHint')}</div>
      </div>
      <div className={styles.sectionDivider} />
      <div className={styles.sectionTitle}><InlineIcon name="skill" />{t('settingsSkillTitle')}</div>
      <div className={styles.field}>
        <label className={styles.label}>{t('settingsSkillDelivery')}</label>
        <select
          className={styles.select}
          value={prefs.skillDelivery === 'direct' ? 'direct' : 'relay'}
          onChange={(event) => patch({ skillDelivery: event.target.value === 'direct' ? 'direct' : 'relay' })}
        >
          <option value="relay">{t('settingsSkillDeliveryRelay')}</option>
          <option value="direct">{t('settingsSkillDeliveryDirect')}</option>
        </select>
        <div className={styles.hint}>
          {prefs.skillDelivery === 'direct' ? t('settingsSkillDeliveryDirectHint') : t('settingsSkillDeliveryRelayHint')}
        </div>
      </div>
      <div className={styles.sectionDivider} />
      <div className={styles.sectionTitle}><InlineIcon name="role" />{t('settingsPresetsTitle')}</div>
      <div className={styles.field}>
        <div className={styles.hint}>{t('settingsPresetsHint')}</div>
        {presets.length === 0 ? (
          <div className={styles.note}>{t('settingsPresetsEmpty')}</div>
        ) : (
          <div className={styles.presetList}>
            {presets.map((preset) => (
              <div key={preset.id} className={styles.presetItem}>
                <div className={styles.presetInfo}>
                  <div className={styles.presetName}>{preset.name}</div>
                  <div className={styles.presetMeta}>{preset.role}</div>
                  <div className={styles.presetRoute}>
                    {preset.provider !== undefined && preset.provider !== '' && preset.model !== undefined && preset.model !== ''
                      ? `${preset.provider}/${preset.model}`
                      : t('manageModelInherit')}
                  </div>
                </div>
                <div className={styles.presetActions}>
                  <button type="button" className={styles.presetBtn} onClick={() => openPresetForm(preset)}>
                    {t('settingsPresetEdit')}
                  </button>
                  <button
                    type="button"
                    className={`${styles.presetBtn} ${styles.presetDeleteBtn}`}
                    onClick={() => deletePreset(preset.id)}
                  >
                    {t('settingsPresetDelete')}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
        {presetFormOpen ? (
          <div className={styles.presetForm}>
            <div className={styles.presetFormRow}>
              <label className={styles.label}>{t('settingsPresetName')}</label>
              <input
                className={styles.input}
                value={presetDraft.name}
                placeholder={t('settingsPresetNamePlaceholder')}
                onChange={(event) => setPresetDraft((previous) => ({ ...previous, name: event.target.value }))}
              />
            </div>
            <div className={styles.presetFormRow}>
              <label className={styles.label}>{t('settingsPresetRole')}</label>
              <input
                className={styles.input}
                value={presetDraft.role}
                placeholder={t('settingsPresetRolePlaceholder')}
                onChange={(event) => setPresetDraft((previous) => ({ ...previous, role: event.target.value }))}
              />
            </div>
            <div className={styles.presetFormRow}>
              <label className={styles.label}>{t('settingsPresetModel')}</label>
              <div className={styles.presetModelRow}>
                <select
                  className={styles.presetSelect}
                  value={presetDraft.provider}
                  onChange={(event) => setPresetDraft((previous) => ({ ...previous, provider: event.target.value, model: '' }))}
                >
                  <option value="">{t('manageModelInherit')}</option>
                  {providers.map((provider) => (
                    <option key={provider.id} value={provider.id}>{provider.name || provider.id}</option>
                  ))}
                </select>
                <select
                  className={styles.presetSelect}
                  value={presetDraft.model}
                  disabled={presetDraft.provider === ''}
                  onChange={(event) => setPresetDraft((previous) => ({ ...previous, model: event.target.value }))}
                >
                  <option value="">{t('manageModelInherit')}</option>
                  {(providers.find((provider) => provider.id === presetDraft.provider)?.models ?? []).map((model) => (
                    <option key={model.id} value={model.id}>{model.name || model.id}</option>
                  ))}
                </select>
              </div>
            </div>
            <div className={styles.presetFormActions}>
              <button type="button" className={styles.presetAddBtn} onClick={submitPreset}>
                {t('settingsPresetSave')}
              </button>
              <button type="button" className={styles.presetCancelBtn} onClick={closePresetForm}>
                {t('settingsPresetCancel')}
              </button>
            </div>
          </div>
        ) : (
          <button type="button" className={styles.presetAddBtn} onClick={() => openPresetForm()}>
            + {t('settingsPresetAdd')}
          </button>
        )}
        {presetNotice === 'saved' ? <span className={styles.saved}>{t('settingsPresetUpdated')}</span> : null}
        {presetNotice === 'failed' ? <span className={styles.failed}>{t('settingsSaveFailed')}</span> : null}
        {presetNotice === 'invalid' ? <span className={styles.failed}>{t('settingsPresetInvalid')}</span> : null}
        {presetNotice === 'limit' ? (
          <span className={styles.failed}>{t('settingsPresetLimit').replace('{max}', String(ROLE_PRESET_LIMIT))}</span>
        ) : null}
      </div>
      <div className={styles.sectionDivider} />
      <div className={styles.sectionTitle}><InlineIcon name="squad" />{t('settingsSquadTitle')}</div>
      <div className={styles.field}>
        <div className={styles.hint}>{t('settingsSquadHint')}</div>
        {squads.length === 0 ? (
          <div className={styles.note}>{t('settingsSquadEmpty')}</div>
        ) : (
          <div className={styles.presetList}>
            {squads.map((squad) => (
              <div key={squad.id} className={styles.presetItem}>
                <div className={styles.presetInfo}>
                  <div className={styles.presetName}>{squad.name}</div>
                  <div className={styles.presetMeta}>
                    {squad.members
                      .map((member) => (member.provider !== undefined && member.provider !== '' && member.model !== undefined && member.model !== ''
                        ? `${member.key}（${member.provider}/${member.model}）`
                        : member.key))
                      .join(' · ')}
                  </div>
                  <div className={styles.presetRoute}>
                    {t('settingsSquadMemberCount').replace('{count}', String(squad.members.length))}
                  </div>
                </div>
                <div className={styles.presetActions}>
                  <button type="button" className={styles.presetBtn} onClick={() => openSquadForm(squad)}>
                    {t('settingsSquadEdit')}
                  </button>
                  <button
                    type="button"
                    className={`${styles.presetBtn} ${styles.presetDeleteBtn}`}
                    onClick={() => deleteSquad(squad.id)}
                  >
                    {t('settingsSquadDelete')}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
        {squadFormOpen ? (
          <div className={styles.presetForm}>
            <div className={styles.presetFormRow}>
              <label className={styles.label}>{t('settingsSquadName')}</label>
              <input
                className={styles.input}
                value={squadDraft.name}
                placeholder={t('settingsSquadNamePlaceholder')}
                onChange={(event) => setSquadDraft((previous) => ({ ...previous, name: event.target.value }))}
              />
            </div>
            <div className={styles.presetFormRow}>
              <label className={styles.label}>{t('settingsSquadMembers')}</label>
              {squadDraft.members.map((member, index) => (
                <div key={`squad-member-${index}`} className={styles.squadMemberRow}>
                  <input
                    className={styles.presetSelect}
                    value={member.key}
                    placeholder={t('settingsSquadMemberKeyPlaceholder')}
                    aria-label={t('settingsSquadMemberKey')}
                    onChange={(event) => patchSquadMember(index, { key: event.target.value })}
                  />
                  <input
                    className={styles.presetSelect}
                    value={member.role}
                    placeholder={t('settingsPresetRolePlaceholder')}
                    onChange={(event) => patchSquadMember(index, { role: event.target.value })}
                  />
                  <select
                    className={styles.presetSelect}
                    value={member.provider}
                    onChange={(event) => patchSquadMember(index, { provider: event.target.value, model: '' })}
                  >
                    <option value="">{t('manageModelInherit')}</option>
                    {providers.map((provider) => (
                      <option key={provider.id} value={provider.id}>{provider.name || provider.id}</option>
                    ))}
                  </select>
                  <select
                    className={styles.presetSelect}
                    value={member.model}
                    disabled={member.provider === ''}
                    onChange={(event) => patchSquadMember(index, { model: event.target.value })}
                  >
                    <option value="">{t('manageModelInherit')}</option>
                    {(providers.find((provider) => provider.id === member.provider)?.models ?? []).map((model) => (
                      <option key={model.id} value={model.id}>{model.name || model.id}</option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className={`${styles.presetBtn} ${styles.presetDeleteBtn}`}
                    disabled={squadDraft.members.length <= 1}
                    onClick={() => removeSquadMember(index)}
                  >
                    {t('settingsSquadRemoveMember')}
                  </button>
                </div>
              ))}
              <button
                type="button"
                className={styles.presetCancelBtn}
                disabled={squadDraft.members.length >= SQUAD_MEMBER_LIMIT}
                onClick={addSquadMember}
              >
                {t('settingsSquadAddMember')}
              </button>
            </div>
            <div className={styles.presetFormActions}>
              <button type="button" className={styles.presetAddBtn} onClick={submitSquad}>
                {t('settingsSquadSave')}
              </button>
              <button type="button" className={styles.presetCancelBtn} onClick={closeSquadForm}>
                {t('settingsSquadCancel')}
              </button>
            </div>
          </div>
        ) : (
          <button type="button" className={styles.presetAddBtn} onClick={() => openSquadForm()}>
            + {t('settingsSquadAdd')}
          </button>
        )}
        {squadNotice === 'saved' ? <span className={styles.saved}>{t('settingsSquadUpdated')}</span> : null}
        {squadNotice === 'failed' ? <span className={styles.failed}>{t('settingsSaveFailed')}</span> : null}
        {squadNotice === 'invalid' ? <span className={styles.failed}>{t('settingsSquadInvalid')}</span> : null}
        {squadNotice === 'limit' ? (
          <span className={styles.failed}>
            {t('settingsSquadLimit').replace('{max}', String(SQUAD_LIMIT)).replace('{members}', String(SQUAD_MEMBER_LIMIT))}
          </span>
        ) : null}
      </div>
      <div className={styles.sectionDivider} />
      <div className={styles.sectionTitle}><InlineIcon name="gauge" />{t('settingsLimitsTitle')}</div>
      <div className={styles.field}>
        <label className={styles.label}>{t('settingsExpertMaxTokens')}</label>
        <input
          className={styles.input}
          type="number"
          min={0}
          step={500}
          value={prefs.expertMaxTokens}
          onChange={(event) => {
            const value = Math.max(0, Math.floor(Number(event.target.value) || 0))
            patch({ expertMaxTokens: value })
          }}
        />
        <div className={styles.hint}>{t('settingsExpertMaxTokensHint')}</div>
      </div>
      <div className={styles.field}>
        <label className={styles.label}>{t('settingsExpertMaxOpinions')}</label>
        <input
          className={styles.input}
          type="number"
          min={0}
          value={prefs.expertMaxOpinions}
          onChange={(event) => {
            const value = Math.max(0, Math.floor(Number(event.target.value) || 0))
            patch({ expertMaxOpinions: value })
          }}
        />
        <div className={styles.hint}>{t('settingsExpertMaxOpinionsHint')}</div>
      </div>
      <div className={styles.sectionDivider} />
      <div className={styles.sectionTitle}><InlineIcon name="message" />{t('feedbackTitle')}</div>
      <div className={styles.field}>
        <label className={styles.label}>{t('feedbackEnabled')}</label>
        <label className={styles.switchRow}>
          <input
            type="checkbox"
            className={styles.switchInput}
            checked={prefs.feedbackEnabled !== false}
            onChange={(event) => patch({ feedbackEnabled: event.target.checked })}
          />
          <span className={styles.switchTrack} aria-hidden="true" />
          <span className={styles.switchLabel}>
            {prefs.feedbackEnabled !== false ? t('settingsShowAllOn') : t('settingsShowAllOff')}
          </span>
        </label>
        <div className={styles.hint}>{t('feedbackEnabledHint')}</div>
        <div className={styles.feedbackNote}>{t('feedbackPrivacyNote')}</div>
      </div>
      <div className={styles.field}>
        <label className={styles.label}>{t('feedbackListTitle')}</label>
        {feedbackLoadFailed ? (
          <div className={styles.note}>{t('feedbackLoadFailed')}</div>
        ) : feedback.length === 0 ? (
          <div className={styles.note}>{t('feedbackListEmpty')}</div>
        ) : (
          <div className={styles.feedbackList}>
            {feedback.map((entry) => (
              <div key={entry.id} className={styles.feedbackItem}>
                <div className={styles.feedbackMeta}>
                  {t('feedbackEntryMeta')
                    .replace('{date}', formatTs(entry.ts))
                    .replace('{mode}', entry.mode)
                    .replace('{providers}', [...new Set([...entry.providers, ...entry.models])].join(', ') || '-')
                    .replace('{rounds}', String(entry.usedRounds))
                    .replace('{tokens}', String(entry.usedTokens))
                    .replace('{rating}', RATING_LABEL[entry.rating] ?? entry.rating)}
                </div>
                {entry.note !== undefined && entry.note !== '' ? (
                  <div className={styles.feedbackNoteText}>{entry.note}</div>
                ) : null}
              </div>
            ))}
          </div>
        )}
        <button type="button" className={styles.feedbackClearBtn} onClick={clearFeedback}>
          {t('feedbackClear')}
        </button>
        {feedbackCleared ? <span className={styles.saved}>{t('feedbackCleared')}</span> : null}
      </div>
      <div className={styles.actions}>
        <button type="button" className={styles.saveButton} disabled={saving} onClick={save}>
          {saving ? '…' : t('settingsSave')}
        </button>
        {saved ? <span className={styles.saved}>{t('settingsSaved')}</span> : null}
        {saveFailed ? <span className={styles.failed}>{t('settingsSaveFailed')}</span> : null}
      </div>
    </div>
  )
}
