import Foundation

/// Finish only after launch is confirmed. The caller delivers attempt callbacks on the main queue.
enum HarnessActivation {
    static let failureMessage = "无法打开 DeepSeek Harness。分享内容已暂存，请手动打开应用后继续，无需重复分享。"

    static func finishAfterOpening(
        primary: (@escaping (Error?) -> Void) -> Void,
        fallback: @escaping (@escaping (Error?) -> Void) -> Void,
        complete: @escaping () -> Void,
        cancel: @escaping (Error) -> Void
    ) {
        var primaryHandled = false
        var settled = false
        primary { error in
            guard !primaryHandled else { return }
            primaryHandled = true
            if error == nil {
                settled = true
                complete()
                return
            }
            fallback { error in
                guard !settled else { return }
                settled = true
                if let error {
                    cancel(NSError(domain: "DSHShare.Activation", code: 1, userInfo: [
                        NSLocalizedDescriptionKey: failureMessage,
                        NSUnderlyingErrorKey: error,
                    ]))
                } else {
                    complete()
                }
            }
        }
    }
}
