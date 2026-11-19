import Foundation
import UIKit
import CryptoKit

private let minBlock: Int64 = 2 * 1024 * 1024
private let bufferSize = 64 * 1024
private let maxHtml = 2 * 1024 * 1024

private final class Block {
    let start: Int64
    let end: Int64
    var done: Int64 = 0
    init(_ start: Int64, _ end: Int64) { self.start = start; self.end = end }
}

private final class Item {
    let id: String
    var url: String
    var filename: String
    let checksum: String?
    let mirrors: [String]
    let category: String
    let description: String
    let scheduledAt: Date?
    let outputFormat: String?
    let extractFormat: String?
    var status = "queued"
    var error: String?
    var total: Int64 = 0
    var downloaded: Int64 = 0
    var blocks: [Block] = []
    var cancelled = false
    var active = false
    var generation = 0
    var needsReview = false
    var speed: Double = 0
    var lastSpeedAt: Date?
    var windowBytes: Int64 = 0
    var createdAt = Date()
    var tasks: [Int: URLSessionDataTask] = [:]

    init(id: String, url: String, filename: String, checksum: String?, mirrors: [String], category: String,
         description: String, scheduledAt: Date?, outputFormat: String?, extractFormat: String?) {
        self.id = id; self.url = url; self.filename = filename; self.checksum = checksum
        self.mirrors = mirrors; self.category = category; self.description = description
        self.scheduledAt = scheduledAt; self.outputFormat = outputFormat; self.extractFormat = extractFormat
        self.status = scheduledAt == nil ? "queued" : "scheduled"
    }
}

/// Native implementation of the desktop bridge surface for iOS: segmented downloads plus the settings, scheduling,
/// clipboard, media-discovery and review methods used by the shared renderer.
final class DownloadService {
    static let shared = DownloadService()

    private let lock = NSLock()
    private var items: [String: Item] = [:]
    private var activeCount = 0
    private let maxConcurrentKey = "maxConcurrent"
    private let root: URL
    private var stateURL: URL { root.appendingPathComponent("state.json") }
    private var outURL: URL { root.appendingPathComponent("out", isDirectory: true) }
    private var settings: [String: Any]

    private let defaults: [String: Any] = [
        "defaultDirectory": "App documents", "maxConcurrent": 4, "connections": 16, "speedLimitKbps": 0,
        "notifyOnComplete": true, "revealOnComplete": false, "confirmBrowserDownloads": true,
        "watchClipboard": false, "closeToTray": false, "launchAtLogin": false, "http2": true,
        "adaptive": true, "verifyHashes": true, "workerThreads": true, "directWrite": false,
        "memoryBudgetMb": 256, "categoryDirectories": [:]
    ]

    private init() {
        let documents = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        root = documents.appendingPathComponent("zdm", isDirectory: true)
        try? FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        try? FileManager.default.createDirectory(at: outURL, withIntermediateDirectories: true)
        settings = defaults
        load()
    }

    // MARK: - bridge

    func handle(method: String, payload: [String: Any]) -> [String: Any] {
        switch method {
        case "status", "snapshot": return snapshot()
        case "downloads", "add": return add(payload)
        case "control", "action": return action(payload)
        case "formats": return formats(payload)
        case "review": return review(payload)
        case "settings": return updateSettings(payload)
        case "clipboard": return ok(UIPasteboard.general.string ?? "")
        case "chooseDirectory": return ok(outURL.path)
        case "integration": return ok(["browsers": [], "extensionPath": "", "connectionError":
            "Browser extensions use native messaging and cannot run on mobile. Paste a link or use the share sheet.", "port": 0])
        case "browserSetup", "registerBrowser", "registerCustom", "removeCustom":
            return ok("Mobile builds do not have desktop browser extensions; use the share sheet or paste a link.")
        case "openProgress", "closeProgress", "resizeProgress", "about": return ok(true)
        default: return failure("Unsupported method: \(method)")
        }
    }

    private func ok(_ value: Any) -> [String: Any] { return ["ok": true, "value": value] }
    private func failure(_ message: String) -> [String: Any] { return ["ok": false, "error": String(message.prefix(700))] }

