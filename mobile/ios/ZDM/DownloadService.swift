import Foundation
import CryptoKit

private let blockSize: Int64 = 2 * 1024 * 1024

private final class Block {
    let start: Int64
    let end: Int64
    var done: Int64 = 0
    init(_ start: Int64, _ end: Int64) { self.start = start; self.end = end }
}

private final class Item {
    let id: String
    let url: String
    var filename: String
    var checksum: String?
    var status = "queued"
    var error: String?
    var total: Int64 = 0
    var downloaded: Int64 = 0
    var blocks: [Block] = []
    var cancelled = false
    var active = false
    var generation = 0
    var tasks: [Int: URLSessionDataTask] = [:]

    init(id: String, url: String, filename: String, checksum: String?) {
        self.id = id; self.url = url; self.filename = filename; self.checksum = checksum
    }
}

/// Native download engine for the iOS mobile build: ranged HTTP downloads written into one pre-sized file,
/// resume from persisted block offsets, pause/cancel, and MD5/SHA-256 verification. Page extraction and browser
/// takeover are desktop-only and are not ported.
final class DownloadService {
    static let shared = DownloadService()

    private let lock = NSLock()
    private var items: [String: Item] = [:]
    private let root: URL
    private var stateURL: URL { root.appendingPathComponent("state.json") }
    private var outURL: URL { root.appendingPathComponent("out", isDirectory: true) }

    private init() {
        let documents = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        root = documents.appendingPathComponent("zdm", isDirectory: true)
        try? FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        try? FileManager.default.createDirectory(at: outURL, withIntermediateDirectories: true)
        load()
    }

    // MARK: - bridge

    func handle(method: String, payload: [String: Any]) -> [String: Any] {
        switch method {
        case "status": return status()
        case "downloads": return add(payload)
        case "control": return control(payload)
        default: return failure("Unsupported method.")
        }
    }

    private func failure(_ message: String) -> [String: Any] {
        return ["ok": false, "error": String(message.prefix(700))]
    }

    private func status() -> [String: Any] {
        lock.lock(); defer { lock.unlock() }
        let list = items.values.map { item -> [String: Any] in
            return [
                "id": item.id, "filename": item.filename, "url": item.url, "status": item.status,
                "downloaded": item.downloaded, "total": item.total > 0 ? item.total : NSNull(),
                "connections": item.blocks.count, "error": item.error ?? NSNull()
            ]
        }
        return ["ok": true, "items": list, "settings": ["watchClipboard": false]]
    }

