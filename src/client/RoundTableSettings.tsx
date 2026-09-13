/**
 * RoundTable preference page (settings.section): default collaboration mode
 * and budget defaults. Switching to egalitarian mode surfaces the safety
 * limits (max rounds / max tokens) with a warning-style hint.
 * @module dsh-plugin-roundtable/client/RoundTableSettings
 */

import { useCallback, useEffect, useState } from 'react'
import type { RpcCaller, RoundTablePrefs, WireFeedbackEntry, WireProviderOption, WireRolePreset } from './wire.ts'
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

export function RoundTableSettings(props: RoundTableSettingsProps): JSX.Element {
  const { rpc, t } = props
  const [prefs, setPrefs] = useState<RoundTablePrefs | null>(null)
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

  const load = useCallback((): void => {
    void rpc<RoundTablePrefs>('roundtable/prefs.get', {})
      .then((result) => {
        if (result.ok) {
          setPrefs(result.value)
          setLoadFailed(false)
        } else {
          setLoadFailed(true)
        }
      })
      .catch(() => setLoadFailed(true))
  }, [rpc])

  useEffect(() => {
    load()
    loadFeedback()
  }, [load, loadFeedback])

  const patch = (next: Partial<RoundTablePrefs>): void => {
    setPrefs((previous) => previous === null ? null : { ...previous, ...next })
    setSaved(false)
  }

  /** R3：点亮/熄灭一个右栏面板（写入 hiddenPanels）。 */
  const togglePanel = (id: string): void => {
    setPrefs((previous) => {
      if (previous === null) return null
      const hidden = Array.isArray(previous.hiddenPanels) ? previous.hiddenPanels : []
      const nextHidden = hidden.includes(id) ? hidden.filter((entry) => entry !== id) : [...hidden, id]
      return { ...previous, hiddenPanels: nextHidden }
    })
    setSaved(false)
  }

  const save = (): void => {
    if (prefs === null || saving) return
    setSaving(true)
    setSaveFailed(false)
    void rpc<RoundTablePrefs>('roundtable/prefs.set', {
      defaultMode: prefs.defaultMode,
      maxRounds: prefs.maxRounds,
      maxTokens: prefs.maxTokens,
      showAllMeetings: prefs.showAllMeetings,
      expertMaxTokens: prefs.expertMaxTokens,
      expertMaxOpinions: prefs.expertMaxOpinions,
      feedbackEnabled: prefs.feedbackEnabled,
      skillDelivery: prefs.skillDelivery === 'direct' ? 'direct' : 'relay',
      hiddenPanels: Array.isArray(prefs.hiddenPanels) ? prefs.hiddenPanels : [],
    })
      .then((result) => {
        setSaving(false)
        if (result.ok) {
          setPrefs(result.value)
          setSaved(true)
        } else {
          setSaveFailed(true)
        }
      })
      .catch(() => {
        setSaving(false)
        setSaveFailed(true)
      })
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

  /** 新建预设的稳定 id；host 侧只在 id 缺失或重复时才重新分配。 */
  const newPresetId = (): string =>
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `preset-${Date.now()}-${Math.floor(Math.random() * 1e6)}`

  /**
   * 写入整份偏好（含新的 rolePresets）。
   *
   * 刻意提交**完整对象**而不是只提交 `{ rolePresets }`：服务端
   * `scope.update` 究竟是合并还是整体替换，客户端无法确定；提交完整对象
   * 在两种语义下都正确，也与底部「保存」按钮的做法一致。
   */
  const persistPresets = (next: WireRolePreset[]): void => {
    if (prefs === null) return
    const full: RoundTablePrefs = { ...prefs, rolePresets: next }
    setPrefs(full)
    void rpc<RoundTablePrefs>('roundtable/prefs.set', { ...full })
      .then((result) => {
        if (result.ok) {
          setPrefs(result.value)
          setPresetNotice('saved')
        } else {
          setPresetNotice('failed')
        }
      })
      .catch(() => setPresetNotice('failed'))
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
      <div className={styles.sectionTitle}>{t('settingsPanelsTitle')}</div>
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
      <div className={styles.sectionTitle}>{t('settingsSkillTitle')}</div>
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
      <div className={styles.sectionTitle}>{t('settingsPresetsTitle')}</div>
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
      <div className={styles.sectionTitle}>{t('settingsLimitsTitle')}</div>
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
      <div className={styles.sectionTitle}>{t('feedbackTitle')}</div>
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
