/**
 * RoundTable preference page (settings.section): default collaboration mode
 * and budget defaults. Switching to egalitarian mode surfaces the safety
 * limits (max rounds / max tokens) with a warning-style hint.
 * @module dsh-plugin-roundtable/client/RoundTableSettings
 */

import { useCallback, useEffect, useState } from 'react'
import type { RpcCaller, RoundTablePrefs } from './wire.ts'
import styles from './RoundTableSettings.module.css'

export interface RoundTableSettingsInjected {
  rpc: RpcCaller
  t: (key: string) => string
}

export interface RoundTableSettingsProps extends RoundTableSettingsInjected {}

export function RoundTableSettings(props: RoundTableSettingsProps): JSX.Element {
  const { rpc, t } = props
  const [prefs, setPrefs] = useState<RoundTablePrefs | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  const [saveFailed, setSaveFailed] = useState(false)
  const [saved, setSaved] = useState(false)
  const [saving, setSaving] = useState(false)

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
  }, [load])

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
        </select>
        <div className={styles.hint}>{t('settingsDefaultModeHint')}</div>
        {prefs.defaultMode === 'egalitarian' ? (
          <div className={styles.warning}>{t('settingsDefaultModeHint')}</div>
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
