import Foundation
import CoreFoundation
import Darwin

// A command-line executable bundled with DSHShare.app. No interpreter is used.
let helperVersion = "0.1.13"
let metadataLimit = 1024 * 1024
let fileManager = FileManager.default

enum HelperFailure: Error, CustomStringConvertible {
    case message(String), usage(String), busy, installationBusy
    var description: String {
        switch self {
        case .message(let value), .usage(let value): return value
        case .busy: return "Inbox is in use. Disable dsh-share in every running profile, then retry."
        case .installationBusy: return "Another plugin installation is in progress. Please try again."
        }
    }
}

func systemError(_ operation: String) -> HelperFailure {
    .message("\(operation): \(String(cString: strerror(errno)))")
}

func emit(_ value: Any) throws {
    var bytes = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys, .withoutEscapingSlashes])
    bytes.append(0x0a)
    FileHandle.standardOutput.write(bytes)
}

func readJSON(_ path: String, limit: Int = metadataLimit) throws -> [String: Any] {
    let fd = open(path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
    guard fd >= 0 else { throw systemError("open metadata") }
    defer { close(fd) }
    var info = stat()
    guard fstat(fd, &info) == 0 else { throw systemError("stat metadata") }
    guard info.st_mode & S_IFMT == S_IFREG else { throw HelperFailure.message("metadata must be a regular file") }
    var data = Data()
    var buffer = [UInt8](repeating: 0, count: 64 * 1024)
    while data.count <= limit {
        let count = read(fd, &buffer, min(buffer.count, limit + 1 - data.count))
        if count < 0 { if errno == EINTR { continue }; throw systemError("read metadata") }
        if count == 0 { break }
        data.append(contentsOf: buffer.prefix(count))
    }
    guard data.count <= limit else { throw HelperFailure.message("metadata exceeds its size limit") }
    guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
        throw HelperFailure.message("metadata must be a JSON object")
    }
    return object
}

func fileInfo(_ path: String) throws -> stat? {
    var info = stat()
    if lstat(path, &info) == 0 { return info }
    if errno == ENOENT { return nil }
    throw systemError("inspect path")
}

func isDirectory(_ path: String) throws -> Bool {
    guard let info = try fileInfo(path) else { return false }
    return info.st_mode & S_IFMT == S_IFDIR
}

func lockInbox(_ root: String, waitMS: Int = 0, fileName: String = ".consumer.lock") throws -> Int32 {
    try fileManager.createDirectory(atPath: root, withIntermediateDirectories: true,
                                    attributes: [.posixPermissions: 0o700])
    let fd = open(root + "/" + fileName, O_CREAT | O_RDWR | O_NOFOLLOW | O_CLOEXEC, 0o600)
    guard fd >= 0 else { throw systemError("open inbox lock") }
    do {
        var info = stat()
        guard fstat(fd, &info) == 0 else { throw systemError("stat inbox lock") }
        guard info.st_mode & S_IFMT == S_IFREG && info.st_nlink == 1 else {
            throw HelperFailure.message("inbox lock must be a regular file with one link")
        }
        let deadline = ProcessInfo.processInfo.systemUptime + Double(waitMS) / 1000
        while flock(fd, LOCK_EX | LOCK_NB) != 0 {
            guard errno == EWOULDBLOCK || errno == EAGAIN else { throw systemError("lock inbox") }
            guard ProcessInfo.processInfo.systemUptime < deadline else { throw HelperFailure.busy }
            usleep(25_000)
        }
        return fd
    } catch {
        close(fd)
        throw error
    }
}