    private func publicStatus(_ item: Item) -> String {
        switch item.status {
        case "error": return "failed"
        case "complete": return "completed"
        default: return item.status
        }
    }

    private func integrationPayload() -> [String: Any] {
        return ["browsers": [], "extensionPath": "", "connectionError":
            "Browser extensions use native messaging and cannot run on mobile. Paste a link or use the share sheet.", "port": 0]
    }

    private func snapshot() -> [String: Any] {
        startScheduled()
        lock.lock(); defer { lock.unlock() }
        let list = items.values.map { item -> [String: Any] in
            let connections = item.blocks.enumerated().map { index, block -> [String: Any] in
                return ["index": index + 1, "received": block.done,
                        "state": block.done >= block.end - block.start + 1 ? "completed" : (item.active ? "downloading" : "paused")]
            }
            return [
                "id": item.id, "filename": item.filename, "url": item.url, "status": publicStatus(item),
                "total": item.total > 0 ? item.total : NSNull(), "downloaded": item.downloaded,
                "speed": item.speed, "protocol": "https", "category": item.category, "description": item.description,
                "needsReview": item.needsReview, "createdAt": item.createdAt.timeIntervalSince1970,
                "scheduledAt": item.scheduledAt.map { $0.timeIntervalSince1970 } ?? NSNull(),
                "error": item.error ?? NSNull(), "directory": outURL.path,
                "outputPath": outURL.appendingPathComponent(item.filename).path, "connections": connections,
                "mirrors": item.mirrors
            ]
        }
        return ["ok": true, "downloads": list, "settings": settings, "integration": integrationPayload()]
    }

    private func add(_ payload: [String: Any]) -> [String: Any] {
        var urls = stringList(payload["urls"])
        if urls.isEmpty, let single = payload["url"] as? String, !single.isEmpty { urls = [single] }
        guard !urls.isEmpty, urls.count <= 500 else { return failure("Add between 1 and 500 links.") }
        let checksum = (payload["checksum"] as? String).flatMap { try? normalizeChecksum($0) }
        if checksum != nil && urls.count != 1 { return failure("A checksum can only be used with one link.") }
        let mirrors = stringList(payload["mirrors"]).compactMap { validate($0) }
        let extract = payload["extract"] as? Bool ?? false
        if extract && urls.count != 1 { return failure("Page extraction works with one link at a time.") }
        let filename = safeName(payload["filename"] as? String ?? "")
        let category = payload["category"] as? String ?? ""
        let description = String((payload["description"] as? String ?? "").prefix(1000))
        let scheduledAt = parseTime(payload["scheduledAt"] as? String ?? "")
        var ids: [String] = []
        for raw in urls {
            guard let url = validate(raw) else { return failure("Only HTTP and HTTPS links are supported.") }
            let item = Item(id: UUID().uuidString, url: url,
                            filename: filename.isEmpty ? nameFrom(url) : filename,
                            checksum: checksum, mirrors: mirrors, category: category, description: description,
                            scheduledAt: scheduledAt, outputFormat: payload["outputFormat"] as? String,
                            extractFormat: payload["extractFormat"] as? String)
            if extract { item.needsReview = true }
            if payload["queueOnly"] as? Bool == true { item.status = "paused" }
            lock.lock(); items[item.id] = item; lock.unlock()
            ids.append(item.id)
            if extract {
                DispatchQueue.global(qos: .utility).async { self.prepareReview(item) }
            } else if item.status != "paused" {
                enqueue(item)
            }
        }
        persist()
        return ok(ids)
    }

    private func prepareReview(_ item: Item) {
        do {
            let choices = try findChoices(item.url)
            lock.lock()
            item.description = (item.description + " \(choices.count) media format(s) found.").trimmingCharacters(in: .whitespaces)
            if choices.isEmpty { item.error = "No downloadable media was found on that page." }
            lock.unlock()
        } catch { lock.lock(); item.error = String(error.localizedDescription.prefix(600)); lock.unlock() }
        persist()
    }

