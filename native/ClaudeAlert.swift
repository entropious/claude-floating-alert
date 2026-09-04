// ClaudeAlert — floating always-on-top alert panel for macOS.
//
// Draws a non-activating HUD panel in the top-right corner that stays above
// every other application, including full-screen ones, until it is clicked or
// the optional timeout expires. VS Code extensions cannot draw outside their
// own window, so this runs as a separate accessory-policy process.
//
// The window that started the session dismisses the panel by killing this
// process once it gets focus, so nothing here watches the frontmost app.
//
// Usage:
//   claude-alert --title "..." --body "..." [--subtitle "..."] [--accent orange]
//                [--timeout 0] [--folder /path] [--url vscode://…] [--bundle-id id]

import AppKit

// MARK: - Arguments

struct Options {
    var title = "Claude Code"
    var subtitle = ""
    var body = ""
    var accent = "blue"
    var timeout: Double = 0
    /// Folder to hand the app, which brings the window holding it forward.
    var folder = ""
    /// Deep link opened once that window is in front, to reveal the chat.
    var url = ""
    var bundleID = "com.microsoft.VSCode"
}

func parseArgs() -> Options {
    var o = Options()
    var args = Array(CommandLine.arguments.dropFirst())
    while let flag = args.first {
        args.removeFirst()
        let value = args.first
        func take() -> String {
            guard let v = value else { return "" }
            args.removeFirst()
            return v
        }
        switch flag {
        case "--title": o.title = take()
        case "--subtitle": o.subtitle = take()
        case "--body": o.body = take()
        case "--accent": o.accent = take()
        case "--folder": o.folder = take()
        case "--url": o.url = take()
        case "--bundle-id": o.bundleID = take()
        case "--timeout": o.timeout = Double(take()) ?? 0
        default: break
        }
    }
    return o
}

func accentColor(_ name: String) -> NSColor {
    switch name {
    case "orange": return .systemOrange
    case "red": return .systemRed
    case "green": return .systemGreen
    case "purple": return .systemPurple
    case "yellow": return .systemYellow
    default: return .systemBlue
    }
}

// MARK: - Panel

/// Borderless panel that can take clicks without pulling keyboard focus away
/// from whatever the user is typing in.
final class AlertPanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }
}

/// Background of the panel — the whole surface is the click target.
final class ClickableEffectView: NSVisualEffectView {
    var onClick: (() -> Void)?

    override func mouseDown(with event: NSEvent) {
        onClick?()
    }

    /// Swallow hits on the labels so any point of the panel triggers the click.
    override func hitTest(_ point: NSPoint) -> NSView? {
        super.hitTest(point) != nil ? self : nil
    }
}

final class Controller: NSObject {
    private let opts: Options
    private var panel: AlertPanel!
    private var dismissTimer: Timer?

    private let width: CGFloat = 450
    private var textWidth: CGFloat { width - 34 }
    /// Long commands wrap instead of being cut off, up to this many lines.
    private let bodyLines = 5
    /// Keeps a one-line alert from looking like a sliver.
    private let minHeight: CGFloat = 104

    init(opts: Options) {
        self.opts = opts
    }

    func show() {
        let accent = accentColor(opts.accent)

        let container = ClickableEffectView()
        container.onClick = { [weak self] in self?.runAction() }
        container.material = .hudWindow
        container.blendingMode = .behindWindow
        container.state = .active
        container.wantsLayer = true
        container.layer?.cornerRadius = 14
        container.layer?.cornerCurve = .continuous
        container.layer?.masksToBounds = true
        container.layer?.borderWidth = 1
        container.layer?.borderColor = accent.withAlphaComponent(0.5).cgColor

        let stripe = NSView()
        stripe.wantsLayer = true
        stripe.layer?.backgroundColor = accent.cgColor
        stripe.translatesAutoresizingMaskIntoConstraints = false

        var textViews: [NSView] = []
        textViews.append(label(opts.title, size: 14, weight: .bold, color: .labelColor, lines: 2))
        if !opts.body.isEmpty {
            textViews.append(
                label(opts.body, size: 12, weight: .regular, color: .secondaryLabelColor, lines: bodyLines)
            )
        }

        let textStack = NSStackView(views: textViews)
        textStack.orientation = .vertical
        textStack.alignment = .leading
        textStack.spacing = 3
        textStack.translatesAutoresizingMaskIntoConstraints = false

        container.addSubview(stripe)
        container.addSubview(textStack)
        var constraints: [NSLayoutConstraint] = [
            stripe.leadingAnchor.constraint(equalTo: container.leadingAnchor),
            stripe.topAnchor.constraint(equalTo: container.topAnchor),
            stripe.bottomAnchor.constraint(equalTo: container.bottomAnchor),
            stripe.widthAnchor.constraint(equalToConstant: 4),

            textStack.leadingAnchor.constraint(equalTo: container.leadingAnchor, constant: 18),
            textStack.widthAnchor.constraint(equalToConstant: textWidth),
        ]

        // The text is centred in whatever is left below the workspace name,
        // which stays pinned to the top-left corner and out of the reckoning.
        let rest = NSLayoutGuide()
        container.addLayoutGuide(rest)
        constraints += [
            rest.bottomAnchor.constraint(equalTo: container.bottomAnchor, constant: -12),
            textStack.centerYAnchor.constraint(equalTo: rest.centerYAnchor),
            textStack.topAnchor.constraint(greaterThanOrEqualTo: rest.topAnchor),
            textStack.bottomAnchor.constraint(lessThanOrEqualTo: rest.bottomAnchor),
        ]

        if opts.subtitle.isEmpty {
            constraints.append(rest.topAnchor.constraint(equalTo: container.topAnchor, constant: 12))
        } else {
            let subtitle = label(opts.subtitle, size: 11, weight: .semibold, color: accent, lines: 1)
            container.addSubview(subtitle)
            constraints += [
                subtitle.leadingAnchor.constraint(equalTo: container.leadingAnchor, constant: 18),
                subtitle.topAnchor.constraint(equalTo: container.topAnchor, constant: 12),
                subtitle.widthAnchor.constraint(equalToConstant: textWidth),
                rest.topAnchor.constraint(equalTo: subtitle.bottomAnchor, constant: 6),
            ]
        }
        NSLayoutConstraint.activate(constraints)

        container.layoutSubtreeIfNeeded()
        let height = max(container.fittingSize.height, minHeight)

        panel = AlertPanel(
            contentRect: NSRect(x: 0, y: 0, width: width, height: height),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        panel.contentView = container
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.hidesOnDeactivate = false
        panel.becomesKeyOnlyIfNeeded = true
        panel.worksWhenModal = true
        // .screenSaver sits above full-screen apps and other floating windows.
        panel.level = .screenSaver
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]

        placeBottomRight(width: width, height: height)
        panel.alphaValue = 0
        panel.orderFrontRegardless()
        NSAnimationContext.runAnimationGroup { ctx in
            ctx.duration = 0.16
            panel.animator().alphaValue = 1
        }

        if opts.timeout > 0 {
            dismissTimer = Timer.scheduledTimer(withTimeInterval: opts.timeout, repeats: false) { [weak self] _ in
                self?.dismiss()
            }
        }
    }

