package com.zelvior.zdm

import android.content.ClipData
import android.content.Context
import android.content.ClipboardManager
import okhttp3.Call
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.RandomAccessFile
import java.net.URL
import java.net.URLDecoder
import java.security.MessageDigest
import java.util.Locale
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong

private const val MIN_BLOCK = 2 * 1024 * 1024L
private const val BUFFER_SIZE = 64 * 1024
private const val MAX_HTML = 2 * 1024 * 1024

private class Block(var start: Long, val end: Long, var done: Long = 0)

private class Item(
    val id: String,
    var url: String,
    var filename: String,
    val checksum: String?,
    val mirrors: List<String>,
    val category: String,
    var description: String,
    val scheduledAt: Long?,
    val outputFormat: String?,
    val extractFormat: String?
) {
    var status = if (scheduledAt != null) "scheduled" else "queued"
    var error: String? = null
    var total = 0L
    val downloaded = AtomicLong(0)
    var blocks = mutableListOf<Block>()
    val cancelled = AtomicBoolean(false)
    val running = AtomicBoolean(false)
    var generation = 0
    var needsReview = false
    var speed = 0.0
    var lastSpeedAt = 0L
    var lastSpeedBytes = 0L
    var downloadedBytesThisWindow = 0L
    var createdAt = System.currentTimeMillis()
    val calls = ConcurrentHashMap<Int, Call>()
}

/**
 * Native mobile implementation of the desktop bridge surface. Beyond segmented HTTP(S) downloads it exposes the
 * settings, scheduling, clipboard, extraction and review methods used by the shared renderer, with mobile-appropriate
 * values for the desktop-only browser-integration methods.
 */
object DownloadService {
    private val client = OkHttpClient.Builder().build()
    private val schedulerPool = Executors.newFixedThreadPool(8)
    private val blockPool = Executors.newFixedThreadPool(64)
    private val items = ConcurrentHashMap<String, Item>()
    private val active = AtomicInteger(0)
    private lateinit var root: File
    private lateinit var context: Context
    private var stateFile: File? = null

    private val defaultSettings = JSONObject()
        .put("defaultDirectory", "App downloads")
        .put("maxConcurrent", 4)
        .put("connections", 16)
        .put("speedLimitKbps", 0)
        .put("notifyOnComplete", true)
        .put("revealOnComplete", false)
        .put("confirmBrowserDownloads", true)
        .put("watchClipboard", false)
        .put("closeToTray", false)
        .put("launchAtLogin", false)
        .put("http2", true)
        .put("adaptive", true)
        .put("verifyHashes", true)
        .put("workerThreads", true)
        .put("directWrite", false)
        .put("memoryBudgetMb", 256)
        .put("categoryDirectories", JSONObject())
    private var settings = JSONObject()

    private val outDir: File get() = File(root, "out")

    @Synchronized
    fun init(appContext: Context) {
        if (this::root.isInitialized) return
        context = appContext.applicationContext
        root = File(context.filesDir, "downloads")
        root.mkdirs()
        outDir.mkdirs()
        stateFile = File(root, "state.json")
        settings = JSONObject(defaultSettings.toString())
        load()
    }

    // MARK: - bridge surface

    @Synchronized
    fun handle(method: String, request: JSONObject): JSONObject = when (method) {
        "status", "snapshot" -> snapshot()
        "downloads", "add" -> add(request)
        "control", "action" -> action(request)
        "formats" -> formats(request)
        "review" -> review(request)
        "settings" -> updateSettings(request)
        "clipboard" -> clipboard()
        "chooseDirectory" -> ok(outDir.absolutePath)
        "integration" -> integration()
        "browserSetup", "registerBrowser", "registerCustom", "removeCustom" ->
            ok("Mobile builds do not have desktop browser extensions; use the share sheet or paste a link.")
        "openProgress", "closeProgress", "resizeProgress", "about" -> ok(true)
        else -> failure("Unsupported method: $method")
    }

