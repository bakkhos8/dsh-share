# DSH Share

<img src="apps/DSHShare/Resources/AppIcon.png" alt="DSH Share 图标" width="96" />

DSH Share 是 macOS 本机分享工具，通过系统共享菜单，将**同一台 Mac** 上其他应用的文件、图片、文本和链接发送到 **DeepSeek Harness 桌面版**。分享内容会作为附件放入 **Harness 当前会话的输入区**，由你检查后手动发送。

[English](README.md) | 简体中文

## 功能

- **Finder：**选中一个或多个普通文件，选择「共享 → DeepSeek Harness」。
- **微信 Mac 版：**在提供该功能的内容上，选择「其他应用 → 选择电脑中的应用 → DeepSeek Harness」。
- 接收来源应用通过系统共享菜单提供的文件、图片、纯文本和链接。**每次最多 128 个文件、合计不超过 256 MiB，不支持文件夹。**
- DeepSeek Harness 未运行时，会尝试打开 DeepSeek Harness；如果打开失败，会向用户报错。分享内容会暂存在本机，待应用和插件启动后继续接收。
- 确认转发成功后，立即删除本工具里的分享副本和转发记录。

DSH Share 提供包含 Apple Silicon 和 Intel 两个架构的 Universal 2 DMG，设置助手会自动连接 Harness 桌面版。安装及日常使用无需 Python 或单独的 Node.js。也可以选择从源码安装，兼容性范围见[兼容性说明](docs/validation.md)。

## 使用前准备

需要具备：

- macOS **13 或更高版本**。目前实际验证环境为 **Apple Silicon、macOS 27.0.1**；Intel Mac 和其他系统版本尚未验证。
- 已能正常使用的 DeepSeek Harness 桌面版。本项目使用的插件接口已在 **0.2.1-rc.5** 验证。
- 使用 DMG 安装不需要开发工具。选择源码安装时，需要 Xcode 或 Apple Command Line Tools；脚本默认编译当前 Mac 的架构，并使用本机 ad-hoc 签名。

收件箱锁、清理命令和插件配置安装使用随 **DSHShare.app** 打包的原生程序，安装及日常使用均不依赖 Python，也不需要单独安装 Node.js。源码安装时需要编译工具；安装后的应用使用 macOS 自带的运行库。

必须同时安装「macOS 分享入口」和「DeepSeek Harness 接收插件」。

### 系统权限

需要用户操作的只有两处系统设置，都不是隐私权限弹窗：

1. 未公证 DMG 首次打开时，在「**系统设置 → 隐私与安全性**」对该 App 选择「**仍要打开**」，之后不再出现；
2. 在「**系统设置 → 通用 → 登录项与扩展 → 共享**」勾选 **DeepSeek Harness**（安装助手第 3 步也会检查并提示）。

**不需要、也不会请求**：完全磁盘访问、文件与文件夹（桌面／文稿／下载）、辅助功能、屏幕录制、自动化、通知、相机／麦克风。扩展读取的是来源应用通过系统分享菜单交给它的条目，不扫描你的磁盘；收件箱在本工具自己的 `~/Library/Application Support/DSHShare/` 下，不属于任何受保护的文件夹。

扩展是沙盒扩展，签名时声明三个 entitlement，安装即生效、不弹窗：`app-sandbox`、`files.user-selected.read-only`，以及范围仅限 `/Library/Application Support/DSHShare/` 的 `home-relative-path.read-write`（收件箱）。宿主 App 与包内原生 helper 不沙盒、以当前用户身份运行，不使用特权 helper，也不需要 sudo 或管理员密码；装到 `~/Applications` 不需要管理员，装到 `/Applications` 仅在当前账户对其没有写权限时由 Finder 提示输入密码。

## 安装

### 使用 DMG 安装

