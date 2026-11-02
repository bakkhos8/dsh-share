import Foundation
import CoreFoundation
import Darwin

enum SetupChecks {
    enum Receiver: String, Codable { case ready, notInstalled, harnessClosed, inactive, otherProfile, unknown }
    enum Sharing: String, Codable { case ready, disabled, notRegistered, otherCopy, unknown }
    struct Snapshot: Codable {
        var receiver: Receiver
        var sharing: Sharing
        var isReady: Bool { receiver == .ready && sharing == .ready }
        var requiresInstallation: Bool { receiver == .notInstalled || sharing == .notRegistered || sharing == .otherCopy }
    }
    static let extensionID = "com.movy.dshshare.host.share"

    private static func canonical(_ url: URL) -> String {
        url.standardizedFileURL.resolvingSymlinksInPath().path
    }
    private static func object(_ fd: Int32, limit: Int) throws -> [String: Any] {
        var info = stat()
        guard fstat(fd, &info) == 0, info.st_mode & S_IFMT == S_IFREG, info.st_size <= limit else {
            throw CocoaError(.fileReadCorruptFile)
        }
        let handle = FileHandle(fileDescriptor: fd, closeOnDealloc: false)
        let data = try handle.read(upToCount: limit + 1) ?? Data()
        guard data.count <= limit,
              let value = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw CocoaError(.fileReadCorruptFile)
        }
        return value
    }
    private static func object(_ url: URL, limit: Int) throws -> [String: Any] {
        let fd = open(url.path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
        guard fd >= 0 else { throw CocoaError(.fileReadUnknown) }
        defer { close(fd) }
        return try object(fd, limit: limit)
    }
    private static func positiveInteger(_ value: Any?) -> Int32? {
        guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(),
              number.doubleValue.isFinite, number.doubleValue.rounded() == number.doubleValue,
              number.doubleValue > 0, number.doubleValue <= Double(Int32.max) else { return nil }
        return number.int32Value
    }
    private static func executable(_ pid: Int32) -> String? {
        var bytes = [CChar](repeating: 0, count: 4 * Int(MAXPATHLEN))
        guard proc_pidpath(pid, &bytes, UInt32(bytes.count)) > 0 else { return nil }
        return canonical(URL(fileURLWithPath: String(cString: bytes)))
    }
    private static func workingDirectory(_ pid: Int32) -> String? {
        var info = proc_vnodepathinfo()
        let size = MemoryLayout<proc_vnodepathinfo>.size
        guard proc_pidinfo(pid, PROC_PIDVNODEPATHINFO, 0, &info, Int32(size)) == size else { return nil }
        return withUnsafePointer(to: &info.pvi_cdir.vip_path) {
            $0.withMemoryRebound(to: CChar.self, capacity: Int(MAXPATHLEN)) {
                canonical(URL(fileURLWithPath: String(cString: $0)))
            }
        }
    }

    // Read-only: never creates a lock, consumes a share, or changes Harness settings.
    static func receiver(profile: URL?, inbox: URL, harnessRunning: Bool,
                         hostExecutable: URL?, fallbackHelper: URL) -> Receiver {
        guard let profile,
              FileManager.default.fileExists(atPath: profile.appendingPathComponent("package.json").path) else { return .notInstalled }
        do {
            let manifest = try object(profile.appendingPathComponent("package.json"), limit: 16 * 1024 * 1024)
            let dependencies = manifest["dependencies"] as? [String: Any]
            let settings = (manifest["dsh"] as? [String: Any])?["profile"] as? [String: Any]
            guard dependencies?["dsh-macos-share"] is String,
                  (settings?["bundles"] as? [String])?.contains("dsh-macos-share") == true else { return .notInstalled }
            let plugin = profile.appendingPathComponent("node_modules/dsh-macos-share")
            guard FileManager.default.fileExists(atPath: plugin.appendingPathComponent("package.json").path) else { return .notInstalled }
            guard try object(plugin.appendingPathComponent("package.json"), limit: 1024 * 1024)["name"] as? String == "dsh-macos-share" else { return .notInstalled }
            guard harnessRunning else { return .harnessClosed }
            guard let hostExecutable else { return .unknown }
            var expectedHelper = fallbackHelper
            let marker = plugin.appendingPathComponent(".installation.json")
            if FileManager.default.fileExists(atPath: marker.path) {
                let record = try object(marker, limit: 16 * 1024)
                guard positiveInteger(record["formatVersion"]) == 1,
                      let path = record["helperPath"] as? String, path.hasPrefix("/") else { return .unknown }
                expectedHelper = URL(fileURLWithPath: path)
            }
            let fd = open(inbox.appendingPathComponent(".consumer.lock").path,
                          O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
            if fd < 0 { return errno == ENOENT ? .inactive : .unknown }
            defer { close(fd) }
            var info = stat()
            guard fstat(fd, &info) == 0, info.st_mode & S_IFMT == S_IFREG, info.st_nlink == 1 else { return .unknown }
            if flock(fd, LOCK_EX | LOCK_NB) == 0 { return .inactive }
            guard errno == EWOULDBLOCK || errno == EAGAIN else { return .unknown }
            let owner = try object(fd, limit: 4096)
            guard positiveInteger(owner["version"]) == 1,
                  let pid = positiveInteger(owner["pid"]), let helperPID = positiveInteger(owner["helperPid"]),
                  kill(pid, 0) == 0, kill(helperPID, 0) == 0,
                  executable(pid) == canonical(hostExecutable),
                  executable(helperPID) == canonical(expectedHelper) else { return .unknown }
            var helper = proc_bsdinfo()
            let size = MemoryLayout<proc_bsdinfo>.size
            guard proc_pidinfo(helperPID, PROC_PIDTBSDINFO, 0, &helper, Int32(size)) == size,
                  helper.pbi_ppid == UInt32(pid), let cwd = workingDirectory(pid) else { return .unknown }
            return cwd == canonical(profile) ? .ready : .otherProfile
        } catch { return .unknown }
    }

    static func sharing(registry: String?, extensionURL: URL, serviceAvailable: Bool) -> Sharing {
        guard let registry else { return .unknown }
        let entries = registry.components(separatedBy: .newlines).map {
            $0.trimmingCharacters(in: .whitespaces)
        }.filter { $0.contains(extensionID + "(") }
        guard !entries.isEmpty else { return .notRegistered }
        let expected = canonical(extensionURL)
        guard let entry = entries.first(where: { line in
            guard let path = line.range(of: "\t/", options: .backwards) else { return false }
            return canonical(URL(fileURLWithPath: String(line[line.index(after: path.lowerBound)...]))) == expected
        }) else { return .otherCopy }
        if entry.first == "-" { return .disabled }
        if entry.first == "=" { return .otherCopy }
        if entry.first == "?" || entry.first == "!" { return .unknown }
        // PlugInKit elections alone do not include the Share host's restrictions.
        return serviceAvailable ? .ready : .disabled
    }

    static func registryReport(command: URL = URL(fileURLWithPath: "/usr/bin/pluginkit"), timeout: TimeInterval = 2) -> String? {
        let process = Process(), output = Pipe(), ended = DispatchSemaphore(value: 0)
        process.executableURL = command
        process.arguments = ["-m", "-v", "-i", extensionID]
        process.standardOutput = output; process.standardError = FileHandle.nullDevice
        process.terminationHandler = { _ in ended.signal() }
        do { try process.run() } catch { return nil }
        guard ended.wait(timeout: .now() + timeout) == .success else {
            if process.isRunning { process.terminate() }
            if ended.wait(timeout: .now() + 0.5) != .success && process.isRunning {
                kill(process.processIdentifier, SIGKILL)
            }
            return nil
        }
        guard process.terminationStatus == 0 else { return nil }
        let data = output.fileHandleForReading.readDataToEndOfFile()
        guard data.count <= 16 * 1024 else { return nil }
        return String(data: data, encoding: .utf8)
    }
}