    private fun formats(request: JSONObject): JSONObject = try {
        val url = request.optString("url", "")
        if (url.isBlank()) failure("A page URL is required.") else ok(findChoices(url))
    } catch (error: Exception) {
        failure(error.message ?: "Could not inspect that page.")
    }

    private fun ok(value: Any): JSONObject = JSONObject().put("ok", true).put("value", value)
    private fun failure(message: String): JSONObject = JSONObject().put("ok", false).put("error", message.take(700))

    @Synchronized
    private fun snapshot(): JSONObject {
        maybeStartScheduled()
        val array = JSONArray()
        for (item in items.values) {
            val connections = JSONArray()
            for ((index, block) in item.blocks.withIndex()) {
                connections.put(JSONObject().put("index", index + 1).put("received", block.done)
                    .put("state", if (block.done >= block.end - block.start + 1) "completed" else if (item.running.get()) "downloading" else "paused"))
            }
            array.put(JSONObject()
                .put("id", item.id)
                .put("filename", item.filename)
                .put("url", item.url)
                .put("status", publicStatus(item))
                .put("total", if (item.total > 0) item.total else JSONObject.NULL)
                .put("downloaded", item.downloaded.get())
                .put("speed", item.speed)
                .put("protocol", "https")
                .put("category", item.category)
                .put("description", item.description)
                .put("needsReview", item.needsReview)
                .put("createdAt", item.createdAt)
                .put("scheduledAt", item.scheduledAt ?: JSONObject.NULL)
                .put("error", item.error ?: JSONObject.NULL)
                .put("directory", outDir.absolutePath)
                .put("outputPath", File(outDir, item.filename).absolutePath)
                .put("connections", connections)
                .put("mirrors", JSONArray(item.mirrors)))
        }
        return JSONObject().put("ok", true).put("downloads", array).put("settings", settings)
            .put("integration", integration().opt("value"))
    }

    private fun publicStatus(item: Item) = when (item.status) {
        "error" -> "failed"
        "complete" -> "completed"
        else -> item.status
    }

    private fun integration(): JSONObject = ok(JSONObject()
        .put("browsers", JSONArray())
        .put("extensionPath", "")
        .put("connectionError", "Browser extensions use native messaging and cannot run on mobile. Paste a link or use the share sheet.")
        .put("port", 0))

    @Synchronized
    private fun add(request: JSONObject): JSONObject {
        val urls = jsonArrayValues(request.opt("urls")).ifEmpty {
            request.optString("url", "").takeIf { it.isNotBlank() }?.let { listOf(it) } ?: emptyList()
        }
        if (urls.isEmpty() || urls.size > 500) return failure("Add between 1 and 500 links.")
        val checksum = try { normalizeChecksum(request.optString("checksum", "")) } catch (e: Exception) { return failure(e.message ?: "Invalid checksum.") }
        if (checksum != null && urls.size != 1) return failure("A checksum can only be used with one link.")
        val mirrors = jsonArrayValues(request.opt("mirrors")).mapNotNull { validateUrl(it) }
        val extract = request.optBoolean("extract", false)
        if (extract && urls.size != 1) return failure("Page extraction works with one link at a time.")
        val filename = safeName(request.optString("filename", ""))
        val category = request.optString("category", "")
        val description = request.optString("description", "").take(1000)
        val scheduledAt = request.optString("scheduledAt", "").ifBlank { null }
        val ids = JSONArray()
        for (raw in urls) {
            val url = validateUrl(raw) ?: return failure("Only HTTP and HTTPS links are supported.")
            val item = Item(
                UUID.randomUUID().toString(), url,
                if (filename.isEmpty()) nameFromUrl(url) else filename, checksum, mirrors, category, description,
                scheduledAt?.let { parseTime(it) }, request.optString("outputFormat", "").ifBlank { null },
                request.optString("extractFormat", "").ifBlank { null })
            if (extract) item.needsReview = true
            if (request.optBoolean("queueOnly", false)) item.status = "paused"
            items[item.id] = item
            ids.put(item.id)
            if (extract) {
                schedulerPool.execute { prepareReview(item) }
            } else if (item.status != "paused") {
                enqueue(item)
            }
        }
        persist()
        return JSONObject().put("ok", true).put("value", ids)
    }

