// bb Status: the menu bar item for bb agents.
//
// Hovering the item shows the panel (served by the local helper on
// 127.0.0.1); moving away hides it. Clicking pins it, so you can type a
// reply; a click elsewhere or Esc closes it. The icon animates while an agent
// works. Reads only the local status file and the local helper.
import AppKit
import WebKit
import QuartzCore

let supportDir = NSHomeDirectory() + "/Library/Application Support/bb-menubar"
let env = ProcessInfo.processInfo.environment
let port = env["BB_MENUBAR_PORT"] ?? "47615"
let statusFile = env["BB_MENUBAR_STATUS"] ?? supportDir + "/status.json"
let staleAfter: TimeInterval = 180

final class HoverView: NSView {
    var onHover: ((Bool) -> Void)?
    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        trackingAreas.forEach(removeTrackingArea)
        addTrackingArea(NSTrackingArea(rect: bounds, options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect],
                                       owner: self, userInfo: nil))
    }
    // Only watches the pointer; clicks go to the button or page underneath.
    override func hitTest(_ point: NSPoint) -> NSView? {
        let view = super.hitTest(point)
        return view === self ? nil : view
    }
    override func mouseEntered(with event: NSEvent) { onHover?(true) }
    override func mouseExited(with event: NSEvent) { onHover?(false) }
}

/// One account's limits as percent used (0 → 100, as in the panel and in bb),
/// from the helper's usage.json.
struct Account {
    let provider: String
    let machines: String
    /// Available limit resets (Codex), as the sidebar's "+1".
    let resets: Int
    let five: Double?
    let week: Double?
    let fiveReset: Date?
    let weekReset: Date?
}

func parseDate(_ text: Any?) -> Date? {
    guard let text = text as? String else { return nil }
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let date = formatter.date(from: text) { return date }
    formatter.formatOptions = [.withInternetDateTime]
    return formatter.date(from: text)
}

/// "1ч 46м", "38м", "2д 3ч" — as in the sidebar's usage rings.
func untilText(_ date: Date?) -> String {
    guard let date = date else { return "" }
    let minutes = Int(date.timeIntervalSinceNow / 60)
    if minutes <= 0 { return "↻" }
    if minutes < 60 { return "↻\(minutes)м" }
    if minutes < 1440 { return "↻\(minutes / 60)ч\(minutes % 60 > 0 ? " \(minutes % 60)м" : "")" }
    return "↻\(minutes / 1440)д \(minutes % 1440 / 60)ч"
}

struct Part {
    let symbol: String
    let color: NSColor
    let count: Int
    let spins: Bool
}

