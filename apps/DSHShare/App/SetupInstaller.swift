import AppKit

struct SetupUninstallFailure: LocalizedError {
    enum Stage { case receiver, registration, application }
    let stage: Stage
    let underlying: Error
    var errorDescription: String? {
        switch stage {
        case .receiver:
            if (underlying as NSError).code == 75 { return underlying.localizedDescription }
            return "接收组件未能卸载。请先完全退出 Harness；若配置文件有异常，请修复后重试。"
        case .registration:
            return "接收组件已移除，但系统分享入口未能注销。请重试，或在 Finder 中移除 App 后重新打开来源应用。"
        case .application:
            return "接收组件和分享入口已移除，但 App 未能移到废纸篓。请在 Finder 中手动移除 App，或调整权限后重试。"
        }
    }
}

enum SetupInstaller {
    static func isProfileDirectory(_ url: URL) -> Bool {
        FileManager.default.fileExists(atPath: url.appendingPathComponent("package.json").path)
    }

    static func desktopProfileDirectory() -> URL? {
        let path = ProcessInfo.processInfo.environment["DSH_PROFILE_DIR"]
        let url = path.flatMap { $0.isEmpty ? nil : URL(fileURLWithPath: $0, isDirectory: true) }
            ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".dsh/profiles/desktop", isDirectory: true)
        return isProfileDirectory(url) ? url : nil
    }

    static func harnessAppURL() -> URL? {
        if let running = NSRunningApplication.runningApplications(withBundleIdentifier: "com.deepseek.dsh").first?.bundleURL { return running }
        if let registered = NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.deepseek.dsh") { return registered }
        let candidates = [URL(fileURLWithPath: "/Applications/DeepSeek Harness.app"),
                          FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Applications/DeepSeek Harness.app")]
        return candidates.first { Bundle(url: $0)?.bundleIdentifier == "com.deepseek.dsh" }
    }

    static func harnessIsRunning() -> Bool {
        !NSRunningApplication.runningApplications(withBundleIdentifier: "com.deepseek.dsh").isEmpty
    }

    static func profileDirectories() -> [URL] {
        let manager = FileManager.default
        if let custom = ProcessInfo.processInfo.environment["DSH_PROFILE_DIR"], !custom.isEmpty {
            let url = URL(fileURLWithPath: custom, isDirectory: true)
            return manager.fileExists(atPath: url.appendingPathComponent("package.json").path) ? [url] : []
        }
        let root = manager.homeDirectoryForCurrentUser.appendingPathComponent(".dsh/profiles", isDirectory: true)
        let urls = (try? manager.contentsOfDirectory(at: root, includingPropertiesForKeys: [.isDirectoryKey],
                                                     options: [.skipsHiddenFiles])) ?? []
        return urls.filter {
            (try? $0.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true
                && manager.fileExists(atPath: $0.appendingPathComponent("package.json").path)
        }.sorted { $0.lastPathComponent < $1.lastPathComponent }
    }

    static func isInstalled(_ app: URL) -> Bool {
        let path = app.standardizedFileURL.resolvingSymlinksInPath().path
        if path.hasPrefix("/Volumes/") || path.contains("/AppTranslocation/") { return false }
        let userApps = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Applications").path
        return path.hasPrefix("/Applications/") || path.hasPrefix(userApps + "/")
    }

    static func run(_ executable: URL, arguments: [String]) throws -> String {
        let process = Process()
        process.executableURL = executable
        process.arguments = arguments
        let output = Pipe()
        process.standardOutput = output
        process.standardError = output
        try process.run()
        let bytes = output.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        let text = String(data: bytes, encoding: .utf8) ?? ""
        if process.terminationStatus == 75 {
            throw NSError(domain: "DSHShare.Setup", code: 75, userInfo: [NSLocalizedDescriptionKey:
                "组件正在使用中。请完全退出 Harness，等待其它安装或卸载结束后重试。"])
        }
        guard process.terminationStatus == 0 else {
            throw NSError(domain: "DSHShare.Setup", code: Int(process.terminationStatus),
                          userInfo: [NSLocalizedDescriptionKey: String(text.prefix(1200))])
        }
        return text
    }

    static func install(app: URL, profile: URL, pluginDestination: String?) throws {
        guard isInstalled(app) else {
            throw NSError(domain: "DSHShare.Setup", code: 1,
                          userInfo: [NSLocalizedDescriptionKey: "请先将 DSHShare 拖到应用程序文件夹，再从那里打开。"])
        }
        let helper = app.appendingPathComponent("Contents/MacOS/dsh-share-helper")
        let source = app.appendingPathComponent("Contents/Resources/plugin/dsh-share", isDirectory: true)
        var arguments = ["install-plugin", "--profile-dir", profile.path, "--source", source.path, "--json"]
        if let pluginDestination, !pluginDestination.isEmpty { arguments += ["--destination", pluginDestination] }
        _ = try run(helper, arguments: arguments)

        let registry = URL(fileURLWithPath: "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister")
        _ = try run(registry, arguments: ["-f", app.path])
        let extensionURL = app.appendingPathComponent("Contents/PlugIns/DSHShareExtension.appex", isDirectory: true)
        _ = try run(URL(fileURLWithPath: "/usr/bin/pluginkit"), arguments: ["-a", extensionURL.path])
        if let bundle = Bundle(url: extensionURL), let identifier = bundle.bundleIdentifier {
            _ = try run(URL(fileURLWithPath: "/usr/bin/pluginkit"), arguments: ["-e", "use", "-i", identifier])
        }
    }

    static func moveToTrash(_ app: URL) throws -> URL {
        var result: NSURL?
        try FileManager.default.trashItem(at: app, resultingItemURL: &result)
        guard let result, !FileManager.default.fileExists(atPath: app.path) else {
            throw NSError(domain: "DSHShare.Setup", code: 2,
                          userInfo: [NSLocalizedDescriptionKey: "未能将 App 移到废纸篓，请在 Finder 中手动移除。"])
        }
        return result as URL
    }

    static func uninstall(app: URL, profile: URL?, pluginDestination: String?) throws {
        guard isInstalled(app), Bundle(url: app)?.bundleIdentifier == Bundle.main.bundleIdentifier else {
            throw NSError(domain: "DSHShare.Setup", code: 1,
                          userInfo: [NSLocalizedDescriptionKey: "请从应用程序文件夹打开已安装的 DSHShare，再执行卸载。"])
        }
        guard !harnessIsRunning() else {
            throw NSError(domain: "DSHShare.Setup", code: 75,
                          userInfo: [NSLocalizedDescriptionKey: "请先保存工作，并用 ⌘Q 完全退出 DeepSeek Harness。"])
        }
        let helper = app.appendingPathComponent("Contents/MacOS/dsh-share-helper")
        var arguments = ["uninstall-plugin", "--json"]
        if let profile { arguments += ["--profile-dir", profile.path] }
        if let pluginDestination, !pluginDestination.isEmpty { arguments += ["--destination", pluginDestination] }
        do { _ = try run(helper, arguments: arguments) }
        catch { throw SetupUninstallFailure(stage: .receiver, underlying: error) }

        do {
            let extensionURL = app.appendingPathComponent("Contents/PlugIns/DSHShareExtension.appex", isDirectory: true)
            if let identifier = Bundle(url: extensionURL)?.bundleIdentifier {
                let registry = URL(fileURLWithPath: "/usr/bin/pluginkit")
                let registered = try run(registry, arguments: ["-m", "-v", "-i", identifier])
                if registered.contains(identifier) {
                    _ = try run(registry, arguments: ["-e", "ignore", "-i", identifier])
                    // Disabling also covers an older registered copy of the same share target.
                    _ = try? run(registry, arguments: ["-r", extensionURL.path])
                }
            }
            let registry = URL(fileURLWithPath: "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister")
            _ = try run(registry, arguments: ["-u", app.path])
        } catch { throw SetupUninstallFailure(stage: .registration, underlying: error) }
        do { _ = try moveToTrash(app) }
        catch { throw SetupUninstallFailure(stage: .application, underlying: error) }
    }
}
