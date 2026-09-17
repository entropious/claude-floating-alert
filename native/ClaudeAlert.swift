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
//                [--ask-file /path] [--ask-click json] [--ask-accept json]
//                [--body-html "<div>…"] [--commands-html "<div>…"] [--report]
//                [--log-file /path]
//                [--bundle-id id]
//
// A caller that raised the panel itself can hand over the text already coloured
// and ask for `--report`, and then what was pressed comes back on standard
// output instead of through a file some window has to be watching.

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
    /// Deep link opened once that window is in front, to reveal the chat. Used
    /// where no window could be named, and empty when there is none to tell.
    var url = ""
    /// File the window holding the chat watches, and what to leave in it: on a
    /// click on the panel, and on the accept button. An empty body means that
    /// way in is not offered — no button for the second one.
    var askFile = ""
    var askClick = ""
    var askAccept = ""
    /// Log to open from the panel. Handed over only when something went wrong
    /// putting the alert together, and then the panel offers a way to see what.
    var logFile = ""
    /// The commands of the line being asked about, each marked `+` where the
    /// user has already allowed it and `-` where they have not.
    var commands = ""
    /// The same two things already coloured, for a caller that knows the line
    /// better than the panel can. The panel understands no shell grammar and no
    /// editor theme; whoever does hands over marked-up text, and it is drawn as
    /// given. Empty means the panel falls back to what it can work out itself.
    var bodyHTML = ""
    var commandsHTML = ""
    /// Say what was pressed on standard output instead of only leaving it in a
    /// file. For a caller that started the panel itself there is nothing to
    /// arrange: the answer comes back down the pipe it already holds, and no
    /// window has to be watching a directory for it.
    var report = false
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
        case "--ask-file": o.askFile = take()
        case "--ask-click": o.askClick = take()
        case "--ask-accept": o.askAccept = take()
        case "--log-file": o.logFile = take()
        case "--commands": o.commands = take()
        case "--body-html": o.bodyHTML = take()
        case "--commands-html": o.commandsHTML = take()
        case "--report": o.report = true
        case "--bundle-id": o.bundleID = take()
        case "--timeout": o.timeout = Double(take()) ?? 0
        default: break
        }
    }
    return o
}

/// How the hook marks a line about what went wrong while the alert was put
/// together, so the panel can tell those from the event itself.
let TROUBLE_MARK = "\u{26A0} "
/// What the hook puts between the tool and what it is about to do.
let TOOL_MARK = " \u{00B7} "

/// A command the rules already allow: the colour a command has anyway, so that
/// only what is being asked about stands out.
let COMMAND_ALLOWED = NSColor(srgbRed: 0.38, green: 0.69, blue: 0.94, alpha: 1)
/// A command no rule allows — what the request is being shown for.
let COMMAND_ASKED = NSColor(srgbRed: 1.0, green: 0.55, blue: 0.53, alpha: 1)
/// Nothing in the line is new: the whole of it has been allowed already.
let COMMAND_SETTLED = NSColor(srgbRed: 0.60, green: 0.76, blue: 0.47, alpha: 1)

/// The panel paints its own background instead of blending with whatever is
/// behind it. The text and the command colours above are picked for a dark
/// surface, and over a light window a translucent one leaves them unreadable.
let PANEL_BACKGROUND = NSColor(srgbRed: 0.13, green: 0.13, blue: 0.14, alpha: 1)

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
final class ClickableSurface: NSView {
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

/// Wraps the text it is given into one click target of its own, so a click on
/// the command unfolds it instead of going where a click on the panel goes.
final class ClickableBox: NSView {
    var onClick: (() -> Void)?

    override func mouseDown(with event: NSEvent) {
        onClick?()
    }

    override func hitTest(_ point: NSPoint) -> NSView? {
        super.hitTest(point) == nil ? nil : self
    }
}

final class Controller: NSObject {
    private let opts: Options
    private var panel: AlertPanel!
    private var dismissTimer: Timer?
    /// Kept alive for as long as the panel is: a signal source stops on release.
    private var presses: [DispatchSourceSignal] = []