    private fun prepareReview(item: Item) {
        try {
            val choices = findChoices(item.url)
            if (choices.length() > 0) item.description = (item.description + " " + choices.length() + " media format(s) found.").trim()
            else item.error = "No downloadable media was found on that page."
        } catch (error: Exception) {
            item.error = error.message?.take(600) ?: "Could not inspect that page."
        }
        persist()
    }

    @Synchronized
    private fun review(request: JSONObject): JSONObject {
        val item = items[request.optString("id", "")] ?: return failure("Download not found.")
        val choices = findChoices(item.url)
        val key = request.optString("extractFormat", "").ifBlank { request.optString("youtubeFormat", "") }
        val choice = if (key.isBlank()) choices.optJSONObject(0) else (0 until choices.length())
            .map { choices.getJSONObject(it) }.firstOrNull { key in it.optString("id") || key == it.optString("quality") }
        if (choice == null) return failure("No usable media format was found for this page.")
        val direct = validateUrl(choice.optString("url", "")) ?: return failure("That format has a direct link that this device cannot use.")
        item.cancelled.set(false)
        item.generation++
        item.error = null
        item.needsReview = false
        item.filename = safeName(request.optString("filename", "").ifBlank { choice.optString("title", item.filename) + extensionFor(choice) })
        synchronized(item) { item.url = direct }
        persist()
        enqueue(item)
        return ok(JSONArray().put(item.id))
    }

    private fun extensionFor(choice: JSONObject): String {
        val ext = choice.optString("extension", "mp4").lowercase(Locale.ROOT)
        return if (ext.startsWith(".")) ext else ".$ext"
    }

    @Synchronized
    private fun action(request: JSONObject): JSONObject {
        val item = items[request.optString("id", "")] ?: return failure("Download not found.")
        when (request.optString("action", "")) {
            "pause", "stop" -> {
                item.cancelled.set(true); item.generation++
                item.calls.values.forEach { it.cancel() }
                if (item.status != "complete") item.status = "paused"
            }
            "resume", "retry", "start" -> {
                if (item.status == "complete") return failure("This download is already complete.")
                item.error = null; item.cancelled.set(false); item.generation++
                item.status = "queued"; enqueue(item)
            }
            "cancel" -> {
                item.cancelled.set(true); item.generation++
                item.calls.values.forEach { it.cancel() }
                item.status = "cancelled"
                item.blocks.forEach { it.done = 0 }
                item.downloaded.set(0)
                File(root, "${item.id}.part").delete()
            }
            "remove" -> {
                item.cancelled.set(true); item.generation++
                item.calls.values.forEach { it.cancel() }
                File(root, "${item.id}.part").delete()
                items.remove(item.id)
            }
            "open", "reveal" -> return ok(File(outDir, item.filename).absolutePath)
            else -> return failure("Unknown action.")
        }
        persist()
        return ok(true)
    }

    @Synchronized
    private fun updateSettings(request: JSONObject): JSONObject {
        val keys = request.keys()
        while (keys.hasNext()) {
            val key = keys.next()
            if (defaultSettings.has(key)) settings.put(key, request.get(key))
        }
        persist()
        return ok(settings)
    }

    private fun clipboard(): JSONObject {
        val manager = context.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager
        val text = manager?.primaryClip?.let { clip: ClipData ->
            if (clip.itemCount > 0) clip.getItemAt(0).text?.toString().orEmpty() else ""
        }.orEmpty()
        return ok(text.take(100000))
    }

