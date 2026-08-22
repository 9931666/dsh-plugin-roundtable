/**
 * Locale dictionaries for the RoundTable browser UI.
 * @module dsh-plugin-roundtable/client/locales
 */

export const NS = 'roundtable'

export type RoundTableKey =
  | 'tab'
  | 'empty'
  | 'emptyHint'
  | 'meeting'
  | 'mode'
  | 'modeOrchestrated'
  | 'modeEgalitarian'
  | 'status'
  | 'round'
  | 'roundsBudget'
  | 'tokensBudget'
  | 'pendingDecision'
  | 'pendingDecisionOptions'
  | 'gatewayDigest'
  | 'noDigest'
  | 'edgeForward'
  | 'edgeBidirectional'
  | 'edgeSetForward'
  | 'edgeSetBidirectional'
  | 'edgeRemove'
  | 'edgeCancel'
  | 'activityRunning'
  | 'activityIdle'
  | 'activityReady'
  | 'nodeRole'
  | 'settingsNav'
  | 'settingsDefaultMode'
  | 'settingsDefaultModeHint'
  | 'settingsMaxRounds'
  | 'settingsMaxTokens'
  | 'settingsSave'
  | 'settingsSaved'
  | 'settingsLoadFailed'
  | 'settingsSaveFailed'
  | 'fetchFailed'
  | 'meetingSelect'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The roundtable topology tab + settings page copy. */
    roundtable: RoundTableKey
  }
}

export const zh: Record<RoundTableKey, string> = {
  tab: '圆桌会议',
  empty: '当前工作区还没有圆桌会议',
  emptyHint: '回到聊天，说一句「开个圆桌会议讨论……」，主持人就会拉起一支专家队伍并出现在这里。历史会议会一直保留在这个 Tab 里，随时可以切换查看。',
  meeting: '会议',
  mode: '协作模式',
  modeOrchestrated: '主持人统筹',
  modeEgalitarian: '多模型平等',
  status: '状态',
  round: '轮',
  roundsBudget: '轮数',
  tokensBudget: 'Token',
  pendingDecision: '待人类决策',
  pendingDecisionOptions: '选项',
  gatewayDigest: '汇聚网关 · 结构化摘要',
  noDigest: '（暂无发言）',
  edgeForward: '单向通道',
  edgeBidirectional: '双向通道',
  edgeSetForward: '设为单向通道',
  edgeSetBidirectional: '设为双向通道',
  edgeRemove: '删除连线',
  edgeCancel: '取消',
  activityRunning: '工作中',
  activityIdle: '空闲',
  activityReady: '待唤醒',
  nodeRole: '角色',
  settingsNav: '圆桌会议',
  settingsDefaultMode: '默认协作模式',
  settingsDefaultModeHint: '主持人统筹：一切经由主持人转达；多模型平等：专家互相直达辩论，超预算自动闭麦（选择它会弹出安全限制）。',
  settingsMaxRounds: '默认最大轮数',
  settingsMaxTokens: '默认 Token 预算',
  settingsSave: '保存',
  settingsSaved: '已保存',
  settingsLoadFailed: '读取设置失败',
  settingsSaveFailed: '保存设置失败',
  fetchFailed: '拉取会议状态失败，正在重试…',
  meetingSelect: '切换会议',
}

export const en: Record<RoundTableKey, string> = {
  tab: 'RoundTable',
  empty: 'No round-table meeting in this workspace yet',
  emptyHint: 'Go back to chat and say "start a round-table meeting to discuss…" — the captain will assemble a team of experts right here. Past meetings stay in this tab and can be switched back to anytime.',
  meeting: 'Meeting',
  mode: 'Mode',
  modeOrchestrated: 'Orchestrated',
  modeEgalitarian: 'Egalitarian',
  status: 'Status',
  round: 'Round',
  roundsBudget: 'Rounds',
  tokensBudget: 'Tokens',
  pendingDecision: 'Awaiting human decision',
  pendingDecisionOptions: 'Options',
  gatewayDigest: 'Aggregation gateway · structured digest',
  noDigest: '(no contributions yet)',
  edgeForward: 'Forward channel',
  edgeBidirectional: 'Bidirectional channel',
  edgeSetForward: 'Set forward',
  edgeSetBidirectional: 'Set bidirectional',
  edgeRemove: 'Remove edge',
  edgeCancel: 'Cancel',
  activityRunning: 'working',
  activityIdle: 'idle',
  activityReady: 'ready',
  nodeRole: 'Role',
  settingsNav: 'RoundTable',
  settingsDefaultMode: 'Default collaboration mode',
  settingsDefaultModeHint: 'Orchestrated: the captain relays everything. Egalitarian: experts debate each other directly and the budget mutes the meeting when exceeded (a warning asks for safety limits).',
  settingsMaxRounds: 'Default max rounds',
  settingsMaxTokens: 'Default token budget',
  settingsSave: 'Save',
  settingsSaved: 'Saved',
  settingsLoadFailed: 'Failed to load preferences',
  settingsSaveFailed: 'Failed to save preferences',
  fetchFailed: 'Failed to fetch meeting state, retrying…',
  meetingSelect: 'Switch meeting',
}