    private let width: CGFloat = 450
    /// An alert that closes itself needs no button; one that waits for an answer
    /// has to be dismissible without going to the chat it came from.
    private var hasClose: Bool { opts.timeout <= 0 }
    /// Only where something on the other side can answer the request.
    private var hasAccept: Bool {
        (!opts.askFile.isEmpty || opts.report) && !opts.askAccept.isEmpty && !acceptExpired
    }
    /// Whether the answer button has stood past its use.
    private var acceptExpired = false
    /// Only where the alert has something to explain.
    private var hasLog: Bool { !opts.logFile.isEmpty }
    private var textWidth: CGFloat { width - 34 - (hasClose ? 26 : 0) }
    /// Whether the whole command is on screen, or only its first lines.
    private var expanded = false
    /// Long commands wrap instead of being cut off, up to this many lines —
    /// as many as the screen holds once the alert has been expanded.
    private var bodyLines: Int { expanded ? expandedLines : collapsedLines }
    private let collapsedLines = 5
    /// The body is the command about to run, and it is what the alert is read
    /// for — the title above it only says which kind of event this is. A shade
    /// off the full label colour keeps the title first all the same.
    private let bodyColor = NSColor.labelColor.withAlphaComponent(0.82)
    /// A command longer than the screen is cut off even expanded; the whole of
    /// it is in the chat, and the alert is not where it gets read.
    private var expandedLines: Int {
        let screen = NSScreen.screens.first { $0.frame.contains(NSEvent.mouseLocation) } ?? NSScreen.main
        let room = (screen?.visibleFrame.height ?? 800) * 0.7 - 90
        return max(collapsedLines, Int(room / 15))
    }
    /// Whether there is a line to show at all. It can arrive as plain text or
    /// already coloured, and either one is a body.
    private var hasBody: Bool { !opts.body.isEmpty || !opts.bodyHTML.isEmpty }
    /// A body that does not fit its five lines gets an arrow to unfold it.
    private lazy var hasExpand: Bool = {
        guard !opts.body.isEmpty else { return false }
        return lines(opts.body, width: textWidth) > collapsedLines
    }()
    /// The panel is as tall as what is in it: the padding around the text is
    /// what keeps a short alert from looking like a sliver, and a minimum on top
    /// of that only shows up as a band of nothing.
    private let minHeight: CGFloat = 0

    init(opts: Options) {
        self.opts = opts
    }

    private func content() -> ClickableSurface {
        let accent = accentColor(opts.accent)

        let container = ClickableSurface()
        container.onClick = { [weak self] in self?.runAction() }
        // Label and control colours resolve against the view they are drawn in,
        // and on a dark surface they have to be the dark-mode ones whatever the
        // rest of the system is set to.
        container.appearance = NSAppearance(named: .darkAqua)
        container.wantsLayer = true
        container.layer?.backgroundColor = PANEL_BACKGROUND.cgColor
        container.layer?.cornerRadius = 14
        container.layer?.cornerCurve = .continuous
        container.layer?.masksToBounds = true
        container.layer?.borderWidth = 1
        container.layer?.borderColor = accent.withAlphaComponent(0.5).cgColor

        let stripe = NSView()
        stripe.wantsLayer = true
        stripe.layer?.backgroundColor = accent.cgColor
        stripe.translatesAutoresizingMaskIntoConstraints = false

        let accept = buttonsRow()
        // The button hangs over the bottom-right corner of the body, which flows
        // around it: only the last lines are cut short, the ones above keep the
        // full width. Without a body there is nothing to flow, and the button
        // gets a line of its own below the text.
        let flows = accept != nil && hasBody

        let title = label(opts.title, size: 14, weight: .bold, color: .labelColor, lines: 2)
        var textViews: [NSView] = [title]
        // What the line is made of, above the line itself: which commands it
        // runs, and which of them are already allowed.
        var listView: NSView?
        if let list = commandList() {
            let view = coloured(list, lines: 2)
            textViews.append(view)
            listView = view
        }
        if hasBody {
            // What is cut off is said by a line of dots under the text: the last
            // line of a command ends in an ellipsis of its own often enough for
            // one there to say nothing.
            let cut = hasExpand && !expanded
            var text: NSView
            if let accept, flows, !cut {
                let size = accept.fittingSize
                text = flowingBody(bodyText(), around: NSSize(width: size.width + 12, height: size.height))
            } else {
                text = coloured(bodyText(), lines: bodyLines)
            }
            if cut {
                // The dots are the bottom line of the panel, where the answer
                // button also sits: they end where it begins.
                let taken = accept.map { $0.fittingSize.width + 12 } ?? 0
                let dots = label("⋯", size: 18, weight: .semibold, color: .secondaryLabelColor, lines: 1)
                dots.widthAnchor.constraint(equalToConstant: textWidth - taken).isActive = true
                let stack = NSStackView(views: [text, dots])
                stack.orientation = .vertical
                stack.alignment = .leading
                stack.spacing = 0
                stack.translatesAutoresizingMaskIntoConstraints = false
                text = stack
            }
            // Where there is more to see, the text itself is the way to see it.
            if hasExpand {
                let box = ClickableBox()
                box.onClick = { [weak self] in self?.toggleExpanded() }
                box.translatesAutoresizingMaskIntoConstraints = false
                box.addSubview(text)
                NSLayoutConstraint.activate([
                    text.leadingAnchor.constraint(equalTo: box.leadingAnchor),
                    text.trailingAnchor.constraint(equalTo: box.trailingAnchor),
                    text.topAnchor.constraint(equalTo: box.topAnchor),
                    text.bottomAnchor.constraint(equalTo: box.bottomAnchor),
                ])
                container.passthrough.append(box)
                text = box
            }
            textViews.append(text)
        }

        let textStack = NSStackView(views: textViews)
        textStack.orientation = .vertical
        textStack.alignment = .leading
        textStack.spacing = 3
        // The list is a line about the command, not part of it: a gap under it
        // keeps the two from reading as one paragraph.
        if let listView { textStack.setCustomSpacing(9, after: listView) }
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
        return container
    }