final class Controller: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
    let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    let popover = NSPopover()
    var web: WKWebView!
    var buttonHover: HoverView!
    var pinned = false
    var overButton = false
    var overPanel = false
    var showTimer: Timer?
    var hideTimer: Timer?
    /// The running symbol spins on its own layer (Core Animation, off the main
    /// thread's drawing); the rest of the title is redrawn only on change.
    var spinLayer: CALayer?
    var lastSignature = ""
    var parts: [Part] = []
    /// The busiest account's 5-hour and weekly use, in percent (nil: not reported).
    var accounts: [Account] = []
    var clickMonitor: Any?
    var keyMonitor: Any?
    var loaded = false
    var panelURL = URL(string: "about:blank")!

    func start() {
        // launchd keeps the observer alive; the menu item follows BB Desktop.
        item.isVisible = false
        for event in [NSWorkspace.didLaunchApplicationNotification,
                      NSWorkspace.didTerminateApplicationNotification] {
            NSWorkspace.shared.notificationCenter.addObserver(
                self, selector: #selector(workspaceChanged(_:)), name: event, object: nil)
        }
        let token = ((try? String(contentsOfFile: supportDir + "/token")) ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let config = WKWebViewConfiguration()
        config.userContentController.add(self, name: "bb")
        let frame = NSRect(x: 0, y: 0, width: 840, height: 660)
        web = WKWebView(frame: frame, configuration: config)
        web.navigationDelegate = self
        web.autoresizingMask = [.width, .height]
        let container = HoverView(frame: frame)
        container.addSubview(web)
        container.onHover = { [weak self] inside in self?.panelHover(inside) }
        let controller = NSViewController()
        controller.view = container
        popover.contentViewController = controller
        popover.contentSize = frame.size
        popover.behavior = .applicationDefined
        popover.animates = false

        if let button = item.button {
            button.target = self
            button.action = #selector(clicked)
            button.sendAction(on: [.leftMouseUp, .rightMouseUp])
            buttonHover = HoverView(frame: button.bounds)
            buttonHover.autoresizingMask = [.width, .height]
            buttonHover.onHover = { [weak self] inside in self?.buttonHovered(inside) }
            button.addSubview(buttonHover)
        }
        panelURL = URL(string: "http://127.0.0.1:\(port)/?t=\(token)&native=1")!
        web.load(URLRequest(url: panelURL))
        refresh()
        Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in self?.refresh() }
    }

    // MARK: panel

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { loaded = true }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        retryLoad()
    }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { retryLoad() }
    func retryLoad() {
        // The helper starts from bb in a terminal on this Mac; until it answers,
        // say so instead of showing a blank panel, and keep trying.
        loaded = false
        web.loadHTMLString("""
        <html><body style="margin:0;height:100vh;display:flex;align-items:center;justify-content:center;
        font:13px -apple-system;color:#8e8e93;background:transparent;text-align:center">
        <div><b style="font-size:15px;color:#555">Подключаюсь к bb…</b><br><br>
        Панель появится, когда bb на сервере запустит помощник на этом Mac.<br>
        Обычно это занимает до минуты.</div></body></html>
        """, baseURL: nil)
        DispatchQueue.main.asyncAfter(deadline: .now() + 3) { [weak self] in
            guard let self = self else { return }
            self.web.load(URLRequest(url: self.panelURL))
        }
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any], let type = body["type"] as? String else { return }
        switch type {
        case "size":
            if let width = body["w"] as? Double, let height = body["h"] as? Double {
                popover.contentSize = NSSize(width: width, height: height)
            }
        case "pin":
            pin()
        case "close":
            close()
        default:
            break
        }
    }

    func buttonHovered(_ inside: Bool) {
        overButton = inside
        if inside {
            hideTimer?.invalidate()
            if !popover.isShown {
                showTimer?.invalidate()
                showTimer = Timer.scheduledTimer(withTimeInterval: 0.12, repeats: false) { [weak self] _ in
                    if self?.overButton == true { self?.show() }
                }
            }
        } else {
            showTimer?.invalidate()
            scheduleHide()
        }
    }

    func panelHover(_ inside: Bool) {
        overPanel = inside
        if inside { hideTimer?.invalidate() } else { scheduleHide() }
    }

    func scheduleHide() {
        guard popover.isShown, !pinned else { return }
        hideTimer?.invalidate()
        hideTimer = Timer.scheduledTimer(withTimeInterval: 0.35, repeats: false) { [weak self] _ in
            guard let self = self, !self.pinned, !self.overButton, !self.overPanel else { return }
            self.close()
        }
    }

    func show() {
        guard let button = item.button, !popover.isShown else { return }
        popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
        web.evaluateJavaScript("window.bbShown && window.bbShown()", completionHandler: nil)
    }

    /// Keeps the panel open and lets it take the keyboard, for typing a reply.
    func pin() {
        if !popover.isShown { show() }
        pinned = true
        hideTimer?.invalidate()
        NSApp.activate(ignoringOtherApps: true)
        popover.contentViewController?.view.window?.makeKey()
        if clickMonitor == nil {
            clickMonitor = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown]) { [weak self] _ in
                self?.close()
            }
        }
        if keyMonitor == nil {
            keyMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
                if event.keyCode == 53 {  // Esc: the page closes its chat first, then asks to close.
                    self?.web.evaluateJavaScript("window.bbEscape && window.bbEscape()", completionHandler: nil)
                    return nil
                }
                return event
            }
        }
    }

    func close() {
        pinned = false
        hideTimer?.invalidate()
        if let monitor = clickMonitor { NSEvent.removeMonitor(monitor); clickMonitor = nil }
        if let monitor = keyMonitor { NSEvent.removeMonitor(monitor); keyMonitor = nil }
        if popover.isShown {
            popover.performClose(nil)
            web.evaluateJavaScript("window.bbHidden && window.bbHidden()", completionHandler: nil)
        }
    }

    @objc func clicked() {
        if NSApp.currentEvent?.type == .rightMouseUp {
            let menu = NSMenu()
            menu.addItem(withTitle: "Открыть bb", action: #selector(openBB), keyEquivalent: "").target = self
            menu.addItem(withTitle: "Обновить панель", action: #selector(reloadPanel), keyEquivalent: "").target = self
            menu.addItem(.separator())
            menu.addItem(withTitle: "Скрыть до перезапуска", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "")
            close()
            item.menu = menu
            item.button?.performClick(nil)
            item.menu = nil
            return
        }
        if popover.isShown && pinned { close() } else { pin() }
    }

    @objc func openBB() { NSWorkspace.shared.open(URL(fileURLWithPath: "/Applications/bb.app")) }
    @objc func reloadPanel() { web.reload() }

    // MARK: menu bar title

    @objc func workspaceChanged(_ notification: Notification) {
        guard let app = notification.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication,
              app.bundleIdentifier == "dev.bb.desktop" else { return }
        refresh()
    }

    func syncVisibility() {
        let desktopRunning = NSWorkspace.shared.runningApplications.contains {
            $0.bundleIdentifier == "dev.bb.desktop" && !$0.isTerminated
        }
        guard item.isVisible != desktopRunning else { return }
        if !desktopRunning {
            showTimer?.invalidate()
            hideTimer?.invalidate()
            overButton = false
            overPanel = false
            close()
        } else {
            // Rebuild the image when BB relaunches, even if counts are unchanged.
            lastSignature = ""
            draw()
        }
        item.isVisible = desktopRunning
        NSLog("bb Status: BB Desktop %@; menu item %@", desktopRunning ? "running" : "stopped",
              desktopRunning ? "shown" : "hidden")
    }

    func refresh() {
        var next: [Part] = []
        let grey = NSColor.systemGray
        if let data = FileManager.default.contents(atPath: statusFile),
           let feed = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] {
            let generated = (feed["generatedAt"] as? Double ?? 0) / 1000
            let counts = feed["counts"] as? [String: Int] ?? [:]
            if Date().timeIntervalSince1970 - generated > staleAfter {
                next = [Part(symbol: "wifi.slash", color: grey, count: 0, spins: false)]
            } else {
                let live: [(String, String, NSColor, Bool)] = [
                    ("needs", "exclamationmark.bubble.fill", .systemOrange, false),
                    ("error", "xmark.octagon.fill", .systemRed, false),
                    ("running", "arrow.triangle.2.circlepath", .systemBlue, true),
                ]
                for (key, symbol, color, spins) in live where (counts[key] ?? 0) > 0 {
                    next.append(Part(symbol: symbol, color: color, count: counts[key]!, spins: spins))
                }
                if next.isEmpty {
                    let unread = counts["unread"] ?? 0
                    next = [unread > 0
                        ? Part(symbol: "circle.fill", color: .systemGreen, count: unread, spins: false)
                        : Part(symbol: "checkmark.circle", color: grey, count: 0, spins: false)]
                }
            }
        } else {
            next = [Part(symbol: "wifi.slash", color: grey, count: 0, spins: false)]
        }
        parts = next
        accounts = readAccounts()
        draw()
        // Polling also catches a missed workspace notification after sleep.
        syncVisibility()
    }

    /// Like the sidebar's usage rings: the account closest to its limit.
    func readAccounts() -> [Account] {
        guard let data = FileManager.default.contents(atPath: supportDir + "/usage.json"),
              let usage = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let at = usage["at"] as? Double, Date().timeIntervalSince1970 - at / 1000 < 15 * 60,
              let list = usage["accounts"] as? [[String: Any]] else { return [] }
        var result: [Account] = []
        for account in list {
            var five: Double? = nil, week: Double? = nil
            var fiveReset: Date? = nil, weekReset: Date? = nil
            for window in account["windows"] as? [[String: Any]] ?? [] {
                let used = min(100, max(0, window["usedPercent"] as? Double ?? 0))
                if window["kind"] as? String == "five-hour" { five = used; fiveReset = parseDate(window["resetsAt"]) }
                if window["kind"] as? String == "weekly" { week = used; weekReset = parseDate(window["resetsAt"]) }
            }
            if five == nil && week == nil { continue }
            // A machine's initial: "server" → S, "MacBook Pro — …" → M; one per machine.
            var letters = ""
            for host in account["hosts"] as? [String] ?? [] {
                if let first = host.trimmingCharacters(in: .whitespaces).first {
                    let letter = String(first).uppercased()
                    if !letters.contains(letter) { letters += letter }
                }
            }
            result.append(Account(provider: account["provider"] as? String ?? "", machines: letters,
                                  resets: account["resets"] as? Int ?? 0,
                                  five: five, week: week, fiveReset: fiveReset, weekReset: weekReset))
        }
        let order = ["claude-code": 0, "codex": 1]
        return result.sorted { (order[$0.provider] ?? 9, $0.machines) < (order[$1.provider] ?? 9, $1.machines) }
    }

    /// Usage colour, as in the panel: orange from 90 % used, light red when used up.
    func tone(_ used: Double, _ ink: NSColor) -> NSColor {
        used >= 100 ? NSColor(red: 1, green: 0.55, blue: 0.5, alpha: 1) : used >= 90 ? .systemOrange : ink
    }

    func agentGlyph(_ provider: String, at origin: NSPoint, _ ink: NSColor) {
        let side: CGFloat = 6.5
        let center = NSPoint(x: origin.x + side / 2, y: origin.y + side / 2)
        let path = NSBezierPath()
        if provider == "claude-code" {
            for index in 0..<4 {
                let angle = CGFloat(index) * .pi / 4
                path.move(to: NSPoint(x: center.x - cos(angle) * 3.1, y: center.y - sin(angle) * 3.1))
                path.line(to: NSPoint(x: center.x + cos(angle) * 3.1, y: center.y + sin(angle) * 3.1))
            }
            path.lineWidth = 1
            path.lineCapStyle = .round
            NSColor(red: 0.85, green: 0.47, blue: 0.34, alpha: 1).setStroke()
        } else {
            for index in 0..<6 {
                let angle = CGFloat(index) * .pi / 3 + .pi / 6
                let point = NSPoint(x: center.x + cos(angle) * 3.2, y: center.y + sin(angle) * 3.2)
                if index == 0 { path.move(to: point) } else { path.line(to: point) }
            }
            path.close()
            for index in [1, 3, 5] {
                let angle = CGFloat(index) * .pi / 3 + .pi / 6
                path.move(to: center)
                path.line(to: NSPoint(x: center.x + cos(angle) * 3.2, y: center.y + sin(angle) * 3.2))
            }
            path.lineWidth = 0.8
            ink.setStroke()
        }
        path.stroke()
    }

    /// Usage block, as chosen from the mock-ups (3c, P2): per agent a glyph in
    /// the label row, per account a thick bar (5 hours) and a thin one (week),
    /// both filling up from 0 to 100 % used, with the machine's initial
    /// underneath; then the time until the reset of the fullest bar.
    func usageBlock(_ ink: NSColor, compact: Bool, includeTimer: Bool = true) -> (image: NSImage, signature: String)? {
        guard !accounts.isEmpty else { return nil }
        let height: CGFloat = 22, barY: CGFloat = 8, barHeight: CGFloat = 13
        let letterFont = NSFont.systemFont(ofSize: 6.5, weight: .semibold)
        struct Column { let account: Account; let x: CGFloat; let width: CGFloat; let label: NSAttributedString }
        var columns: [Column] = []
        var glyphs: [(String, CGFloat)] = []
        var separators: [CGFloat] = []
        var x: CGFloat = 0
        var previous = ""
        for account in accounts {
            if account.provider != previous {
                if !previous.isEmpty {
                    separators.append(x + (compact ? 2 : 3))
                    x += compact ? 4.5 : 6.5
                }
                glyphs.append((account.provider, x))
                x += 8
                previous = account.provider
            } else {
                x += compact ? 2 : 3.5
            }
            let label = NSMutableAttributedString(string: compact ? "" : account.machines, attributes: [
                .font: letterFont, .foregroundColor: ink.withAlphaComponent(0.85), .kern: 0.3])
            if !compact && account.resets > 0 {
                label.append(NSAttributedString(string: "+\(account.resets)", attributes: [
                    .font: NSFont.systemFont(ofSize: 6.5, weight: .heavy),
                    .foregroundColor: NSColor(red: 0.45, green: 0.95, blue: 0.6, alpha: 1)]))
            }
            let bars: CGFloat = (account.five != nil ? 3 + 1.5 : 0) + 1.5
            let width = max(bars, ceil(label.size().width))
            columns.append(Column(account: account, x: x, width: width, label: label))
            x += width
        }
        // Which reset matters: the most used 5-hour window; if that account's
        // week is used up too, its 5-hour reset does not help, so the week's.
        // Without 5-hour windows, the most used week.
        var shown: (used: Double, reset: Date?)? = nil
        if let account = accounts.filter({ $0.five != nil }).max(by: { $0.five! < $1.five! }) {
            if let week = account.week, week >= 100 { shown = (100, account.weekReset) }
            else { shown = (account.five!, account.fiveReset) }
        } else if let account = accounts.filter({ $0.week != nil }).max(by: { $0.week! < $1.week! }) {
            shown = (account.week!, account.weekReset)
        }
        var timer: NSAttributedString? = nil
        var badge: NSColor? = nil
        let badgePadding: CGFloat = compact ? 4 : 8
        if includeTimer, let shown = shown, shown.reset != nil {
            let calm = shown.used < 90
            // Red or orange text is hard to read on the menu bar: an alert is
            // white text on a coloured badge instead.
            badge = calm ? nil : (shown.used >= 100 ? NSColor(red: 0.93, green: 0.23, blue: 0.2, alpha: 1)
                                                  : NSColor(red: 0.96, green: 0.55, blue: 0.05, alpha: 1))
            let time = untilText(shown.reset)
            timer = NSAttributedString(string: compact ? time.replacingOccurrences(of: " ", with: "") : time, attributes: [
                .font: NSFont.monospacedDigitSystemFont(ofSize: 9.5, weight: calm ? .regular : .bold),
                .foregroundColor: calm ? ink.withAlphaComponent(0.75) : NSColor.white])
            x += (compact ? 3 : 4.5) + ceil(timer!.size().width) + (badge != nil ? badgePadding : 0)
        }
        let signature = columns.map { "\($0.account.machines)+\($0.account.resets):\(Int($0.account.five ?? -1)):\(Int($0.account.week ?? -1))" }
            .joined(separator: ",") + "|" + (timer?.string ?? "")
        let image = NSImage(size: NSSize(width: ceil(x), height: height), flipped: false) { _ in
            // Fills from the bottom as the limit is used: empty at 0 %, full at 100 %.
            func bar(_ x: CGFloat, _ width: CGFloat, _ used: Double) {
                let track = NSRect(x: x, y: barY, width: width, height: barHeight)
                let shape = NSBezierPath(roundedRect: track, xRadius: width / 2, yRadius: width / 2)
                ink.withAlphaComponent(0.28).setFill()
                shape.fill()
                guard used > 0 else { return }
                NSGraphicsContext.saveGraphicsState()
                shape.addClip()
                self.tone(used, ink).setFill()
                NSRect(x: x, y: barY, width: width, height: max(1, barHeight * CGFloat(used) / 100)).fill()
                NSGraphicsContext.restoreGraphicsState()
            }
            for column in columns {
                let bars: CGFloat = (column.account.five != nil ? 3 + 1.5 : 0) + 1.5
                var bx = column.x + (column.width - bars) / 2
                if let five = column.account.five { bar(bx, 3, five); bx += 4.5 }
                if let week = column.account.week { bar(bx, 1.5, week) }
                let labelWidth = column.label.size().width
                column.label.draw(at: NSPoint(x: column.x + (column.width - labelWidth) / 2, y: -0.5))
            }
            for (provider, gx) in glyphs { self.agentGlyph(provider, at: NSPoint(x: gx, y: 0.3), ink) }
            for sx in separators {
                ink.withAlphaComponent(0.35).setFill()
                NSRect(x: sx, y: 2, width: 0.6, height: 18).fill()
            }
            if let timer = timer {
                let size = timer.size()
                if let badge = badge {
                    let pillWidth = ceil(size.width) + badgePadding
                    let pill = NSRect(x: x - pillWidth, y: (height - 14) / 2, width: pillWidth, height: 14)
                    badge.setFill()
                    NSBezierPath(roundedRect: pill, xRadius: 7, yRadius: 7).fill()
                    timer.draw(at: NSPoint(x: pill.minX + badgePadding / 2, y: (height - size.height) / 2))
                } else {
                    timer.draw(at: NSPoint(x: x - ceil(size.width), y: (height - size.height) / 2))
                }
            }
            return true
        }
        return (image, signature)
    }

    func symbol(_ name: String, _ color: NSColor) -> NSImage? {
        guard let base = NSImage(systemSymbolName: name, accessibilityDescription: nil)?
            .withSymbolConfiguration(NSImage.SymbolConfiguration(pointSize: 12, weight: .semibold)) else { return nil }
        let side: CGFloat = 16
        return NSImage(size: NSSize(width: side, height: side), flipped: false) { rect in
            let size = base.size
            let target = NSRect(x: (side - size.width) / 2, y: (side - size.height) / 2,
                                width: size.width, height: size.height)
            base.draw(in: target)
            color.set()
            target.fill(using: .sourceAtop)
            return true
        }
    }

    func draw() {
        guard let button = item.button else { return }
        let dark = button.effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
        let ink = dark ? NSColor.white : NSColor.black
        let logo = NSAttributedString(string: "bb", attributes: [
            .font: NSFont.systemFont(ofSize: 14, weight: .bold), .foregroundColor: ink])
        let digits: [NSAttributedString.Key: Any] = [
            .font: NSFont.monospacedDigitSystemFont(ofSize: 12.5, weight: .semibold), .foregroundColor: ink]
        let logoWidth = ceil(logo.size().width) + 2
        let pieces: [(NSImage?, NSAttributedString?)] = parts.map { part in
            let image = symbol(part.symbol, part.color)
            let count = part.count > 0 ? NSAttributedString(string: "\(part.count)", attributes: digits) : nil
            return (image, count)
        }

        func statusWidth(symbolSide: CGFloat, partGap: CGFloat, countGap: CGFloat) -> CGFloat {
            pieces.reduce(logoWidth) { width, piece in
                width + partGap + symbolSide + (piece.1.map { countGap + ceil($0.size().width) } ?? 0)
            }
        }

        // macOS can hide the whole item if its image is too wide for a crowded menu bar.
        // Leave room for the margins AppKit adds around the image.
        let maxImageWidth: CGFloat = 180
        let fullUsage = usageBlock(ink, compact: false)
        let fullUsageWidth = fullUsage.map { 9 + $0.image.size.width } ?? 0
        let compact = statusWidth(symbolSide: 16, partGap: 5, countGap: 2) + fullUsageWidth > maxImageWidth
        let symbolSide: CGFloat = compact ? 14 : 16
        let partGap: CGFloat = compact ? 2 : 5
        let countGap: CGFloat = compact ? 1 : 2
        let usageGap: CGFloat = compact ? 4 : 9
        let countsWidth = statusWidth(symbolSide: symbolSide, partGap: partGap, countGap: countGap)
        let availableUsageWidth = maxImageWidth - countsWidth - usageGap
        var usage = compact ? usageBlock(ink, compact: true) : fullUsage
        if let block = usage, block.image.size.width > availableUsageWidth {
            usage = usageBlock(ink, compact: true, includeTimer: false)
        }
        if let block = usage, block.image.size.width > availableUsageWidth {
            usage = nil
        }
        let width = countsWidth + (usage.map { usageGap + $0.image.size.width } ?? 0)
        let signature = "\(dark)|\(compact)|" + parts.map { "\($0.symbol):\($0.count)" }.joined(separator: ",")
            + "|\(usage?.signature ?? "")"
        if signature == lastSignature { return }
        lastSignature = signature
        let height: CGFloat = 22
        var spinX: CGFloat? = nil
        var spinImage: NSImage? = nil
        var x0: CGFloat = 1 + ceil(logo.size().width) + 1
        for (index, (symbolImage, count)) in pieces.enumerated() {
            x0 += partGap
            if parts[index].spins { spinX = x0; spinImage = symbolImage }
            x0 += symbolSide + (count.map { countGap + ceil($0.size().width) } ?? 0)
        }
        let image = NSImage(size: NSSize(width: width, height: height), flipped: false) { _ in
            var x: CGFloat = 1
            logo.draw(at: NSPoint(x: x, y: (height - logo.size().height) / 2))
            x += ceil(logo.size().width) + 1
            for (index, (symbolImage, count)) in pieces.enumerated() {
                x += partGap
                // The spinning symbol is drawn by its own layer instead.
                if !self.parts[index].spins {
                    symbolImage?.draw(in: NSRect(x: x, y: (height - symbolSide) / 2, width: symbolSide, height: symbolSide))
                }
                x += symbolSide
                if let count = count {
                    x += countGap
                    count.draw(at: NSPoint(x: x, y: (height - count.size().height) / 2))
                    x += ceil(count.size().width)
                }
            }
            if let usage = usage {
                x += usageGap
                usage.image.draw(at: NSPoint(x: x, y: 0), from: .zero, operation: .sourceOver, fraction: 1)
            }
            return true
        }
        let scale = button.window?.backingScaleFactor ?? 2
        button.image = rasterize(image, scale: scale)
        button.title = ""
        button.superview?.layoutSubtreeIfNeeded()
        placeSpinner(spinImage.map { rasterize($0, scale: scale) }, at: spinX,
                     imageWidth: width, symbolSide: symbolSide, scale: scale)
    }

    /// Draws a drawing-handler image once into a bitmap, so redraws are a copy.
    func rasterize(_ image: NSImage, scale: CGFloat) -> NSImage {
        guard let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(ceil(image.size.width * scale)),
                                         pixelsHigh: Int(ceil(image.size.height * scale)), bitsPerSample: 8,
                                         samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                                         colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0) else { return image }
        rep.size = image.size
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
        image.draw(in: NSRect(origin: .zero, size: image.size))
        NSGraphicsContext.restoreGraphicsState()
        let out = NSImage(size: image.size)
        out.addRepresentation(rep)
        return out
    }

    func placeSpinner(_ image: NSImage?, at slot: CGFloat?, imageWidth: CGFloat, symbolSide: CGFloat, scale: CGFloat) {
        guard let button = item.button else { return }
        guard let image = image, let slot = slot else {
            spinLayer?.removeFromSuperlayer()
            spinLayer = nil
            return
        }
        button.wantsLayer = true
        let layer: CALayer
        if let existing = spinLayer {
            layer = existing
        } else {
            layer = CALayer()
            let spin = CABasicAnimation(keyPath: "transform.rotation.z")
            spin.fromValue = 0
            spin.toValue = -2 * Double.pi
            spin.duration = 1.4
            spin.repeatCount = .infinity
            spin.isRemovedOnCompletion = false
            layer.add(spin, forKey: "spin")
            button.layer?.addSublayer(layer)
            spinLayer = layer
        }
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        layer.contentsScale = scale
        layer.contents = image
        // The button centres its image.
        let left = (button.bounds.width - imageWidth) / 2
        layer.bounds = CGRect(x: 0, y: 0, width: symbolSide, height: symbolSide)
        layer.position = CGPoint(x: left + slot + symbolSide / 2, y: button.bounds.height / 2)
        CATransaction.commit()
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
// Not visible, but gives the reply field copy, paste, undo and select-all.
let mainMenu = NSMenu()
let editItem = NSMenuItem()
let editMenu = NSMenu(title: "Edit")
editMenu.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
editMenu.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "Z")
editMenu.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
editMenu.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
editMenu.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
editMenu.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
editItem.submenu = editMenu
mainMenu.addItem(editItem)
app.mainMenu = mainMenu
let controller = Controller()
controller.start()
app.run()
