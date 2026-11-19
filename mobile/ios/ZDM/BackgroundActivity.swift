import Foundation
import UIKit
import UserNotifications

/** Keeps transfers alive while the app is backgrounded and reports completion as a local notification. */
final class BackgroundActivity {
    static let shared = BackgroundActivity()

    private var task: UIBackgroundTaskIdentifier = .invalid
    private let lock = NSLock()
    private var notified = false

    private init() {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { _, _ in }
    }

    func begin() {
        lock.lock()
        if task == .invalid {
            task = UIApplication.shared.beginBackgroundTask(withName: "ZDM transfer") { [weak self] in
                self?.end()
            }
        }
        lock.unlock()
    }

    func endIfIdle(active: Int) {
        if active == 0 { end() }
    }

    func notifyCompletion(filename: String) {
        lock.lock()
        guard !notified else { lock.unlock(); return }
        notified = true
        lock.unlock()
        let content = UNMutableNotificationContent()
        content.title = "ZDM download complete"
        content.body = filename
        content.sound = .default
        let request = UNNotificationRequest(identifier: "zdm-\(UUID().uuidString)", content: content, trigger: nil)
        UNUserNotificationCenter.current().add(request) { [weak self] _ in
            self?.lock.lock(); self?.notified = false; self?.lock.unlock()
        }
    }

    private func end() {
        lock.lock()
        guard task != .invalid else { lock.unlock(); return }
        let current = task
        task = .invalid
        lock.unlock()
        UIApplication.shared.endBackgroundTask(current)
    }
}