    private func review(_ payload: [String: Any]) -> [String: Any] {
        guard let id = payload["id"] as? String else { return failure("Download not found.") }
        lock.lock()
        guard let item = items[id] else { lock.unlock(); return failure("Download not found.") }
        let page = item.url
        lock.unlock()
        let choices = (try? findChoices(page)) ?? []
        let key = (payload["extractFormat"] as? String ?? payload["youtubeFormat"] as? String ?? "")
        let choice = key.isEmpty ? choices.first : choices.first { key.contains($0["id"] as? String ?? "") || key == $0["quality"] as? String }
        guard let chosen = choice, let direct = validate(chosen["url"] as? String ?? "") else {
            return failure("No usable media format was found for this page.")
        }
        lock.lock()
        item.cancelled = false; item.generation += 1; item.error = nil; item.needsReview = false
        item.url = direct
        let name = payload["filename"] as? String ?? (chosen["title"] as? String ?? item.filename) + extensionFor(chosen)
        item.filename = safeName(name)
        lock.unlock()
        persist()
        enqueue(item)
        return ok([item.id])
    }

    private func extensionFor(_ choice: [String: Any]) -> String {
        var ext = (choice["extension"] as? String ?? "mp4").lowercased()
        if !ext.hasPrefix(".") { ext = "." + ext }
        return ext
    }

    private func action(_ payload: [String: Any]) -> [String: Any] {
        guard let id = payload["id"] as? String else { return failure("Download not found.") }
        lock.lock()
        guard let item = items[id] else { lock.unlock(); return failure("Download not found.") }
        switch payload["action"] as? String ?? "" {
        case "pause", "stop":
            item.cancelled = true; item.generation += 1
            item.tasks.values.forEach { $0.cancel() }
            if item.status != "complete" { item.status = "paused" }
        case "resume", "retry", "start":
            if item.status == "complete" { lock.unlock(); return failure("This download is already complete.") }
            item.error = nil; item.cancelled = false; item.generation += 1; item.status = "queued"
            lock.unlock(); enqueue(item); persist(); return ok(true)
        case "cancel":
            item.cancelled = true; item.generation += 1
            item.tasks.values.forEach { $0.cancel() }
            item.status = "cancelled"
            item.blocks.forEach { $0.done = 0 }; item.downloaded = 0
            try? FileManager.default.removeItem(at: tempURL(item))
        case "remove":
            item.cancelled = true; item.generation += 1
            item.tasks.values.forEach { $0.cancel() }
            try? FileManager.default.removeItem(at: tempURL(item))
            items.removeValue(forKey: id)
        case "open", "reveal":
            let path = outURL.appendingPathComponent(item.filename).path
            lock.unlock(); return ok(path)
        default:
            lock.unlock(); return failure("Unknown action.")
        }
        lock.unlock(); persist(); return ok(true)
    }

    private func updateSettings(_ payload: [String: Any]) -> [String: Any] {
        lock.lock()
        for (key, value) in payload where defaults.keys.contains(key) { settings[key] = value }
        lock.unlock(); persist()
        return ok(settings)
    }

    // MARK: - media discovery

    private func fetchText(_ url: String) throws -> String {
        guard let target = URL(string: url) else { throw NSError(domain: "ZDM", code: 1, userInfo: nil) }
        var request = URLRequest(url: target)
        request.setValue("Mozilla/5.0 ZDM/0.3.0", forHTTPHeaderField: "User-Agent")
        let semaphore = DispatchSemaphore(value: 0)
        var data = Data()
        var error: Error?
        var status = 0
        let task = URLSession.shared.dataTask(with: request) { body, response, failure in
            if let failure = error { error = failure } else {
                status = (response as? HTTPURLResponse)?.statusCode ?? 0
                data = Data((body ?? Data()).prefix(maxHtml))
            }
            semaphore.signal()
        }
        task.resume(); semaphore.wait()
        if let error = error { throw error }
        guard status == 200 else { throw NSError(domain: "ZDM", code: status, userInfo: [NSLocalizedDescriptionKey: "Page returned HTTP \(status)."]) }
        return String(data: data, encoding: .utf8) ?? ""
    }

