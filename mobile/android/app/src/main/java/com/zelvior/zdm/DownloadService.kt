package com.zelvior.zdm

import android.content.Context
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
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong

private const val BLOCK_SIZE = 2 * 1024 * 1024L
private const val BUFFER_SIZE = 64 * 1024

private class Block(var start: Long, val end: Long, var done: Long = 0)

private class Item(val id: String, val url: String, var filename: String, val checksum: String?) {
    var status = "queued"
    var error: String? = null
    var total = 0L
    var downloaded = AtomicLong(0)
    var blocks = mutableListOf<Block>()
    val cancelled = AtomicBoolean(false)
    val running = AtomicBoolean(false)
    var generation = 0
    val calls = ConcurrentHashMap<Int, Call>()
}

/**
 * Native download engine for the Android mobile build.
 *
 * Implements the subset of the desktop engine that makes sense on a phone: HTTP(S) HEAD probing, parallel byte-range
 * blocks written straight into one pre-sized file, resume from persisted block offsets, pause/cancel, and MD5/SHA-256
 * verification. Page extraction, browser takeover and the desktop extension are deliberately not ported.
 */
object DownloadService {
    private val client = OkHttpClient.Builder().build()
    private val pool = Executors.newFixedThreadPool(4)
    private val items = ConcurrentHashMap<String, Item>()
    private lateinit var root: File
    private var stateFile: File? = null

    @Synchronized
    fun init(context: Context) {
        if (this::root.isInitialized) return
        root = File(context.applicationContext.filesDir, "downloads")
        root.mkdirs()
        stateFile = File(root, "state.json")
        load()
    }

    @Synchronized
    fun handle(method: String, request: JSONObject): JSONObject = when (method) {
        "status" -> status()
        "downloads" -> add(request)
        "control" -> control(request)
        "formats" -> failure("Page-video extraction is not available in the mobile build.")
        else -> failure("Unsupported method.")
    }

    private fun failure(message: String): JSONObject = JSONObject().put("ok", false).put("error", message)

    @Synchronized
    private fun status(): JSONObject {
        val array = JSONArray()
        for (item in items.values) {
            array.put(JSONObject()
                .put("id", item.id)
                .put("filename", item.filename)
                .put("url", item.url)
                .put("status", item.status)
                .put("downloaded", item.downloaded.get())
                .put("total", if (item.total > 0) item.total else JSONObject.NULL)
                .put("connections", item.blocks.size)
                .put("error", item.error ?: JSONObject.NULL))
        }
        return JSONObject().put("ok", true).put("items", array)
            .put("settings", JSONObject().put("watchClipboard", false))
    }

    @Synchronized
    private fun add(request: JSONObject): JSONObject {
        val array = request.optJSONArray("urls") ?: JSONArray().put(request.optString("url", ""))
        if (array.length() == 0 || array.length() > 500) return failure("Add between 1 and 500 links.")
        val checksum = normalizeChecksum(request.optString("checksum", ""))
        if (checksum != null && array.length() != 1) return failure("A checksum can only be used with one link.")
        val ids = JSONArray()
        for (i in 0 until array.length()) {
            val url = validateUrl(array.optString(i, "")) ?: return failure("Only HTTP and HTTPS links are supported.")
            var name = safeName(request.optString("filename", ""))
            if (name.isEmpty()) name = nameFromUrl(url)
            val item = Item(UUID.randomUUID().toString(), url, name, checksum)
            items[item.id] = item
            ids.put(item.id)
            pool.execute { start(item) }
        }
        persist()
        return JSONObject().put("ok", true).put("ids", ids)
    }

    @Synchronized
    private fun control(request: JSONObject): JSONObject {
        val item = items[request.optString("id", "")] ?: return failure("Download not found.")
        when (request.optString("action", "")) {
            "pause" -> {
                item.cancelled.set(true)
                item.generation++
                item.calls.values.forEach { it.cancel() }
                if (item.status != "complete") item.status = "paused"
            }
            "resume", "retry" -> {
                if (item.status == "complete") return failure("This download is already complete.")
                item.error = null
                item.cancelled.set(false)
                item.generation++
                item.status = "queued"
                pool.execute { start(item) }
            }
            "cancel" -> {
                item.cancelled.set(true)
                item.generation++
                item.calls.values.forEach { it.cancel() }
                item.status = "cancelled"
                item.blocks.forEach { it.done = 0 }
                item.downloaded.set(0)
                File(root, "${item.id}.part").delete()
            }
            else -> return failure("Unknown action.")
        }
        persist()
        return JSONObject().put("ok", true)
    }

