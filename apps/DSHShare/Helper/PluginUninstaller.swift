import Foundation
import Darwin

// Read bounded original bytes so rollback preserves the user's exact configuration.
private func configurationBytes(_ path: String) throws -> Data {
    let fd = open(path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
    guard fd >= 0 else { throw systemError("open configuration") }
    let handle = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
    var info = stat()
    guard fstat(fd, &info) == 0, info.st_mode & S_IFMT == S_IFREG,
          info.st_size >= 0, info.st_size <= 16 * metadataLimit else {
        throw HelperFailure.message("configuration must be a regular file of at most 16 MiB")
    }
    let bytes = try handle.read(upToCount: 16 * metadataLimit + 1) ?? Data()
    guard bytes.count == info.st_size else { throw HelperFailure.message("configuration changed while reading") }
    try handle.close()
    return bytes
}

func recordedProfilePaths(_ target: String) throws -> [String] {
    let marker = target + "/.installation.json"
    guard try fileInfo(marker) != nil else { return [] }
    let value = try readJSON(marker, limit: 16 * 1024)
    guard versionOne(value["formatVersion"]), let helper = value["helperPath"] as? String,
          helper.hasPrefix("/") else { throw HelperFailure.message("invalid plugin installation record; preserved") }
    if let identifier = value["applicationIdentifier"] {
        guard identifier as? String == "com.movy.dshshare.host" else {
            throw HelperFailure.message("installation record belongs to another application; preserved")
        }
    } else if (helper as NSString).lastPathComponent != "dsh-share-helper" {
        throw HelperFailure.message("unrecognized legacy installation record; preserved")
    }
    guard let raw = value["profileDirectories"] else { return [] }
    guard let paths = raw as? [String], paths.count <= 128,
          paths.allSatisfy({ $0.hasPrefix("/") && !$0.contains("\0") }) else {
        throw HelperFailure.message("invalid recorded profile directories; preserved")
    }
    return paths.map(absolutePath)
}

private func lexicalPath(_ value: String) -> String {
    let expanded = (value as NSString).expandingTildeInPath
    let full = expanded.hasPrefix("/") ? expanded : fileManager.currentDirectoryPath + "/" + expanded
    var parts: [Substring] = []
    for part in full.split(separator: "/") {
        if part == "." { continue }
        if part == ".." { if !parts.isEmpty { parts.removeLast() }; continue }
        parts.append(part)
    }
    return "/" + parts.joined(separator: "/")
}

private func isSharePackage(_ directory: String) -> Bool {
    guard let package = try? readJSON(directory + "/package.json"),
          package["name"] as? String == "dsh-share",
          let dsh = package["dsh"] as? [String: Any],
          let bundle = dsh["bundle"] as? [String: Any] else { return false }
    return ["cordis.patch.yml", "./cordis.patch.yml"].contains(bundle["patch"] as? String ?? "")
}

private struct ProfileRemoval {
    let path: String
    let original: Data
    let replacement: Data?
    let link: String?
    let manifestBackup: String
    let linkBackup: String
}

private func removalPlan(_ profile: String, required: Bool, token: String) throws -> ProfileRemoval? {
    let manifestPath = profile + "/package.json"
    guard try fileInfo(manifestPath) != nil else { return nil }
    let modules = profile + "/node_modules", link = modules + "/dsh-share"
    let modulesInfo = try fileInfo(modules)
    // Never mutate a shared/external node_modules reached through a symlink.
    let realModules = modulesInfo == nil || modulesInfo!.st_mode & S_IFMT == S_IFDIR
    let linkInfo = realModules ? try fileInfo(link) : nil
    let ownedLink = linkInfo.map { _ in isSharePackage(absolutePath(link)) } ?? false
    let bytes: Data
    let original: [String: Any]
    do {
        bytes = try configurationBytes(manifestPath)
        guard let value = try JSONSerialization.jsonObject(with: bytes) as? [String: Any] else {
            throw HelperFailure.message("profile configuration must be a JSON object")
        }
        original = value
    } catch {
        if required || ownedLink { throw error }
        return nil
    }
    let dependency = (original["dependencies"] as? [String: Any])?["dsh-share"]
    let dshValue = original["dsh"] as? [String: Any]
    let profileValue = dshValue?["profile"] as? [String: Any]
    let bundlesValue = profileValue?["bundles"] as? [Any]
    let hasBundle = bundlesValue?.contains { $0 as? String == "dsh-share" } == true
    guard dependency != nil || hasBundle || ownedLink else { return nil }
    guard realModules else { throw HelperFailure.message("profile node_modules is not a real directory; preserved") }

    var updated = original
    if original["dependencies"] != nil {
        guard var dependencies = original["dependencies"] as? [String: Any] else {
            throw HelperFailure.message("profile dependencies must be an object")
        }
        dependencies.removeValue(forKey: "dsh-share")
        updated["dependencies"] = dependencies
    }
    if original["dsh"] != nil {
        guard var dsh = dshValue else { throw HelperFailure.message("profile dsh must be an object") }
        if dsh["profile"] != nil {
            guard var config = profileValue else { throw HelperFailure.message("profile dsh.profile must be an object") }
            if config["bundles"] != nil {
                guard let bundles = bundlesValue else { throw HelperFailure.message("profile dsh.profile.bundles must be an array") }
                config["bundles"] = bundles.filter { $0 as? String != "dsh-share" }
            }
            dsh["profile"] = config
        }
        updated["dsh"] = dsh
    }
    var linkToRemove: String?
    if let info = linkInfo {
        let kind = info.st_mode & S_IFMT
        guard kind == S_IFLNK || (kind == S_IFDIR && ownedLink) else {
            throw HelperFailure.message("unrecognized dsh-share module; preserved")
        }
        linkToRemove = link
    }
    let replacement: Data?
    if (original as NSDictionary).isEqual(to: updated) { replacement = nil }
    else {
        var data = try JSONSerialization.data(withJSONObject: updated, options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes])
        data.append(0x0a); replacement = data
    }
    guard replacement != nil || linkToRemove != nil else { return nil }
    return ProfileRemoval(path: profile, original: bytes, replacement: replacement, link: linkToRemove,
        manifestBackup: manifestPath + ".dsh-share-backup-" + token,
        linkBackup: modules + "/.dsh-share-uninstalled-" + token)
}

