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
  | 'activityRemoved'
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
  | 'agents'
  | 'tasks'
  | 'kb'
  | 'activity'
  | 'files'
  | 'kbEmpty'
  | 'filesEmpty'
  | 'noActivity'
  | 'editAgents'
  | 'editKb'
  | 'agentsHintTitle'
  | 'agentsHint'
  | 'kbHintTitle'
  | 'kbHint'
  | 'meetingDelete'
  | 'meetingDeleteConfirm'
  | 'settingsShowAll'
  | 'settingsShowAllHint'
  | 'settingsShowAllOn'
  | 'settingsShowAllOff'

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
  activityRemoved: '已退出',
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
  agents: '专家',
  tasks: '分工',
  kb: '知识库',
  activity: '发言记录',
  files: '产出文件',
  kbEmpty: '暂无参考资料（后续支持上传与检索）',
  filesEmpty: '暂无文件产出',
  noActivity: '（暂无发言）',
  editAgents: '新增 / 修改专家',
  editKb: '知识库管理',
  agentsHintTitle: '通过主持人修改',
  agentsHint: '新增、修改或移除专家与分工，直接在聊天里告诉主持人（DeepSeek），例如：\n· 「再加一位安全合规专家」\n· 「把工程师的分工改成……」\n主持人会调用工具实时更新会议。',
  kbHintTitle: '知识库',
  kbHint: '知识库将支持上传参考资料与全文检索，属于后续迭代功能，敬请期待。',
  meetingDelete: '删除会议',
  meetingDeleteConfirm: '确定删除会议「{name}」？此操作不可恢复（会议文件将被永久删除）。',
  settingsShowAll: '互通（跨对话查看会议）',
  settingsShowAllHint: '开启：查看所有对话开启的圆桌会议；关闭：仅查看当前对话开启的圆桌会议。',
  settingsShowAllOn: '开启',
  settingsShowAllOff: '关闭',
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
  activityRemoved: 'removed',
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
  agents: 'Agents',
  tasks: 'Tasks',
  kb: 'Knowledge base',
  activity: 'Activity',
  files: 'Files',
  kbEmpty: 'No reference materials yet (upload & search coming later)',
  filesEmpty: 'No file outputs yet',
  noActivity: '(no contributions yet)',
  editAgents: 'Add or edit agents',
  editKb: 'Manage knowledge base',
  agentsHintTitle: 'Edit via the captain',
  agentsHint: 'To add, change or remove agents and their roles, just tell the captain (DeepSeek) in chat, e.g.:\n· "Add a security & compliance expert"\n· "Change the engineer role to …"\nThe captain updates the meeting through tools in real time.',
  kbHintTitle: 'Knowledge base',
  kbHint: 'The knowledge base will support uploading reference materials and full-text search — a later iteration. Stay tuned.',
  meetingDelete: 'Delete meeting',
  meetingDeleteConfirm: 'Delete meeting "{name}"? This cannot be undone (the meeting files will be permanently removed).',
  settingsShowAll: 'Show meetings across conversations',
  settingsShowAllHint: 'On: show every round-table meeting. Off: only meetings started by this conversation.',
  settingsShowAllOn: 'On',
  settingsShowAllOff: 'Off',
}
