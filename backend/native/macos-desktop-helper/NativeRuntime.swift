// SPDX-License-Identifier: MIT
// Copyright (c) 2026 NEURAFLOK contributors
import Foundation
import AppKit
import ApplicationServices
import Carbon.HIToolbox
import ScreenCaptureKit
import CoreMedia
import CoreImage
import ImageIO
import UniformTypeIdentifiers
import Darwin

typealias JSONObject = [String: Any]

struct HelperFailure: Error {
    let code: String
    let message: String
}

func fail(_ code: String, _ message: String) -> HelperFailure {
    HelperFailure(code: code, message: message)
}

func number(_ value: Any?) -> NSNumber? {
    value as? NSNumber
}

func int(_ value: Any?, default fallback: Int = 0) -> Int {
    number(value)?.intValue ?? fallback
}

func bool(_ value: Any?, default fallback: Bool = false) -> Bool {
    number(value)?.boolValue ?? fallback
}

func string(_ value: Any?, default fallback: String = "") -> String {
    value as? String ?? fallback
}

func rectObject(_ rect: CGRect) -> JSONObject {
    [
        "x": Int(rect.origin.x.rounded()),
        "y": Int(rect.origin.y.rounded()),
        "width": Int(rect.width.rounded()),
        "height": Int(rect.height.rounded())
    ]
}

func rect(_ value: Any?) -> CGRect? {
    guard let object = value as? JSONObject else { return nil }
    let x = number(object["x"])?.doubleValue
    let y = number(object["y"])?.doubleValue
    let width = number(object["width"])?.doubleValue
    let height = number(object["height"])?.doubleValue
    guard let x, let y, let width, let height, width > 0, height > 0 else { return nil }
    return CGRect(x: x, y: y, width: width, height: height)
}

let maxDecodedScreenshotPixels = 8_000_000
let maxEncodedScreenshotBytes = 6_242_304
let maxAXStringCharacters = 4_096
let maxAXTraversalSeconds = 6.0

// The addon executes synchronously inside the Electron process. A Node Worker timeout cannot pre-empt a blocked native accessibility message, so bound the AX transport itself and let longer traversals enforce their own aggregate deadline between messages.
let axMessagingTimeoutConfigured: Void = {
    let system = AXUIElementCreateSystemWide()
    _ = AXUIElementSetMessagingTimeout(system, 1.0)
}()

func axApplication(_ pid: pid_t) -> AXUIElement {
    _ = axMessagingTimeoutConfigured
    return AXUIElementCreateApplication(pid)
}

func approximatelyEqual(_ left: CGRect, _ right: CGRect, tolerance: CGFloat = 2) -> Bool {
    abs(left.minX - right.minX) <= tolerance &&
        abs(left.minY - right.minY) <= tolerance &&
        abs(left.maxX - right.maxX) <= tolerance &&
        abs(left.maxY - right.maxY) <= tolerance
}

func convincinglyMatchesWindow(_ candidate: CGRect, _ expected: CGRect) -> Bool {
    guard !candidate.isNull, !candidate.isEmpty else { return false }
    let intersection = candidate.intersection(expected)
    guard !intersection.isNull, !intersection.isEmpty else { return false }
    let intersectionArea = intersection.width * intersection.height
    let unionArea = candidate.width * candidate.height + expected.width * expected.height - intersectionArea
    guard unionArea > 0, intersectionArea / unionArea >= 0.8 else { return false }
    let maximumEdgeDelta = max(
        abs(candidate.minX - expected.minX),
        abs(candidate.minY - expected.minY),
        abs(candidate.maxX - expected.maxX),
        abs(candidate.maxY - expected.maxY)
    )
    return maximumEdgeDelta <= 64
}

func windowGeometryDistance(_ candidate: CGRect, _ expected: CGRect) -> CGFloat {
    abs(candidate.minX - expected.minX) + abs(candidate.minY - expected.minY) +
        abs(candidate.width - expected.width) + abs(candidate.height - expected.height)
}

func boundedAXString(_ value: String) -> String {
    let prefix = value.prefix(maxAXStringCharacters)
    guard prefix.endIndex != value.endIndex else { return value }
    return String(prefix.dropLast()) + "…"
}

func activeDisplayRects() throws -> [CGRect] {
    var count: UInt32 = 0
    guard CGGetActiveDisplayList(0, nil, &count) == .success, count > 0 else {
        throw fail("SCREEN_UNAVAILABLE", "no active display is available")
    }
    var displays = Array(repeating: CGDirectDisplayID(), count: Int(count))
    guard CGGetActiveDisplayList(count, &displays, &count) == .success else {
        throw fail("SCREEN_UNAVAILABLE", "the active display list could not be read")
    }
    return displays.prefix(Int(count)).map(CGDisplayBounds)
}

func orderedDisplayRects(_ rects: [CGRect]) -> [CGRect] {
    rects.map(\.integral).sorted {
        ($0.minX, $0.minY, $0.width, $0.height) < ($1.minX, $1.minY, $1.width, $1.height)
    }
}

func displayTopologyObject(_ rects: [CGRect]) -> [JSONObject] {
    orderedDisplayRects(rects).map(rectObject)
}

func displayTopology(_ value: Any?) -> [CGRect]? {
    guard let raw = value as? [Any] else { return nil }
    let parsed = raw.compactMap(rect)
    return parsed.count == raw.count && !parsed.isEmpty ? orderedDisplayRects(parsed) : nil
}

func sameDisplayTopology(_ left: [CGRect], _ right: [CGRect]) -> Bool {
    orderedDisplayRects(left) == orderedDisplayRects(right)
}

func virtualScreenRect() throws -> CGRect {
    try activeDisplayRects().reduce(CGRect.null) { $0.union($1) }
}

func requirePointOnActiveDisplay(_ point: CGPoint, displays suppliedDisplays: [CGRect]? = nil) throws {
    let displays = try suppliedDisplays ?? activeDisplayRects()
    guard displays.contains(where: { $0.contains(point) }) else {
        throw fail(
            "OUTSIDE_ACTIVE_DISPLAY",
            "point \(Int(point.x.rounded())),\(Int(point.y.rounded())) falls outside every active display; no input was sent"
        )
    }
}
