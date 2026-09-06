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
  | 'modeRedteam'
  | 'status'
  | 'round'
  | 'roundsBudget'
  | 'tokensBudget'
  | 'pendingDecision'
  | 'pendingDecisionOptions'
  | 'gatewayDigest'
  | 'noDigest'
  | 'edgeSetForward'
  | 'edgeSetBidirectional'
  | 'edgeRemove'
  | 'activityRunning'
  | 'activityIdle'
  | 'activityReady'
  | 'activityRemoved'
  | 'settingsNav'
  | 'settingsDefaultMode'
  | 'settingsDefaultModeHint'
  | 'settingsEgalitarianWarning'
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
  | 'kbTitle'
  | 'kbPathLabel'
  | 'kbPathPlaceholder'
  | 'kbPathRequired'
  | 'kbSave'
  | 'kbSaved'
  | 'kbSaveFailed'
  | 'kbFiles'
  | 'kbLoadHint'
  | 'kbContentChanged'
  | 'kbBrowseHint'
  | 'kbNotSet'
  | 'meetingDelete'
  | 'meetingDeleteConfirm'
  | 'settingsShowAll'
  | 'settingsShowAllHint'
  | 'settingsShowAllOn'
  | 'settingsShowAllOff'
  | 'settingsLimitsTitle'
  | 'settingsExpertMaxTokens'
  | 'settingsExpertMaxTokensHint'
  | 'settingsExpertMaxOpinions'
  | 'settingsExpertMaxOpinionsHint'
  | 'feedbackTitle'
  | 'feedbackEnabled'
  | 'feedbackEnabledHint'
  | 'feedbackPrivacyNote'
  | 'feedbackListEmpty'
  | 'feedbackListTitle'
  | 'feedbackClear'
  | 'feedbackCleared'
  | 'feedbackLoadFailed'
  | 'feedbackEntryMeta'
  | 'feedbackAskTitle'
  | 'feedbackAskGood'
  | 'feedbackAskMeh'
  | 'feedbackAskBad'
  | 'feedbackAskNotePlaceholder'
  | 'feedbackAskSubmit'
  | 'feedbackAskSkip'
  | 'feedbackAskSubmitted'
  | 'feedbackAskFailed'
  | 'pendingBadge'
  | 'manageTitle'
  | 'managePendingNote'
  | 'manageExisting'
  | 'manageRemove'
  | 'manageRemoveConfirm'
  | 'manageRemovedSoon'
  | 'manageQueueFailed'
  | 'managePendingRemove'
  | 'managePendingAdd'
  | 'managePendingAddRole'
  | 'manageAddTitle'
  | 'manageName'
  | 'manageNamePlaceholder'
  | 'manageNameRequired'
  | 'manageNameTaken'
  | 'manageRole'
  | 'manageRolePlaceholder'
  | 'manageModel'
  | 'manageModelInherit'
  | 'manageAddBtn'
  | 'manageAddedSoon'
  | 'manageEffectiveHint'
  | 'manageClose'
  | 'manageNoExperts'
  | 'reviewTitle'
  | 'reviewQuestion'
  | 'reviewPlan'
  | 'reviewViewpoints'
  | 'reviewEmpty'
  | 'reviewSupport'
  | 'reviewSupported'
  | 'reviewSupportedToast'
  | 'reviewEndorsed'
  | 'reviewEndorseFailed'
  | 'reviewHint'
  | 'reviewClose'
  | 'reviewBadge'
  | 'reviewOpen'
  | 'reviewPanelTitle'
  | 'reviewPanelEmpty'
  | 'reviewStatusReady'
  | 'reviewStatusReviewing'
  | 'reviewStatusDone'
  | 'reviewEndorsedCount'
  | 'reviewPending'
  | 'reviewRejected'
  | 'reviewReject'
  | 'reviewRejectedDone'
  | 'reviewRejectedToast'
  | 'reviewPendingToast'
  | 'reviewRejectReasonPrompt'
  | 'reviewRejectReasonPlaceholder'
  | 'reviewRejectReasonRequired'
  | 'reviewRejectConfirm'
  | 'reviewRejectCancel'
  | 'reviewEvidenceRepro'
  | 'reviewEvidenceArgument'
  | 'reviewPassBadge'
  | 'reviewImpactTitle'
  | 'reviewImpactThresholdHint'
  | 'reviewImpactOk'
  | 'reviewExportHint'

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
  modeRedteam: '针锋相对',
  status: '状态',
  round: '轮',
  roundsBudget: '轮数',
  tokensBudget: 'Token',
  pendingDecision: '待人类决策',
  pendingDecisionOptions: '选项',
  gatewayDigest: '汇聚网关 · 结构化摘要',
  noDigest: '（暂无发言）',
  edgeSetForward: '设为单向通道',
  edgeSetBidirectional: '设为双向通道',
  edgeRemove: '删除连线',
  activityRunning: '工作中',
  activityIdle: '空闲',
  activityReady: '待唤醒',
  activityRemoved: '已退出',
  settingsNav: '圆桌会议',
  settingsDefaultMode: '默认协作模式',
  settingsDefaultModeHint: '主持人统筹：一切经由主持人转达；多模型平等：专家互相直达辩论，超预算自动闭麦（选择它会弹出安全限制）。',
  settingsEgalitarianWarning: '已选择「多模型平等」：专家互相直达、无主持人中转，请务必设置足够的轮数/Token 上限，超限将自动闭麦。',
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
  kbEmpty: '该文件夹内暂无文件',
  filesEmpty: '暂无文件产出',
  noActivity: '（暂无发言）',
  editAgents: '新增 / 修改专家',
  editKb: '知识库管理',
  kbTitle: '知识库阅览',
  kbPathLabel: '路径',
  kbPathPlaceholder: '输入电脑上的文件夹路径（支持相对工作区路径）',
  kbPathRequired: '请输入知识库路径',
  kbSave: '保存并阅览',
  kbSaved: '知识库路径已保存，已记录待主持人同步',
  kbSaveFailed: '保存知识库路径失败',
  kbFiles: '文件列表',
  kbLoadHint: '输入路径并保存后，这里会显示文件夹内的文件列表',
  kbContentChanged: '已修改知识库部分内容',
  kbBrowseHint: '仅供阅览：点击文件无反应；专家需要内容时由主持人读取并转交。',
  kbNotSet: '未设置知识库路径',
  meetingDelete: '删除会议',
  meetingDeleteConfirm: '确定删除会议「{name}」？此操作不可恢复（会议文件将被永久删除）。',
  settingsShowAll: '互通（跨对话查看会议）',
  settingsShowAllHint: '开启：查看所有对话开启的圆桌会议；关闭：仅查看当前对话开启的圆桌会议。',
  settingsShowAllOn: '开启',
  settingsShowAllOff: '关闭',
  settingsLimitsTitle: '回答限制（省 token）',
  settingsExpertMaxTokens: '专家每轮输出上限（token）',
  settingsExpertMaxTokensHint: '每次专家调用模型的输出 token 上限（max_tokens）；0 = 不限制（用模型默认）。',
  settingsExpertMaxOpinions: '专家每轮最多意见数',
  settingsExpertMaxOpinionsHint: '每轮最多提出的意见条数（提示词约束）；0 = 不限制。',
  pendingBadge: '{n} 条操作待下一轮生效',
  manageTitle: '专家管理',
  managePendingNote: '以下操作已记录，主持人将在下一轮对话中逐条执行；执行失败会保留记录。',
  manageExisting: '现有专家',
  manageRemove: '删除',
  manageRemoveConfirm: '确定删除专家「{name}」？会议状态将在主持人下一轮执行时更新。',
  manageRemovedSoon: '已记录：专家 {name} 将在下一轮移除',
  manageQueueFailed: '记录操作失败',
  managePendingRemove: '待移除',
  managePendingAdd: '待生效',
  managePendingAddRole: '新增专家 · 待主持人拉入',
  manageAddTitle: '新增专家',
  manageName: '名称',
  manageNamePlaceholder: '如 researcher（唯一标识）',
  manageNameRequired: '请输入专家名称',
  manageNameTaken: '专家 {name} 已存在',
  manageRole: '角色',
  manageRolePlaceholder: '如 安全审查',
  manageModel: '模型',
  manageModelInherit: '（继承主持人默认）',
  manageAddBtn: '加入队列',
  manageAddedSoon: '已记录：专家 {name} 将在下一轮加入',
  manageEffectiveHint: '改动将在主持人下一轮对话中正式起效（UI 会先行标记状态）。',
  manageClose: '关闭',
  manageNoExperts: '暂无专家，可通过下方表单新增',
  reviewTitle: '针锋相对 · 方案评审',
  reviewQuestion: '用户提出的问题',
  reviewPlan: '主持人提供的方案与说明',
  reviewViewpoints: '专家挑刺观点',
  reviewEmpty: '（暂无观点，评审还在进行中）',
  reviewSupport: '支持（认定为缺陷）',
  reviewSupported: '已认定',
  reviewSupportedToast: '已认定该缺陷，将进入后续方案修改',
  reviewEndorsed: '已认定为缺陷',
  reviewEndorseFailed: '标记失败',
  reviewHint: '点击「支持」= 认定该缺陷真实存在，将进入后续方案修改。',
  reviewClose: '关闭',
  reviewBadge: '针锋相对',
  reviewOpen: '打开评审',
  reviewPanelTitle: '分针记录',
  reviewPanelEmpty: '暂无评审记录',
  reviewStatusReady: '已就绪',
  reviewStatusReviewing: '评审中',
  reviewStatusDone: '已完成',
  reviewEndorsedCount: '已认定',
  reviewPending: '待审/未表态',
  reviewRejected: '已驳回',
  reviewReject: '驳回',
  reviewRejectedDone: '已驳回',
  reviewRejectedToast: '已驳回该观点（审阅后否定）',
  reviewPendingToast: '已取消标记',
  reviewRejectReasonPrompt: '驳回需填写理由（必填，将计入评审记录）：',
  reviewRejectReasonPlaceholder: '例如：该缺陷基于误解，方案已覆盖此场景…',
  reviewRejectReasonRequired: '请填写驳回理由后再确认',
  reviewRejectConfirm: '确认驳回',
  reviewRejectCancel: '取消',
  reviewEvidenceRepro: '可复现步骤',
  reviewEvidenceArgument: '论证链',
  reviewPassBadge: '第 {pass}/{max} 轮评审',
  reviewImpactTitle: '影响概览',
  reviewImpactThresholdHint: '已认定缺陷较多，建议据此重新协商方案后再修订。',
  reviewImpactOk: '已认定缺陷已记录，可按此修订方案。',
  reviewExportHint: '导出完整评审记录（Markdown）请在对话中让主持人调用导出。',
  feedbackTitle: '用户反馈',
  feedbackEnabled: '会议结束后询问轻量反馈',
  feedbackEnabledHint: '开启：会议结束（评审关闭）后弹一次 1 键有用度询问；可随时在此关闭。',
  feedbackPrivacyNote: '隐私边界：仅记录协作模式、专家 provider/模型、轮数/Token 用量、时间戳与可选一句说明；绝不记录对话内容。文件为工作区级 feedback.jsonl（建议加入 .gitignore），可一键清空。',
  feedbackListEmpty: '（暂无已收集的反馈）',
  feedbackListTitle: '已收集的反馈',
  feedbackClear: '清空全部反馈',
  feedbackCleared: '已清空反馈',
  feedbackLoadFailed: '读取反馈失败',
  feedbackEntryMeta: '{date} · {mode} · {providers} · {rounds} 轮 / {tokens} token · {rating}',
  feedbackAskTitle: '这场会议对你有帮助吗？（1 键，匿名，可在设置里关闭）',
  feedbackAskGood: '有帮助',
  feedbackAskMeh: '一般',
  feedbackAskBad: '没帮助',
  feedbackAskNotePlaceholder: '最卡的点是什么？（可选）',
  feedbackAskSubmit: '提交',
  feedbackAskSkip: '跳过',
  feedbackAskSubmitted: '谢谢反馈！可随时在设置 → 圆桌会议 → 用户反馈中关闭或清空。',
  feedbackAskFailed: '反馈提交失败',
}