    // MARK: - media discovery

    private fun fetchText(url: String, limit: Int = MAX_HTML): String {
        val request = Request.Builder().url(url).header("User-Agent", "Mozilla/5.0 ZDM/0.3.0").build()
        client.newCall(request).execute().use { response ->
            if (!response.isSuccessful) throw Exception("Page returned HTTP ${response.code}.")
            return response.body?.source()?.let { source ->
                val buffer = okio.Buffer()
                var total = 0
                while (!source.exhausted() && total < limit) {
                    val chunk = source.readByteArray(minOf(64 * 1024L, (limit - total).toLong()))
                    buffer.write(chunk); total += chunk.size
                }
                buffer.readUtf8()
            } ?: throw Exception("The page was empty.")
        }
    }

    private fun findChoices(pageUrl: String): JSONArray {
        val html = fetchText(pageUrl)
        val choices = JSONArray()
        val normalized = youtubeUrl(pageUrl)
        if (normalized != null) {
            val match = Regex("ytInitialPlayerResponse\\s*=\\s*(\\{.*?\\});", RegexOption.DOT_MATCHES_ALL).find(html)
                ?: throw Exception("YouTube did not return player data. Try another video or paste the media link directly.")
            val player = JSONObject(match.groupValues[1])
            val details = player.optJSONObject("videoDetails")
            val title = details?.optString("title", "YouTube video")?.take(180) ?: "YouTube video"
            val duration = details?.optString("lengthSeconds", "0")?.toLongOrNull() ?: 0
            val formats = player.optJSONObject("streamingData")?.optJSONArray("formats") ?: JSONArray()
            val adaptive = player.optJSONObject("streamingData")?.optJSONArray("adaptiveFormats") ?: JSONArray()
            for (i in 0 until formats.length() + adaptive.length()) {
                val f = if (i < formats.length()) formats.getJSONObject(i) else adaptive.getJSONObject(i - formats.length())
                val direct = f.optString("url", "")
                if (direct.isBlank() || f.optBoolean("hasDrm")) continue
                val height = f.optInt("height", 0)
                val itag = f.optInt("itag", 0)
                val audioOnly = f.optString("mimeType", "").startsWith("audio/")
                val ext = if (audioOnly) "m4a" else "mp4"
                choices.put(JSONObject().put("id", "itag:$itag").put("url", direct)
                    .put("title", title).put("duration", duration).put("provider", "youtube")
                    .put("quality", if (audioOnly) "audio" else "${height}p").put("extension", ext)
                    .put("size", f.optLong("contentLength", 0)))
            }
            if (choices.length() == 0) throw Exception("This YouTube video only offers cipher-protected formats; direct media links are not available on mobile.")
            return choices
        }

        val seen = mutableSetOf<String>()
        val candidates = mutableListOf<Pair<String, String>>()
        for (regex in listOf(
            Regex("<meta[^>]+property=[\"']og:video(?::url)?[\"'][^>]+content=[\"']([^\"']+)[\"']", RegexOption.IGNORE_CASE),
            Regex("<source[^>]+src=[\"']([^\"']+)[\"']", RegexOption.IGNORE_CASE),
            Regex("[\"'](contentUrl|url)[\"']\\s*:\\s*[\"'](https?:[^\"']+\\.(?:mp4|m4a|webm|mkv)[^\"']*)[\"']", RegexOption.IGNORE_CASE)
        )) {
            for (match in regex.findAll(html)) {
                val raw = match.groupValues[1].let { if (it.startsWith("http")) it else match.groupValues.getOrNull(2).orEmpty() }
                val url = decodeHtml(raw)
                if (url.startsWith("http") && url !in seen) { seen.add(url); candidates.add(url to "") }
            }
        }
        for (match in Regex("https?:[^\"'\\s<>]+\\.(?:mp4|m4a|webm|mkv)(?:\\?[^\"'\\s<>]*)?", RegexOption.IGNORE_CASE).findAll(html)) {
            val url = decodeHtml(match.value)
            if (url !in seen) { seen.add(url); candidates.add(url to "") }
        }
        for ((index, pair) in candidates.withIndex()) {
            choices.put(JSONObject().put("id", "media:$index").put("url", pair.first)
                .put("title", pageUrl.substringAfterLast('/').take(180)).put("quality", "")
                .put("extension", pair.first.substringAfterLast('.', "mp4").take(5)).put("provider", "page"))
        }
        if (choices.length() == 0) throw Exception("No video or audio link was found on that page. Open the media directly, or paste a file link.")
        return choices
    }