    private func findChoices(_ page: String) throws -> [[String: Any]] {
        let html = try fetchText(page)
        var choices: [[String: Any]] = []
        if youtubeId(page) != nil {
            guard let range = regex("ytInitialPlayerResponse\\s*=\\s*(\\{.*?\\});", html).first,
                  let data = range[1].data(using: .utf8),
                  let player = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let streaming = player["streamingData"] as? [String: Any] else {
                throw NSError(domain: "ZDM", code: 2, userInfo: [NSLocalizedDescriptionKey: "YouTube did not return player data. Try another video or paste the media link directly."])
            }
            let title = (player["videoDetails"] as? [String: Any])?["title"] as? String ?? "YouTube video"
            let duration = Int64((player["videoDetails"] as? [String: Any])?["lengthSeconds"] as? String ?? "0") ?? 0
            let formats = (streaming["formats"] as? [[String: Any]] ?? []) + (streaming["adaptiveFormats"] as? [[String: Any]] ?? [])
            for format in formats {
                guard let direct = format["url"] as? String, format["hasDrm"] as? Bool != true else { continue }
                let mime = format["mimeType"] as? String ?? ""
                let audioOnly = mime.hasPrefix("audio/")
                let height = format["height"] as? Int ?? 0
                let itag = format["itag"] as? Int ?? 0
                choices.append(["id": "itag:\(itag)", "url": direct, "title": String(title.prefix(180)),
                                "duration": duration, "provider": "youtube", "quality": audioOnly ? "audio" : "\(height)p",
                                "extension": audioOnly ? "m4a" : "mp4", "size": format["contentLength"] as? Int64 ?? 0])
            }
            if choices.isEmpty {
                throw NSError(domain: "ZDM", code: 3, userInfo: [NSLocalizedDescriptionKey: "This YouTube video only offers cipher-protected formats; direct media links are not available on mobile."])
            }
            return choices
        }
        var seen = Set<String>()
        let patterns = [
            "<meta[^>]+property=[\"']og:video(?::url)?[\"'][^>]+content=[\"']([^\"']+)[\"']",
            "<source[^>]+src=[\"']([^\"']+)[\"']",
            "[\"']contentUrl[\"']\\s*:\\s*[\"'](https?:[^\"']+\\.(?:mp4|m4a|webm|mkv)[^\"']*)[\"']",
            "https?:[^\"'\\s<>]+\\.(?:mp4|m4a|webm|mkv)(?:\\?[^\"'\\s<>]*)?"
        ]
        for pattern in patterns {
            for match in regex(pattern, html) {
                let raw = match[1]
                let url = decodeHtml(raw)
                guard url.hasPrefix("http"), !seen.contains(url) else { continue }
                seen.insert(url)
                choices.append(["id": "media:\(seen.count - 1)", "url": url,
                                "title": String((page as NSString).lastPathComponent.prefix(180)), "quality": "",
                                "extension": (url as NSString).pathExtension.lowercased(), "provider": "page"])
            }
        }
        if choices.isEmpty {
            throw NSError(domain: "ZDM", code: 4, userInfo: [NSLocalizedDescriptionKey: "No video or audio link was found on that page. Open the media directly, or paste a file link."])
        }
        return choices
    }

