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
//                [--timeout 0] [--folder /path] [--url vscode://…]
//                [--accept-file /path] [--bundle-id id]

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
    /// File the accept button writes for the window holding the chat, which
    /// watches for it. Empty where nothing can answer, and then the alert
    /// offers no such button.
    var acceptFile = ""
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
        case "--accept-file": o.acceptFile = take()
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
    /// The few things that answer clicks on their own; everything else is surface.
    var passthrough: [NSView] = []

    override func mouseDown(with event: NSEvent) {
        onClick?()
    }

    /// Swallow hits on the labels so any point of the panel triggers the click.
    override func hitTest(_ point: NSPoint) -> NSView? {
        guard let hit = super.hitTest(point) else { return nil }
        if passthrough.contains(where: { hit === $0 || hit.isDescendant(of: $0) }) { return hit }
        return self
    }
}

final class Controller: NSObject {
    private let opts: Options
    private var panel: AlertPanel!
    private var dismissTimer: Timer?

    private let width: CGFloat = 450
    /// An alert that closes itself needs no button; one that waits for an answer
    /// has to be dismissible without going to the chat it came from.
    private var hasClose: Bool { opts.timeout <= 0 }
    /// Only where something on the other side can answer the request.
    private var hasAccept: Bool { !opts.acceptFile.isEmpty }
    private var textWidth: CGFloat { width - 34 - (hasClose ? 26 : 0) }
    /// Long commands wrap instead of being cut off, up to this many lines.
    private let bodyLines = 5
    /// The panel is as tall as what is in it: the padding around the text is
    /// what keeps a short alert from looking like a sliver, and a minimum on top
    /// of that only shows up as a band of nothing.
    private let minHeight: CGFloat = 0

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

        let accept = hasAccept ? acceptButton() : nil
        // The button hangs over the bottom-right corner of the body, which flows
        // around it: only the last lines are cut short, the ones above keep the
        // full width. Without a body there is nothing to flow, and the button
        // gets a line of its own below the text.
        let flows = accept != nil && !opts.body.isEmpty