    private fun decodeHtml(value: String): String = value.replace("&amp;", "&").replace("&#39;", "'").replace("&quot;", "\"")

    private fun youtubeUrl(page: String): String? {
        val url = validateUrl(page) ?: return null
        val host = URL(url).host.lowercase(Locale.ROOT)
        val id = if (host == "youtu.be") url.substringAfter("youtu.be/").substringBefore("?")
        else if (host in setOf("youtube.com", "www.youtube.com", "m.youtube.com") && "/watch?" in url)
            url.substringAfter("v=").substringBefore("&") else null
        return if (id != null && Regex("^[\\w-]{11}$").matches(id)) "https://www.youtube.com/watch?v=$id" else null
    }

    // MARK: - engine

    @Synchronized
    private fun enqueue(item: Item) {
        if (active.get() >= settings.optInt("maxConcurrent", 4)) {
            if (item.status != "scheduled") item.status = "queued"
            return
        }
        active.incrementAndGet()
        schedulerPool.execute {
            try { start(item) } finally { active.decrementAndGet(); drainQueue() }
        }
    }

    @Synchronized
    private fun drainQueue() {
        if (active.get() >= settings.optInt("maxConcurrent", 4)) return
        for (item in items.values) {
            if (item.status == "queued" || (item.status == "scheduled" && item.scheduledAt != null && item.scheduledAt!! <= System.currentTimeMillis())) {
                item.status = "queued"
                enqueue(item)
                return
            }
        }
    }

    @Synchronized
    private fun maybeStartScheduled() {
        for (item in items.values) {
            if (item.status == "scheduled" && (item.scheduledAt ?: Long.MAX_VALUE) <= System.currentTimeMillis()) {
                item.status = "queued"
                enqueue(item)
            }
        }
    }

    private fun start(item: Item) {
        if (!item.running.compareAndSet(false, true)) return
        val generation = synchronized(this) { item.generation }
        try {
            val urls = listOf(item.url) + item.mirrors
            var total = -1L
            var ranged = false
            var lastError: Exception? = null
            for (candidate in urls) {
                try {
                    client.newCall(Request.Builder().url(candidate).head().build()).execute().use { response ->
                        if (response.isSuccessful) {
                            total = response.header("Content-Length")?.toLongOrNull() ?: -1
                            ranged = response.header("Accept-Ranges")?.equals("bytes", ignoreCase = true) == true
                            synchronized(item) { item.url = candidate }
                        } else lastError = Exception("Server returned HTTP ${response.code}.")
                    }
                    if (total > 0) break
                } catch (error: Exception) { lastError = error }
            }
            if (total <= 0) throw lastError ?: Exception("The server did not report a file size.")
            val connectionLimit = settings.optInt("connections", 16).coerceIn(1, 64)
            val blockSize = maxOf(MIN_BLOCK, (total + connectionLimit - 1) / connectionLimit)
            synchronized(this) {
                item.total = total
                item.error = null
                if (item.blocks.isEmpty()) {
                    var at = 0L
                    while (at < total) {
                        val end = minOf(at + blockSize - 1, total - 1)
                        item.blocks.add(Block(at, end)); at = end + 1
                    }
                }
                item.status = "downloading"
            }
            val temp = File(root, "${item.id}.part")
            RandomAccessFile(temp, "rw").use { it.setLength(total) }
            persist()
            val latch = CountDownLatch(item.blocks.size)
            for (index in item.blocks.indices) blockPool.execute { downloadBlock(item, index, temp, latch, generation, ranged) }
            schedulerPool.execute {
                latch.await()
                if (!item.cancelled.get() && synchronized(this) { item.generation } == generation) finish(item, temp)
                item.running.set(false)
            }
        } catch (error: Exception) {
            synchronized(this) {
                item.status = if (item.cancelled.get()) "paused" else "error"
                item.error = error.message ?: "Download failed."
            }
            persist()
            item.running.set(false)
        }
    }

