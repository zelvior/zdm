import UIKit
import WebKit

/// Hosts the shared mobile UI and resolves bridge calls from the WKWebView.
final class ZdmViewController: UIViewController, WKScriptMessageHandler {
    private let web = WKWebView(frame: .zero)

    override func viewDidLoad() {
        super.viewDidLoad()
        web.configuration.userContentController.add(self, name: "zdmNative")
        web.frame = view.bounds
        web.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(web)
        if let url = Bundle.main.url(forResource: "index", withExtension: "html", subdirectory: "renderer"),
           let bundleRoot = Bundle.main.resourceURL {
            web.loadFileURL(url, allowingReadAccessTo: bundleRoot)
        } else if let url = Bundle.main.url(forResource: "index", withExtension: "html") {
            web.loadFileURL(url, allowingReadAccessTo: url.deletingLastPathComponent())
        }
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let payload = message.body as? [String: Any] else {
            reply("[]", ["ok": false, "error": "Invalid bridge request."])
            return
        }
        let id = payload["id"] as? String ?? "0"
        let method = payload["method"] as? String ?? ""
        let arguments = payload["payload"] as? [String: Any] ?? [:]
        let result = DownloadService.shared.handle(method: method, payload: arguments)
        guard let data = try? JSONSerialization.data(withJSONObject: result, options: []),
              let json = String(data: data, encoding: .utf8) else {
            reply(id, ["ok": false, "error": "Could not encode the native response."])
            return
        }
        reply(id, json)
    }

    private func reply(_ id: String, _ result: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: result, options: []),
              let json = String(data: data, encoding: .utf8) else { return }
        reply(id, json)
    }

    private func reply(_ id: String, _ json: String) {
        let escapedId = id.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "'", with: "\\'")
        let escapedJson = json.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "'", with: "\\'")
        web.evaluateJavaScript("window.zdmResolve('\(escapedId)', '\(escapedJson)')")
    }
}
