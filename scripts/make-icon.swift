// Draws media/icon.png: the alert itself, scaled up to a 128×128 marketplace tile.
//
//   /usr/bin/xcrun swift scripts/make-icon.swift
import AppKit

let side: CGFloat = 128
let scale: CGFloat = 4 // render at 512 and let the PNG carry the detail
let size = NSSize(width: side * scale, height: side * scale)

let image = NSImage(size: size)
image.lockFocus()

guard let ctx = NSGraphicsContext.current?.cgContext else { exit(1) }
ctx.setShouldAntialias(true)

func rounded(_ rect: NSRect, _ radius: CGFloat) -> NSBezierPath {
    NSBezierPath(roundedRect: rect, xRadius: radius, yRadius: radius)
}

let accent = NSColor(calibratedRed: 0.98, green: 0.62, blue: 0.23, alpha: 1)

// Tile background: the dark panel body, edge to edge.
let tile = NSRect(origin: .zero, size: size)
rounded(tile, 96).setClip()
NSColor(calibratedRed: 0.13, green: 0.13, blue: 0.14, alpha: 1).setFill()
tile.fill()

// The panel's accent stripe, hugging the left edge.
let stripe = NSRect(x: 56, y: 96, width: 44, height: size.height - 192)
accent.setFill()
rounded(stripe, 22).fill()

// Two text lines: a bold title and a lighter body line under it.
NSColor(calibratedWhite: 0.96, alpha: 1).setFill()
rounded(NSRect(x: 152, y: 239, width: 268, height: 44), 22).fill()
NSColor(calibratedWhite: 0.55, alpha: 1).setFill()
rounded(NSRect(x: 152, y: 167, width: 196, height: 32), 16).fill()

// Subtitle above the title, in the accent colour, as in a real alert.
accent.setFill()
rounded(NSRect(x: 152, y: 315, width: 150, height: 30), 15).fill()

image.unlockFocus()

guard
    let tiff = image.tiffRepresentation,
    let bitmap = NSBitmapImageRep(data: tiff),
    let png = bitmap.representation(using: .png, properties: [:])
else { exit(1) }

let out = URL(fileURLWithPath: "media/icon.png")
try png.write(to: out)
print("wrote \(out.path)")
