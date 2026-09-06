/**
 * RoundTable preference page (settings.section): default collaboration mode
 * and budget defaults. Switching to egalitarian mode surfaces the safety
 * limits (max rounds / max tokens) with a warning-style hint.
 * @module dsh-plugin-roundtable/client/RoundTableSettings
 */

import { useCallback, useEffect, useState } from 'react'
import type { RpcCaller, RoundTablePrefs, WireFeedbackEntry } from './wire.ts'
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