    private fun downloadBlock(item: Item, index: Int, temp: File, latch: CountDownLatch, generation: Int, ranged: Boolean) {
        try {
            val block = synchronized(this) { item.blocks[index] }
            var attempt = 0
            while (attempt < 4 && !item.cancelled.get() && synchronized(this) { item.generation } == generation) {
                attempt++
                try {
                    val from = block.start + block.done
                    val urls = listOf(item.url) + item.mirrors
                    var lastError: Exception? = null
                    var succeeded = false
                    for (candidate in urls) {
                        val header = if (ranged || from > 0) "bytes=$from-${block.end}" else null
                        val builder = Request.Builder().url(candidate)
                        if (header != null) builder.header("Range", header)
                        val call = client.newCall(builder.build())
                        item.calls[index] = call
                        try {
                            call.execute().use { response ->
                                val expected = if (header != null) 206 else 200
                                if (response.code != expected) throw Exception("Server returned HTTP ${response.code} instead of a byte range.")
                                val body = response.body ?: throw Exception("The response had no body.")
                                if (response.code == 206) {
                                    val contentRange = response.header("Content-Range") ?: ""
                                    if (!contentRange.startsWith("bytes $from-")) throw Exception("Server returned an inconsistent byte range.")
                                }
                                RandomAccessFile(temp, "rw").use { out ->
                                    out.seek(from)
                                    val buffer = ByteArray(BUFFER_SIZE)
                                    val input = body.byteStream()
                                    while (!item.cancelled.get() && synchronized(this) { item.generation } == generation) {
                                        val read = input.read(buffer)
                                        if (read == -1) break
                                        out.write(buffer, 0, read)
                                        synchronized(this) { block.done += read.toLong() }
                                        recordProgress(item, read.toLong())
                                    }
                                }
                            }
                            succeeded = true
                            break
                        } catch (error: Exception) { lastError = error; item.calls.remove(index) }
                    }
                    item.calls.remove(index)
                    if (!succeeded) throw lastError ?: Exception("No mirror could serve this block.")
                    if (block.done < block.end - block.start + 1 && !item.cancelled.get()) throw Exception("Connection ended before the block finished.")
                    break
                } catch (error: Exception) {
                    item.calls.remove(index)
                    if (item.cancelled.get()) break
                    if (attempt >= 4) {
                        synchronized(this) { item.status = "error"; item.error = error.message ?: "Block failed." }
                        item.cancelled.set(true)
                        item.calls.values.forEach { it.cancel() }
                        persist()
                        break
                    }
                    Thread.sleep(400L * attempt)
                }
            }
        } finally { latch.countDown() }
    }

    @Synchronized
    private fun recordProgress(item: Item, bytes: Long) {
        val now = System.currentTimeMillis()
        item.downloaded.addAndGet(bytes)
        synchronized(item) {
            item.downloadedBytesThisWindow += bytes
            if (item.lastSpeedAt == 0L) item.lastSpeedAt = now
            if (now - item.lastSpeedAt >= 700) {
                item.speed = item.downloadedBytesThisWindow * 1000.0 / (now - item.lastSpeedAt)
                item.downloadedBytesThisWindow = 0
                item.lastSpeedAt = now
            }
        }
        persist()
    }