    private func add(_ payload: [String: Any]) -> [String: Any] {
        let urls = payload["urls"] as? [String] ?? (payload["url"] as? String).map { [$0] } ?? []
        guard !urls.isEmpty, urls.count <= 500 else { return failure("Add between 1 and 500 links.") }
        let checksum = (payload["checksum"] as? String).flatMap { try? normalizeChecksum($0) }
        if checksum != nil && urls.count != 1 { return failure("A checksum can only be used with one link.") }
        let requestedName = (payload["filename"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        var ids: [String] = []
        for raw in urls {
            guard let url = validate(raw) else { return failure("Only HTTP and HTTPS links are supported.") }
            let name = safeName(requestedName.isEmpty ? nameFrom(url) : requestedName)
            let item = Item(id: UUID().uuidString, url: url, filename: name, checksum: checksum)
            lock.lock(); items[item.id] = item; lock.unlock()
            ids.append(item.id)
            DispatchQueue.global(qos: .userInitiated).async { self.start(item) }
        }
        persist()
        return ["ok": true, "ids": ids]
    }

    private func control(_ payload: [String: Any]) -> [String: Any] {
        guard let id = payload["id"] as? String else { return failure("Download not found.") }
        lock.lock()
        guard let item = items[id] else { lock.unlock(); return failure("Download not found.") }
        switch payload["action"] as? String ?? "" {
        case "pause":
            item.cancelled = true
            item.generation += 1
            item.tasks.values.forEach { $0.cancel() }
            if item.status != "complete" { item.status = "paused" }
        case "resume", "retry":
            if item.status == "complete" { lock.unlock(); return failure("This download is already complete.") }
            item.error = nil; item.cancelled = false; item.status = "queued"
            item.generation += 1
            lock.unlock()
            DispatchQueue.global(qos: .userInitiated).async { self.start(item) }
            persist()
            return ["ok": true]
        case "cancel":
            item.cancelled = true
            item.generation += 1
            item.tasks.values.forEach { $0.cancel() }
            item.status = "cancelled"
            item.blocks.forEach { $0.done = 0 }
            item.downloaded = 0
            try? FileManager.default.removeItem(at: tempURL(item))
        default:
            lock.unlock(); return failure("Unknown action.")
        }
        lock.unlock()
        persist()
        return ["ok": true]
    }

    // MARK: - engine

    private func start(_ item: Item) {
        lock.lock()
        if item.active { lock.unlock(); return }
        item.active = true
        let generation = item.generation
        lock.unlock()

        do {
            guard let url = URL(string: item.url) else { throw NSError(domain: "ZDM", code: 1, userInfo: [NSLocalizedDescriptionKey: "Invalid URL."]) }
            var request = URLRequest(url: url)
            request.httpMethod = "HEAD"
            let semaphore = DispatchSemaphore(value: 0)
            var headStatus = 0
            var contentLength: Int64 = 0
            let head = URLSession.shared.dataTask(with: request) { _, response, _ in
                if let http = response as? HTTPURLResponse {
                    headStatus = http.statusCode
                    contentLength = Int64(http.value(forHTTPHeaderField: "Content-Length") ?? "0") ?? 0
                }
                semaphore.signal()
            }
            head.resume()
            semaphore.wait()
            guard headStatus == 200, contentLength > 0 else {
                throw NSError(domain: "ZDM", code: 2, userInfo: [NSLocalizedDescriptionKey: "The server did not report a file size."])
            }

            lock.lock()
            item.total = contentLength
            item.error = nil
            if item.blocks.isEmpty {
                var at: Int64 = 0
                while at < contentLength {
                    let end = min(at + blockSize - 1, contentLength - 1)
                    item.blocks.append(Block(at, end))
                    at = end + 1
                }
            }
            item.status = "downloading"
            lock.unlock()

            let temp = tempURL(item)
            if !FileManager.default.fileExists(atPath: temp.path) {
                FileManager.default.createFile(atPath: temp.path, contents: nil)
            }
            let handle = try FileHandle(forWritingTo: temp)
            (handle as NSFileHandle).truncateFile(atOffset: UInt64(contentLength))
            try? handle.close()
            persist()

            DispatchQueue.concurrentPerform(iterations: item.blocks.count) { index in
                for attempt in 1...4 {
                    lock.lock()
                    let current = item.generation
                    let cancelled = item.cancelled
                    lock.unlock()
                    guard !cancelled, current == generation else { break }
                    do {
                        try downloadBlock(item, index, temp, generation)
                        break
                    } catch {
                        if attempt == 4 {
                            lock.lock()
                            item.status = "error"
                            item.error = error.localizedDescription
                            item.cancelled = true
                            lock.unlock()
                            item.tasks.values.forEach { $0.cancel() }
                            persist()
                        } else {
                            Thread.sleep(forTimeInterval: Double(attempt) * 0.4)
                        }
                    }
                }
            }
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

    private func downloadBlock(_ item: Item, _ index: Int, _ temp: URL, _ generation: Int) throws {
        lock.lock()
        let block = item.blocks[index]
        let from = block.start + block.done
        let currentGeneration = item.generation
        lock.unlock()
        guard currentGeneration == generation else { return }
        guard let url = URL(string: item.url) else { throw NSError(domain: "ZDM", code: 3, userInfo: nil) }
        var request = URLRequest(url: url)
        request.setValue("bytes=\(from)-\(block.end)", forHTTPHeaderField: "Range")

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
        task.resume()
        semaphore.wait()
        lock.lock(); item.tasks.removeValue(forKey: index); lock.unlock()
        if let error = taskError { throw error }
        guard statusCode == 206 else {
            throw NSError(domain: "ZDM", code: statusCode, userInfo: [NSLocalizedDescriptionKey: "Server returned HTTP \(statusCode) instead of a byte range."])
        }
        guard !received.isEmpty else { throw NSError(domain: "ZDM", code: 4, userInfo: [NSLocalizedDescriptionKey: "Connection ended before the block finished."]) }

        let handle = try FileHandle(forWritingTo: temp)
        (handle as NSFileHandle).seek(toFileOffset: UInt64(from))
        try handle.write(contentsOf: received)
        try? handle.close()
        lock.lock()
        block.done += Int64(received.count)
        item.downloaded += Int64(received.count)
        lock.unlock()
        persist()
        if block.done < block.end - block.start + 1 {
            throw NSError(domain: "ZDM", code: 5, userInfo: [NSLocalizedDescriptionKey: "Incomplete block."])
        }
    }

    private func finish(_ item: Item, _ temp: URL) throws {
        if let checksum = item.checksum, !verify(checksum, temp) {
            lock.lock()
            item.status = "error"
            item.error = "Checksum mismatch. The corrupted file was discarded."
            item.blocks.forEach { $0.done = 0 }
            item.downloaded = 0
            lock.unlock()
            try? FileManager.default.removeItem(at: temp)
            persist()
            return
        }
        var destination = outURL.appendingPathComponent(item.filename)
        var suffix = 1
        while FileManager.default.fileExists(atPath: destination.path) {
            let ext = destination.pathExtension
            let base = (ext.isEmpty ? item.filename : String(item.filename.dropLast(ext.count + 1)))
            destination = outURL.appendingPathComponent("\(base) (\(suffix))\(ext.isEmpty ? "" : "." + ext)")
            suffix += 1
        }
        try FileManager.default.moveItem(at: temp, to: destination)
        lock.lock()
        item.filename = destination.lastPathComponent
        item.status = "complete"
        item.downloaded = item.total
        lock.unlock()
        persist()
    }

    private func tempURL(_ item: Item) -> URL { root.appendingPathComponent("\(item.id).part") }

    // MARK: - helpers

    private func validate(_ value: String) -> String? {
        guard let url = URL(string: value), let scheme = url.scheme?.lowercased(),
              scheme == "http" || scheme == "https", url.user == nil, url.password == nil else { return nil }
        return url.absoluteString
    }

    private func safeName(_ value: String) -> String {
        var name = value.trimmingCharacters(in: .whitespacesAndNewlines).map { ch -> Character in
            if "<>:\"/\\|?*".contains(ch) || (ch.unicodeScalars.first?.value ?? 32) < 32 { return "_" }
            return ch
        }
        while name.last == "." || name.last == " " { name.removeLast() }
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
        let validLength = (inferred == "md5" && hex.count == 32) || (inferred == "sha256" && hex.count == 64)
        guard validLength, hex.allSatisfy({ $0.isHexDigit }) else {
            throw NSError(domain: "ZDM", code: 6, userInfo: [NSLocalizedDescriptionKey: "Enter a checksum as sha256:<64 hex> or md5:<32 hex>."])
        }
        return "\(inferred):\(hex)"
    }

    private func verify(_ checksum: String, _ file: URL) -> Bool {
        let parts = checksum.split(separator: ":", maxSplits: 1).map(String.init)
        let algorithm = parts[0]
        let expected = parts[1]
        guard let handle = try? FileHandle(forReadingFrom: file) else { return false }
        var md5 = Insecure.MD5()
        var sha = SHA256()
        while true {
            let data = (handle as NSFileHandle).readData(ofLength: 64 * 1024)
            if data.isEmpty { break }
            if algorithm == "md5" { md5.update(data: data) } else { sha.update(data: data) }
        }
        try? handle.close()
        let hex: String
        if algorithm == "md5" { hex = md5.finalize().map { String(format: "%02x", $0) }.joined() }
        else { hex = sha.finalize().map { String(format: "%02x", $0) }.joined() }
        return hex == expected
    }

    // MARK: - state

    private func persist() {
        lock.lock()
        let saved: [String: Any] = ["version": 1, "downloads": items.values.map { item -> [String: Any] in
            var blocks: [[String: Any]] = []
            for block in item.blocks { blocks.append(["start": block.start, "end": block.end, "done": block.done]) }
            return [
                "id": item.id, "url": item.url, "filename": item.filename, "checksum": item.checksum ?? NSNull(),
                "status": item.status, "error": item.error ?? NSNull(), "total": item.total,
                "downloaded": item.downloaded, "blocks": blocks
            ]
        }]
        lock.unlock()
        guard let data = try? JSONSerialization.data(withJSONObject: saved, options: []) else { return }
        try? data.write(to: stateURL, options: .atomic)
    }

    private func load() {
        guard let data = try? Data(contentsOf: stateURL),
              let saved = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let list = saved["downloads"] as? [[String: Any]] else { return }
        for entry in list {
            guard let id = entry["id"] as? String, let url = entry["url"] as? String else { continue }
            let item = Item(id: id, url: url, filename: entry["filename"] as? String ?? "download",
                            checksum: (entry["checksum"] as? String).flatMap { try? normalizeChecksum($0) })
            let status = entry["status"] as? String ?? "paused"
            item.status = (status == "complete" || status == "cancelled") ? status : "paused"
            item.error = entry["error"] as? String
            item.total = Int64(entry["total"] as? Int ?? 0)
            for blockData in entry["blocks"] as? [[String: Any]] ?? [] {
                let block = Block(Int64(blockData["start"] as? Int ?? 0), Int64(blockData["end"] as? Int ?? 0))
                block.done = Int64(blockData["done"] as? Int ?? 0)
                item.blocks.append(block)
            }
            item.downloaded = item.blocks.reduce(0) { $0 + $1.done }
            lock.lock(); items[id] = item; lock.unlock()
        }
    }
}
