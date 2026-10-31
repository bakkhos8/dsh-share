# Known issues / 已知限制

## Compatibility / 兼容性

The minimum is macOS 13. The local environment is Apple Silicon, macOS 27.0.1. The draft adapter uses interfaces shipped with DeepSeek Harness **0.2.1-rc.5**. Future Harness changes may require updating the plugin. The Universal 2 DMG contains arm64 and x86_64; actual Intel operation and other macOS versions need separate verification. See [validation](docs/validation.md).

本项目提供开源源码和未经 Apple 公证的 DMG。安装助手为简体中文。

## Source applications / 来源应用

Finder and WeChat 4.1.15 sharing have been exercised locally. After installing or updating the extension, completely quit and reopen the source app, especially WeChat. Private WeChat cards must expose a standard file, text or URL; otherwise share the original link or saved file. Safari, Preview and Mail remain individually unverified.

微信遇到旧图标或分享无反应时，先用 **⌘Q 完全退出并重开**，只关闭窗口不够。

## Content limits / 内容限制

Each share accepts at most 128 ordinary files and 256 MiB in total, including its generated text attachment. Folders are rejected. Text plus manifest metadata is limited to 1 MiB. Provider collection has a 15-second deadline; any provider failure cancels the whole share. Harness may impose additional upload or image limits.

本机路由按需分块读取文件，客户端接收为浏览器文件对象。大批量内容会占用浏览器附件草稿的内存和存储；极端磁盘故障未全面验证。失败内容会保留，不会冒充成功。

## Current thread and drafts / 当前会话与草稿

Select the receiving thread before sharing. Attachments append to its input area; sharing does not create a session, alter draft text or submit a prompt. Text and URLs become a `分享内容.txt` attachment. Without an open composer, shares wait. Once a transfer starts, its target is pinned; if you switch threads, return to that original thread to finish receiving it.

附件进入输入区后，由 Harness 管理，需手动发送才会执行。关闭或重新加载 Harness 可能丢弃未发送的附件草稿，与手动添加附件相同。本工具在确认交接后立即清理副本，不提供已转发内容的恢复或历史记录。

Use one receiving Host profile for the inbox. The bundled native helper enforces an exclusive OS lock; extra consumers stop. A missing helper or unexpected helper exit stops consumption safely. The persistent `.consumer.lock` file is not a stale lease; do not remove it while a consumer runs. Stop receivers before installation or update.

## Delivery and retained data / 投递与保留数据

The inbox is `~/Library/Application Support/DSHShare/inbox`. Source bytes remain until all attachments are owned by the selected composer and the client acknowledges the exact share, thread and request. Preparation or a completed file download alone cannot authorize deletion. ACK removes the package, state and temporary completion receipt immediately.

ACK failure retries confirmation without adding attachments again, including a plugin hot reload while the Harness draft service remains alive. After a full browser reload, Harness may have lost its runtime draft; any still-unconfirmed package remains available for re-import into its pinned thread. Previously completed shares are not replayed.

Pending, unconfirmed, failed, temporary and ambiguous content has no TTL. Invalid packages go to `failed/` with an error. Legacy `.delivery.json` files without `deliveryMode: "draft"` are also preserved there because an earlier prompt may already have been submitted. Check Harness before manually retrying them.

Interrupted cleanup retains its proof and retries without re-importing partial data. Valid orphan completion records are removed regardless of age. Symlinks and ambiguous records never authorize deletion. `scripts/cleanup-inbox.sh` previews proven completions; `--apply` explicitly removes them under the same exclusive lock.

收件箱可能含原文件、文本和链接，应按私人数据处理，不要上传 GitHub。接收失败或草稿忙碌时内容会等待重试；不要反复分享相同内容。自定义收件箱需要同时调整扩展与插件。

## Uninstall / 卸载

The uninstaller handles standard profiles and recorded custom profiles. An unrecorded custom profile can be specified using the native helper’s `uninstall-plugin --profile-dir` option. Active receivers block removal. Permission failures are reported with the remaining stage.

卸载移除插件配置和链接，将当前打开的 App 移到废纸篓。已确认完成的转发残留会清理；未完成分享、配置备份和开发源码会保留。Harness 收到的内容不受影响。单独安装的其他 App 副本需另行移除。

## Activation and installation / 唤起与安装

The extension opens `dsh://open`, which brings Harness forward without selecting another thread, then falls back to `/Applications/DeepSeek Harness.app`. The extension waits for the asynchronous launch result. If both attempts fail, it returns a user-facing error; the queued content is retained for receipt after opening Harness manually. Its official app bundle is not modified.

DMG installation and daily use need no compiler, Python or standalone Node.js. Source installation needs Xcode or Apple Command Line Tools. Moving the installed App requires rerunning setup to repair its recorded helper path. Existing code and configuration are backed up before replacement.

未公证 DMG 首次打开可能被 Gatekeeper 拦截；先尝试打开，再在系统设置中为该 App 单独选择“仍要打开”。签名或注册检查通过不能替代实际分享测试。当前没有「打开方式」或拖入 DSHShare 窗口的接收入口。
