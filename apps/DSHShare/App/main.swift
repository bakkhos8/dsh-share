import AppKit

private enum SetupStep: Int, CaseIterable {
    case prepare, install, enable, test
    var title: String { ["准备", "安装", "启用共享", "测试分享"][rawValue] }
    var hint: String { ["自动连接桌面版", "添加接收组件", "自动检查共享状态", "确认可以正常使用"][rawValue] }
}
private enum Readiness { case moveApp, needHarness, initialize, quitHarness, ready }
private enum Installation { case idle, running, succeeded, failed(String) }
private enum Uninstallation { case ready, running, succeeded, failed(String) }

/// Internal Harness profile names stay out of the normal setup flow.
@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, NSMenuItemValidation {
    private var window: NSWindow!
    private let page = NSStackView()
    private let primary = NSButton()
    private let back = NSButton()
    private let secondary = NSButton()
    private let uninstallButton = NSButton()
    private var stepRows: [(NSImageView, NSTextField)] = []
    private var step = SetupStep.prepare
    private var installation = Installation.idle
    private var uninstallation: Uninstallation?
    private var busy = false
    private var showErrorDetails = false
    private var uninstallErrorDetails: String?
    private var manualAppRemovalAvailable = false
    private var observers: [NSObjectProtocol] = []
    private var enablement: SetupChecks.Snapshot?
    private var checkingEnablement = false
    private var enablementGeneration = UUID()
    private var enablementTimer: Timer?
    private let bodyWidth: CGFloat = 514

    private var profile: URL? { SetupInstaller.desktopProfileDirectory() }
    private var readiness: Readiness {
        if !SetupInstaller.isInstalled(Bundle.main.bundleURL) { return .moveApp }
        if SetupInstaller.harnessAppURL() == nil { return .needHarness }
        if profile == nil { return .initialize }
        if SetupInstaller.harnessIsRunning() { return .quitHarness }
        return .ready
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        let menu = NSMenu()
        let root = NSMenuItem(title: "DSH Share", action: nil, keyEquivalent: "")
        let items = NSMenu(title: "DSH Share")
        let uninstallItem = NSMenuItem(title: "卸载 DSH Share…", action: #selector(showUninstaller), keyEquivalent: "")
        uninstallItem.target = self; items.addItem(uninstallItem); items.addItem(.separator())
        items.addItem(withTitle: "退出 DSH Share", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        root.submenu = items; menu.addItem(root); NSApp.mainMenu = menu

        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 760, height: 600),
                          styleMask: [.titled, .closable, .miniaturizable], backing: .buffered, defer: false)
        window.title = "DSH Share 设置助手"
        window.isReleasedWhenClosed = false
        window.delegate = self
        window.center()
        buildLayout()


        for name in [NSWorkspace.didLaunchApplicationNotification, NSWorkspace.didTerminateApplicationNotification] {
            observers.append(NSWorkspace.shared.notificationCenter.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated {
                    guard let self, !self.busy else { return }
                    if self.step == .enable && self.uninstallation == nil { self.checkEnablement() }
                    else if self.step == .prepare || self.uninstallation != nil { self.render() }
                }
            })
        }
        if ProcessInfo.processInfo.arguments.contains("--uninstall") { uninstallation = .ready }
        render()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        if step == .enable { startEnablementChecks() }
    }

    func applicationDidBecomeActive(_ notification: Notification) {
        if window != nil, step == .enable, uninstallation == nil, !busy { checkEnablement(showProgress: true); return }
        if window != nil, (step == .prepare || uninstallation != nil), !busy { render() }
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
    func windowShouldClose(_ sender: NSWindow) -> Bool {
        if busy { return false }
        stopEnablementChecks(); return true
    }
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply { busy ? .terminateCancel : .terminateNow }
    func validateMenuItem(_ menuItem: NSMenuItem) -> Bool {
        if menuItem.action == #selector(showUninstaller) { return !busy && uninstallation == nil }
        return true
    }

    private func text(_ value: String, size: CGFloat = 13, weight: NSFont.Weight = .regular,
                      color: NSColor = .labelColor) -> NSTextField {
        let label = NSTextField(wrappingLabelWithString: value)
        label.font = .systemFont(ofSize: size, weight: weight)
        label.textColor = color
        label.setContentCompressionResistancePriority(.required, for: .vertical)
        return label
    }
    private func column(_ views: [NSView], spacing: CGFloat = 6) -> NSStackView {
        let stack = NSStackView(views: views)
        stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = spacing
        return stack
    }
    private func button(_ title: String, action: Selector) -> NSButton {
        let button = NSButton(title: title, target: self, action: action)
        button.bezelStyle = .rounded
        return button
    }

    private func buildLayout() {
        let root = window.contentView!
        let sidebar = NSVisualEffectView()
        sidebar.material = .sidebar; sidebar.blendingMode = .behindWindow
        sidebar.translatesAutoresizingMaskIntoConstraints = false
        root.addSubview(sidebar)
        NSLayoutConstraint.activate([
            sidebar.leadingAnchor.constraint(equalTo: root.leadingAnchor), sidebar.topAnchor.constraint(equalTo: root.topAnchor),
            sidebar.bottomAnchor.constraint(equalTo: root.bottomAnchor), sidebar.widthAnchor.constraint(equalToConstant: 190),
        ])
        let icon = NSImageView(image: NSImage(named: NSImage.applicationIconName) ?? NSImage())
        icon.imageScaling = .scaleProportionallyUpOrDown
        icon.widthAnchor.constraint(equalToConstant: 56).isActive = true
        icon.heightAnchor.constraint(equalToConstant: 56).isActive = true
        let brand = column([icon, text("DSH Share", size: 18, weight: .semibold), text("设置助手", color: .secondaryLabelColor)], spacing: 7)
        let rail = column([brand], spacing: 26)
        for item in SetupStep.allCases {
            let image = NSImageView()
            image.widthAnchor.constraint(equalToConstant: 24).isActive = true
            image.heightAnchor.constraint(equalToConstant: 24).isActive = true
            let heading = text(item.title, size: 13, weight: .semibold)
            let hint = text(item.hint, size: 11, color: .secondaryLabelColor)
            let row = NSStackView(views: [image, column([heading, hint], spacing: 3)])
            row.spacing = 10; row.alignment = .top
            rail.addArrangedSubview(row)
            stepRows.append((image, heading))
        }
        rail.translatesAutoresizingMaskIntoConstraints = false
        sidebar.addSubview(rail)
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? ""
        let release = text("\(version)\n未经 Apple 公证", size: 11, color: .secondaryLabelColor)
        release.translatesAutoresizingMaskIntoConstraints = false
        sidebar.addSubview(release)
        NSLayoutConstraint.activate([
            rail.leadingAnchor.constraint(equalTo: sidebar.leadingAnchor, constant: 22),
            rail.trailingAnchor.constraint(lessThanOrEqualTo: sidebar.trailingAnchor, constant: -14),
            rail.topAnchor.constraint(equalTo: sidebar.topAnchor, constant: 28),
            release.leadingAnchor.constraint(equalTo: rail.leadingAnchor),
            release.bottomAnchor.constraint(equalTo: sidebar.bottomAnchor, constant: -22),
        ])

        page.orientation = .vertical; page.alignment = .leading; page.spacing = 15
        page.translatesAutoresizingMaskIntoConstraints = false
        root.addSubview(page)
        primary.target = self; primary.action = #selector(primaryAction)
        primary.bezelStyle = .rounded; primary.controlSize = .large; primary.keyEquivalent = "\r"
        back.title = "上一步"; back.target = self; back.action = #selector(goBack); back.bezelStyle = .rounded
        secondary.target = self; secondary.action = #selector(secondaryAction); secondary.bezelStyle = .rounded
        uninstallButton.title = "卸载"; uninstallButton.target = self; uninstallButton.action = #selector(showUninstaller)
        uninstallButton.bezelStyle = .rounded; uninstallButton.controlSize = .large
        let footer = NSStackView(views: [secondary, NSView(), back, uninstallButton, primary])
        footer.spacing = 10; footer.alignment = .centerY; footer.translatesAutoresizingMaskIntoConstraints = false
        root.addSubview(footer)
        let separator = NSBox(); separator.boxType = .separator; separator.translatesAutoresizingMaskIntoConstraints = false
        root.addSubview(separator)
        NSLayoutConstraint.activate([
            page.leadingAnchor.constraint(equalTo: sidebar.trailingAnchor, constant: 28),
            page.topAnchor.constraint(equalTo: root.topAnchor, constant: 28), page.widthAnchor.constraint(equalToConstant: bodyWidth),
            page.bottomAnchor.constraint(lessThanOrEqualTo: separator.topAnchor, constant: -18),
            footer.leadingAnchor.constraint(equalTo: page.leadingAnchor), footer.trailingAnchor.constraint(equalTo: page.trailingAnchor),
            footer.bottomAnchor.constraint(equalTo: root.bottomAnchor, constant: -18), footer.heightAnchor.constraint(equalToConstant: 34),
            separator.leadingAnchor.constraint(equalTo: sidebar.trailingAnchor), separator.trailingAnchor.constraint(equalTo: root.trailingAnchor),
            separator.bottomAnchor.constraint(equalTo: footer.topAnchor, constant: -16),
        ])
    }

    private func add(_ view: NSView) {
        page.addArrangedSubview(view)
        view.widthAnchor.constraint(equalToConstant: bodyWidth).isActive = true
    }
    private func heading(_ title: String, _ explanation: String) {
        add(text("第 \(step.rawValue + 1) 步，共 4 步", size: 12, color: .secondaryLabelColor))
        add(text(title, size: 24, weight: .semibold))
        add(text(explanation, color: .secondaryLabelColor))
    }
    private func row(symbol: String, title: String, detail: String, color: NSColor = .controlAccentColor,
                     actionTitle: String? = nil, action: Selector? = nil) {
        let icon = NSImageView(image: NSImage(systemSymbolName: symbol, accessibilityDescription: nil) ?? NSImage())
        icon.contentTintColor = color
        icon.widthAnchor.constraint(equalToConstant: 23).isActive = true
        icon.heightAnchor.constraint(equalToConstant: 23).isActive = true
        let titleLabel = text(title, size: 14, weight: .semibold)
        let detailLabel = text(detail, size: 12, color: .secondaryLabelColor)
        let content = column([titleLabel, detailLabel], spacing: 5)
        for label in [titleLabel, detailLabel] { label.widthAnchor.constraint(equalToConstant: bodyWidth - 37).isActive = true }
        if let actionTitle, let action { content.addArrangedSubview(button(actionTitle, action: action)) }
        let row = NSStackView(views: [icon, content]); row.spacing = 14; row.alignment = .top
        add(row)
    }

    private func render() {
        for view in page.arrangedSubviews { page.removeArrangedSubview(view); view.removeFromSuperview() }
        for (index, row) in stepRows.enumerated() {
            let completed = uninstallation == nil && index < step.rawValue
            let active = uninstallation == nil && index == step.rawValue
            row.0.image = NSImage(systemSymbolName: completed ? "checkmark.circle.fill" : "\(index + 1).circle\(active ? ".fill" : "")",
                                 accessibilityDescription: completed ? "已完成" : nil)
            row.0.contentTintColor = active || completed ? .controlAccentColor : .tertiaryLabelColor
            row.1.textColor = active ? .labelColor : .secondaryLabelColor
        }
        primary.isEnabled = !busy; back.isHidden = step == .prepare || busy
        primary.hasDestructiveAction = false
        uninstallButton.isHidden = step != .prepare || uninstallation != nil || !canUninstall
        uninstallButton.isEnabled = !busy
        secondary.isEnabled = !busy; secondary.isHidden = step == .prepare && uninstallation == nil
        secondary.title = step == .test ? "稍后测试" : "稍后设置"
        if let uninstallation {
            window.title = "卸载 DSH Share"
            renderUninstallation(uninstallation)
            window.contentView?.layoutSubtreeIfNeeded()
            return
        }
        window.title = "DSH Share 设置助手"
        switch step {
        case .prepare: renderPreparation()
        case .install: renderInstallation()
        case .enable:
            renderEnablement()
        case .test:
            heading("试一次，就知道装好了", "先在 Harness 选中接收会话，再分享内置测试文件。")
            row(symbol: "1.circle", title: "在 Finder 中找到测试文件", detail: "点击按钮，测试文件会被选中。",
                actionTitle: "显示测试文件", action: #selector(showTestFile))
            row(symbol: "2.circle", title: "右键文件 → 共享 → DeepSeek Harness", detail: "点击 DeepSeek Harness的图标。")
            row(symbol: "3.circle", title: "检查当前会话的输入区", detail: "看到测试附件且没有自动回复，就成功了；需要处理时再手动发送。")
            add(column([text("使用微信分享前，请用 ⌘Q 完全退出微信，再重新打开。", size: 12, color: .secondaryLabelColor),
                        button("没有成功？查看排查提示", action: #selector(showTroubleshooting))], spacing: 7))
            primary.title = "分享成功，完成"
        }
        window?.contentView?.layoutSubtreeIfNeeded()
    }

    private func renderPreparation() {
        switch readiness {
        case .moveApp:
            heading("先把 App 放进应用程序", "请先完成下面三步，再开始设置。")
            row(symbol: "1.circle", title: "拖入应用程序文件夹", detail: "在安装磁盘中，把 DSHShare.app 拖到 Applications。")
            row(symbol: "2.circle", title: "推出安装磁盘", detail: "复制完成后，推出“DSH Share”安装磁盘。")
            row(symbol: "3.circle", title: "从应用程序重新打开", detail: "关闭此窗口，再从应用程序文件夹打开 DSHShare。",
                actionTitle: "打开应用程序文件夹", action: #selector(openApplications))
            primary.title = "关闭，去移动 App"; secondary.isHidden = true
        case .needHarness:
            heading("先准备好 DeepSeek Harness", "请先在这台 Mac 上安装 DeepSeek Harness 桌面版。")
            row(symbol: "1.circle", title: "打开 Harness，完成首次设置", detail: "配置好模型和 Agent，确认能正常新建会话。")
            row(symbol: "2.circle", title: "完全退出 Harness", detail: "在 Harness 中按 ⌘Q，然后回到这里继续。")
            primary.title = "已准备好，重新检查"
        case .initialize:
            heading("先打开一次 Harness", "还没有找到桌面版的接收设置。完成下面两步即可继续。")
            row(symbol: "1.circle", title: "完成 Harness 的首次设置", detail: "打开 Harness，配置好模型和 Agent，确认能新建会话。",
                actionTitle: "打开 Harness", action: #selector(openHarness))
            row(symbol: "2.circle", title: "完全退出，再回来继续", detail: "在 Harness 中按 ⌘Q。只关闭窗口不够。")
            primary.title = "我已完成，重新检查"
        case .quitHarness:
            heading("请先完全退出 Harness", "为了安全更新设置，安装前请先退出 DeepSeek Harness。")
            row(symbol: "keyboard", title: "在 Harness 中按 ⌘Q", detail: "请先保存正在处理的内容。只关闭窗口不够。")
            row(symbol: "checkmark.circle.fill", title: "接收位置已自动找到",
                detail: "接收设置已自动找到，无需手动选择。")
            primary.title = "我已退出，继续安装"
        case .ready:
            heading("准备好了，可以安装", "将自动连接这台 Mac 的 DeepSeek Harness 桌面版。")
            row(symbol: "square.and.arrow.up", title: "添加系统分享入口", detail: "分享菜单将显示 DeepSeek Harness的图标。")
            row(symbol: "arrow.down.doc", title: "让 Harness 可以接收分享",
                detail: "自动配置接收组件，保留原有设置和其他插件。")
            add(text("只需设置一次。日常分享时，无需打开此窗口。", size: 12, color: .secondaryLabelColor))
            primary.title = "开始安装"
        }
    }

    private func renderInstallation() {
        switch installation {
        case .running, .idle:
            heading("正在安装，请稍候", "正在连接 Harness，并注册系统分享入口。")
            let spinner = NSProgressIndicator(); spinner.style = .spinning; spinner.startAnimation(nil)
            let progress = NSStackView(views: [spinner, text("正在安装接收组件…", size: 14)])
            progress.spacing = 12; add(progress)
            add(text("安装期间请保持此窗口打开。", size: 12, color: .secondaryLabelColor))
            primary.title = "正在安装…"
        case .succeeded:
            heading("安装完成", "接下来启用共享入口，再试一次分享。")
            row(symbol: "checkmark.circle.fill", title: "Harness 接收组件已安装", detail: "已连接到所选接收位置。")
            row(symbol: "checkmark.circle.fill", title: "系统分享入口已注册", detail: "下一步在系统设置中确认它已启用。")
            add(text("成功转发后立即清理副本和记录；未送达内容不会自动删除。", size: 12, color: .secondaryLabelColor))
            primary.title = "下一步：启用共享"
        case .failed(let error):
            heading("安装没有完成", "请查看下面的原因，处理后重新尝试。")
            row(symbol: "exclamationmark.circle", title: "设置接收组件时遇到问题",
                detail: "请确认 Harness 已完全退出，并检查设置文件夹是否允许写入。未送达内容会保留。", color: .systemOrange)
            add(button(showErrorDetails ? "收起错误详情" : "查看错误详情", action: #selector(toggleErrorDetails)))
            if showErrorDetails {
                let detail = text(String(error.prefix(1100)), size: 11, color: .secondaryLabelColor)
                detail.maximumNumberOfLines = 8; detail.isSelectable = true; add(detail)
            }
            primary.title = "重试安装"
        }
    }

    private func renderEnablement() {
        guard let status = enablement else {
            heading("正在检查共享设置", "正在确认 Harness 接收端和系统共享入口是否已就绪。")
            let spinner = NSProgressIndicator(); spinner.style = .spinning; spinner.startAnimation(nil)
            add(spinner)
            primary.title = "正在检查…"; primary.isEnabled = false; secondary.isHidden = true
            return
        }
        heading(status.isReady ? "共享已就绪" : "完成尚未就绪的设置",
                status.isReady ? "两项检查均已通过，可以直接测试分享。" : "已自动检查，只需处理下面未就绪的项目。")
        switch status.receiver {
        case .ready:
            row(symbol: "checkmark.circle.fill", title: "Harness 已准备好接收", detail: "接收组件已启用并正在运行。", color: .systemGreen)
        case .notInstalled:
            row(symbol: "exclamationmark.circle", title: "接收组件尚未安装", detail: "点击下方“返回安装”，添加 Harness 接收组件。", color: .systemOrange)
        case .harnessClosed:
            row(symbol: "1.circle", title: "打开 DeepSeek Harness", detail: "启动后会自动检查 dsh-share 的运行状态。",
                actionTitle: "打开 Harness", action: #selector(openHarness))
        case .inactive:
            row(symbol: "1.circle", title: "启用 Harness 接收组件", detail: "在 Harness 的插件列表中启用 dsh-share，助手会自动复查。",
                actionTitle: "打开 Harness", action: #selector(openHarness))
        case .otherProfile:
            row(symbol: "exclamationmark.circle", title: "其它 Harness 实例正在接收", detail: "先停用其它实例的 dsh-share，再启用桌面版。", color: .systemOrange,
                actionTitle: "打开 Harness", action: #selector(openHarness))
        case .unknown:
            row(symbol: "questionmark.circle", title: "暂时无法确认接收状态", detail: "可以在 Harness 中检查 dsh-share，或直接测试分享。", color: .systemOrange,
                actionTitle: "打开 Harness", action: #selector(openHarness))
        }
        switch status.sharing {
        case .ready:
            row(symbol: "checkmark.circle.fill", title: "系统共享入口已启用", detail: "共享菜单已可提供 DeepSeek Harness。", color: .systemGreen)
        case .disabled:
            row(symbol: "2.circle", title: "启用系统共享入口", detail: "系统设置 → 通用 → 登录项与扩展 → 共享\n打开“DeepSeek Harness”的开关。",
                actionTitle: "打开系统设置", action: #selector(openSettings))
        case .notRegistered, .otherCopy:
            row(symbol: "exclamationmark.circle", title: "重新注册共享入口", detail: "点击下方“返回安装”，注册应用程序文件夹中的这份 App。", color: .systemOrange)
        case .unknown:
            row(symbol: "questionmark.circle", title: "暂时无法确认共享入口", detail: "可以在系统设置中检查共享扩展，或直接测试分享。", color: .systemOrange,
                actionTitle: "打开系统设置", action: #selector(openSettings))
        }
        if !status.isReady { add(text("修改设置后回到此窗口，会自动重新检查。", size: 12, color: .secondaryLabelColor)) }
        primary.title = status.isReady ? "下一步：测试分享" : status.requiresInstallation ? "返回安装" : "重新检查"
        secondary.title = "直接测试分享"; secondary.isHidden = status.isReady
    }

    private func startEnablementChecks() {
        stopEnablementChecks(); enablement = nil; render(); checkEnablement()
        enablementTimer = Timer.scheduledTimer(withTimeInterval: 3, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self, NSApp.isActive else { return }
                self.checkEnablement()
            }
        }
    }
    private func stopEnablementChecks() {
        enablementTimer?.invalidate(); enablementTimer = nil
        enablementGeneration = UUID(); checkingEnablement = false
    }
    private func checkEnablement(showProgress: Bool = false) {
        guard step == .enable, uninstallation == nil else { return }
        if showProgress, enablement != nil { primary.title = "正在检查…"; primary.isEnabled = false }
        guard !checkingEnablement else { return }
        checkingEnablement = true
        let generation = enablementGeneration, profile = profile, app = Bundle.main.bundleURL
        let home = FileManager.default.homeDirectoryForCurrentUser
        let inbox = ProcessInfo.processInfo.environment["DSH_SHARE_INBOX"].flatMap { $0.isEmpty ? nil : URL(fileURLWithPath: $0) }
            ?? home.appendingPathComponent("Library/Application Support/DSHShare/inbox")
        let running = NSRunningApplication.runningApplications(withBundleIdentifier: "com.deepseek.dsh")
        let hostExecutable = running.first?.executableURL
        let fallbackHelper = ProcessInfo.processInfo.environment["DSH_SHARE_HELPER"].flatMap { $0.isEmpty ? nil : URL(fileURLWithPath: $0) }
            ?? app.appendingPathComponent("Contents/MacOS/dsh-share-helper")
        DispatchQueue.global(qos: .utility).async {
            let receiver = SetupChecks.receiver(profile: profile, inbox: inbox, harnessRunning: !running.isEmpty,
                hostExecutable: hostExecutable, fallbackHelper: fallbackHelper)
            let registry = SetupChecks.registryReport()
            DispatchQueue.main.async {
                guard self.enablementGeneration == generation, self.step == .enable, self.uninstallation == nil else { return }
                let extensionURL = app.appendingPathComponent("Contents/PlugIns/DSHShareExtension.appex")
                let needsServiceQuery = SetupChecks.sharing(registry: registry, extensionURL: extensionURL, serviceAvailable: true) == .ready
                let sample = Bundle.main.resourceURL?.appendingPathComponent("分享测试.txt")
                let available = needsServiceQuery && (sample.map { file in
                    NSSharingService.sharingServices(forItems: [file]).contains {
                        $0.title.caseInsensitiveCompare("DeepSeek Harness") == .orderedSame
                            || $0.menuItemTitle.caseInsensitiveCompare("DeepSeek Harness") == .orderedSame
                    }
                } ?? false)
                let sharing = SetupChecks.sharing(registry: registry,
                    extensionURL: extensionURL, serviceAvailable: available)
                self.enablement = .init(receiver: receiver, sharing: sharing)
                self.checkingEnablement = false; self.render()
            }
        }
    }
    @objc private func restartSetup() {
        stopEnablementChecks(); step = .prepare; installation = .idle; render()
    }

    @objc private func primaryAction() {
        guard !busy else { return }
        if let uninstallation {
            if case .succeeded = uninstallation { finish() } else { confirmUninstall() }
            return
        }
        switch step {
        case .prepare:
            if readiness == .moveApp { finish(); return }
            if readiness == .ready { install(); return }
            render()
        case .install:
            if case .succeeded = installation { step = .enable; startEnablementChecks() }
            else { install() }
        case .enable:
            if enablement?.isReady == true { stopEnablementChecks(); step = .test; render() }
            else if enablement?.requiresInstallation == true { restartSetup() }
            else { checkEnablement(showProgress: true) }
        case .test: finish()
        }
    }
    @objc private func secondaryAction() {
        if let uninstallation {
            if case .succeeded = uninstallation { return }
            if case .failed = uninstallation { step = .prepare; installation = .idle }
            self.uninstallation = nil; render()
            return
        }
        if step == .enable { stopEnablementChecks(); step = .test; render(); return }
        if step != .prepare { finish() }
    }
    @objc private func goBack() {
        guard !busy else { return }
        if uninstallation != nil { uninstallation = nil; render(); return }
        stopEnablementChecks()
        step = SetupStep(rawValue: max(0, step.rawValue - 1)) ?? .prepare; render()
        if step == .enable { startEnablementChecks() }
    }
    @objc private func toggleErrorDetails() { showErrorDetails.toggle(); render() }

    private func install() {
        guard readiness == .ready, let profile else { step = .prepare; render(); return }
        busy = true; step = .install; installation = .running; render()
        let app = Bundle.main.bundleURL
        let destination = ProcessInfo.processInfo.environment["DSH_PLUGIN_DIR"]
        DispatchQueue.global(qos: .userInitiated).async {
            let result = Result { try SetupInstaller.install(app: app, profile: profile, pluginDestination: destination) }
            DispatchQueue.main.async {
                self.busy = false
                switch result {
                case .success: self.installation = .succeeded
                case .failure(let error): self.installation = .failed(error.localizedDescription)
                }
                self.render()
            }
        }
    }

    @objc private func showUninstaller() {
        guard !busy else { return }
        stopEnablementChecks()
        showErrorDetails = false; uninstallErrorDetails = nil; manualAppRemovalAvailable = false
        uninstallation = .ready; render()
    }

    private func renderUninstallation(_ state: Uninstallation) {
        back.isHidden = true
        secondary.title = "取消卸载"
        switch state {
        case .ready:
            add(text("卸载 DSH Share", size: 24, weight: .semibold))
            add(text("移除分享入口和接收组件，App 将移到废纸篓。", color: .secondaryLabelColor))
            row(symbol: "minus.circle", title: "移除系统分享入口", detail: "共享菜单将不再提供 DSH Share 的 DeepSeek Harness 入口。")
            row(symbol: "minus.circle", title: "移除 Harness 接收组件", detail: "清除已连接配置中的 dsh-share，保留其它插件和设置。")
            if !canUninstall {
                add(text("请从应用程序文件夹打开已安装的 DSHShare，再执行卸载。", size: 12, color: .secondaryLabelColor))
                primary.isEnabled = false
            } else if mustQuitHarness {
                add(text("请先保存工作，并在 Harness 中按 ⌘Q 完全退出，然后点击下方按钮。", size: 12, color: .secondaryLabelColor))
            }
            primary.title = mustQuitHarness ? "我已退出，继续卸载" : "卸载 DSH Share…"
            primary.hasDestructiveAction = !mustQuitHarness
        case .running:
            add(text("正在卸载，请稍候", size: 24, weight: .semibold))
            let spinner = NSProgressIndicator(); spinner.style = .spinning; spinner.startAnimation(nil)
            let progress = NSStackView(views: [spinner, text("正在移除接收组件和分享入口…", size: 14)])
            progress.spacing = 12; add(progress)
            add(text("请保持此窗口打开，等待卸载完成。", color: .secondaryLabelColor))
            primary.title = "正在卸载…"
        case .succeeded:
            add(text("卸载完成", size: 24, weight: .semibold))
            row(symbol: "checkmark.circle.fill", title: "App 已移到废纸篓", detail: "系统分享入口和 Harness 接收组件已移除。")
            add(text("请完全退出并重新打开微信等来源应用，以刷新它们缓存的共享菜单。", size: 12, color: .secondaryLabelColor))
            secondary.isHidden = true
            primary.title = "完成并关闭"
        case .failed(let error):
            add(text("卸载尚未完成", size: 24, weight: .semibold))
            row(symbol: "exclamationmark.circle", title: "请处理提示后重试", detail: "部分步骤可能已经完成。处理提示后重试即可继续卸载。", color: .systemOrange)
            add(text(error, size: 12, color: .secondaryLabelColor))
            if let details = uninstallErrorDetails {
                add(button(showErrorDetails ? "收起错误详情" : "查看错误详情", action: #selector(toggleErrorDetails)))
                if showErrorDetails {
                    let detail = text(String(details.prefix(800)), size: 11, color: .secondaryLabelColor)
                    detail.maximumNumberOfLines = 6; detail.isSelectable = true; add(detail)
                }
            }
            if manualAppRemovalAvailable { add(button("在 Finder 中显示 App", action: #selector(revealApp))) }
            primary.title = "重试卸载…"; primary.hasDestructiveAction = true
        }
    }

    private var canUninstall: Bool {
        return SetupInstaller.isInstalled(Bundle.main.bundleURL)
    }

    private var mustQuitHarness: Bool {
        return SetupInstaller.harnessIsRunning()
    }

    private func confirmUninstall() {
        guard canUninstall, !mustQuitHarness else { render(); return }
        let alert = NSAlert()
        alert.messageText = "卸载 DSH Share？"
        alert.informativeText = "将移除系统分享入口和 Harness 接收组件，并将 DSH Share 移到废纸篓。"
        alert.addButton(withTitle: "取消")
        alert.addButton(withTitle: "卸载并移到废纸篓").hasDestructiveAction = true
        alert.beginSheetModal(for: window) { [weak self] response in
            if response == .alertSecondButtonReturn { self?.performUninstall() }
        }
    }

    private func performUninstall() {
        guard !busy else { return }
        busy = true; uninstallation = .running; render()
        let app = Bundle.main.bundleURL, profile = profile
        let destination = ProcessInfo.processInfo.environment["DSH_PLUGIN_DIR"]
        DispatchQueue.global(qos: .userInitiated).async {
            let result = Result { try SetupInstaller.uninstall(app: app, profile: profile, pluginDestination: destination) }
            DispatchQueue.main.async {
                self.busy = false
                switch result {
                case .success: self.uninstallation = .succeeded
                case .failure(let error):
                    let failure = error as? SetupUninstallFailure
                    self.uninstallation = .failed(error.localizedDescription)
                    self.uninstallErrorDetails = failure?.underlying.localizedDescription
                    self.manualAppRemovalAvailable = failure.map { $0.stage != .receiver } ?? false
                }
                self.render()
            }
        }
    }

    @objc private func revealApp() { NSWorkspace.shared.activateFileViewerSelecting([Bundle.main.bundleURL]) }
    @objc private func openHarness() {
        guard let url = SetupInstaller.harnessAppURL() else { return }
        NSWorkspace.shared.openApplication(at: url, configuration: .init()) { _, _ in }
    }
    @objc private func openSettings() { NSWorkspace.shared.open(URL(fileURLWithPath: "/System/Applications/System Settings.app")) }
    @objc private func openApplications() { NSWorkspace.shared.open(URL(fileURLWithPath: "/Applications")) }
    @objc private func showTestFile() {
        guard let file = Bundle.main.resourceURL?.appendingPathComponent("分享测试.txt"),
              FileManager.default.fileExists(atPath: file.path) else { return }
        NSWorkspace.shared.activateFileViewerSelecting([file])
    }
    @objc private func showTroubleshooting() {
        let alert = NSAlert()
        alert.messageText = "分享没有成功时"
        alert.informativeText = "1. 没有入口或头像不对：检查系统共享扩展，并完全退出、重新打开来源应用。微信请按 ⌘Q。\n\n2. Harness 没收到：打开接收会话，确认 dsh-share 已启用，再检查输入区的附件。\n\n3. 先用内置的小文本文件测试。请勿反复分享同一内容，以免重复添加附件。\n\n未送达的内容会保留，可以稍后继续排查。"
        alert.addButton(withTitle: "返回测试"); alert.beginSheetModal(for: window)
    }
    private func finish() { if !busy { window.performClose(nil) } }
}

@main
struct DSHShareApp {
    @MainActor
    static func main() {
        let application = NSApplication.shared
        let delegate = AppDelegate()
        application.delegate = delegate
        withExtendedLifetime(delegate) { application.run() }
    }
}
