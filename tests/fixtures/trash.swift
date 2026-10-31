import Foundation
@main
struct TrashFixture {
    static func main() throws {
        guard CommandLine.arguments.count == 2 else { fatalError("expected a disposable fixture") }
        let app = URL(fileURLWithPath: CommandLine.arguments[1]).resolvingSymlinksInPath()
        let temp = FileManager.default.temporaryDirectory.resolvingSymlinksInPath().path
        let prefix = temp.hasSuffix("/") ? temp : temp + "/"
        guard app.path.hasPrefix(prefix), app.lastPathComponent == "DSH Share uninstall fixture.app",
              try String(contentsOf: app.appendingPathComponent("test-marker"), encoding: .utf8) == "DSH_SHARE_UNINSTALL_TEST" else {
            fatalError("refusing to trash anything except the disposable test fixture")
        }
        let trashed = try SetupInstaller.moveToTrash(app)
        defer {
            if FileManager.default.fileExists(atPath: trashed.path), !FileManager.default.fileExists(atPath: app.path) {
                try? FileManager.default.moveItem(at: trashed, to: app)
            }
        }
        guard !FileManager.default.fileExists(atPath: app.path),
              FileManager.default.fileExists(atPath: trashed.appendingPathComponent("test-marker").path) else {
            fatalError("fixture did not move to Trash")
        }
        try FileManager.default.moveItem(at: trashed, to: app)
        print("{\"trashedAndRestored\":true}")
    }
}