export const en: Record<RoundTableKey, string> = {
  tab: 'RoundTable',
  empty: 'No round-table meeting in this workspace yet',
  emptyHint: 'Go back to chat and say "start a round-table meeting to discuss…" — the captain will assemble a team of experts right here. Past meetings stay in this tab and can be switched back to anytime.',
  meeting: 'Meeting',
  mode: 'Mode',
  modeOrchestrated: 'Orchestrated',
  modeEgalitarian: 'Egalitarian',
  modeRedteam: 'Adversarial review',
  status: 'Status',
  round: 'Round',
  roundsBudget: 'Rounds',
  tokensBudget: 'Tokens',
  pendingDecision: 'Awaiting human decision',
  pendingDecisionOptions: 'Options',
  gatewayDigest: 'Aggregation gateway · structured digest',
  noDigest: '(no contributions yet)',
  edgeSetForward: 'Set forward',
  edgeSetBidirectional: 'Set bidirectional',
  edgeRemove: 'Remove edge',
  activityRunning: 'working',
  activityIdle: 'idle',
  activityReady: 'ready',
  activityRemoved: 'removed',
  settingsNav: 'RoundTable',
  settingsDefaultMode: 'Default collaboration mode',
  settingsDefaultModeHint: 'Orchestrated: the captain relays everything. Egalitarian: experts debate each other directly and the budget mutes the meeting when exceeded (a warning asks for safety limits).',
  settingsEgalitarianWarning: 'Egalitarian selected: experts talk to each other directly with no captain relay — set generous round/token caps; exceeding them mutes the meeting.',
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
  kbEmpty: 'No files in this folder yet',
  filesEmpty: 'No file outputs yet',
  noActivity: '(no contributions yet)',
  editAgents: 'Add or edit agents',
  editKb: 'Manage knowledge base',
  kbTitle: 'Knowledge base (browse)',
  kbPathLabel: 'Path',
  kbPathPlaceholder: 'A folder on this computer (relative paths resolve against the workspace)',
  kbPathRequired: 'Please enter a knowledge-base path',
  kbSave: 'Save & browse',
  kbSaved: 'Knowledge-base path saved; change recorded for the captain',
  kbSaveFailed: 'Failed to save the knowledge-base path',
  kbFiles: 'Files',
  kbLoadHint: 'Enter a path and save to see the file list here',
  kbContentChanged: 'I have changed some knowledge-base content',
  kbBrowseHint: 'Browse-only: clicking a file does nothing; the captain reads and relays content to experts when needed.',
  kbNotSet: 'No knowledge-base path set',
  meetingDelete: 'Delete meeting',
  meetingDeleteConfirm: 'Delete meeting "{name}"? This cannot be undone (the meeting files will be permanently removed).',
  settingsShowAll: 'Show meetings across conversations',
  settingsShowAllHint: 'On: show every round-table meeting. Off: only meetings started by this conversation.',
  settingsShowAllOn: 'On',
  settingsShowAllOff: 'Off',
  settingsLimitsTitle: 'Answer limits (save tokens)',
  settingsExpertMaxTokens: 'Expert output cap per round (tokens)',
  settingsExpertMaxTokensHint: 'max_tokens per expert model request; 0 = unlimited (provider default).',
  settingsExpertMaxOpinions: 'Max opinions per expert round',
  settingsExpertMaxOpinionsHint: 'Opinion count cap per round (prompt constraint); 0 = unlimited.',
  pendingBadge: '{n} pending action(s), effective next round',
  manageTitle: 'Expert management',
  managePendingNote: 'The actions below are recorded; the captain executes them one by one next round. Failed actions stay recorded.',
  manageExisting: 'Existing experts',
  manageRemove: 'Remove',
  manageRemoveConfirm: 'Remove expert "{name}"? The meeting state updates when the captain executes it next round.',
  manageRemovedSoon: 'Recorded: expert {name} will be removed next round',
  manageQueueFailed: 'Failed to record the action',
  managePendingRemove: 'pending removal',
  managePendingAdd: 'pending join',
  managePendingAddRole: 'New expert · waiting for the captain',
  manageAddTitle: 'Add expert',
  manageName: 'Name',
  manageNamePlaceholder: 'e.g. researcher (unique key)',
  manageNameRequired: 'Please enter an expert name',
  manageNameTaken: 'Expert {name} already exists',
  manageRole: 'Role',
  manageRolePlaceholder: 'e.g. security reviewer',
  manageModel: 'Model',
  manageModelInherit: '(inherit captain default)',
  manageAddBtn: 'Queue',
  manageAddedSoon: 'Recorded: expert {name} will join next round',
  manageEffectiveHint: 'Changes take effect when the captain acts in the next round (the UI marks pending states right away).',
  manageClose: 'Close',
  manageNoExperts: 'No experts yet — add one with the form below',
  reviewTitle: '针锋相对 · plan review',
  reviewQuestion: 'User\'s question',
  reviewPlan: 'Plan & explanation',
  reviewViewpoints: 'Expert objections',
  reviewEmpty: '(no objections yet, review in progress)',
  reviewSupport: 'Support (real flaw)',
  reviewSupported: 'Endorsed',
  reviewSupportedToast: 'Endorsed as a real flaw; it will feed the plan revision',
  reviewEndorsed: 'endorsed flaw',
  reviewEndorseFailed: 'Endorse failed',
  reviewHint: 'Click "Support" to confirm a real flaw — it feeds the next plan revision.',
  reviewClose: 'Close',
  reviewBadge: 'Adversarial review',
  reviewOpen: 'Open review',
  reviewPanelTitle: 'Review log',
  reviewPanelEmpty: 'No review records yet',
  reviewStatusReady: 'ready',
  reviewStatusReviewing: 'reviewing',
  reviewStatusDone: 'done',
  reviewEndorsedCount: 'endorsed',
  reviewPending: 'unreviewed',
  reviewRejected: 'rejected',
  reviewReject: 'Reject',
  reviewRejectedDone: 'Rejected',
  reviewRejectedToast: 'Rejected after review; it will not feed the plan revision',
  reviewPendingToast: 'Marking cleared',
  reviewRejectReasonPrompt: 'Rejecting requires a reason (required, kept in the review record):',
  reviewRejectReasonPlaceholder: 'e.g. this flaw is based on a misunderstanding; the plan already covers it…',
  reviewRejectReasonRequired: 'Please enter a reject reason before confirming',
  reviewRejectConfirm: 'Confirm reject',
  reviewRejectCancel: 'Cancel',
  reviewEvidenceRepro: 'Reproduction steps',
  reviewEvidenceArgument: 'Argument chain',
  reviewPassBadge: 'Review pass {pass}/{max}',
  reviewImpactTitle: 'Impact overview',
  reviewImpactThresholdHint: 'Several flaws were endorsed — consider renegotiating the plan before revising.',
  reviewImpactOk: 'Endorsed flaws are recorded; revise the plan accordingly.',
  reviewExportHint: 'To export the full review record (Markdown), ask the captain to export it in the conversation.',
  feedbackTitle: 'User feedback',
  feedbackEnabled: 'Ask for lightweight feedback when a meeting ends',
  feedbackEnabledHint: 'On: shows one 1-tap usefulness question after a meeting/review closes; turn it off here anytime.',
  feedbackPrivacyNote: 'Privacy: only the collaboration mode, expert provider/model, round/token usage, timestamp and an optional one-line note are recorded — never conversation content. Stored in the workspace-level feedback.jsonl (consider .gitignore); can be wiped with one click.',
  feedbackListEmpty: '(no feedback collected yet)',
  feedbackListTitle: 'Collected feedback',
  feedbackClear: 'Clear all feedback',
  feedbackCleared: 'Feedback cleared',
  feedbackLoadFailed: 'Failed to load feedback',
  feedbackEntryMeta: '{date} · {mode} · {providers} · {rounds} rounds / {tokens} tokens · {rating}',
  feedbackAskTitle: 'Was this meeting useful? (1 tap, anonymous, disable in settings)',
  feedbackAskGood: 'Useful',
  feedbackAskMeh: 'Meh',
  feedbackAskBad: 'Not useful',
  feedbackAskNotePlaceholder: 'What was the biggest pain point? (optional)',
  feedbackAskSubmit: 'Submit',
  feedbackAskSkip: 'Skip',
  feedbackAskSubmitted: 'Thanks! Manage or clear feedback anytime under Settings → RoundTable → User feedback.',
  feedbackAskFailed: 'Failed to submit feedback',
}