    private fun finish(item: Item, temp: File) {
        val expected = item.checksum
        if (expected != null && settings.optBoolean("verifyHashes", true) && !verify(expected, temp)) {
            synchronized(this) {
                item.status = "error"
                item.error = "Checksum mismatch. The corrupted file was discarded."
                item.blocks.forEach { it.done = 0 }
                item.downloaded.set(0)
            }
            temp.delete(); persist(); return
        }
        outDir.mkdirs()
        var destination = File(outDir, item.filename)
        var suffix = 1
        while (destination.exists()) {
            val dot = item.filename.lastIndexOf('.')
            val base = if (dot > 0) item.filename.substring(0, dot) else item.filename
            val ext = if (dot > 0) item.filename.substring(dot) else ""
            destination = File(outDir, "$base ($suffix)$ext"); suffix++
        }
        if (!temp.renameTo(destination)) {
            synchronized(this) { item.status = "error"; item.error = "Could not move the finished file into place." }
            persist(); return
        }
        synchronized(this) {
            item.filename = destination.name
            item.status = "complete"
            item.downloaded.set(item.total)
            item.speed = 0.0
        }
        persist()
    }

    private fun verify(checksum: String, file: File): Boolean {
        val parts = checksum.split(':', limit = 2)
        val algorithm = parts[0]
        val expected = parts[1]
        val digest = MessageDigest.getInstance(if (algorithm == "md5") "MD5" else "SHA-256")
        file.inputStream().use { input ->
            val buffer = ByteArray(BUFFER_SIZE)
            while (true) { val read = input.read(buffer); if (read == -1) break; digest.update(buffer, 0, read) }
        }
        return digest.digest().joinToString("") { "%02x".format(it) } == expected
    }

    private fun validateUrl(value: String): String? = try {
        val url = URL(value)
        if (url.protocol.lowercase(Locale.ROOT) !in setOf("http", "https")) null
        else if (!url.userInfo.isNullOrEmpty()) null else url.toExternalForm()
    } catch (_: Exception) { null }

    private fun safeName(value: String): String {
        val bad = "<>:\"/\\|?*"
        var name = value.trim().map { if (it in bad || it.code < 32) '_' else it }.joinToString("")
        name = name.trimEnd('.', ' ').take(180)
        if (name.isEmpty() || name.uppercase(Locale.ROOT) in setOf("CON", "PRN", "AUX", "NUL")) name = "download"
        return name
    }

    private fun nameFromUrl(value: String): String = try {
        val path = URL(value).path.substringAfterLast('/')
        safeName(URLDecoder.decode(path, "UTF-8"))
    } catch (_: Exception) { "download" }

    private fun normalizeChecksum(value: String): String? {
        val text = value.trim()
        if (text.isEmpty()) return null
        val parts = if (text.contains(':')) text.split(':', limit = 2).map { it.lowercase(Locale.ROOT) }
        else listOf("", text.lowercase(Locale.ROOT))
        val algorithm = parts[0]
        val hex = parts[1]
        val valid = ((algorithm == "md5" && hex.length == 32) || (algorithm == "sha256" && hex.length == 64) ||
            (algorithm.isEmpty() && (hex.length == 32 || hex.length == 64))) && hex.all { it in '0'..'9' || it in 'a'..'f' }
        if (!valid) throw IllegalArgumentException("Enter a checksum as sha256:<64 hex> or md5:<32 hex>.")
        return "${if (algorithm.isEmpty()) if (hex.length == 32) "md5" else "sha256" else algorithm}:$hex"
    }

    private fun parseTime(value: String): Long? = try {
        val parsers = listOf(
            java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US),
            java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'Z'", Locale.US))
        var result: Long? = null
        for (format in parsers) {
            format.timeZone = java.util.TimeZone.getTimeZone("UTC")
            try {
                val parsed = format.parse(value)?.time
                if (parsed != null && parsed > System.currentTimeMillis()) {
                    result = parsed
                    break
                }
            } catch (_: Exception) { }
        }
        result
    } catch (_: Exception) { null }