1. 先安装并打开一次 **DeepSeek Harness**，完成模型和 Agent 设置，确认能正常新建会话，然后用 **⌘Q 完全退出**。
2. 打开 DMG，把 **DSHShare.app** 拖到 **Applications／应用程序** 文件夹。复制完成后，推出安装磁盘。
3. 从应用程序文件夹打开 **DSHShare**。安装包未经 Apple 公证，首次打开可能被系统拦截；先尝试打开一次，再到「**系统设置 → 隐私与安全性**」为这个 App 选择「**仍要打开**」。
4. 按设置助手的四步完成：**准备 → 安装 → 启用共享 → 测试分享**。默认自动连接 Harness 桌面版。第 3 步自动检查接收端和共享入口，只对未就绪的项目显示操作按钮；从设置返回后会自动复查，无需重复设置已就绪的项目，也无需选择配置名称或使用终端。
5. 在最后一步点击「**显示测试文件**」，在 Finder 中右键该文件，选择「**共享 → DeepSeek Harness**」。先在 Harness 选中接收会话，确认测试附件出现在该会话的输入区，且没有自动开始回复，即可完成设置并关闭助手。

也可以将 App 复制到当前用户的 `~/Applications`。App 需要固定的本机位置，以便推出安装磁盘后仍能提供分享入口。包内附有[安装与使用说明](docs/installation.zh-CN.txt)。安装完成后即可关闭设置助手，日常分享时无需打开它。

### 从源码安装

下载并解压本仓库，在终端进入项目目录，依次执行：

```bash
./scripts/build-app.sh --install
./scripts/install-plugin.sh
```

第一条命令将 **DSHShare.app** 安装到 `~/Applications` 并注册共享入口；第二条命令把接收插件安装到 **desktop** profile。原生应用已有安装时，会先备份到项目中已忽略的 `backups/` 目录。

随后完成以下操作：

1. 打开 DeepSeek Harness，确认插件列表中的 **dsh-macos-share** 已启用。若尚未出现，重启 DeepSeek Harness。
2. 如共享入口未启用，进入「**系统设置 → 通用 → 登录项与扩展 → 共享**」，勾选 **DeepSeek Harness**。
3. 完全退出并重新打开安装前已经运行的来源应用，尤其是**微信**。请用 **⌘Q** 退出，仅关闭窗口不够。

如果使用其他已存在的 DeepSeek Harness profile，将第二条安装命令替换为：

```bash
DSH_PROFILE_DIR="$HOME/.dsh/profiles/your-profile" ./scripts/install-plugin.sh
```

同一个收件箱只在一个运行中的 profile 启用本插件。系统独占锁会阻止额外消费者；遇到占用提示时，先停用其他 profile 的插件，再重新加载需要使用的接收端。安装或更新前，请先完全退出所有运行中的接收端。

## 如何使用

### 从 Finder 分享

1. 选中文件，打开「共享」菜单。
2. 点击 **DeepSeek Harness的图标**。
3. 文件会作为附件进入 Harness 当前会话的输入区；文本和链接合并为 `分享内容.txt` 附件。
4. 检查附件、补充你的要求，再手动点击「**发送**」。仅分享不会启动 Agent。

分享前先在 Harness 选中接收会话。输入区原有的文字和附件会保留。没有打开会话时，分享会继续等待，选中会话后再接收。传输开始后会固定接收会话；途中切换会话时，回到原会话即可继续。

### 从微信分享

在内容的分享选项中，选择「**其他应用 → 选择电脑中的应用 → DeepSeek Harness**」。具体可用入口取决于微信向系统提供的内容；小程序卡片、完整聊天记录等微信私有格式不保证可直接转发。

**安装或更新扩展后，若微信仍显示旧图标或转发无反应，请先 ⌘Q 完全退出微信，再重新打开。**

### DeepSeek Harness 没有自动打开时

如果无法打开，系统会提示错误。请手动打开 DeepSeek Harness，并确认 **dsh-macos-share** 已启用。本地分享副本会保留，等待插件接收。打开一个有输入区的会话。排查期间不要反复分享同一内容，以免重复添加附件。

## 隐私与本地数据

点击分享后，内容会进入 DeepSeek Harness 的附件草稿；你手动发送后才会启动 Agent。模型访问、联网处理及工具权限以**你自己的 DeepSeek Harness 配置**为准，请只分享你愿意交给该 Agent 处理的内容。

原生扩展通过本机目录交接内容，不需要模型 API Key；本项目没有额外的遥测或统计服务。

| 位置 | 用途 |
| --- | --- |
| `/Applications/DSHShare.app` 或 `~/Applications/DSHShare.app` | macOS 共享入口与设置助手 |
| `~/Library/Application Support/DSHShare/plugins/dsh-macos-share` | 默认安装方式保存的插件文件 |
| `~/Library/Application Support/DSHShare/inbox` | 待处理的本地分享副本 |
| `inbox/failed/` | 失败包及错误信息 |