    private func regex(_ pattern: String, _ text: String) -> [[String]] {
        guard let expression = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive, .dotsMatchLineSeparators]) else { return [] }
        let ns = text as NSString
        return expression.matches(in: text, range: NSRange(location: 0, length: ns.length)).map { match in
            (0..<match.numberOfRanges).compactMap { index in
                guard let range = Range(match.range(at: index), in: text) else { return nil }
                return String(text[range])
            }
        }
    }

    private func decodeHtml(_ text: String) -> String {
        return text.replacingOccurrences(of: "&amp;", with: "&")
            .replacingOccurrences(of: "&#39;", with: "'")
            .replacingOccurrences(of: "&quot;", with: "\"")
    }

    private func youtubeId(_ page: String) -> String? {
        guard let url = URL(string: page), let host = url.host?.lowercased() else { return nil }
        let id: String?
        if host == "youtu.be" { id = String(url.path.dropFirst()) }
        else if ["youtube.com", "www.youtube.com", "m.youtube.com"].contains(host) {
            id = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "v" }?.value
        } else { id = nil }
        return id?.count == 11 ? id : nil
    }

    // MARK: - engine

    private func enqueue(_ item: Item) {
        lock.lock()
        let limit = settings[maxConcurrentKey] as? Int ?? 4
        if activeCount >= limit {
            if item.status != "scheduled" { item.status = "queued" }
            lock.unlock(); return
        }
        activeCount += 1
        lock.unlock()
        DispatchQueue.global(qos: .userInitiated).async {
            self.start(item)
            self.lock.lock(); self.activeCount -= 1; self.lock.unlock()
            self.drainQueue()
        }
    }

    private func drainQueue() {
        lock.lock()
        let limit = settings[maxConcurrentKey] as? Int ?? 4
        guard activeCount < limit else { lock.unlock(); return }
        let next = items.values.first { $0.status == "queued" || ($0.status == "scheduled" && ($0.scheduledAt ?? Date.distantFuture) <= Date()) }
        next?.status = "queued"
        lock.unlock()
        if let next = next { enqueue(next) }
    }

    private func startScheduled() {
        lock.lock()
        let ready = items.values.filter { $0.status == "scheduled" && ($0.scheduledAt ?? Date.distantFuture) <= Date() }
        for item in ready { item.status = "queued" }
        lock.unlock()
        for item in ready { enqueue(item) }
    }

    private func start(_ item: Item) {
        lock.lock()
        if item.active { lock.unlock(); return }
        item.active = true
        let generation = item.generation
        lock.unlock()

        do {
            let candidates = [item.url] + item.mirrors
            var total: Int64 = 0
            var ranged = false
            var lastError: Error?
            for candidate in candidates {
                guard let url = URL(string: candidate) else { continue }
                var head = URLRequest(url: url); head.httpMethod = "HEAD"
                let semaphore = DispatchSemaphore(value: 0)
                var code = 0, length: Int64 = 0, acceptRanges = ""
                URLSession.shared.dataTask(with: head) { _, response, _ in
                    if let http = response as? HTTPURLResponse {
                        code = http.statusCode
                        length = Int64(http.value(forHTTPHeaderField: "Content-Length") ?? "0") ?? 0
                        acceptRanges = http.value(forHTTPHeaderField: "Accept-Ranges") ?? ""
                    }
                    semaphore.signal()
                }.resume()
                semaphore.wait()
                if code == 200, length > 0 {
                    total = length; ranged = acceptRanges.lowercased() == "bytes"
                    lock.lock(); item.url = candidate; lock.unlock()
                    break
                }
                lastError = NSError(domain: "ZDM", code: code, userInfo: [NSLocalizedDescriptionKey: "Server returned HTTP \(code)."])
            }
            guard total > 0 else { throw lastError ?? NSError(domain: "ZDM", code: 1, userInfo: [NSLocalizedDescriptionKey: "The server did not report a file size."]) }

            let connections = (settings["connections"] as? Int ?? 16)
            let blockSize = max(minBlock, (total + Int64(connections) - 1) / Int64(connections))
            lock.lock()
            item.total = total; item.error = nil
            if item.blocks.isEmpty {
                var at: Int64 = 0
                while at < total {
                    let end = min(at + blockSize - 1, total - 1)
                    item.blocks.append(Block(at, end)); at = end + 1
                }
            }
            item.status = "downloading"
            lock.unlock()

            let temp = tempURL(item)
            if !FileManager.default.fileExists(atPath: temp.path) { FileManager.default.createFile(atPath: temp.path, contents: nil) }
            let handle = try FileHandle(forWritingTo: temp)
            (handle as NSFileHandle).truncateFile(atOffset: UInt64(total))
            try? handle.close()
            persist()

            let group = DispatchGroup()
            for index in item.blocks.indices {
                group.enter()
                DispatchQueue.global(qos: .utility).async {
                    for attempt in 1...4 {
                        self.lock.lock()
                        let current = item.generation
                        let cancelled = item.cancelled
                        self.lock.unlock()
                        guard !cancelled, current == generation else { break }
                        do {
                            try self.downloadBlock(item, index, temp, generation, ranged)
                            break
                        } catch {
                            if attempt == 4 {
                                self.lock.lock()
                                item.status = "error"; item.error = error.localizedDescription
                                item.cancelled = true
                                self.lock.unlock()
                                item.tasks.values.forEach { $0.cancel() }
                                self.persist()
                            } else { Thread.sleep(forTimeInterval: Double(attempt) * 0.4) }
                        }
                    }
                    group.leave()
                }
            }
            group.wait()
            lock.lock()
            let canFinish = !item.cancelled && item.generation == generation
            lock.unlock()
            if canFinish { try finish(item, temp) }
        } catch {
            lock.lock()
            item.status = item.cancelled ? "paused" : "error"
            item.error = error.localizedDescription
            lock.unlock()
            persist()
        }
        lock.lock(); item.active = false; lock.unlock()
    }

    private func downloadBlock(_ item: Item, _ index: Int, _ temp: URL, _ generation: Int, _ ranged: Bool) throws {
        lock.lock()
        let block = item.blocks[index]
        let from = block.start + block.done
        let currentGeneration = item.generation
        let candidates = [item.url] + item.mirrors
        lock.unlock()
        guard currentGeneration == generation else { return }

        var lastError: Error?
        var succeeded = false
        for candidate in candidates {
            guard let url = URL(string: candidate) else { continue }
            var request = URLRequest(url: url)
            if ranged || from > 0 { request.setValue("bytes=\(from)-\(block.end)", forHTTPHeaderField: "Range") }
            let semaphore = DispatchSemaphore(value: 0)
            var received = Data()
            var taskError: Error?
            var statusCode = 0
            let task = URLSession.shared.dataTask(with: request) { data, response, error in
                if let error = error { taskError = error }
                else {
                    statusCode = (response as? HTTPURLResponse)?.statusCode ?? 0
                    received = data ?? Data()
                }
                semaphore.signal()
            }
            lock.lock(); item.tasks[index] = task; lock.unlock()
            task.resume(); semaphore.wait()
            lock.lock(); item.tasks.removeValue(forKey: index); lock.unlock()
            if let error = taskError { lastError = error; continue }
            let expected = (ranged || from > 0) ? 206 : 200
            guard statusCode == expected else {
                lastError = NSError(domain: "ZDM", code: statusCode, userInfo: [NSLocalizedDescriptionKey: "Server returned HTTP \(statusCode) instead of a byte range."])
                continue
            }
            do {
                let handle = try FileHandle(forWritingTo: temp)
                (handle as NSFileHandle).seek(toFileOffset: UInt64(from))
                (handle as NSFileHandle).write(received)
                try? handle.close()
                lock.lock()
                block.done += Int64(received.count)
                item.downloaded += Int64(received.count)
                recordProgressLocked(item, Int64(received.count))
                lock.unlock()
                persist()
                succeeded = true
                break
            } catch { lastError = error }
        }
        guard succeeded else { throw lastError ?? NSError(domain: "ZDM", code: 4, userInfo: [NSLocalizedDescriptionKey: "No mirror could serve this block."]) }
        if block.done < block.end - block.start + 1 {
            throw NSError(domain: "ZDM", code: 5, userInfo: [NSLocalizedDescriptionKey: "Connection ended before the block finished."])
        }
    }

    private func recordProgressLocked(_ item: Item, _ bytes: Int64) {
        let now = Date()
        item.windowBytes += bytes
        if item.lastSpeedAt == nil { item.lastSpeedAt = now }
        if let start = item.lastSpeedAt, now.timeIntervalSince(start) >= 0.7 {
            item.speed = Double(item.windowBytes) / now.timeIntervalSince(start)
            item.windowBytes = 0
            item.lastSpeedAt = now
        }
    }

    private func finish(_ item: Item, _ temp: URL) throws {
        if let checksum = item.checksum, (settings["verifyHashes"] as? Bool ?? true), !verify(checksum, temp) {
            lock.lock()
            item.status = "error"; item.error = "Checksum mismatch. The corrupted file was discarded."
            item.blocks.forEach { $0.done = 0 }; item.downloaded = 0
            lock.unlock()
            try? FileManager.default.removeItem(at: temp); persist(); return
        }
        var destination = outURL.appendingPathComponent(item.filename)
        var suffix = 1
        while FileManager.default.fileExists(atPath: destination.path) {
            let ext = destination.pathExtension
            let base = ext.isEmpty ? item.filename : String(item.filename.dropLast(ext.count + 1))
            destination = outURL.appendingPathComponent("\(base) (\(suffix))\(ext.isEmpty ? "" : "." + ext)")
            suffix += 1
        }
        try FileManager.default.moveItem(at: temp, to: destination)
        lock.lock()
        item.filename = destination.lastPathComponent
        item.status = "complete"; item.downloaded = item.total; item.speed = 0
        lock.unlock()
        persist()
    }

    private func tempURL(_ item: Item) -> URL { root.appendingPathComponent("\(item.id).part") }

    // MARK: - helpers

    private func validate(_ value: String) -> String? {
        guard let url = URL(string: value), let scheme = url.scheme?.lowercased(),
              ["http", "https"].contains(scheme), url.user == nil, url.password == nil else { return nil }
        return url.absoluteString
    }

    private func safeName(_ value: String) -> String {
        var name = value.trimmingCharacters(in: .whitespacesAndNewlines).map { ch -> Character in
            if "<>:\"/\\|?*".contains(ch) || (ch.unicodeScalars.first?.value ?? 32) < 32 { return "_" }
            return ch
        }
        while let last = name.last, last == "." || last == " " { name.removeLast() }
        if name.isEmpty || ["CON", "PRN", "AUX", "NUL"].contains(String(name).uppercased()) { name = Array("download") }
        return String(name.prefix(180))
    }

    private func nameFrom(_ value: String) -> String {
        guard let url = URL(string: value) else { return "download" }
        return safeName(url.lastPathComponent.removingPercentEncoding ?? url.lastPathComponent)
    }

    private func normalizeChecksum(_ value: String) throws -> String {
        let text = value.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let parts = text.split(separator: ":", maxSplits: 1).map(String.init)
        let algorithm = parts.count == 2 ? parts[0] : ""
        let hex = parts.count == 2 ? parts[1] : text
        let inferred = algorithm.isEmpty ? (hex.count == 32 ? "md5" : hex.count == 64 ? "sha256" : "") : algorithm
        let valid = (inferred == "md5" && hex.count == 32) || (inferred == "sha256" && hex.count == 64)
        guard valid, hex.allSatisfy({ $0.isHexDigit }) else {
            throw NSError(domain: "ZDM", code: 6, userInfo: [NSLocalizedDescriptionKey: "Enter a checksum as sha256:<64 hex> or md5:<32 hex>."])
        }
        return "\(inferred):\(hex)"
    }

    private func verify(_ checksum: String, _ file: URL) -> Bool {
        let parts = checksum.split(separator: ":", maxSplits: 1).map(String.init)
        guard parts.count == 2 else { return false }
        let algorithm = parts[0], expected = parts[1]
        guard let handle = try? FileHandle(forReadingFrom: file) else { return false }
        var md5 = Insecure.MD5(); var sha = SHA256()
        while true {
            let data = (handle as NSFileHandle).readData(ofLength: bufferSize)
            if data.isEmpty { break }
            if algorithm == "md5" { md5.update(data: data) } else { sha.update(data: data) }
        }
        try? handle.close()
        let hex: String
        if algorithm == "md5" { hex = md5.finalize().map { String(format: "%02x", $0) }.joined() }
        else { hex = sha.finalize().map { String(format: "%02x", $0) }.joined() }
        return hex == expected
    }

    private func parseTime(_ value: String) -> Date? {
        guard !value.isEmpty else { return nil }
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyy-MM-dd'T'HH:mm:ss.SSSZ"
        var date = formatter.date(from: value)
        if date == nil {
            formatter.dateFormat = "yyyy-MM-dd'T'HH:mm:ssZ"
            date = formatter.date(from: value)
        }
        guard let parsed = date, parsed.timeIntervalSinceNow > 0 else { return nil }
        return parsed
    }

    private func stringList(_ value: Any?) -> [String] {
        if let list = value as? [String] { return list.filter { !$0.isEmpty } }
        if let text = value as? String { return text.split(separator: "\n").map { String($0).trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty } }
        return []
    }

    // MARK: - state

    private func persist() {
        lock.lock()
        let saved: [String: Any] = [
            "version": 2, "settings": settings,
            "downloads": items.values.map { item -> [String: Any] in
                let blocks: [[String: Any]] = item.blocks.map { ["start": $0.start, "end": $0.end, "done": $0.done] }
                return [
                    "id": item.id, "url": item.url, "filename": item.filename, "checksum": item.checksum ?? NSNull(),
                    "status": item.status, "error": item.error ?? NSNull(), "total": item.total,
                    "downloaded": item.downloaded, "blocks": blocks, "mirrors": item.mirrors,
                    "category": item.category, "description": item.description,
                    "scheduledAt": item.scheduledAt?.timeIntervalSince1970 ?? NSNull(),
                    "outputFormat": item.outputFormat ?? NSNull(), "extractFormat": item.extractFormat ?? NSNull(),
                    "needsReview": item.needsReview, "createdAt": item.createdAt.timeIntervalSince1970
                ]
            }
        ]
        lock.unlock()
        guard let data = try? JSONSerialization.data(withJSONObject: saved, options: []) else { return }
        try? data.write(to: stateURL, options: .atomic)
    }

    private func load() {
        guard let data = try? Data(contentsOf: stateURL),
              let saved = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }
        if let stored = saved["settings"] as? [String: Any] {
            var merged = defaults
            for (key, value) in stored where defaults.keys.contains(key) { merged[key] = value }
            settings = merged
        }
        guard let list = saved["downloads"] as? [[String: Any]] else { return }
        for entry in list {
            guard let id = entry["id"] as? String, let url = entry["url"] as? String else { continue }
            let scheduled = (entry["scheduledAt"] as? NSNumber).map { Date(timeIntervalSince1970: $0.doubleValue) }
            let item = Item(id: id, url: url, filename: entry["filename"] as? String ?? "download",
                            checksum: (entry["checksum"] as? String).flatMap { try? normalizeChecksum($0) },
                            mirrors: entry["mirrors"] as? [String] ?? [], category: entry["category"] as? String ?? "",
                            description: entry["description"] as? String ?? "", scheduledAt: scheduled,
                            outputFormat: entry["outputFormat"] as? String, extractFormat: entry["extractFormat"] as? String)
            let status = entry["status"] as? String ?? "paused"
            if status == "complete" || status == "cancelled" { item.status = status }
            else if status == "scheduled" && scheduled != nil && scheduled! > Date() { item.status = "scheduled" }
            else { item.status = "paused" }
            item.error = entry["error"] as? String
            item.total = Int64(entry["total"] as? Int ?? 0)
            for blockData in entry["blocks"] as? [[String: Any]] ?? [] {
                let block = Block(Int64(blockData["start"] as? Int ?? 0), Int64(blockData["end"] as? Int ?? 0))
                block.done = Int64(blockData["done"] as? Int ?? 0)
                item.blocks.append(block)
            }
            item.downloaded = item.blocks.reduce(0) { $0 + $1.done }
            item.needsReview = entry["needsReview"] as? Bool ?? false
            item.createdAt = Date(timeIntervalSince1970: entry["createdAt"] as? Double ?? Date().timeIntervalSince1970)
            lock.lock(); items[id] = item; lock.unlock()
        }
        drainQueue()
    }
}
