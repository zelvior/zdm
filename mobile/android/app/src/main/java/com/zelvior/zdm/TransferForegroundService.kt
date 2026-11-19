package com.zelvior.zdm

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import org.json.JSONObject

/** Keeps the download engine alive in the background and shows live transfer progress in the notification shade. */
class TransferForegroundService : Service() {
    private val handler = Handler(Looper.getMainLooper())
    private val channelId = "zdm-transfers"
    private val notificationId = 2701
    private var lastUpdate = 0L

    private val ticker = object : Runnable {
        override fun run() {
            updateNotification()
            handler.postDelayed(this, 1000)
        }
    }

    override fun onCreate() {
        super.onCreate()
        createChannel()
        startForeground(notificationId, buildNotification(0, 0, "ZDM is ready"))
        handler.post(ticker)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        updateNotification()
        return START_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        handler.removeCallbacks(ticker)
        super.onDestroy()
    }

    private fun createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val channel = NotificationChannel(channelId, "Downloads", NotificationManager.IMPORTANCE_LOW).apply {
            description = "Active and queued ZDM transfers"
            setSound(null, null)
        }
        getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
    }

    private fun activeSnapshot(): Triple<Int, Long, Long> = try {
        val response = DownloadService.handle("snapshot", JSONObject())
        val downloads = response.optJSONArray("downloads") ?: return Triple(0, 0, 0)
        var active = 0
        var done = 0L
        var total = 0L
        for (i in 0 until downloads.length()) {
            val item = downloads.getJSONObject(i)
            val status = item.optString("status")
            if (status in setOf("downloading", "connecting", "assembling", "queued", "scheduled", "paused")) active++
            if (status == "downloading") {
                done += item.optLong("downloaded")
                if (item.optLong("total") > 0) total += item.optLong("total")
            }
        }
        Triple(active, done, total)
    } catch (_: Exception) {
        Triple(0, 0, 0)
    }

    private fun updateNotification() {
        val now = System.currentTimeMillis()
        if (now - lastUpdate < 900) return
        lastUpdate = now
        val (active, done, total) = activeSnapshot()
        val title = if (active > 0) "ZDM · $active transfer${if (active == 1) "" else "s"}" else "ZDM"
        val detail = if (total > 0) "${percent(done, total)}% · ${done / 1048576} of ${total / 1048576} MB"
        else if (active > 0) "Downloading in background" else "No active downloads"
        val notification = buildNotification(if (total > 0) (done * 100 / total).toInt() else 0, active, "$title — $detail")
        getSystemService(NotificationManager::class.java).notify(notificationId, notification)
    }

    private fun percent(done: Long, total: Long): Int = (done * 100 / total).toInt().coerceIn(0, 100)

    private fun buildNotification(progress: Int, active: Int, text: String): Notification {
        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
            Notification.Builder(this, channelId) else Notification.Builder(this)
        builder.setSmallIcon(android.R.drawable.stat_sys_download)
            .setContentTitle("ZDM downloads")
            .setContentText(text)
            .setOngoing(active > 0)
            .setOnlyAlertOnce(true)
            .setCategory(Notification.CATEGORY_PROGRESS)
            .setVisibility(Notification.VISIBILITY_PUBLIC)
        if (progress in 1..99) builder.setProgress(100, progress, false)
        else if (active > 0) builder.setProgress(100, 0, true)
        return builder.build()
    }

    companion object {
        fun start(context: Context) {
            val intent = Intent(context, TransferForegroundService::class.java)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.startForegroundService(intent)
            else context.startService(intent)
        }
    }
}