/// Remove this integration and completed transfers. Preserve unfinished shares and source directories.
func uninstallPlugin(profileRoot: String?, profileDirectory: String?, destination: String?, inbox: String?) throws -> [String: Any] {
    let home = fileManager.homeDirectoryForCurrentUser
    let requested = lexicalPath(destination ?? home.appendingPathComponent("Library/Application Support/DSHShare/plugin/dsh-share").path)
    if let info = try fileInfo(requested), info.st_mode & S_IFMT != S_IFDIR {
        throw HelperFailure.message("plugin destination is not a real directory; preserved")
    }
    let target = absolutePath(requested)
    let parent = (target as NSString).deletingLastPathComponent
    let inbox = absolutePath(inbox ?? ProcessInfo.processInfo.environment["DSH_SHARE_INBOX"]
        ?? home.appendingPathComponent("Library/Application Support/DSHShare/inbox").path)
    guard target != "/", target != home.path,
          !inbox.hasPrefix(target + "/"), !target.hasPrefix(inbox + "/"), target != inbox else {
        throw HelperFailure.message("plugin destination overlaps retained data; preserved")
    }
    let installLock: Int32
    do { installLock = try lockInbox(parent, fileName: ".install.lock") }
    catch HelperFailure.busy { throw HelperFailure.installationBusy }
    defer { close(installLock) }
    let consumerLock = try lockInbox(inbox)
    defer { close(consumerLock) }

    let targetExists = try fileInfo(target) != nil
    let hasRecord = try fileInfo(target + "/.installation.json") != nil
    if targetExists && !isSharePackage(target) && !hasRecord {
        throw HelperFailure.message("plugin destination does not identify DSH Share; preserved")
    }
    var profiles: [String: Bool] = [:]
    if targetExists { for path in try recordedProfilePaths(target) { profiles[path] = true } }
    if let profileDirectory { profiles[absolutePath(profileDirectory)] = true }
    let root = absolutePath(profileRoot ?? home.appendingPathComponent(".dsh/profiles").path)
    if try isDirectory(root) {
        for name in try fileManager.contentsOfDirectory(atPath: root) where !name.hasPrefix(".") {
            let path = root + "/" + name
            if try isDirectory(path), profiles[path] == nil { profiles[path] = false }
        }
    }
    let token = String(Int(Date().timeIntervalSince1970 * 1000)) + "-" + UUID().uuidString
    let plans = try profiles.keys.sorted().compactMap { path in
        try removalPlan(path, required: profiles[path] == true, token: token)
    }
    for plan in plans {
        guard target != plan.path, !plan.path.hasPrefix(target + "/") else {
            throw HelperFailure.message("plugin destination overlaps a profile; preserved")
        }
    }
    let completionCleanup = try cleanupLocked(inbox, olderDays: 0, apply: true)
    guard (completionCleanup["eligible"] as? [Any] ?? []).count
            == (completionCleanup["removed"] as? [Any] ?? []).count else {
        throw HelperFailure.message("completion cleanup could not finish; check inbox permissions and retry; unfinished data is preserved")
    }
    // Preflight every profile and save every changed manifest before altering any active file.
    for plan in plans {
        guard try configurationBytes(plan.path + "/package.json") == plan.original else {
            throw HelperFailure.message("profile changed during uninstall; retry after quitting Harness")
        }
        if plan.replacement != nil {
            try plan.original.write(to: URL(fileURLWithPath: plan.manifestBackup), options: .atomic)
            guard chmod(plan.manifestBackup, 0o600) == 0 else { throw systemError("protect uninstall backup") }
        }
    }
    let backups = parent + "/backups"
    let pluginBackup = backups + "/uninstalled-dsh-share-" + token
    var written: [ProfileRemoval] = [], moved: [ProfileRemoval] = []
    var movedTarget = false
    do {
        for plan in plans {
            if let link = plan.link, lexicalPath(link) != target {
                try fileManager.moveItem(atPath: link, toPath: plan.linkBackup)
                moved.append(plan)
            }
            if let replacement = plan.replacement {
                try replacement.write(to: URL(fileURLWithPath: plan.path + "/package.json"), options: .atomic)
                written.append(plan)
            }
        }
        if targetExists {
            try fileManager.createDirectory(atPath: backups, withIntermediateDirectories: true,
                                           attributes: [.posixPermissions: 0o700])
            guard try isDirectory(backups) else { throw HelperFailure.message("backup directory is not a real directory") }
            try fileManager.moveItem(atPath: target, toPath: pluginBackup)
            movedTarget = true
        }
    } catch {
        var rollbackErrors: [String] = []
        for plan in written.reversed() {
            do { try plan.original.write(to: URL(fileURLWithPath: plan.path + "/package.json"), options: .atomic) }
            catch { rollbackErrors.append(plan.manifestBackup) }
        }
        for plan in moved.reversed() {
            do { try fileManager.moveItem(atPath: plan.linkBackup, toPath: plan.link!) }
            catch { rollbackErrors.append(plan.linkBackup) }
        }
        if !rollbackErrors.isEmpty {
            throw HelperFailure.message("uninstall stopped; original data and backups are retained; restore from: " + rollbackErrors.joined(separator: ", "))
        }
        throw error
    }
    var result: [String: Any] = [
        "status": "uninstalled", "changed": !plans.isEmpty || movedTarget,
        "profiles": plans.map(\.path), "inboxPreserved": inbox,
        "completedTransfersRemoved": (completionCleanup["removed"] as? [Any] ?? []).count,
        "configurationBackups": plans.filter { $0.replacement != nil }.map(\.manifestBackup),
    ]
    if movedTarget { result["pluginBackup"] = pluginBackup }
    return result
}
