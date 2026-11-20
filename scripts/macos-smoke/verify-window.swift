import AppKit
import CoreGraphics

func verifyWindow(appPath: String, previousPID: Int32) -> Int32 {
    let expectedPath = URL(fileURLWithPath: appPath).resolvingSymlinksInPath().path
    var sawProcess = false

    let deadline = ProcessInfo.processInfo.systemUptime + 30
    while ProcessInfo.processInfo.systemUptime < deadline {
        let launchedApp = NSWorkspace.shared.runningApplications.first {
            $0.processIdentifier != previousPID && $0.bundleURL?.resolvingSymlinksInPath().path == expectedPath
        }

        if let app = launchedApp {
            sawProcess = true
            let windows = CGWindowListCopyWindowInfo(
                [.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID
            ) as? [[String: Any]] ?? []
            for window in windows {
                guard let owner = window[kCGWindowOwnerPID as String] as? NSNumber,
                      owner.int32Value == app.processIdentifier,
                      let layer = window[kCGWindowLayer as String] as? NSNumber,
                      layer.intValue == 0,
                      let bounds = window[kCGWindowBounds as String] as? [String: NSNumber],
                      let width = bounds["Width"]?.intValue,
                      let height = bounds["Height"]?.intValue,
                      width >= 320, height >= 200 else { continue }
                print(owner.int32Value)
                return 0
            }
        }
        Thread.sleep(forTimeInterval: 0.5)
    }
    let reason = !sawProcess ? "no matching FineShell process" : "no visible FineShell window"
    FileHandle.standardError.write(Data("Startup verification failed: \(reason).\n".utf8))
    return 1
}

guard CommandLine.arguments.count == 3, let previousPID = Int32(CommandLine.arguments[2]) else {
    FileHandle.standardError.write(Data("Usage: verify-window /path/to/FineShell.app previous-pid\n".utf8))
    exit(2)
}

exit(verifyWindow(appPath: CommandLine.arguments[1], previousPID: previousPID))
