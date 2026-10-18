/**
 * 内联 SVG 图标（零依赖、零资源、随主题变色）。
 *
 * 与针锋 `icons.tsx` 同一套几何规格（16×16、1.4px 描边、currentColor），但按圆桌
 * 自己的设置页需要收窄到六个图标 —— 两个插件各自独立打包，不跨包共享源码。
 *
 * @module dsh-plugin-roundtable/client/icons
 */

/** 圆桌设置页用到的图标名。新增图标必须同时加进 {@link SHAPES}。 */
export type IconName = 'panel' | 'skill' | 'role' | 'squad' | 'gauge' | 'message'

const SHAPES: Record<IconName, JSX.Element> = {
  // 右栏面板：带分隔的窗口。
  panel: (
    <>
      <rect x="2.2" y="3.2" width="11.6" height="9.6" rx="2" />
      <path d="M6.2 3.2v9.6" />
    </>
  ),
  // skill：闪电。
  skill: <path d="M9.2 2 4.6 8.8h3L6.8 14l4.6-6.8h-3L9.2 2Z" />,
  // 角色预设：证件卡。
  role: (
    <>
      <rect x="2.2" y="3.2" width="11.6" height="9.6" rx="2" />
      <circle cx="6" cy="7.2" r="1.4" />
      <path d="M8.6 6.4h3.2M8.6 8.4h2.4" />
    </>
  ),
  // 阵容预设：两人。
  squad: (
    <>
      <circle cx="6" cy="6" r="2" />
      <path d="M2.6 13c.3-2.1 1.7-3.2 3.4-3.2s3.1 1.1 3.4 3.2" />
      <circle cx="11.4" cy="6.6" r="1.5" />
      <path d="M11.4 9.4c1.5 0 2.5 1 2.8 2.6" />
    </>
  ),
  // 预算 / 限额：半圆仪表 + 指针。
  gauge: (
    <>
      <path d="M2.2 11.5a5.8 5.8 0 1 1 11.6 0" />
      <path d="M8 11.5 10.8 6.5" />
      <circle cx="8" cy="11.5" r="0.9" />
    </>
  ),
  // 用户反馈：对话气泡。
  message: (
    <path d="M3 3.4h10a1.6 1.6 0 0 1 1.6 1.6v5.2A1.6 1.6 0 0 1 13 11.8H8.4L5 14v-2.2H3A1.6 1.6 0 0 1 1.4 10.2V5A1.6 1.6 0 0 1 3 3.4Z" />
  ),
}

/** 渲染一个 16×16 线性图标，颜色跟随 `currentColor`。 */
export function InlineIcon({ name, size = 14 }: { name: IconName; size?: number }): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {SHAPES[name]}
    </svg>
  )
}