DSH Share 不保存会话历史，也不归档已完成的分享。Harness 输入区持有附件并确认收到后，**本工具立即删除收件箱里的分享副本、投递状态和临时完成回执**。DeepSeek Harness 收到的会话和附件属于转发结果，由 Harness 自身管理。

清理被中断时，接收端恢复运行后会自动继续；旧版本遗留的有效完成回执也会清除，不按天数保留。失败包会保留以便排查，不要把包含分享内容的收件箱或日志提交到公开仓库。

**待处理、尚未确认及失败内容不会按时间自动删除。** 文件通过本机流式传输交给 Harness 的附件草稿，文本和链接作为 UTF-8 文本文件。附件草稿遵循 Harness 自身的生命周期；关闭或重新加载 Harness 可能丢弃未发送的草稿。DeepSeek Harness 自身还可能有额外的附件限制。

## 常见问题

| 现象 | 处理方法 |
| --- | --- |
| 点击 DSHShare 没有窗口 | 先在「活动监视器」中退出 DSHShare，再从应用程序文件夹打开新版。保留一个安装副本，并推出安装磁盘；后台旧版可能接走打开请求。 |
| 菜单里没有入口，或头像还是占位图 | 在系统设置启用扩展，然后完全退出并重开来源应用。微信请使用 ⌘Q。 |
| DeepSeek Harness 没收到内容 | 打开应用，启用 **dsh-macos-share**，安装或更新插件后重启应用，并核对使用的 profile。 |
| 文件夹或大文件无法分享 | 每次分享不超过 128 个普通文件，合计不超过 256 MiB；失败内容会保留。 |
| 很长的内联文本分享失败 | 保存为文件再分享；内联文本与 manifest 元数据合计上限为 1 MiB。 |
| 插件提示收件箱被占用 | 停用另一个接收端，再重新加载需要使用的插件。不要删除 `.consumer.lock`；持有进程退出后系统会释放锁。 |
| 插件无法启动原生辅助程序 | 先运行 `./scripts/build-app.sh --install` 更新原生应用，再安装插件并重启 DSH。应用和接收插件需要一起更新。 |
| 某种微信内容无法转发 | 完全重启微信后重试；私有卡片若没有提供标准文本、URL 或文件，请改为分享原始链接或保存后的文件。 |
| 安装或系统安全检查失败 | 参阅[签名与安装排查](docs/signing.md)。静态签名通过、菜单里有入口，都不能单独证明分享成功。 |

更多边界见[已知问题](KNOWN-ISSUES.md)。Safari、预览、邮件等其他来源应用仍需分别进行兼容性验证。

## 更新

DMG 更新时，先完全退出 DeepSeek Harness 和 DSHShare，再用新版替换应用程序文件夹中的 DSHShare.app，打开它并重新完成安装步骤。源码更新则在新版源码目录依次执行两条安装命令。随后重新打开 DeepSeek Harness 和之前运行的来源应用。应用和接收插件应一起更新；安装器修改现有配置前会保留私有备份。

## 卸载

1. 保存正在处理的内容，用 **⌘Q 完全退出 DeepSeek Harness**。
2. 从应用程序文件夹打开 **DSHShare**，点击「开始安装」左侧的「**卸载**」。也可从顶部菜单「**DSH Share → 卸载 DSH Share…**」进入。
3. 查看移除范围，再确认「**卸载并移到废纸篓**」。完成后关闭窗口，重新打开微信等来源应用以刷新共享菜单。

卸载会移除系统分享入口、已连接配置中的接收插件及其配置，并将 App 移到废纸篓，也不会删除源码目录或其他插件。

标准位置及安装记录中的 Harness 配置会自动处理。未被记录的手动安装配置，处理方式见[已知限制](KNOWN-ISSUES.md#uninstall--卸载)。

通过源码安装的应用也可运行以下命令打开卸载助手，随后在窗口中确认：

```bash
./scripts/build-app.sh --uninstall
```

仅需暂停接收时，在 Harness 中停用 **dsh-macos-share** 即可。

## 许可证

代码与文档采用 [MIT](LICENSE) 许可证。头像图标**不包含在 MIT 授权范围内**，复用前请阅读[素材说明](apps/DSHShare/Resources/README.md)。

本项目独立维护，不是 DeepSeek Harness 官方发行版。