    func show() {
        let container = content()
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

    /// Shows the rest of a command that did not fit, and folds it back. The
    /// panel grows upwards from its corner, so nothing else on screen moves.
    @objc private func toggleExpanded() {
        expanded.toggle()
        redraw()
    }

    /// Build the panel again from what is true now, keeping its corner.
    private func redraw() {
        let container = content()
        container.layoutSubtreeIfNeeded()
        let height = max(container.fittingSize.height, minHeight)
        let frame = panel.frame
        panel.contentView = container
        // The origin stays where it is and the height grows from it: the panel
        // sits in the bottom corner, so the text unfolds upwards.
        panel.setFrame(
            NSRect(x: frame.minX, y: frame.minY, width: width, height: height),
            display: true
        )
    }

    /// Takes the answer button away once the alert has stood long enough for
    /// the request behind it to be anyone's guess.
    ///
    /// The window listens for the answer for a while after the event and then
    /// stops; a button that outlives that listening promises an answer nobody
    /// is waiting for. The panel itself stays — the event still happened.
    @objc private func expireAccept() {
        guard hasAccept else { return }
        acceptExpired = true
        redraw()
    }

    /// The row of answers along the bottom: what went wrong, and what can be
    /// done about the request without leaving what you are doing.
    private func buttonsRow() -> NSView? {
        var buttons: [NSView] = []
        if hasLog { buttons.append(logButton()) }
        if hasAccept { buttons.append(acceptButton()) }
        guard !buttons.isEmpty else { return nil }
        let row = NSStackView(views: buttons)
        row.orientation = .horizontal
        row.spacing = 8
        row.translatesAutoresizingMaskIntoConstraints = false
        return row
    }

    /// Opens the log of the hook, where the whole event is written down: what
    /// the alert says about the trouble is one line of it.
    private func logButton() -> NSButton {
        let button = NSButton()
        button.translatesAutoresizingMaskIntoConstraints = false
        button.bezelStyle = .rounded
        button.controlSize = .large
        button.title = "Log"
        button.font = .systemFont(ofSize: 13, weight: .semibold)
        button.image = NSImage(
            systemSymbolName: "doc.text.magnifyingglass",
            accessibilityDescription: nil
        )?.withSymbolConfiguration(.init(pointSize: 11, weight: .semibold))
        button.imagePosition = .imageLeading
        button.target = self
        button.action = #selector(showLog)
        button.toolTip = opts.logFile
        return button
    }

    /// Hands the log to the editor and goes away. Nothing is revealed and no
    /// request is answered: the point is to see what happened.
    @objc private func showLog() {
        let file = opts.logFile
        let bundle = opts.bundleID
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            self?.runOpen(["-b", bundle, file])
        }
        dismiss()
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
        ask(opts.askAccept)
        dismiss()
    }

