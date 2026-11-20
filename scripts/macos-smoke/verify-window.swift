import AppKit
import CoreGraphics

func verifyWindow(appPath: String) -> Int32 {
    let expectedPath = URL(fileURLWithPath: appPath).resolvingSymlinksInPath().path
    var launchedApp: NSRunningApplication?
    defer { launchedApp?.terminate() }

    let deadline = ProcessInfo.processInfo.systemUptime + 30
    while ProcessInfo.processInfo.systemUptime < deadline {
        launchedApp = NSWorkspace.shared.runningApplications.first {
            $0.bundleURL?.resolvingSymlinksInPath().path == expectedPath
        } ?? launchedApp

        if let app = launchedApp {
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
                print("FineShell opened a visible desktop window (\(width)x\(height), PID \(owner.int32Value)).")
                return 0
            }
        }
        Thread.sleep(forTimeInterval: 0.5)
    }
    let reason = launchedApp == nil ? "no matching FineShell process" : "no visible FineShell window"
    FileHandle.standardError.write(Data("Startup verification failed: \(reason).\n".utf8))
    return 1
}

guard CommandLine.arguments.count == 2 else {
    FileHandle.standardError.write(Data("Usage: verify-window /path/to/FineShell.app\n".utf8))
    exit(2)
}

exit(verifyWindow(appPath: CommandLine.arguments[1]))