        var textViews: [NSView] = []
        textViews.append(label(opts.title, size: 14, weight: .bold, color: .labelColor, lines: 2))
        if !opts.body.isEmpty {
            if let accept, flows {
                let size = accept.fittingSize
                textViews.append(
                    flowingBody(opts.body, around: NSSize(width: size.width + 12, height: size.height))
                )
            } else {
                textViews.append(
                    label(opts.body, size: 12, weight: .regular, color: .secondaryLabelColor, lines: bodyLines)
                )
            }
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
        if let accept {
            container.addSubview(accept)
            container.passthrough.append(accept)
            constraints += [
                accept.trailingAnchor.constraint(equalTo: container.trailingAnchor, constant: -12),
                accept.bottomAnchor.constraint(equalTo: container.bottomAnchor, constant: -12),
            ]
        }
        if flows {
            // The hole in the body was cut for the button sitting at its bottom
            // right, so the text has to end where the button does.
            constraints += [
                rest.bottomAnchor.constraint(equalTo: container.bottomAnchor, constant: -12),
                textStack.bottomAnchor.constraint(equalTo: rest.bottomAnchor),
                textStack.topAnchor.constraint(greaterThanOrEqualTo: rest.topAnchor),
            ]
        } else {
            if let accept {
                constraints.append(rest.bottomAnchor.constraint(equalTo: accept.topAnchor, constant: -8))
            } else {
                constraints.append(
                    rest.bottomAnchor.constraint(equalTo: container.bottomAnchor, constant: -12)
                )
            }
            constraints += [
                textStack.centerYAnchor.constraint(equalTo: rest.centerYAnchor),
                textStack.topAnchor.constraint(greaterThanOrEqualTo: rest.topAnchor),
                textStack.bottomAnchor.constraint(lessThanOrEqualTo: rest.bottomAnchor),
            ]
        }

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
        if hasClose {
            let close = closeButton()
            container.addSubview(close)
            container.passthrough.append(close)
            constraints += [
                close.trailingAnchor.constraint(equalTo: container.trailingAnchor, constant: -8),
                close.topAnchor.constraint(equalTo: container.topAnchor, constant: 8),
                close.widthAnchor.constraint(equalToConstant: 30),
                close.heightAnchor.constraint(equalToConstant: 30),
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

    /// Closes the alert and nothing more: the chat stays where it is, and the
    /// event is left unanswered on purpose.
    private func closeButton() -> NSButton {
        let button = NSButton()
        button.translatesAutoresizingMaskIntoConstraints = false
        button.bezelStyle = .inline
        button.isBordered = false
        button.title = ""
        button.image = NSImage(
            systemSymbolName: "xmark",
            accessibilityDescription: "Close"
        )?.withSymbolConfiguration(.init(pointSize: 15, weight: .semibold))
        button.contentTintColor = .secondaryLabelColor
        button.imagePosition = .imageOnly
        button.target = self
        button.action = #selector(dismiss)
        button.toolTip = "Close"
        return button
    }

    /// Answers the request from here: the link picks the first option in the
    /// chat, and the panel goes away without anything coming to the front.
    private func acceptButton() -> NSButton {
        let button = NSButton()
        button.translatesAutoresizingMaskIntoConstraints = false
        button.bezelStyle = .rounded
        button.controlSize = .large
        button.title = "Accept"
        button.font = .systemFont(ofSize: 13, weight: .semibold)
        button.image = NSImage(
            systemSymbolName: "checkmark",
            accessibilityDescription: nil
        )?.withSymbolConfiguration(.init(pointSize: 11, weight: .semibold))
        button.imagePosition = .imageLeading
        button.target = self
        button.action = #selector(accept)
        button.toolTip = "Accept"
        return button
    }

    /// Like a dismissal that also answers: the file is left for the window
    /// holding the chat, nothing is brought forward, and the panel goes away.
    @objc private func accept() {
        try? Data("1".utf8).write(to: URL(fileURLWithPath: opts.acceptFile))
        dismiss()
    }

    /// Body text with a hole for the button in its bottom-right corner: the
    /// last lines stop at the button, everything above runs the full width.
    ///
    /// Where that hole goes depends on how tall the text turns out, and the
    /// height depends on the hole, so the two are settled by repeating the
    /// layout until it stops moving — which it does in a pass or two.
    private func flowingBody(_ text: String, around avoid: NSSize) -> NSTextView {
        let storage = NSTextStorage(
            string: text,
            attributes: [
                .font: NSFont.systemFont(ofSize: 12),
                .foregroundColor: NSColor.secondaryLabelColor,
            ]
        )
        let layout = NSLayoutManager()
        let box = NSTextContainer(size: NSSize(width: textWidth, height: .greatestFiniteMagnitude))
        box.lineFragmentPadding = 0
        box.maximumNumberOfLines = bodyLines
        box.lineBreakMode = .byTruncatingTail
        layout.addTextContainer(box)
        storage.addLayoutManager(layout)

        func used() -> CGFloat {
            layout.ensureLayout(for: box)
            return ceil(layout.usedRect(for: box).maxY)
        }
        var height = used()
        for _ in 0..<4 {
            box.exclusionPaths = [
                NSBezierPath(
                    rect: NSRect(
                        x: textWidth - avoid.width,
                        y: height - avoid.height,
                        width: avoid.width,
                        height: avoid.height
                    )
                )
            ]
            let next = used()
            if abs(next - height) < 0.5 { break }
            height = next
        }

        let view = NSTextView(frame: NSRect(x: 0, y: 0, width: textWidth, height: height), textContainer: box)
        view.translatesAutoresizingMaskIntoConstraints = false
        view.isEditable = false
        view.isSelectable = false
        view.drawsBackground = false
        view.textContainerInset = .zero
        NSLayoutConstraint.activate([
            view.widthAnchor.constraint(equalToConstant: textWidth),
            view.heightAnchor.constraint(equalToConstant: height),
        ])
        return view
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
        if opts.folder.isEmpty {
            // Nothing to raise by folder: activate the app itself, which brings
            // its existing windows forward without opening one.
            runOpen(["-b", opts.bundleID])
        } else {
            runOpen(["-b", opts.bundleID, opts.folder])
        }
        guard !opts.url.isEmpty else { return }
        // `open` returns before the window is actually in front, and a link
        // arriving too early finds no window to belong to — VS Code then opens
        // an empty one for it. Waiting for the app to come forward costs
        // nothing when it already is, which is the common case for a click.
        waitUntilFront()
        runOpen([opts.url])
    }

    /// Blocks until the editor is the frontmost app, or until the wait has gone
    /// on long enough to be a failure rather than a slow activation.
    private func waitUntilFront() {
        let deadline = Date().addingTimeInterval(0.5)
        while Date() < deadline {
            if NSWorkspace.shared.frontmostApplication?.bundleIdentifier == opts.bundleID { return }
            Thread.sleep(forTimeInterval: 0.1)
        }
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
