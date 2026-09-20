/**
 * 插件版本号的源码侧单一来源。
 *
 * `package.json` 的 `version` 是发布侧的权威值，两者必须一致：
 * `test/version.test.mjs` 会在不一致时直接让测试失败。加这道闸门是因为
 * `renderReviewMarkdown` 的导出头部曾长期硬编码 `v0.2.21`，而 package.json
 * 已经走到 0.2.32 —— 导出物里的版本号说了谎，却没有任何测试会发现。
 *
 * @module dsh-plugin-roundtable/version
 */

/** 当前插件版本（必须与 package.json 的 version 逐字一致）。 */
export const PLUGIN_VERSION = '0.2.36'

/** 导出物头部使用的插件标识行。 */
export const PLUGIN_ID = `@huanlin/dsh-plugin-roundtable v${PLUGIN_VERSION}`

/** DeepSeek Harness 版本区间（导出头部展示用）。 */
export const HARNESS_RANGE = 'DeepSeek Harness 0.1.5-rc.2+'
