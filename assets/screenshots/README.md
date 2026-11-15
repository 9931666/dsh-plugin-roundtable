# 市场截图

市场（dsh-market）从仓库根的 `screenshots.json` 读取本目录图片，每晚构建自动抓取，不需要 PR。

当前清单：

- `01-topology.png` —— 会议拓扑视图（专家节点 + 连线 + 汇聚网关）
- `02-settings.png` —— 圆桌会议设置页

要求：PNG/JPEG，单张 < 1 MB；改文件名时同步改仓库根的 `screenshots.json`，否则市场会当成 404 丢弃。
