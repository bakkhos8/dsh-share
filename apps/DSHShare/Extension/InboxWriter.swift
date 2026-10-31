import Foundation
import Darwin
import OSLog

enum ShareLog {
    static let logger = Logger(subsystem: "com.movy.dshshare", category: "share")
}

enum ShareFailure {
    static func error(_ message: String) -> NSError {
        NSError(domain: "com.movy.dshshare", code: 1,
                userInfo: [NSLocalizedDescriptionKey: message])
    }
}

/// Only the final rename publishes a complete package to the host plugin.
enum InboxWriter {
    static let maxItemBytes: Int64 = 256 * 1024 * 1024

    static func inboxBase() throws -> URL {
        try accountHomeDirectory()
            .appendingPathComponent("Library/Application Support/DSHShare/inbox", isDirectory: true)
    }

    static func accountHomeDirectory() throws -> URL {
        // Foundation's current-user home is the container in a sandboxed process.
        // Resolve the actual account home; the home-relative entitlement grants access.
        var account = passwd()
        var result: UnsafeMutablePointer<passwd>?
        var buffer = [CChar](repeating: 0, count: 16 * 1024)
        let home: String? = buffer.withUnsafeMutableBufferPointer { storage in
            guard getpwuid_r(getuid(), &account, storage.baseAddress, storage.count, &result) == 0,
                  result != nil, let directory = account.pw_dir else { return nil }
            return String(cString: directory)
        }
        guard let home, home.hasPrefix("/") else {
            throw ShareFailure.error("无法确定分享收件箱的位置。")
        }
        return URL(fileURLWithPath: home, isDirectory: true)
    }

    static func makeScratchDirectory() throws -> URL {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("DSHShare-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true,
                                                attributes: [.posixPermissions: 0o700])
        return directory
    }

    /// NSItemProvider may remove its file when its callback returns; copy inside it.
    static func stageCopy(_ source: URL, in directory: URL) throws -> URL {
        let fm = FileManager.default
        let scoped = source.startAccessingSecurityScopedResource()
        defer { if scoped { source.stopAccessingSecurityScopedResource() } }
        let values = try source.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey])
        guard values.isRegularFile == true else {
            throw ShareFailure.error("请选择普通文件；暂不支持分享文件夹。")
        }
        guard Int64(values.fileSize ?? 0) <= maxItemBytes else {
            throw ShareFailure.error("单个分享文件不能超过 256 MiB。")
        }
        let destination = directory.appendingPathComponent(UUID().uuidString)
        try fm.copyItem(at: source, to: destination)
        return destination
    }

    @discardableResult
    static func write(_ payloads: [SharePayload]) throws -> URL {
        guard !payloads.isEmpty else { throw ShareFailure.error("没有可分享的内容。") }
        let base = try inboxBase()
        let fm = FileManager.default
        let id = UUID().uuidString
        let staging = base.appendingPathComponent(".tmp-\(id)", isDirectory: true)
        let final = base.appendingPathComponent(id, isDirectory: true)
        try fm.createDirectory(at: staging, withIntermediateDirectories: true,
                               attributes: [.posixPermissions: 0o700])
        defer { try? fm.removeItem(at: staging) }

        var items: [[String: Any]] = []
        var urls: [String] = []
        var texts: [String] = []
        for payload in payloads {
            switch payload.kind {
            case .file, .image:
                guard let source = payload.fileURL else {
                    throw ShareFailure.error("分享附件未能读取，请重试。")
                }
                let fileName = "\(items.count).bin"
                try fm.copyItem(at: source, to: staging.appendingPathComponent(fileName))
                items.append(["kind": payload.kind.rawValue, "name": payload.name, "file": fileName])
            case .url:
                if let value = payload.url, !value.isEmpty { urls.append(value) }
            case .text:
                if let value = payload.text, !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    texts.append(value)
                }
            }
        }
        guard !items.isEmpty || !urls.isEmpty || !texts.isEmpty else {
            throw ShareFailure.error("没有可分享的内容。")
        }
        let manifest: [String: Any] = [
            "version": 1,
            "createdAt": Int(Date().timeIntervalSince1970),
            "text": texts.joined(separator: "\n\n"),
            "urls": urls,
            "items": items,
        ]
        let data = try JSONSerialization.data(withJSONObject: manifest, options: [.prettyPrinted, .sortedKeys])
        try data.write(to: staging.appendingPathComponent("manifest.json"), options: .atomic)
        try fm.moveItem(at: staging, to: final)
        return final
    }
}