    private func placeBottomRight(width: CGFloat, height: CGFloat) {
        let screen = NSScreen.screens.first { $0.frame.contains(NSEvent.mouseLocation) } ?? NSScreen.main
        guard let visible = screen?.visibleFrame else { return }
        panel.setFrameOrigin(NSPoint(x: visible.maxX - width - 16, y: visible.minY + 16))
    }

    private func label(
        _ text: String,
        size: CGFloat,
        weight: NSFont.Weight,
        color: NSColor,
        lines: Int,
        alignment: NSTextAlignment = .left
    ) -> NSTextField {
        let field = NSTextField(labelWithString: text)
        field.translatesAutoresizingMaskIntoConstraints = false
        field.alignment = alignment
        field.font = .systemFont(ofSize: size, weight: weight)
        field.textColor = color
        field.lineBreakMode = .byTruncatingTail
        field.maximumNumberOfLines = lines
        field.preferredMaxLayoutWidth = textWidth
        field.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        if lines > 1 {
            // A label only wraps once the cell is told to; without this the text
            // stays on one line and everything past the width is cut off.
            field.usesSingleLineMode = false
            field.cell?.wraps = true
            field.cell?.isScrollable = false
            field.setContentCompressionResistancePriority(.defaultHigh, for: .vertical)
        }
        return field
    }

    /// Fades the panel out right away, but keeps the process alive until the
    /// window and the link have been opened — quitting first would cut them off.
    @objc private func runAction() {
        dismissTimer?.invalidate()
        NSAnimationContext.runAnimationGroup { ctx in
            ctx.duration = 0.12
            panel.animator().alphaValue = 0
        }
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            self?.openTarget()
            DispatchQueue.main.async { NSApp.terminate(nil) }
        }
    }

    /// Raise the window holding the folder, then hand it the deep link — that
    /// order is what makes the link land in the right window.
    ///
    /// Both go through `open`, which reuses the window that already has the
    /// folder; launching the app with the folder as an argument would open a
    /// second window for it instead.
    private func openTarget() {
        if !opts.folder.isEmpty {
            runOpen(["-b", opts.bundleID, opts.folder])
        }
        guard !opts.url.isEmpty else { return }
        // `open` returns before the window is actually in front, and a link
        // arriving too early finds no window to belong to — VS Code then opens
        // an empty one for it.
        Thread.sleep(forTimeInterval: opts.folder.isEmpty ? 0 : 0.6)
        runOpen([opts.url])
    }

    private func runOpen(_ arguments: [String]) {
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/usr/bin/open")
        task.arguments = arguments
        try? task.run()
        task.waitUntilExit()
    }

    @objc private func dismiss() {
        dismissTimer?.invalidate()
        NSAnimationContext.runAnimationGroup({ ctx in
            ctx.duration = 0.12
            panel.animator().alphaValue = 0
        }, completionHandler: {
            NSApp.terminate(nil)
        })
    }
}

// MARK: - Entry point

let options = parseArgs()

let app = NSApplication.shared
// .accessory: no Dock icon, no menu bar, and the panel never steals activation.
app.setActivationPolicy(.accessory)
let controller = Controller(opts: options)
controller.show()
app.run()