func holdInbox(_ root: String, waitMS: Int, parentPID: Int) throws {
    let fd = try lockInbox(root, waitMS: waitMS)
    defer { close(fd) } // The kernel also releases ownership if this process is terminated.
    var owner = try JSONSerialization.data(withJSONObject: [
        "version": 1, "pid": parentPID, "helperPid": Int(getpid()),
        "startedAt": Date().timeIntervalSince1970 * 1000,
    ])
    owner.append(0x0a)
    guard ftruncate(fd, 0) == 0 else { throw systemError("reset lock metadata") }
    try owner.withUnsafeBytes { storage in
        var offset = 0
        while offset < storage.count {
            let count = write(fd, storage.baseAddress!.advanced(by: offset), storage.count - offset)
            if count < 0 { if errno == EINTR { continue }; throw systemError("write lock metadata") }
            offset += count
        }
    }
    try emit(["status": "locked", "protocolVersion": 1])
    var byte: UInt8 = 0
    while read(STDIN_FILENO, &byte, 1) < 0 {
        if errno != EINTR { throw systemError("read lock lease pipe") }
    }
    // Never unlink .consumer.lock; replacing its inode could admit two owners.
}

func versionOne(_ value: Any?) -> Bool {
    guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else { return false }
    return number.doubleValue == 1
}

func trueBoolean(_ value: Any?) -> Bool {
    guard let number = value as? NSNumber, CFGetTypeID(number) == CFBooleanGetTypeID() else { return false }
    return number.boolValue
}

func timestamp(_ value: Any?) -> Double? {
    guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(),
          number.doubleValue.isFinite, number.doubleValue > 0 else { return nil }
    return number.doubleValue
}

func safeID(_ name: String) -> Bool {
    let bytes = Array(name.utf8)
    func alphanumeric(_ byte: UInt8) -> Bool { (48...57).contains(byte) || (65...90).contains(byte) || (97...122).contains(byte) }
    return !bytes.isEmpty && bytes.count <= 128 && alphanumeric(bytes[0])
        && bytes.allSatisfy { alphanumeric($0) || [45, 46, 95].contains($0) }
}

func acknowledged(_ receipt: [String: Any], shareID: String) -> Bool {
    versionOne(receipt["version"]) && trueBoolean(receipt["accepted"])
        && receipt["shareId"] as? String == shareID
        && !(receipt["sessionId"] as? String ?? "").isEmpty
        && !(receipt["requestId"] as? String ?? "").isEmpty
        && timestamp(receipt["acknowledgedAt"]) != nil
}

func packageMatches(_ path: String, receipt: [String: Any]) throws -> Bool {
    guard let info = try fileInfo(path) else { return false }
    guard info.st_mode & S_IFMT == S_IFDIR else {
        throw HelperFailure.message("package is not a real directory; preserved")
    }
    let statePath = path + "/.delivery.json"
    if try fileInfo(statePath) == nil, try fileManager.contentsOfDirectory(atPath: path).isEmpty {
        return true // Interrupted cleanup removed the final proof but not its empty directory.
    }
    let state = try readJSON(statePath)
    guard versionOne(state["version"]), trueBoolean(state["accepted"]),
          state["sessionId"] as? String == receipt["sessionId"] as? String,
          state["requestId"] as? String == receipt["requestId"] as? String else {
        throw HelperFailure.message("package has no matching acknowledged delivery; preserved")
    }
    return true
}

