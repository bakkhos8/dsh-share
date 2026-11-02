# 图标候选项 / Icon candidates

把候选图片直接丢进这个目录（png / jpg / webp / heic 都行，svg 请先导出成位图）。
这里只是**工作区**：原始候选默认不进 Git（见仓库 `.gitignore`），选定后我会把它转成项目真正使用的两个源文件。

## 丢进来之后我会做什么

| 产出 | 目标文件 | 要求 |
|---|---|---|
| 应用/分享菜单图标 | `apps/DSHShare/Resources/AppIcon.png` | 正方形，由候选图裁切/缩放，1254×1254；构建时再派生 16–1024 全尺寸 `.icns`，同时写入宿主 App 与 appex |
| 插件/市场图标 | `plugins/dsh-macos-share/icon.png` | 正方形，256×256 |
| 市场截图（可选） | `plugins/dsh-macos-share/screenshots.json` 引用的图片 | 1–8 张，横竖都行 |

分享菜单里的图标在 16–32px 尺寸下显示，细节越多越糊；建议主体居中、留一点边距、避免细小文字。

## 素材版权提醒

`apps/DSHShare/Resources/README.md` 记录着当前头像同样**不在 MIT 授权范围内**。如果候选图也要随仓库公开，需要能确认它的来源/授权；否则我可以把它只做成构建期资源（不提交），或换用可自由再许可的图。

## 命名建议

一张图一个文件，名字随意但带上候选序号/风格，例如 `01-深色.png`、`02-浅色.png`。选定后我会在收到你确认时替换上面两个目标文件，并跑 `./scripts/build-app.sh --install` 重新生成 `.icns`。