    /// Leave a request for the window holding the chat, which watches for it —
    /// and say the same thing on standard output where the caller is listening
    /// there. The two are the same request; which way it travels depends only
    /// on who raised the panel.
    private func ask(_ body: String) {
        guard !body.isEmpty else { return }
        if opts.report {
            print(body)
            fflush(stdout)
        }
        guard !opts.askFile.isEmpty else { return }
        // Written whole or not at all: the window watches that directory, and a
        // file it finds empty because the writing is still going on is a
        // request it cannot read.
        try? Data(body.utf8).write(to: URL(fileURLWithPath: opts.askFile), options: .atomic)
    }

    /// Text a caller handed over already coloured. Nil for an empty string and
    /// for anything that will not parse — the panel then colours it itself, and
    /// an alert is never lost to a piece of markup.
    ///
    /// Only the colours are taken from the markup. Type sizes belong to the
    /// panel — the reader turns CSS into fonts of its own reckoning, and text
    /// half the size of everything around it reads as a mistake.
    ///
    /// The trailing newline the HTML reader adds after a block is dropped: the
    /// panel lays the lines out itself, and an extra one is a blank row.
    private func fromHTML(_ html: String, font: NSFont) -> NSAttributedString? {
        guard !html.isEmpty, let data = html.data(using: .utf8) else { return nil }
        guard
            let read = try? NSAttributedString(
                data: data,
                options: [
                    .documentType: NSAttributedString.DocumentType.html,
                    .characterEncoding: String.Encoding.utf8.rawValue,
                ],
                documentAttributes: nil
            )
        else { return nil }

        let out = NSMutableAttributedString(attributedString: read)
        while out.string.hasSuffix("\n") {
            out.deleteCharacters(in: NSRange(location: out.length - 1, length: 1))
        }
        guard out.length > 0 else { return nil }
        out.addAttribute(.font, value: font, range: NSRange(location: 0, length: out.length))
        return out
    }

    /// The body of a permission alert, coloured where it is a shell command:
    /// what runs, what it is given, and the punctuation between the two.
    ///
    /// The hook puts the tool in front of the command — `Bash · git push` — and
    /// that prefix is what says the rest is a command at all. Anything else is
    /// prose and stays one colour.
    private func bodyText() -> NSAttributedString {
        // Already coloured by someone who read the line properly: drawn as
        // given, with the trouble lines of this run still appended below.
        if let given = fromHTML(opts.bodyHTML, font: NSFont.systemFont(ofSize: 12)) {
            let out = NSMutableAttributedString(attributedString: given)
            for line in opts.body.components(separatedBy: "\n") where line.hasPrefix(TROUBLE_MARK) {
                out.append(
                    NSAttributedString(
                        string: "\n\(line)",
                        attributes: [
                            .font: NSFont.systemFont(ofSize: 12),
                            .foregroundColor: NSColor.systemRed,
                        ]
                    )
                )
            }
            return out
        }
        let font = NSFont.systemFont(ofSize: 12)
        // What went wrong is marked by the hook and comes after the event
        // itself; it is written in the colour of trouble so that a detail
        // missing from the alert cannot be mistaken for part of the command.
        let lines = opts.body.components(separatedBy: "\n")
        let said = lines.filter { !$0.hasPrefix(TROUBLE_MARK) }.joined(separator: "\n")
        let wrong = lines.filter { $0.hasPrefix(TROUBLE_MARK) }

        let prefix = "Bash\(TOOL_MARK)"
        let out = NSMutableAttributedString()
        if said.hasPrefix(prefix) {
            // Where the list above carries the tool, the command starts on its
            // own; where there is no list, it keeps the name in front of it.
            if toolName.isEmpty {
                out.append(
                    NSAttributedString(
                        string: prefix,
                        attributes: [.font: font, .foregroundColor: NSColor.secondaryLabelColor]
                    )
                )
            }
            out.append(highlighted(String(said.dropFirst(prefix.count))))
        } else {
            out.append(
                NSAttributedString(string: said, attributes: [.font: font, .foregroundColor: bodyColor])
            )
        }
        for line in wrong {
            out.append(
                NSAttributedString(
                    string: "\n\(line)",
                    attributes: [.font: font, .foregroundColor: NSColor.systemRed]
                )
            )
        }
        return out
    }