// Walk descriptor-relative directories without following symlinks, including nested ones.
func removeEntry(parentFD: Int32, name: String, acceptanceLast: Bool = false) throws {
    var info = stat()
    guard fstatat(parentFD, name, &info, AT_SYMLINK_NOFOLLOW) == 0 else { throw systemError("inspect cleanup entry") }
    if info.st_mode & S_IFMT != S_IFDIR {
        guard unlinkat(parentFD, name, 0) == 0 else { throw systemError("remove cleanup file") }
        return
    }
    let fd = openat(parentFD, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
    guard fd >= 0 else { throw systemError("open cleanup directory") }
    defer { close(fd) }
    var opened = stat()
    guard fstat(fd, &opened) == 0, opened.st_dev == info.st_dev, opened.st_ino == info.st_ino else {
        throw HelperFailure.message("cleanup directory changed; preserved")
    }
    let enumerationFD = dup(fd)
    guard enumerationFD >= 0 else { throw systemError("duplicate cleanup directory") }
    guard let directory = fdopendir(enumerationFD) else { close(enumerationFD); throw systemError("enumerate cleanup directory") }
    defer { closedir(directory) }
    var children: [String] = []
    while true {
        errno = 0
        guard let entry = readdir(directory) else {
            if errno != 0 { throw systemError("read cleanup directory") }
            break
        }
        let child = withUnsafePointer(to: &entry.pointee.d_name) { pointer in
            pointer.withMemoryRebound(to: CChar.self, capacity: Int(entry.pointee.d_namlen) + 1) { String(cString: $0) }
        }
        if child != "." && child != ".." { children.append(child) }
    }
    for child in children.sorted() where !acceptanceLast || child != ".delivery.json" {
        try removeEntry(parentFD: fd, name: child)
    }
    if acceptanceLast && children.contains(".delivery.json") {
        try removeEntry(parentFD: fd, name: ".delivery.json")
    }
    guard unlinkat(parentFD, name, AT_REMOVEDIR) == 0 else { throw systemError("remove cleanup directory") }
}

func cleanup(_ root: String, olderDays: Int, apply: Bool) throws -> [String: Any] {
    guard try fileInfo(root) != nil else {
        return try cleanupLocked(root, olderDays: olderDays, apply: apply)
    }
    let lock = try lockInbox(root)
    defer { close(lock) }
    return try cleanupLocked(root, olderDays: olderDays, apply: apply)
}

// Caller owns .consumer.lock. Uninstall uses this without trying to reacquire its lease.
func cleanupLocked(_ root: String, olderDays: Int, apply: Bool) throws -> [String: Any] {
    var result: [String: Any] = ["mode": apply ? "apply" : "preview", "inbox": root,
        "eligible": [[String: Any]](), "removed": [[String: Any]](), "preserved": [[String: Any]](),
        "pendingPackages": 0, "failedPackages": 0]
    guard try fileInfo(root) != nil else { return result }
    var eligible = [[String: Any]](), removed = [[String: Any]](), preserved = [[String: Any]]()
    let receipts = root + "/.receipts"
    if try fileInfo(receipts) != nil {
        guard try isDirectory(receipts) else { throw HelperFailure.message(".receipts must be a real directory; no cleanup performed") }
        let cutoff = (Date().timeIntervalSince1970 - Double(olderDays) * 86400) * 1000
        for name in try fileManager.contentsOfDirectory(atPath: receipts).sorted() {
            let shareID: String
            if name.hasSuffix(".json") { shareID = String(name.dropLast(5)) }
            else if let marker = name.range(of: ".json.tmp-", options: .backwards),
                    UUID(uuidString: String(name[marker.upperBound...])) != nil {
                shareID = String(name[..<marker.lowerBound])
            } else { shareID = "" }
            do {
                guard safeID(shareID) else { throw HelperFailure.message("unrecognized receipt name") }
                let receipt = try readJSON(receipts + "/" + name)
                guard acknowledged(receipt, shareID: shareID) else { throw HelperFailure.message("not a valid acknowledged receipt") }
                guard olderDays == 0 || timestamp(receipt["acknowledgedAt"])! <= cutoff else { continue }
                let hasPackage = try packageMatches(root + "/" + shareID, receipt: receipt)
                let item: [String: Any] = ["shareId": shareID, "package": hasPackage]
                eligible.append(item)
                if apply {
                    if hasPackage {
                        let parent = open(root, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
                        guard parent >= 0 else { throw systemError("open cleanup inbox") }
                        defer { close(parent) }
                        try removeEntry(parentFD: parent, name: shareID, acceptanceLast: true)
                    }
                    // If package removal failed, keep its receipt as the acknowledgement evidence.
                    guard unlink(receipts + "/" + name) == 0 else { throw systemError("remove completion receipt") }
                    removed.append(item)
                }
            } catch {
                preserved.append(["path": ".receipts/" + name, "reason": String(describing: error)])
            }
        }
        if apply && rmdir(receipts) != 0 && errno != ENOTEMPTY && errno != ENOENT {
            throw systemError("remove empty completion directory")
        }
    }
    result["eligible"] = eligible; result["removed"] = removed; result["preserved"] = preserved
    result["pendingPackages"] = try fileManager.contentsOfDirectory(atPath: root).filter {
        guard !$0.hasPrefix("."), $0 != "failed" else { return false }
        return try isDirectory(root + "/" + $0)
    }.count
    let failed = root + "/failed"
    if try isDirectory(failed) { result["failedPackages"] = try fileManager.contentsOfDirectory(atPath: failed).count }
    return result
}

func updatedProfile(_ path: String, plugin: String) throws -> [String: Any] {
    var manifest = try readJSON(path, limit: 16 * metadataLimit)
    func object(_ value: Any?, field: String) throws -> [String: Any] {
        if value == nil { return [:] }
        guard let result = value as? [String: Any] else { throw HelperFailure.message("profile \(field) must be an object") }
        return result
    }
    var dependencies = try object(manifest["dependencies"], field: "dependencies")
    dependencies["dsh-share"] = "file:" + plugin
    manifest["dependencies"] = dependencies
    var dsh = try object(manifest["dsh"], field: "dsh")
    var profile = try object(dsh["profile"], field: "dsh.profile")
    if profile["bundles"] != nil && !(profile["bundles"] is [Any]) {
        throw HelperFailure.message("profile dsh.profile.bundles must be an array")
    }
    var bundles = profile["bundles"] as? [Any] ?? []
    if !bundles.contains(where: { $0 as? String == "dsh-share" }) { bundles.append("dsh-share") }
    profile["bundles"] = bundles; dsh["profile"] = profile; manifest["dsh"] = dsh
    return manifest
}

@discardableResult
func configureProfile(_ path: String, plugin: String, quiet: Bool = false) throws -> String? {
    let original = try readJSON(path, limit: 16 * metadataLimit) as NSDictionary
    let manifest = try updatedProfile(path, plugin: plugin)
    if original.isEqual(to: manifest) { if !quiet { print("profile manifest unchanged: " + path) }; return nil }
    let data = try JSONSerialization.data(withJSONObject: manifest, options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes])
    let backup = path + ".dsh-share-backup-" + String(Int(Date().timeIntervalSince1970 * 1000)) + "-" + UUID().uuidString
    try fileManager.copyItem(atPath: path, toPath: backup)
    guard chmod(backup, 0o600) == 0 else { throw systemError("protect profile backup") }
    var output = data; output.append(0x0a)
    try output.write(to: URL(fileURLWithPath: path), options: .atomic)
    if !quiet {
        print("profile backup saved: " + backup)
        print("profile manifest updated: " + path)
    }
    return backup
}

struct Arguments {
    let command: String
    var values: [String: String] = [:]
    var flags = Set<String>()
    init(_ args: [String]) throws {
        guard let first = args.first else { throw HelperFailure.usage("expected a helper command") }
        command = first
        let allowed: [String: Set<String>] = [
            "hold": ["--inbox", "--wait-ms", "--parent-pid"],
            "cleanup": ["--inbox", "--older-than-days", "--apply", "--json"],
            "configure-profile": ["--profile", "--plugin"],
            "install-plugin": ["--profile-dir", "--source", "--destination", "--json"],
            "uninstall-plugin": ["--profiles-root", "--profile-dir", "--destination", "--inbox", "--json"],
            "bundle-plugin": ["--source", "--destination"],
        ]
        guard let options = allowed[first] else { throw HelperFailure.usage("unknown command: " + first) }
        var index = 1
        while index < args.count {
            let key = args[index]
            guard options.contains(key), values[key] == nil, !flags.contains(key) else { throw HelperFailure.usage("unknown or duplicate option: " + key) }
            if ["--apply", "--json"].contains(key) { flags.insert(key); index += 1; continue }
            guard index + 1 < args.count else { throw HelperFailure.usage("missing value for " + key) }
            values[key] = args[index + 1]; index += 2
        }
    }
    func required(_ key: String) throws -> String {
        guard let value = values[key], !value.isEmpty else { throw HelperFailure.usage("required option: " + key) }
        return value
    }
    func nonnegative(_ key: String, default fallback: Int) throws -> Int {
        guard let value = values[key] else { return fallback }
        guard let result = Int(value), result >= 0 else { throw HelperFailure.usage(key + " must be zero or greater") }
        return result
    }
}

umask(0o077)
do {
    let raw = Array(CommandLine.arguments.dropFirst())
    if raw == ["--version"] { print(helperVersion); exit(0) }
    if raw.isEmpty || raw.contains("--help") || raw == ["-h"] {
        print("dsh-share-helper \(helperVersion)\n  hold --inbox PATH [--wait-ms 2000] [--parent-pid PID]\n  cleanup [--inbox PATH] [--older-than-days 30] [--apply] [--json]\n  configure-profile --profile PACKAGE_JSON --plugin PLUGIN_DIRECTORY\n  install-plugin --profile-dir DIRECTORY --source DIRECTORY [--destination DIRECTORY] [--json]\n  uninstall-plugin [--profiles-root DIRECTORY] [--profile-dir DIRECTORY] [--destination DIRECTORY] [--inbox PATH] [--json]")
        exit(0)
    }
    let args = try Arguments(raw)
    if args.command == "bundle-plugin" {
        try bundlePlugin(source: args.required("--source"), destination: args.required("--destination"))
    } else if args.command == "install-plugin" {
        let result = try installPlugin(profileDirectory: args.required("--profile-dir"),
                                       source: args.required("--source"), destination: args.values["--destination"])
        if args.flags.contains("--json") { try emit(result) }
        else { print("plugin installed: \(result["pluginDirectory"]!)\nprofile manifest: \(result["profileManifest"]!)") }
    } else if args.command == "uninstall-plugin" {
        let result = try uninstallPlugin(profileRoot: args.values["--profiles-root"],
            profileDirectory: args.values["--profile-dir"], destination: args.values["--destination"], inbox: args.values["--inbox"])
        if args.flags.contains("--json") { try emit(result) }
        else { print("DSH Share receiver uninstalled. Completed transfers are cleared; unfinished transfers and configuration backups are retained.") }
    } else if args.command == "configure-profile" {
        try configureProfile(args.required("--profile"), plugin: args.required("--plugin"))
    } else {
        let fallback = fileManager.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/DSHShare/inbox").path
        let path = args.values["--inbox"] ?? ProcessInfo.processInfo.environment["DSH_SHARE_INBOX"] ?? fallback
        let root = URL(fileURLWithPath: (path as NSString).expandingTildeInPath).standardizedFileURL.resolvingSymlinksInPath().path
        if args.command == "hold" {
            try holdInbox(root, waitMS: args.nonnegative("--wait-ms", default: 2000),
                          parentPID: args.nonnegative("--parent-pid", default: Int(getppid())))
        } else {
            let result = try cleanup(root, olderDays: args.nonnegative("--older-than-days", default: 0), apply: args.flags.contains("--apply"))
            if args.flags.contains("--json") { try emit(result) }
            else {
                print("Mode: \(result["mode"]!)\nInbox: \(root)")
                let eligible = result["eligible"] as! [[String: Any]]
                print("Eligible acknowledged records: \(eligible.count)")
                for item in eligible { print("  \(item["shareId"]!) (\((item["package"] as! Bool) ? "receipt + acknowledged package" : "receipt"))") }
                print("Removed: \((result["removed"] as! [Any]).count)\nRetained pending/unconfirmed packages: \(result["pendingPackages"]!)\nRetained failed packages: \(result["failedPackages"]!)\nPreserved ambiguous records: \((result["preserved"] as! [Any]).count)")
                if !args.flags.contains("--apply") { print("Preview only. Add --apply to remove only the eligible completion data.") }
            }
        }
    }
} catch {
    FileHandle.standardError.write(Data(("Inbox operation stopped: \(error)\n").utf8))
    switch error {
    case HelperFailure.busy, HelperFailure.installationBusy: exit(75)
    case HelperFailure.usage: exit(2)
    default: exit(1)
    }
}
