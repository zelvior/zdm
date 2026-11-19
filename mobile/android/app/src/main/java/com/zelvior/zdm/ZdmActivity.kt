package com.zelvior.zdm

import android.annotation.SuppressLint
import android.app.Activity
import android.os.Bundle
import android.webkit.JavascriptInterface
import android.webkit.WebView
import android.webkit.WebViewClient
import org.json.JSONObject

/** Hosts the shared mobile UI and exposes the native bridge contract synchronously. */
class ZdmActivity : Activity() {
    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        DownloadService.init(applicationContext)
        val web = WebView(this)
        web.settings.javaScriptEnabled = true
        web.webViewClient = WebViewClient()
        web.addJavascriptInterface(Bridge(), "zdmNative")
        web.loadUrl("file:///android_asset/renderer/index.html")
        setContentView(web)
    }

    private inner class Bridge {
        @JavascriptInterface
        fun call(method: String, json: String): String {
            return try {
                DownloadService.handle(method, JSONObject(json)).toString()
            } catch (error: Exception) {
                JSONObject().put("ok", false)
                    .put("error", (error.message ?: "Invalid request.").take(700)).toString()
            }
        }
    }
}