    /// Whether each command of the line has been allowed, under the name the
    /// list above gives it — `git status` and `git push` are separate entries
    /// there and separate answers here, so one name used both ways does not have
    /// to settle on a single colour.
    private lazy var commandStatus: [String: Bool] = {
        var status: [String: Bool] = [:]
        for one in opts.commands.split(separator: ",") where one.count > 1 {
            status[String(one.dropFirst())] = one.hasPrefix("+")
        }
        return status
    }()

    /// Which words of a command the list named, and whether it allowed them.
    /// Nil where the list says nothing about this command.
    ///
    /// The words of a rule stand next to each other, so they are looked for as a
    /// run, longest first: `npm run package` is a different answer from `npm
    /// run`. A subcommand need not stand next to the name — `git -C .. push` is
    /// still `git push` — so that is looked for separately.
    private func verdict(_ words: [String]) -> (marks: Set<Int>, allowed: Bool)? {
        var count = min(words.count, 4)
        while count > 0 {
            if let allowed = commandStatus[words.prefix(count).joined(separator: " ")] {
                return (Set(0..<count), allowed)
            }
            count -= 1
        }
        for at in 1..<max(words.count, 1) where words[at].range(of: "^[A-Za-z][\\w-]*$", options: .regularExpression) != nil {
            if let allowed = commandStatus["\(words[0]) \(words[at])"] {
                return ([0, at], allowed)
            }
            break
        }
        return nil
    }

    /// The words of the command starting at `from`, up to what ends it, each with
    /// where it begins. The name is read as the list reads it: a program given by
    /// path is named by its last component.
    private func wordsAhead(_ chars: [Character], _ from: Int) -> [(text: String, start: Int)] {
        let breaks = Set("|&;\n(){}")
        let stops = Set(" \t\n|&;(){}<>\"'")
        var words: [(text: String, start: Int)] = []
        var at = from
        while at < chars.count, !breaks.contains(chars[at]) {
            if chars[at] == " " || chars[at] == "\t" {
                at += 1
                continue
            }
            if chars[at] == "\"" || chars[at] == "'" || chars[at] == "<" || chars[at] == ">" { break }
            var end = at
            while end < chars.count, !stops.contains(chars[end]) {
                end += chars[end] == "\\" ? 2 : 1
            }
            end = min(end, chars.count)
            var word = String(chars[at..<end])
            if words.isEmpty {
                word = word.split(separator: "/").last.map(String.init)?
                    .replacingOccurrences(of: "\\", with: "") ?? word
            }
            words.append((word, at))
            at = end
        }
        return words
    }

    /// The tool the hook named in front of the command, when there is a list to
    /// carry it. Empty otherwise, and then the body keeps it.
    private var toolName: String {
        guard !opts.commands.isEmpty, let at = opts.body.range(of: TOOL_MARK) else { return "" }
        return String(opts.body[opts.body.startIndex..<at.lowerBound])
    }