    private fun jsonArrayValues(value: Any?): List<String> = when (value) {
        is JSONArray -> (0 until value.length()).map { value.optString(it, "") }.filter { it.isNotBlank() }
        is String -> value.split('\n').map { it.trim() }.filter { it.isNotBlank() }
        else -> emptyList()
    }

    @Synchronized
    private fun persist() {
        val file = stateFile ?: return
        val saved = JSONObject().put("version", 2).put("settings", settings)
        val array = JSONArray()
        for (item in items.values) {
            val blocks = JSONArray()
            synchronized(item) {
                for (block in item.blocks) blocks.put(JSONObject().put("start", block.start).put("end", block.end).put("done", block.done))
                array.put(JSONObject()
                    .put("id", item.id).put("url", item.url).put("filename", item.filename)
                    .put("checksum", item.checksum ?: JSONObject.NULL).put("status", item.status)
                    .put("error", item.error ?: JSONObject.NULL).put("total", item.total)
                    .put("downloaded", item.downloaded.get()).put("blocks", blocks)
                    .put("mirrors", JSONArray(item.mirrors)).put("category", item.category)
                    .put("description", item.description).put("scheduledAt", item.scheduledAt ?: JSONObject.NULL)
                    .put("outputFormat", item.outputFormat ?: JSONObject.NULL)
                    .put("extractFormat", item.extractFormat ?: JSONObject.NULL)
                    .put("needsReview", item.needsReview).put("createdAt", item.createdAt))
            }
        }
        saved.put("downloads", array)
        val temp = File(root, "state.tmp")
        temp.writeText(saved.toString())
        temp.renameTo(file)
    }

    @Synchronized
    private fun load() {
        val file = stateFile ?: return
        try {
            val saved = JSONObject(file.readText())
            saved.optJSONObject("settings")?.let { settings = JSONObject(defaultSettings.toString()).apply {
                val keys = it.keys(); while (keys.hasNext()) { val key = keys.next(); put(key, it.get(key)) }
            } }
            val list = saved.optJSONArray("downloads") ?: return
            for (i in 0 until list.length()) {
                val data = list.getJSONObject(i)
                val mirrors = jsonArrayValues(data.opt("mirrors"))
                val item = Item(data.optString("id"), data.optString("url"), data.optString("filename", "download"),
                    data.optString("checksum", "").ifBlank { null }, mirrors, data.optString("category", ""),
                    data.optString("description", ""), (data.opt("scheduledAt") as? Number)?.toLong(),
                    (data.opt("outputFormat") as? String)?.ifBlank { null },
                    (data.opt("extractFormat") as? String)?.ifBlank { null })
                item.status = when (data.optString("status")) {
                    "complete", "cancelled" -> data.optString("status")
                    "scheduled" -> if (item.scheduledAt != null && item.scheduledAt!! > System.currentTimeMillis()) "scheduled" else "paused"
                    else -> "paused"
                }
                item.error = data.optString("error", "").ifBlank { null }
                item.total = data.optLong("total")
                val blocks = data.optJSONArray("blocks")
                if (blocks != null) for (b in 0 until blocks.length()) {
                    val bd = blocks.getJSONObject(b)
                    item.blocks.add(Block(bd.optLong("start"), bd.optLong("end"), bd.optLong("done")))
                }
                item.downloaded.set(item.blocks.sumOf { it.done })
                item.needsReview = data.optBoolean("needsReview")
                item.createdAt = data.optLong("createdAt", System.currentTimeMillis())
                items[item.id] = item
            }
            drainQueue()
        } catch (_: Exception) { /* a corrupt state file must not stop the app */ }
    }
}