    private fun start(item: Item) {
        if (!item.running.compareAndSet(false, true)) return
        val generation = synchronized(this) { item.generation }
        try {
            val head = client.newCall(Request.Builder().url(item.url).head().build()).execute()
            val total: Long
            val ranged: Boolean
            head.use { response ->
                if (!response.isSuccessful) throw Exception("Server returned HTTP ${response.code}.")
                total = response.header("Content-Length")?.toLongOrNull() ?: -1
                ranged = response.header("Accept-Ranges")?.equals("bytes", ignoreCase = true) == true
            }
            if (total <= 0) throw Exception("The server did not report a file size.")
            synchronized(this) {
                item.total = total
                item.error = null
                if (item.blocks.isEmpty()) {
                    var at = 0L
                    while (at < total) {
                        val end = minOf(at + BLOCK_SIZE - 1, total - 1)
                        item.blocks.add(Block(at, end))
                        at = end + 1
                    }
                }
                item.status = "downloading"
            }
            val temp = File(root, "${item.id}.part")
            RandomAccessFile(temp, "rw").use { it.setLength(total) }
            persist()

            val latch = CountDownLatch(item.blocks.size)
            for (index in item.blocks.indices) pool.execute { downloadBlock(item, index, temp, latch, generation) }
            pool.execute {
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

    private fun downloadBlock(item: Item, index: Int, temp: File, latch: CountDownLatch, generation: Int) {
        try {
            val block = synchronized(this) { item.blocks[index] }
            var attempt = 0
            while (attempt < 4 && !item.cancelled.get() && synchronized(this) { item.generation } == generation) {
                attempt++
                try {
                    val from = block.start + block.done
                    val request = Request.Builder().url(item.url).header("Range", "bytes=$from-${block.end}").build()
                    val call = client.newCall(request)
                    item.calls[index] = call
                    call.execute().use { response ->
                        if (response.code != 206) throw Exception("Server returned HTTP ${response.code} instead of a byte range.")
                        val contentRange = response.header("Content-Range") ?: ""
                        if (!contentRange.startsWith("bytes $from-")) throw Exception("Server returned an inconsistent byte range.")
                        val body = response.body ?: throw Exception("The response had no body.")
                        RandomAccessFile(temp, "rw").use { out ->
                            out.seek(from)
                            val buffer = ByteArray(BUFFER_SIZE)
                            val input = body.byteStream()
                            while (!item.cancelled.get() && synchronized(this) { item.generation } == generation) {
                                val read = input.read(buffer)
                                if (read == -1) break
                                out.write(buffer, 0, read)
                                synchronized(this) {
                                    block.done += read.toLong()
                                    item.downloaded.addAndGet(read.toLong())
                                }
                                persist()
                            }
                        }
                    }
                    item.calls.remove(index)
                    if (block.done < block.end - block.start + 1 && !item.cancelled.get()) throw Exception("Connection ended before the block finished.")
                    break
                } catch (error: Exception) {
                    item.calls.remove(index)
                    if (item.cancelled.get()) break
                    if (attempt >= 4) {
                        synchronized(this) {
                            item.status = "error"
                            item.error = error.message ?: "Block failed."
                        }
                        item.cancelled.set(true)
                        item.calls.values.forEach { it.cancel() }
                        persist()
                        break
                    }
                    Thread.sleep(400L * attempt)
                }
            }
        } finally {
            latch.countDown()
        }
    }

    private fun finish(item: Item, temp: File) {
        val expected = item.checksum
        if (expected != null && !verify(expected, temp)) {
            synchronized(this) {
                item.status = "error"
                item.error = "Checksum mismatch. The corrupted file was discarded."
                item.blocks.forEach { it.done = 0 }
                item.downloaded.set(0)
            }
            temp.delete()
            persist()
            return
        }
        val outDir = File(root, "out")
        outDir.mkdirs()
        var destination = File(outDir, item.filename)
        var suffix = 1
        while (destination.exists()) {
            val dot = item.filename.lastIndexOf('.')
            val base = if (dot > 0) item.filename.substring(0, dot) else item.filename
            val ext = if (dot > 0) item.filename.substring(dot) else ""
            destination = File(outDir, "$base ($suffix)$ext")
            suffix++
        }
        if (!temp.renameTo(destination)) {
            synchronized(this) {
                item.status = "error"
                item.error = "Could not move the finished file into place."
            }
            persist()
            return
        }
        synchronized(this) {
            item.filename = destination.name
            item.status = "complete"
            item.downloaded.set(item.total)
        }
        persist()
    }

    private fun verify(checksum: String, file: File): Boolean {
        val (algorithm, expected) = if (checksum.contains(':')) {
            val parts = checksum.split(':', limit = 2)
            parts[0].lowercase() to parts[1].lowercase()
        } else "sha256" to checksum.lowercase()
        if (algorithm != "md5" && algorithm != "sha256") return false
        val digest = MessageDigest.getInstance(if (algorithm == "md5") "MD5" else "SHA-256")
        val buffer = ByteArray(BUFFER_SIZE)
        val input = file.inputStream()
        input.use {
            while (true) {
                val read = it.read(buffer)
                if (read == -1) break
                digest.update(buffer, 0, read)
            }
        }
        return digest.digest().joinToString("") { "%02x".format(it) } == expected
    }

    private fun validateUrl(value: String): String? = try {
        val url = URL(value)
        if (url.protocol != "http" && url.protocol != "https") null
        else if (!url.userInfo.isNullOrEmpty()) null
        else url.toExternalForm()
    } catch (_: Exception) {
        null
    }

    private fun safeName(value: String): String {
        val bad = "<>:\"/\\|?*"
        var name = value.trim().map { if (it in bad || it.code < 32) '_' else it }.joinToString("")
        name = name.trimEnd('.', ' ').take(180)
        if (name.isEmpty() || name.uppercase() in setOf("CON", "PRN", "AUX", "NUL")) name = "download"
        return name
    }

    private fun nameFromUrl(url: String): String = try {
        val path = URL(url).path.substringAfterLast('/')
        safeName(URLDecoder.decode(path, "UTF-8"))
    } catch (_: Exception) {
        "download"
    }

    private fun normalizeChecksum(value: String): String? {
        val text = value.trim()
        if (text.isEmpty()) return null
        val (algorithm, hex) = if (text.contains(':')) {
            val parts = text.split(':', limit = 2)
            parts[0].lowercase() to parts[1].lowercase()
        } else "" to text.lowercase()
        val valid = (algorithm == "md5" && hex.length == 32 || algorithm == "sha256" && hex.length == 64 ||
            algorithm.isEmpty() && (hex.length == 32 || hex.length == 64)) && hex.all { it in '0'..'9' || it in 'a'..'f' }
        if (!valid) throw IllegalArgumentException("Enter a checksum as sha256:<64 hex> or md5:<32 hex>.")
        return "${if (algorithm.isEmpty()) if (hex.length == 32) "md5" else "sha256" else algorithm}:$hex"
    }

    @Synchronized
    private fun persist() {
        val file = stateFile ?: return
        val rootObject = JSONObject()
        val array = JSONArray()
        for (item in items.values) {
            val blocks = JSONArray()
            synchronized(this) {
                for (block in item.blocks) blocks.put(JSONObject().put("start", block.start).put("end", block.end).put("done", block.done))
                array.put(JSONObject()
                    .put("id", item.id).put("url", item.url).put("filename", item.filename)
                    .put("checksum", item.checksum ?: JSONObject.NULL).put("status", item.status)
                    .put("error", item.error ?: JSONObject.NULL).put("total", item.total)
                    .put("downloaded", item.downloaded.get()).put("blocks", blocks))
            }
        }
        rootObject.put("version", 1).put("downloads", array)
        val temp = File(root, "state.tmp")
        temp.writeText(rootObject.toString())
        temp.renameTo(file)
    }

    @Synchronized
    private fun load() {
        val file = stateFile ?: return
        try {
            val saved = JSONObject(file.readText())
            val savedItems = saved.optJSONArray("downloads")
            val count = savedItems?.length() ?: 0
            for (i in 0 until count) {
                val data = savedItems!!.getJSONObject(i)
                val item = Item(
                    data.optString("id"), data.optString("url"), data.optString("filename"),
                    data.optString("checksum", "").ifEmpty { null })
                item.status = when (data.optString("status")) {
                    "complete", "cancelled" -> data.optString("status")
                    else -> "paused" // anything in flight when the app closed is resumed explicitly
                }
                item.error = data.optString("error", "").ifEmpty { null }
                item.total = data.optLong("total")
                val blocks = data.optJSONArray("blocks")
                if (blocks != null) for (b in 0 until blocks.length()) {
                    val blockData = blocks.getJSONObject(b)
                    item.blocks.add(Block(blockData.optLong("start"), blockData.optLong("end"), blockData.optLong("done")))
                }
                item.downloaded.set(item.blocks.sumOf { it.done })
                items[item.id] = item
            }
        } catch (_: Exception) {
            // A corrupt state file must never prevent the app from starting.
        }
    }
}
