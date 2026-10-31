import Foundation

@main
struct SetupChecksFixture {
    static func main() throws {
        let args = Array(CommandLine.arguments.dropFirst())
        guard let mode = args.first, args.count % 2 == 1 else { throw CocoaError(.fileReadInvalidFileName) }
        var options: [String: String] = [:]
        for index in stride(from: 1, to: args.count, by: 2) { options[args[index]] = args[index + 1] }
        func url(_ key: String) -> URL { URL(fileURLWithPath: options[key] ?? "/missing-fixture") }
        let result: [String: Any]
        switch mode {
        case "activation":
            var primaryReply: ((Error?) -> Void)?
            var fallbackReply: ((Error?) -> Void)?
            var events: [String] = []
            var message: String?
            let failure = CocoaError(.executableNotLoadable)
            HarnessActivation.finishAfterOpening(primary: { callback in
                events.append("open-url")
                primaryReply = callback
            }, fallback: { callback in
                events.append("open-app")
                fallbackReply = callback
            }, complete: {
                events.append("complete")
            }, cancel: { error in
                events.append("cancel")
                message = error.localizedDescription
            })
            let beforeReply = events
            primaryReply?(options["--primary"] == "success" ? nil : failure)
            let afterPrimary = events
            fallbackReply?(options["--fallback"] == "success" ? nil : failure)
            // Even duplicate API callbacks cannot complete/cancel the request twice.
            primaryReply?(nil)
            fallbackReply?(failure)
            result = ["beforeReply": beforeReply, "afterPrimary": afterPrimary, "events": events,
                      "message": message ?? ""]
        case "receiver":
            result = ["receiver": SetupChecks.receiver(profile: options["--profile"].map { URL(fileURLWithPath: $0) },
                inbox: url("--inbox"), harnessRunning: options["--harness-running"] == "yes",
                hostExecutable: options["--host-executable"].map { URL(fileURLWithPath: $0) }, fallbackHelper: url("--helper")).rawValue]
        case "sharing":
            let report = try options["--report"].map { try String(contentsOfFile: $0, encoding: .utf8) }
            result = ["sharing": SetupChecks.sharing(registry: report, extensionURL: url("--extension"),
                serviceAvailable: options["--service-available"] == "yes").rawValue]
        case "registry":
            let report = SetupChecks.registryReport(command: url("--command"), timeout: 0.2)
            result = ["available": report != nil]
        default: throw CocoaError(.fileReadInvalidFileName)
        }
        let data = try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys])
        FileHandle.standardOutput.write(data)
    }
}
