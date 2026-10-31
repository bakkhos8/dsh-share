import AppKit
import UniformTypeIdentifiers
import OSLog

struct SharePayload {
    enum Kind: String { case file, image, text, url }
    var kind: Kind
    var name: String
    var text: String?
    var url: String?
    /// All binary items have been copied while the provider's callback is valid.
    var fileURL: URL?
}

/// A short-lived, headless share target. Completion means the inbox package exists.
final class ShareViewController: NSViewController {
    private var finished = false
    private var timeout: DispatchWorkItem?
    private var progress: [Progress] = []

    override func loadView() {
        view = NSView(frame: NSRect(x: 0, y: 0, width: 120, height: 40))
    }

    override func beginRequest(with context: NSExtensionContext) {
        finished = false
        let items = (context.inputItems as? [NSExtensionItem]) ?? []
        let providers = items.flatMap { $0.attachments ?? [] }
        // Some Services supply selected text on the item instead of an attachment.
        let itemText = items.compactMap { $0.attributedContentText?.string }
            .filter { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

        let scratch: URL
        do { scratch = try InboxWriter.makeScratchDirectory() }
        catch { finish(context, error: error); return }

        var results = [Int: SharePayload]()
        var failures: [Error] = []
        let group = DispatchGroup()
        let resultLock = NSLock()
        // Only collection is timed out. Never report success for a partial payload.
        let timeout = DispatchWorkItem { [weak self] in
            self?.finish(context, error: ShareFailure.error("读取分享内容超时，请重试。"))
        }
        self.timeout = timeout
        DispatchQueue.main.asyncAfter(deadline: .now() + 15, execute: timeout)

        for (index, provider) in providers.enumerated() {
            group.enter()
            if let task = load(provider: provider, scratch: scratch, completion: { result in
                resultLock.lock()
                switch result {
                case .success(let payload): results[index] = payload
                case .failure(let error): failures.append(error)
                }
                resultLock.unlock()
                group.leave()
            }) { progress.append(task) }
        }

        group.notify(queue: .main) { [weak self] in
            guard let self, !self.finished else {
                try? FileManager.default.removeItem(at: scratch)
                return
            }
            self.timeout?.cancel()
            self.progress.removeAll()
            if let error = failures.first {
                try? FileManager.default.removeItem(at: scratch)
                self.finish(context, error: error)
                return
            }
            var payloads = results.keys.sorted().compactMap { results[$0] }
            if !payloads.contains(where: { $0.kind == .text }) {
                payloads += itemText.map { SharePayload(kind: .text, name: "", text: $0) }
            }
            let collectedPayloads = payloads
            // File copies must not block the extension's main run loop.
            DispatchQueue.global(qos: .userInitiated).async {
                let result = Result { try InboxWriter.write(collectedPayloads) }
                try? FileManager.default.removeItem(at: scratch)
                DispatchQueue.main.async {
                    switch result {
                    case .success: self.finish(context)
                    case .failure(let error): self.finish(context, error: error)
                    }
                }
            }
        }
    }

    private func load(provider: NSItemProvider, scratch: URL,
                      completion: @escaping (Result<SharePayload, Error>) -> Void) -> Progress? {
        if provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) {
            provider.loadItem(forTypeIdentifier: UTType.fileURL.identifier, options: nil) { item, error in
                completion(Result {
                    if let error { throw error }
                    guard let url = Self.url(from: item), url.isFileURL else {
                        throw ShareFailure.error("未能读取分享文件的位置。")
                    }
                    let staged = try InboxWriter.stageCopy(url, in: scratch)
                    return SharePayload(kind: .file, name: url.lastPathComponent, fileURL: staged)
                })
            }
            return nil
        }
        if provider.hasItemConformingToTypeIdentifier(UTType.url.identifier) {
            provider.loadItem(forTypeIdentifier: UTType.url.identifier, options: nil) { item, error in
                completion(Result {
                    if let error { throw error }
                    guard let url = Self.url(from: item) else { throw ShareFailure.error("未能读取分享链接。") }
                    return SharePayload(kind: .url, name: "", url: url.absoluteString)
                })
            }
            return nil
        }
        if provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier) {
            provider.loadItem(forTypeIdentifier: UTType.plainText.identifier, options: nil) { item, error in
                completion(Result {
                    if let error { throw error }
                    let text: String?
                    if let string = item as? String { text = string }
                    else if let data = item as? Data { text = String(data: data, encoding: .utf8) }
                    else if let attributed = item as? NSAttributedString { text = attributed.string }
                    else { text = nil }
                    guard let text else { throw ShareFailure.error("未能读取分享文本。") }
                    return SharePayload(kind: .text, name: "", text: text)
                })
            }
            return nil
        }
        let image = provider.hasItemConformingToTypeIdentifier(UTType.image.identifier)
        let type = image ? UTType.image : UTType.data
        if provider.hasItemConformingToTypeIdentifier(type.identifier) {
            return provider.loadFileRepresentation(forTypeIdentifier: type.identifier) { url, error in
                completion(Result {
                    if let error { throw error }
                    guard let url else { throw ShareFailure.error("未能读取分享附件。") }
                    let staged = try InboxWriter.stageCopy(url, in: scratch)
                    let name = provider.suggestedName ?? url.lastPathComponent
                    return SharePayload(kind: image ? .image : .file, name: name, fileURL: staged)
                })
            }
        }
        completion(.failure(ShareFailure.error("此分享条目的类型暂不受支持。")))
        return nil
    }

    private static func url(from item: NSSecureCoding?) -> URL? {
        if let url = item as? URL { return url }
        if let data = item as? Data { return URL(dataRepresentation: data, relativeTo: nil) }
        if let string = item as? String { return URL(string: string) }
        return nil
    }

    private func finish(_ context: NSExtensionContext, error: Error? = nil) {
        guard !finished else { return }
        finished = true
        timeout?.cancel()
        progress.forEach { $0.cancel() }
        progress.removeAll()
        if let error {
            let failure = error as NSError
            ShareLog.logger.error("share_cancelled domain=\(failure.domain, privacy: .public) code=\(failure.code)")
            context.cancelRequest(withError: error)
            return
        }
        // A URL request being accepted is not confirmation that the app opened.
        // Keep the extension alive until launch finishes, then report any failure
        // to the source application without removing the already queued content.
        HarnessActivation.finishAfterOpening(primary: { callback in
            NSWorkspace.shared.open(URL(string: "dsh://open")!, configuration: .init()) { app, error in
                DispatchQueue.main.async {
                    callback(error ?? (app == nil ? CocoaError(.executableNotLoadable) : nil))
                }
            }
        }, fallback: { callback in
            let workspace = NSWorkspace.shared
            let candidates = [workspace.urlForApplication(withBundleIdentifier: "com.deepseek.dsh"),
                URL(fileURLWithPath: "/Applications/DeepSeek Harness.app"),
                (try? InboxWriter.accountHomeDirectory())?.appendingPathComponent("Applications/DeepSeek Harness.app")]
            guard let app = candidates.compactMap({ $0 }).first(where: {
                Bundle(url: $0)?.bundleIdentifier == "com.deepseek.dsh"
            }) else {
                callback(CocoaError(.fileNoSuchFile))
                return
            }
            workspace.openApplication(at: app, configuration: .init()) { app, error in
                DispatchQueue.main.async {
                    callback(error ?? (app == nil ? CocoaError(.executableNotLoadable) : nil))
                }
            }
        }, complete: {
            context.completeRequest(returningItems: [], completionHandler: nil)
        }, cancel: { error in
            ShareLog.logger.error("share_activation_failed; queued content retained")
            context.cancelRequest(withError: error)
        })
    }
}