    /// The commands of the line, in green where they are already allowed and in
    /// red where they are not. Nil when there is nothing to list.
    private func commandList() -> NSAttributedString? {
        if let given = fromHTML(opts.commandsHTML, font: NSFont.systemFont(ofSize: 13, weight: .semibold)) { return given }
        let marked = opts.commands.split(separator: ",").map(String.init).filter { $0.count > 1 }
        guard !marked.isEmpty else { return nil }
        let font = NSFont.systemFont(ofSize: 13, weight: .semibold)
        // Brackets and commas in the plain text colour: dimmed, they vanish
        // between the green and the red and the list reads as one word.
        let punctuation: [NSAttributedString.Key: Any] = [
            .font: font,
            .foregroundColor: NSColor.labelColor,
        ]
        let out = NSMutableAttributedString()
        // The tool joins the list rather than heading the command: one line
        // says what is being asked for, the next is the line itself.
        if !toolName.isEmpty {
            // Green where the whole line has already been allowed, red where
            // anything in it is not: one glance then answers the request before
            // the list is read at all.
            let settled = marked.allSatisfy { $0.hasPrefix("+") }
            out.append(
                NSAttributedString(
                    string: "\(toolName): ",
                    attributes: [
                        .font: font,
                        .foregroundColor: settled ? COMMAND_SETTLED : COMMAND_ASKED,
                    ]
                )
            )
        }
        out.append(NSAttributedString(string: "[", attributes: punctuation))
        for (at, one) in marked.enumerated() {
            if at > 0 { out.append(NSAttributedString(string: ", ", attributes: punctuation)) }
            out.append(
                NSAttributedString(
                    string: String(one.dropFirst()),
                    attributes: [
                        .font: font,
                        .foregroundColor: one.hasPrefix("+") ? COMMAND_ALLOWED : COMMAND_ASKED,
                    ]
                )
            )
        }
        out.append(NSAttributedString(string: "]", attributes: punctuation))
        return out
    }

    /// Colours a shell command. Nothing here parses the shell: it tells apart
    /// the word a command starts with, the options handed to it, quoted text,
    /// variables and comments — which is what makes a command readable at a
    /// glance, and all that fits on an alert.
    private func highlighted(_ text: String) -> NSAttributedString {
        let font = NSFont.systemFont(ofSize: 12)
        let strong = NSFont.systemFont(ofSize: 12, weight: .semibold)
        let out = NSMutableAttributedString()
        func add(_ piece: String, _ color: NSColor, _ face: NSFont? = nil) {
            out.append(
                NSAttributedString(string: piece, attributes: [.font: face ?? font, .foregroundColor: color])
            )
        }

        let chars = Array(text)
        // Everything that ends one command and starts the next; the first word
        // after one of them is a command again.
        let breaks = Set("|&;\n(){}")
        let stops = Set(" \t\n|&;(){}<>\"'")
        // Where a word is coloured by the list's answer, and which answer. Filled
        // in as each command is reached, so the line is lit exactly where the list
        // above named something.
        var marked: [Int: Bool] = [:]
        var starting = true
        var index = 0
        while index < chars.count {
            let char = chars[index]
            if char == "\"" || char == "'" {
                var end = index + 1
                while end < chars.count, chars[end] != char { end += 1 }
                let last = min(end, chars.count - 1)
                add(String(chars[index...last]), .systemGreen)
                index = last + 1
                starting = false
                continue
            }
            if char == "#", index == 0 || chars[index - 1] == "\n" || chars[index - 1] == " " {
                var end = index
                while end < chars.count, chars[end] != "\n" { end += 1 }
                add(String(chars[index..<end]), .tertiaryLabelColor)
                index = end
                continue
            }
            if char == "<" || char == ">" {
                // A redirection and the descriptor it names — `2>&1` — belong
                // to no command: what follows is not a command starting.
                add(String(char), .secondaryLabelColor)
                index += 1
                continue
            }
            if breaks.contains(char) {
                add(String(char), .secondaryLabelColor)
                // `&` right after a redirection is part of it, not a break.
                if !(char == "&" && index > 0 && (chars[index - 1] == ">" || chars[index - 1] == "<")) {
                    starting = true
                }
                index += 1
                continue
            }
            if char == " " || char == "\t" {
                add(String(char), bodyColor)
                index += 1
                continue
            }
            var end = index
            // A backslash holds the next character inside the word, spaces of a
            // path included: `Visual\ Studio\ Code.app` is one word.
            while end < chars.count, !stops.contains(chars[end]) {
                end += chars[end] == "\\" ? 2 : 1
            }
            end = min(end, chars.count)
            let word = String(chars[index..<end])
            if let allowed = marked[index] {
                // A word the list named: same colour there and here, so the two
                // can be read against each other.
                add(word, allowed ? COMMAND_ALLOWED : COMMAND_ASKED, strong)
            } else if word.hasPrefix("-") {
                add(word, .labelColor)
            } else if word.hasPrefix("$") {
                add(word, .systemPurple)
            } else if starting {
                // A word that is only a descriptor left over from `2>&1`, or an
                // assignment in front of the command, is not the command.
                if word.allSatisfy({ $0.isNumber }) || word.contains("=") {
                    add(word, bodyColor)
                } else {
                    let ahead = wordsAhead(chars, index)
                    if let call = verdict(ahead.map { $0.text }) {
                        for at in call.marks where at < ahead.count {
                            marked[ahead[at].start] = call.allowed
                        }
                    }
                    add(word, marked[index] == false ? COMMAND_ASKED : COMMAND_ALLOWED, strong)
                    starting = false
                }
            } else {
                add(word, bodyColor)
            }
            index = end
        }
        return out
    }

