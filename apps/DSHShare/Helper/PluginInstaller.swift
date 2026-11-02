import Foundation
import Darwin

func absolutePath(_ value: String) -> String {
    let expanded = (value as NSString).expandingTildeInPath
    var ancestor = expanded.hasPrefix("/") ? expanded : fileManager.currentDirectoryPath + "/" + expanded
    var missing: [String] = []
    // Foundation can resolve an alias differently before and after its final directory exists.
    // Resolve the nearest existing ancestor with POSIX realpath, then append the missing tail.
    while true {
        if let resolved = realpath(ancestor, nil) {
            defer { free(resolved) }
            return missing.reversed().reduce(String(cString: resolved)) { prefix, name in
                (prefix == "/" ? "/" : prefix + "/") + name
            }
        }
        let parent = (ancestor as NSString).deletingLastPathComponent
        if parent == ancestor { return ancestor }
        missing.append((ancestor as NSString).lastPathComponent)
        ancestor = parent
    }
}

private func bundledPluginPayload(_ source: String) throws -> (version: String, files: [String: Data]) {
    let package = try readJSON(source + "/package.json")
    guard package["name"] as? String == "dsh-macos-share", let version = package["version"] as? String,
          let declared = package["files"] as? [String] else {
        throw HelperFailure.message("bundled plugin package is invalid")
    }
    let names = Set(declared + ["package.json"])
    guard names.allSatisfy({ !$0.isEmpty && $0 != "." && $0 != ".." && !$0.contains("/") && !$0.contains("\\") && !$0.hasPrefix(".") }) else {
        throw HelperFailure.message("bundled plugin contains an unsafe file name")
    }
    var payload: [String: Data] = [:]
    for name in names {
        let path = source + "/" + name
        let fd = open(path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
        guard fd >= 0 else { throw systemError("open bundled plugin file") }
        let handle = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
        var info = stat()
        guard fstat(fd, &info) == 0, info.st_mode & S_IFMT == S_IFREG, info.st_size <= 16 * metadataLimit else {
            throw HelperFailure.message("bundled plugin files must be regular files of at most 16 MiB")
        }
        let data = try handle.read(upToCount: 16 * metadataLimit + 1) ?? Data()
        guard data.count <= 16 * metadataLimit, data.count == info.st_size else {
            throw HelperFailure.message("bundled plugin file changed while reading")
        }
        payload[name] = data
        try handle.close()
    }
    return (version, payload)
}

func bundlePlugin(source: String, destination: String) throws {
    let payload = try bundledPluginPayload(absolutePath(source)).files
    guard try fileInfo(destination) == nil else { throw HelperFailure.message("plugin bundle destination already exists") }
    try fileManager.createDirectory(atPath: destination, withIntermediateDirectories: true,
                                    attributes: [.posixPermissions: 0o755])
    for (name, data) in payload {
        let target = destination + "/" + name
        try data.write(to: URL(fileURLWithPath: target), options: .atomic)
        guard chmod(target, 0o644) == 0 else { throw systemError("set bundled plugin permissions") }
    }
    guard chmod(destination, 0o755) == 0 else { throw systemError("set plugin bundle permissions") }
}

// The same installer is called by the first-run app and the source-install script.
func installPlugin(profileDirectory: String, source: String, destination: String?) throws -> [String: Any] {
    let profile = absolutePath(profileDirectory)
    let source = absolutePath(source)
    let fallback = fileManager.homeDirectoryForCurrentUser
        .appendingPathComponent("Library/Application Support/DSHShare/plugins/dsh-macos-share").path
    let target = absolutePath(destination ?? fallback)
    let parent = URL(fileURLWithPath: target).deletingLastPathComponent().path
    let manifest = profile + "/package.json"
    guard target != "/", target != source, !source.hasPrefix(target + "/"), !target.hasPrefix(source + "/") else {
        throw HelperFailure.message("plugin source and destination must be separate directories")
    }
    _ = try updatedProfile(manifest, plugin: target)
    let bundled = try bundledPluginPayload(source)
    let version = bundled.version
    var payload = bundled.files
    let executable = URL(fileURLWithPath: CommandLine.arguments[0]).standardizedFileURL.resolvingSymlinksInPath().path
    let installLock: Int32
    do { installLock = try lockInbox(parent, fileName: ".install.lock") }
    catch HelperFailure.busy { throw HelperFailure.installationBusy }
    defer { close(installLock) }
    // An explicit reinstall also repairs an invalid helper-discovery record.
    let profiles = Array(Set(((try? recordedProfilePaths(target)) ?? []) + [profile])).sorted()
    let marker = try JSONSerialization.data(withJSONObject: [
        "formatVersion": 1, "helperPath": executable, "pluginVersion": version,
        "applicationIdentifier": "com.movy.dshshare.host",
        "profileDirectories": profiles,
    ], options: [.sortedKeys, .withoutEscapingSlashes])
    guard profiles.count <= 128, marker.count <= 16 * 1024 else {
        throw HelperFailure.message("too many recorded profiles for this installation")
    }
    payload[".installation.json"] = marker
    let nodeModules = profile + "/node_modules"
    try fileManager.createDirectory(atPath: nodeModules, withIntermediateDirectories: true)
    let link = nodeModules + "/dsh-macos-share"
    let token = String(Int(Date().timeIntervalSince1970 * 1000)) + "-" + UUID().uuidString
    let staging = parent + "/.install-" + token
    let backups = parent + "/backups"
    let previousTarget = backups + "/dsh-share-" + token
    let previousLink = backups + "/profile-link-" + token
    let stagedLink = nodeModules + "/.dsh-share-install-" + token
    defer {
        try? fileManager.removeItem(atPath: staging)
        try? fileManager.removeItem(atPath: stagedLink)
    }
    var equal = (try? isDirectory(target)) == true
    if equal {
        let existing = Set(try fileManager.contentsOfDirectory(atPath: target))
        equal = existing == Set(payload.keys)
        for (name, data) in payload where equal {
            let path = target + "/" + name
            let info = try fileInfo(path)
            equal = (info?.st_mode ?? 0) & S_IFMT == S_IFREG && (try? Data(contentsOf: URL(fileURLWithPath: path))) == data
        }
    }
    let linkEqual = (try? fileManager.destinationOfSymbolicLink(atPath: link)) == target
    var replacedTarget = false, replacedLink = false, backedUpTarget = false, backedUpLink = false
    do {
        if !equal {
            try fileManager.createDirectory(atPath: staging, withIntermediateDirectories: false,
                                            attributes: [.posixPermissions: 0o700])
            for (name, data) in payload { try data.write(to: URL(fileURLWithPath: staging + "/" + name), options: .atomic) }
            if try fileInfo(target) != nil {
                try fileManager.createDirectory(atPath: backups, withIntermediateDirectories: true,
                                                attributes: [.posixPermissions: 0o700])
                try fileManager.moveItem(atPath: target, toPath: previousTarget)
                backedUpTarget = true
            }
            try fileManager.moveItem(atPath: staging, toPath: target)
            replacedTarget = true
        }
        if !linkEqual {
            try fileManager.createSymbolicLink(atPath: stagedLink, withDestinationPath: target)
            if try fileInfo(link) != nil {
                try fileManager.createDirectory(atPath: backups, withIntermediateDirectories: true,
                                                attributes: [.posixPermissions: 0o700])
                try fileManager.moveItem(atPath: link, toPath: previousLink)
                backedUpLink = true
            }
            try fileManager.moveItem(atPath: stagedLink, toPath: link)
            replacedLink = true
        }
        let profileBackup = try configureProfile(manifest, plugin: target, quiet: true)
        var result: [String: Any] = ["status": "installed", "pluginDirectory": target,
            "profileManifest": manifest, "pluginVersion": version, "helperPath": executable,
            "changed": replacedTarget || replacedLink || profileBackup != nil]
        if let profileBackup { result["profileBackup"] = profileBackup }
        if backedUpTarget { result["pluginBackup"] = previousTarget }
        return result
    } catch {
        // A failed profile write must not leave new code or links in an old profile.
        if replacedLink { try? fileManager.removeItem(atPath: link) }
        if backedUpLink { try? fileManager.moveItem(atPath: previousLink, toPath: link) }
        if replacedTarget { try? fileManager.removeItem(atPath: target) }
        if backedUpTarget { try? fileManager.moveItem(atPath: previousTarget, toPath: target) }
        throw error
    }
}
