import AppKit
import WebKit

final class HarborMusic: NSObject, NSApplicationDelegate, WKNavigationDelegate {
    let home: URL
    private var pairingCode: String?
    private let verify: Bool
    private var window: NSWindow!
    private var player: WKWebView!
    private let unavailable = NSStackView()

    init(home: URL, pairingCode: String?, verify: Bool) {
        self.home = home
        self.pairingCode = pairingCode
        self.verify = verify
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        configureMenu()
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        configuration.limitsNavigationsToAppBoundDomains = true
        configuration.mediaTypesRequiringUserActionForPlayback = .audio
        player = WKWebView(frame: .zero, configuration: configuration)
        player.navigationDelegate = self

        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1080, height: 760),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = "Harbor Music"
        window.minSize = NSSize(width: 360, height: 420)
        window.isReleasedWhenClosed = false
        let container = NSView()
        container.wantsLayer = true
        container.layer?.backgroundColor = NSColor(srgbRed: 0.047, green: 0.063, blue: 0.086, alpha: 1).cgColor
        let title = NSTextField(labelWithString: "Harbor Music is unreachable")
        title.font = .systemFont(ofSize: 18, weight: .semibold)
        let detail = NSTextField(labelWithString: "Check your private network connection and try again.")
        unavailable.orientation = .vertical
        unavailable.alignment = .centerX
        unavailable.spacing = 12
        unavailable.appearance = NSAppearance(named: .darkAqua)
        unavailable.addArrangedSubview(title)
        unavailable.addArrangedSubview(detail)
        unavailable.addArrangedSubview(NSButton(title: "Retry", target: self, action: #selector(reload(_:))))

        [player!, unavailable].forEach { view in
            view.translatesAutoresizingMaskIntoConstraints = false
            container.addSubview(view)
        }
        NSLayoutConstraint.activate([
            player.leadingAnchor.constraint(equalTo: container.leadingAnchor),
            player.trailingAnchor.constraint(equalTo: container.trailingAnchor),
            player.topAnchor.constraint(equalTo: container.topAnchor),
            player.bottomAnchor.constraint(equalTo: container.bottomAnchor),
            unavailable.centerXAnchor.constraint(equalTo: container.centerXAnchor),
            unavailable.centerYAnchor.constraint(equalTo: container.centerYAnchor),
        ])
        window.contentView = container
        window.center()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        reload(nil)
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows: Bool) -> Bool {
        window.makeKeyAndOrderFront(nil)
        return true
    }

    private func configureMenu() {
        let bar = NSMenu()
        let app = NSMenu(title: "Harbor Music")
        app.addItem(withTitle: "About Harbor Music", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        app.addItem(.separator())
        app.addItem(withTitle: "Hide Harbor Music", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        app.addItem(withTitle: "Quit Harbor Music", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        let file = NSMenu(title: "File")
        file.addItem(withTitle: "Close Window", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        file.addItem(withTitle: "Reload Library", action: #selector(reload(_:)), keyEquivalent: "r").target = self
        file.addItem(withTitle: "Open in Browser", action: #selector(openInBrowser(_:)), keyEquivalent: "").target = self
        let edit = NSMenu(title: "Edit")
        edit.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        for menu in [app, file, edit] {
            let item = NSMenuItem()
            item.submenu = menu
            bar.addItem(item)
        }
        NSApp.mainMenu = bar
    }

    @objc private func reload(_ sender: Any?) {
        unavailable.isHidden = true
        player.isHidden = false
        player.load(URLRequest(url: home, timeoutInterval: 20))
    }

    @objc private func openInBrowser(_ sender: Any?) {
        NSWorkspace.shared.open(home)
    }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url, url.scheme == "https", url.host == home.host,
              (url.port ?? 443) == (home.port ?? 443), url.user == nil, url.password == nil,
              ["/music", "/music/"].contains(url.path), action.targetFrame?.isMainFrame == true else {
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        showConnectionFailure(error)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        showConnectionFailure(error)
    }

    private func showConnectionFailure(_ error: Error) {
        guard (error as NSError).code != NSURLErrorCancelled else { return }
        player.isHidden = true
        unavailable.isHidden = false
        if verify { print("Harbor Music could not load the private library."); fflush(stdout) }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard verify else { return }
        let code = pairingCode ?? ""
        pairingCode = nil
        webView.callAsyncJavaScript("""
            const session = async () => (await fetch('/music/api/session', {cache: 'no-store'})).json();
            if (!(await session()).paired && code) {
              const form = document.getElementById('pair-form');
              form.elements.namedItem('name').value = 'Mac · Harbor Music';
              form.elements.namedItem('code').value = code;
              form.requestSubmit();
            }
            for (let attempt = 0; attempt < 50; attempt++) {
              if ((await session()).paired && document.querySelector('#tracks .track')) {
                const catalog = await (await fetch('/music/api/tracks', {cache: 'no-store'})).json();
                return {paired: true, total: catalog.total, sharing: !document.getElementById('open-sharing').hidden};
              }
              await new Promise(resolve => setTimeout(resolve, 200));
            }
            return {paired: false};
            """, arguments: ["code": code], in: nil, in: .page) { result in
            switch result {
            case .success(let value):
                if let state = value as? [String: Any], state["paired"] as? Bool == true,
                   let total = state["total"] as? Int {
                    print("Paired Mac player loaded \(total) tracks. Sharing visible: \(state["sharing"] as? Bool == true)")
                } else { print("Mac player loaded but pairing or library verification did not finish.") }
            case .failure: print("Mac player loaded but could not verify the library.")
            }
            fflush(stdout)
        }
    }
}

let args = Set(CommandLine.arguments.dropFirst())
let code = args.contains("--pair-from-stdin") ? readLine() : nil
if args.contains("--pair-from-stdin"), code?.range(of: "^[A-F0-9]{8}$", options: .regularExpression) == nil {
    fputs("A valid one-time pairing code is required.\n", stderr)
    exit(1)
}
guard let address = Bundle.main.object(forInfoDictionaryKey: "HarborMusicURL") as? String,
      let home = URL(string: address), home.scheme == "https" else {
    fputs("The app needs a private Harbor Music HTTPS address.\n", stderr)
    exit(1)
}
let app = NSApplication.shared
let delegate = HarborMusic(home: home, pairingCode: code, verify: args.contains("--verify") || code != nil)
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