    /// How many lines the body takes at a given width, with nothing clamping it.
    private func lines(_ text: String, width: CGFloat) -> Int {
        let storage = NSTextStorage(string: text, attributes: [.font: NSFont.systemFont(ofSize: 12)])
        let layout = NSLayoutManager()
        let box = NSTextContainer(size: NSSize(width: width, height: .greatestFiniteMagnitude))
        box.lineFragmentPadding = 0
        layout.addTextContainer(box)
        storage.addLayoutManager(layout)
        layout.ensureLayout(for: box)

        var count = 0
        var index = 0
        let glyphs = layout.numberOfGlyphs
        while index < glyphs {
            var range = NSRange()
            layout.lineFragmentRect(forGlyphAt: index, effectiveRange: &range)
            index = NSMaxRange(range)
            count += 1
        }
        return count
    }

    /// Body text with a hole for the button in its bottom-right corner: the
    /// last lines stop at the button, everything above runs the full width.
    ///
    /// Where that hole goes depends on how tall the text turns out, and the
    /// height depends on the hole, so the two are settled by repeating the
    /// layout until it stops moving — which it does in a pass or two.
    private func flowingBody(_ text: NSAttributedString, around avoid: NSSize) -> NSTextView {
        let storage = NSTextStorage(attributedString: text)
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

    /// A label of text that carries its own colours, wrapped and clamped the
    /// same way a plain one is.
    private func coloured(_ text: NSAttributedString, lines: Int) -> NSTextField {
        let field = NSTextField(labelWithAttributedString: text)
        field.translatesAutoresizingMaskIntoConstraints = false
        field.lineBreakMode = .byTruncatingTail
        field.maximumNumberOfLines = lines
        field.preferredMaxLayoutWidth = textWidth
        field.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        field.usesSingleLineMode = false
        field.cell?.wraps = true
        field.cell?.isScrollable = false
        field.setContentCompressionResistancePriority(.defaultHigh, for: .vertical)
        return field
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

    /// Bring the window holding the chat forward, and tell it what to show.
    ///
    /// The folder is what names the window, and the editor's own command line is
    /// what raises it: handing the folder to `open` asks the system to open a
    /// document, and with that folder already open in a background window the
    /// app comes forward on whatever window was in front — which is the window
    /// the user is leaving, not the one the alert is about.
    private func openTarget() {
        // The window is told what to show before it is raised: it watches for
        // the request either way, and this way the chat is already coming up as
        // the window arrives.
        ask(opts.askClick)
        if !opts.folder.isEmpty { raiseUntilFront(opts.folder) }
        // Which app: whatever window the editor now has in front is the one that
        // comes up with it, which is why this goes last.
        runOpen(["-b", opts.bundleID])
        guard !opts.url.isEmpty else { return }
        // `open` returns before the window is actually in front, and a link
        // arriving too early finds no window to belong to — VS Code then opens
        // an empty one for it. Waiting for the app to come forward costs
        // nothing when it already is, which is the common case for a click.
        waitUntilFront()
        runOpen([opts.url])
    }

    /// Ask for the window until it says it is in front.
    ///
    /// One request is not enough: an editor busy with a window switch of its
    /// own drops it, and a click right after leaving that window is exactly
    /// when it is busy. Whether it worked is knowable — every window publishes
    /// its focus for the hook to read, and so can this.
    private func raiseUntilFront(_ folder: String) {
        for attempt in 0..<4 {
            // The system is asked first, and usually that is the end of it. The
            // editor's own command line comes second because it runs the app as
            // a helper process, and the Dock shows the icon for as long as that
            // takes — a flash for something the first way did without one.
            if attempt == 0 {
                runOpen(["-b", opts.bundleID, folder])
            } else {
                raise(folder)
            }
            let until = Date().addingTimeInterval(0.4)
            while Date() < until {
                if windowInFront(folder) { return }
                Thread.sleep(forTimeInterval: 0.1)
            }
        }
    }

    /// Whether a window holding this folder says it has focus.
    private func windowInFront(_ folder: String) -> Bool {
        let dir = (NSHomeDirectory() as NSString).appendingPathComponent(".claude/floating-alert/focus")
        guard let names = try? FileManager.default.contentsOfDirectory(atPath: dir) else { return false }
        for name in names {
            let file = (dir as NSString).appendingPathComponent(name)
            guard
                let data = FileManager.default.contents(atPath: file),
                let state = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                state["focused"] as? Bool == true,
                let folders = state["folders"] as? [String]
            else { continue }
            if folders.contains(where: { folder == $0 || folder.hasPrefix("\($0)/") }) { return true }
        }
        return false
    }

    /// Bring the window holding this folder forward.
    private func raise(_ folder: String) {
        // A stand names its own way in, and going around it would reach the
        // editor the user runs instead of the one being tested.
        if ProcessInfo.processInfo.environment["CFA_OPEN"] == nil, let cli = editorCommandLine() {
            runEditor(cli, [folder])
            return
        }
        runOpen(["-b", opts.bundleID, folder])
    }

    /// The editor's own command line, which talks to the running instance and
    /// raises the window of a folder it already has open. Absent for an editor
    /// installed somewhere unusual, and then `open` has to do.
    private func editorCommandLine() -> String? {
        guard
            let app = NSWorkspace.shared.urlForApplication(withBundleIdentifier: opts.bundleID)
        else { return nil }
        let cli = app.appendingPathComponent("Contents/Resources/app/bin/code").path
        return FileManager.default.isExecutableFile(atPath: cli) ? cli : nil
    }

    private func runEditor(_ program: String, _ arguments: [String]) {
        let task = Process()
        task.executableURL = URL(fileURLWithPath: program)
        task.arguments = arguments
        try? task.run()
        task.waitUntilExit()
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

    /// Hand a folder or a link to the editor.
    ///
    /// `open` talks to the editor the system knows, which is the one the user
    /// runs. A debug stand runs its own copy on its own profile and would never
    /// be reached that way, so `CFA_OPEN` may name what to run instead — same
    /// arguments, a different way in. Nothing but the stand sets it.
    private func runOpen(_ arguments: [String]) {
        let task = Process()
        let opener = ProcessInfo.processInfo.environment["CFA_OPEN"] ?? "/usr/bin/open"
        task.executableURL = URL(fileURLWithPath: opener)
        task.arguments = arguments
        try? task.run()
        task.waitUntilExit()
    }

    /// Do what a click does, without one.
    ///
    /// A mouse click on this panel cannot be sent by a test: posting one needs
    /// accessibility rights a run does not have. These two signals run the very
    /// code a click runs, so what is checked is the panel's own behaviour and
    /// not a copy of it.
    func listenForPress() {
        for (number, act) in [
            (SIGUSR1, #selector(runAction)),
            (SIGUSR2, #selector(accept)),
            // The window has stopped listening for an answer, so the button
            // that would send one goes away. The panel stays: the event it is
            // about still happened.
            (SIGHUP, #selector(expireAccept)),
        ] {
            signal(number, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: number, queue: .main)
            source.setEventHandler { [weak self] in
                guard let self else { return }
                _ = self.perform(act)
            }
            source.resume()
            presses.append(source)
        }
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
// Before anything is drawn: until these are taken, either signal is a way to
// kill the process outright, and one arriving early would take the panel with
// it instead of pressing it.
controller.listenForPress()
controller.show()
app.run()
