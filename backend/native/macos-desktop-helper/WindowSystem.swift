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

struct WindowRow {
    let id: CGWindowID
    let pid: pid_t
    let title: String
    let process: String
    let bounds: CGRect
    let onScreen: Bool
    let minimized: Bool
    let layer: Int

    func json(foreground: CGWindowID?) -> JSONObject {
        [
            "id": Int(id),
            "title": title,
            "process": process,
            "x": Int(bounds.origin.x.rounded()),
            "y": Int(bounds.origin.y.rounded()),
            "width": Int(bounds.width.rounded()),
            "height": Int(bounds.height.rounded()),
            "state": id == foreground ? "foreground" : (minimized ? "minimized" : "open")
        ]
    }
}

func offscreenAXWindowStates(in rows: [WindowRow]) -> [CGWindowID: Bool] {
    // CGWindowIsOnscreen is also false for hidden apps and windows on another Space. Keep those real app windows discoverable only when AX independently proves their identity. This avoids flooding discovery with unrelated layer-0 provider surfaces. The value records actual AXMinimized state so another Space/hidden app remains "open".
    guard AXIsProcessTrusted() else { return [:] }
    let candidatePids = Set(rows.lazy.filter { !$0.onScreen }.map(\.pid)).prefix(64)
    var states: [CGWindowID: Bool] = [:]
    let deadline = ProcessInfo.processInfo.systemUptime + 2.0
    pidLoop: for pid in candidatePids {
        if ProcessInfo.processInfo.systemUptime >= deadline { break }
        let app = axApplication(pid)
        var windows = axElementValues(app, attribute: kAXWindowsAttribute as CFString, limit: 64)
        // Chromium can expose AXFocusedWindow/AXMainWindow while AXWindows is temporarily unavailable during navigation. Those attributes are still exact AX window evidence.
        if let focused = axElementAttribute(app, kAXFocusedWindowAttribute as CFString) { windows.append(focused) }
        if let main = axElementAttribute(app, kAXMainWindowAttribute as CFString) { windows.append(main) }
        for window in windows {
            if ProcessInfo.processInfo.systemUptime >= deadline { break pidLoop }
            let id: CGWindowID?
            if let exact = axWindowNumber(window) {
                id = rows.contains(where: { $0.id == exact && $0.pid == pid }) ? exact : nil
            } else if let bounds = axBounds(window) {
                id = unambiguousWindowID(bounds: bounds, pid: pid, rows: rows)
            } else {
                id = nil
            }
            guard let id else { continue }
            states[id] = axBool(window, kAXMinimizedAttribute as CFString, default: false)
        }
    }
    return states
}

func allWindowRows(includeMinimized: Bool = true) -> [WindowRow] {
    guard let raw = CGWindowListCopyWindowInfo([.optionAll, .excludeDesktopElements], kCGNullWindowID)
        as? [JSONObject] else { return [] }
    let ownPid = getpid()
    // A visible-looking off-Space window can have no kCGWindowIsOnscreen key. Only the authoritative on-screen list may restore an omitted flag.
    let onScreenIDs = Set((CGWindowListCopyWindowInfo(
        [.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID
    ) as? [JSONObject] ?? []).compactMap { number($0[kCGWindowNumber as String])?.uint32Value })
    let rows: [WindowRow] = raw.compactMap { item -> WindowRow? in
        guard
            let id = number(item[kCGWindowNumber as String])?.uint32Value,
            let pid = number(item[kCGWindowOwnerPID as String])?.int32Value,
            pid != ownPid,
            let boundsDictionary = item[kCGWindowBounds as String] as? NSDictionary,
            let bounds = CGRect(dictionaryRepresentation: boundsDictionary),
            bounds.width > 1,
            bounds.height > 1
        else { return nil }
        let layer = int(item[kCGWindowLayer as String])
        let reportedOnScreen = number(item[kCGWindowIsOnscreen as String])?.boolValue
        let alpha = number(item[kCGWindowAlpha as String])?.doubleValue ?? 1
        guard layer == 0, alpha > 0 else { return nil }
        let process = string(item[kCGWindowOwnerName as String], default: "Process \(pid)")
        let title = string(item[kCGWindowName as String]).trimmingCharacters(in: .whitespacesAndNewlines)
        // macOS 15 can omit kCGWindowIsOnscreen for a real visible Chromium top-level window. Recover only a titled, substantial, display-intersecting row. Explicit false stays off-screen and continues through the AX minimised/hidden recovery path below.
        let displayIntersection = (try? activeDisplayRects())?.contains { !$0.intersection(bounds).isNull && $0.intersection(bounds).width >= 160 && $0.intersection(bounds).height >= 120 } ?? false
        let missingOnScreenFallback = reportedOnScreen == nil && onScreenIDs.contains(id) && !title.isEmpty && bounds.width >= 320 && bounds.height >= 240 && displayIntersection
        let onScreen = reportedOnScreen ?? missingOnScreenFallback
        let displayTitle = title.isEmpty ? "\(process) window" : title
        return WindowRow(
            id: id,
            pid: pid,
            title: displayTitle,
            process: process,
            bounds: bounds,
            onScreen: onScreen,
            minimized: false,
            layer: layer
        )
    }
    let visible = rows.filter { $0.onScreen }
    guard includeMinimized else { return visible }
    let offscreenStates = offscreenAXWindowStates(in: rows)
    return rows.compactMap { row in
        if row.onScreen { return row }
        guard let minimized = offscreenStates[row.id] else { return nil }
        return WindowRow(
            id: row.id,
            pid: row.pid,
            title: row.title,
            process: row.process,
            bounds: row.bounds,
            onScreen: false,
            minimized: minimized,
            layer: row.layer
        )
    }
}

func windowRow(_ id: CGWindowID) -> WindowRow? {
    allWindowRows().first { $0.id == id }
}

func frontmostPID() -> pid_t? {
    // For trusted assistive control, query the system-wide AX focus directly. NSWorkspace's frontmostApplication is notification-backed and can be stale on a native worker or command-line helper whose run loop does not own the workspace notification source.
    if AXIsProcessTrusted() {
        let system = AXUIElementCreateSystemWide()
        if let focused = axElementAttribute(system, kAXFocusedApplicationAttribute as CFString),
           let pid = axPID(focused),
           pid > 0 {
            return pid
        }
    }
    return NSWorkspace.shared.frontmostApplication?.processIdentifier
}

func windowServerFrontWindowID(rows suppliedRows: [WindowRow]? = nil) -> CGWindowID? {
    let rows = suppliedRows ?? allWindowRows(includeMinimized: false)
    let eligible = Set(rows.lazy.filter(\.onScreen).map(\.id))
    guard let ordered = CGWindowListCopyWindowInfo(
        [.optionOnScreenOnly, .excludeDesktopElements],
        kCGNullWindowID
    ) as? [JSONObject] else { return nil }
    // CGWindowListCopyWindowInfo documents the on-screen list in front-to-back order. allWindowRows uses optionAll so it can also recover genuinely minimised windows; its filtered array must not be reused as z-order evidence. Intersect the authoritative ordered list with rows that already passed our layer/alpha/geometry policy instead.
    for item in ordered {
        guard let id = number(item[kCGWindowNumber as String])?.uint32Value,
              eligible.contains(id) else { continue }
        return id
    }
    return nil
}

func foregroundWindowID() -> CGWindowID? {
    guard let pid = frontmostPID() else { return nil }
    let rows = allWindowRows(includeMinimized: false)
    guard let frontID = windowServerFrontWindowID(rows: rows),
          let front = rows.first(where: { $0.id == frontID }),
          front.pid == pid else { return nil }
    // Screen-only observation must still work without Accessibility. When AX is available, disagreement means an app transition is in flight, so expose no active window rather than attributing input or pixels to stale state from either subsystem.
    if AXIsProcessTrusted(), let focused = focusedAXWindowID(for: pid, rows: rows), focused != front.id {
        return nil
    }
    return front.id
}

func requireAccessibility() throws {
    _ = axMessagingTimeoutConfigured
    // Packaged builds execute this Swift code inside the Electron process on a Node Worker. Electron owns prompting through systemPreferences; native execution only performs this fail-closed mutation-boundary preflight. The standalone CLI is a development probe.
    guard AXIsProcessTrusted() else {
        throw fail(
            "ACCESSIBILITY_PERMISSION_REQUIRED",
            "enable Accessibility for NEURAFLOK (Device Control on newer macOS), then fully quit and reopen the app"
        )
    }
}

func requireScreenCapture() throws {
    guard CGPreflightScreenCaptureAccess() else {
        _ = CGRequestScreenCaptureAccess()
        throw fail(
            "SCREEN_PERMISSION_REQUIRED",
            "enable Screen Recording for NEURAFLOK, then fully quit and reopen the app"
        )
    }
}

func axAttribute(_ element: AXUIElement, _ attribute: CFString) -> AnyObject? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, attribute, &value) == .success else { return nil }
    return value
}

func axElementAttribute(_ element: AXUIElement, _ attribute: CFString) -> AXUIElement? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, attribute, &value) == .success, let value else { return nil }
    guard CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
    return (value as! AXUIElement)
}

func axString(_ element: AXUIElement, _ attribute: CFString) -> String? {
    axAttribute(element, attribute) as? String
}

func axBool(_ element: AXUIElement, _ attribute: CFString, default fallback: Bool) -> Bool {
    (axAttribute(element, attribute) as? NSNumber)?.boolValue ?? fallback
}

func axPoint(_ element: AXUIElement, _ attribute: CFString) -> CGPoint? {
    guard let value = axAttribute(element, attribute) else { return nil }
    guard CFGetTypeID(value) == AXValueGetTypeID() else { return nil }
    let axValue = value as! AXValue
    guard AXValueGetType(axValue) == .cgPoint else { return nil }
    var point = CGPoint.zero
    return AXValueGetValue(axValue, .cgPoint, &point) ? point : nil
}

func axSize(_ element: AXUIElement, _ attribute: CFString) -> CGSize? {
    guard let value = axAttribute(element, attribute) else { return nil }
    guard CFGetTypeID(value) == AXValueGetTypeID() else { return nil }
    let axValue = value as! AXValue
    guard AXValueGetType(axValue) == .cgSize else { return nil }
    var size = CGSize.zero
    return AXValueGetValue(axValue, .cgSize, &size) ? size : nil
}

func axBounds(_ element: AXUIElement) -> CGRect? {
    guard let point = axPoint(element, kAXPositionAttribute as CFString),
          let size = axSize(element, kAXSizeAttribute as CFString),
          size.width >= 0,
          size.height >= 0 else { return nil }
    return CGRect(origin: point, size: size)
}

func axElementValues(_ element: AXUIElement, attribute: CFString, limit: Int) -> [AXUIElement] {
    guard limit > 0 else { return [] }
    var values: CFArray?
    guard AXUIElementCopyAttributeValues(
        element,
        attribute,
        0,
        limit,
        &values
    ) == .success else { return [] }
    return values as? [AXUIElement] ?? []
}

func axChildren(_ element: AXUIElement, limit: Int) -> [AXUIElement] {
    axElementValues(element, attribute: kAXChildrenAttribute as CFString, limit: limit)
}

func axRole(_ element: AXUIElement) -> String {
    let raw = axString(element, kAXRoleAttribute as CFString) ?? "AXUnknown"
    return raw.hasPrefix("AX") ? String(raw.dropFirst(2)) : raw
}

func axName(_ element: AXUIElement) -> String {
    for attribute in [kAXTitleAttribute, kAXDescriptionAttribute, kAXValueAttribute] {
        if let value = axString(element, attribute as CFString)?.trimmingCharacters(in: .whitespacesAndNewlines),
           !value.isEmpty { return boundedAXString(value) }
    }
    return ""
}

func axWindowNumber(_ element: AXUIElement) -> CGWindowID? {
    (axAttribute(element, "AXWindowNumber" as CFString) as? NSNumber)?.uint32Value
}

func axPID(_ element: AXUIElement) -> pid_t? {
    var pid = pid_t()
    return AXUIElementGetPid(element, &pid) == .success ? pid : nil
}

func unambiguousWindowID(bounds: CGRect, pid: pid_t, rows: [WindowRow]) -> CGWindowID? {
    let candidates = rows
        .filter { $0.pid == pid && convincinglyMatchesWindow(bounds, $0.bounds) }
        .map { (id: $0.id, distance: windowGeometryDistance(bounds, $0.bounds)) }
        .sorted { $0.distance < $1.distance }
    guard let winner = candidates.first else { return nil }
    // Exact geometry is stronger than a nearby overlapping window. Accept it only when exactly one PID-matched WindowServer row has the same four edges.
    let exact = rows.filter { $0.pid == pid && approximatelyEqual(bounds, $0.bounds) }
    if exact.count == 1 { return exact[0].id }
    if exact.count > 1 { return nil }
    if candidates.count > 1, candidates[1].distance - winner.distance < 32 { return nil }
    return winner.id
}

func owningAXWindowID(
    _ element: AXUIElement,
    pid: pid_t,
    rows suppliedRows: [WindowRow]? = nil
) -> CGWindowID? {
    var current: AXUIElement? = element
    let deadline = ProcessInfo.processInfo.systemUptime + 2.0
    for _ in 0..<12 {
        if ProcessInfo.processInfo.systemUptime >= deadline { return nil }
        guard let candidate = current else { return nil }
        let window = axElementAttribute(candidate, kAXWindowAttribute as CFString) ??
            (axRole(candidate) == "Window" ? candidate : nil)
        if let window {
            if let exact = axWindowNumber(window) { return exact }
            if let bounds = axBounds(window) {
                return unambiguousWindowID(
                    bounds: bounds,
                    pid: pid,
                    rows: suppliedRows ?? allWindowRows(includeMinimized: false)
                )
            }
        }
        current = axElementAttribute(candidate, kAXParentAttribute as CFString)
    }
    return nil
}

func focusedAXWindowID(for pid: pid_t, rows suppliedRows: [WindowRow]? = nil) -> CGWindowID? {
    guard AXIsProcessTrusted() else { return nil }
    let app = axApplication(pid)
    guard let focused = axElementAttribute(app, kAXFocusedWindowAttribute as CFString) else { return nil }
    if let exact = axWindowNumber(focused) { return exact }
    guard let bounds = axBounds(focused) else { return nil }
    let rows = suppliedRows ?? allWindowRows(includeMinimized: false)
    return unambiguousWindowID(bounds: bounds, pid: pid, rows: rows)
}

func focusedAXElementWindowID(for pid: pid_t, rows suppliedRows: [WindowRow]? = nil) -> CGWindowID? {
    guard AXIsProcessTrusted() else { return nil }
    let app = axApplication(pid)
    guard let element = axElementAttribute(app, kAXFocusedUIElementAttribute as CFString) else { return nil }
    return owningAXWindowID(element, pid: pid, rows: suppliedRows)
}

func windowServerTopWindowID(at point: CGPoint) -> CGWindowID? {
    guard let ordered = CGWindowListCopyWindowInfo(
        [.optionOnScreenOnly, .excludeDesktopElements],
        kCGNullWindowID
    ) as? [JSONObject] else { return nil }
    let displayRects = (try? activeDisplayRects()) ?? []
    for item in ordered {
        guard let id = number(item[kCGWindowNumber as String])?.uint32Value,
              let boundsDictionary = item[kCGWindowBounds as String] as? NSDictionary,
              let bounds = CGRect(dictionaryRepresentation: boundsDictionary),
              bounds.contains(point),
              (number(item[kCGWindowAlpha as String])?.doubleValue ?? 1) > 0 else { continue }
        // Dock publishes a full-display, non-interactive compositor backdrop at layer 20. Exclude only that exact surface; actual Dock menus and other overlays remain blockers.
        let layer = int(item[kCGWindowLayer as String])
        let owner = string(item[kCGWindowOwnerName as String])
        let name = string(item[kCGWindowName as String])
        let dockBackdrop = layer == 20 && owner == "Dock" && name == "Dock" &&
            displayRects.contains { approximatelyEqual($0, bounds) }
        if dockBackdrop { continue }
        // The first real window at the coordinate wins, including nonzero-layer floating panels and popups. Restricting to allWindowRows(layer == 0) clicks through them.
        return id
    }
    return nil
}

// Focus ownership is not z-order ownership. Chromium may place a same-process transient popup (for example Translate) above the requested main window while AX still proves that the requested window owns focus. Do not treat that popup as a failed focus. Pointer and keyboard delivery retain their stricter WindowServer checks below.
func focusTargetMatches(_ row: WindowRow) -> Bool {
    guard frontmostPID() == row.pid else { return false }
    let rows = allWindowRows(includeMinimized: false)
    return focusedAXWindowID(for: row.pid, rows: rows) == row.id
}

// Pointer delivery is spatial. Prove the exact active window without requiring the keyboard-focused AX control, which Chromium may publish asynchronously after activation.
func pointerTargetMatches(_ row: WindowRow, point: CGPoint? = nil) -> Bool {
    guard frontmostPID() == row.pid else { return false }
    let rows = allWindowRows(includeMinimized: false)
    guard windowServerFrontWindowID(rows: rows) == row.id else { return false }
    guard focusedAXWindowID(for: row.pid, rows: rows) == row.id else { return false }
    if let point {
        guard row.bounds.contains(point) else { return false }
        guard windowServerTopWindowID(at: point) == row.id else { return false }
    }
    return true
}

func inputTargetMatches(_ row: WindowRow) -> Bool {
    guard frontmostPID() == row.pid else { return false }
    let rows = allWindowRows(includeMinimized: false)
    guard windowServerFrontWindowID(rows: rows) == row.id else { return false }
    guard focusedAXWindowID(for: row.pid, rows: rows) == row.id else { return false }
    // Missing focused-control evidence is not agreement. AX can return nil on a timeout, an untyped value or an app transition; accepting that would turn an unprovable keyboard destination into global physical input.
    guard focusedAXElementWindowID(for: row.pid, rows: rows) == row.id else { return false }
    return true
}

func assertPointerTarget(_ id: CGWindowID, point: CGPoint? = nil) throws -> WindowRow {
    guard let row = windowRow(id), row.onScreen else {
        throw fail("INPUT_TARGET_LOST", "target window \(id) no longer exists on screen; no input was sent")
    }
    guard pointerTargetMatches(row, point: point) else {
        throw fail("INPUT_TARGET_LOST", "window \(id) is no longer the exact active pointer target; no input was sent")
    }
    return row
}

func assertInputTarget(_ id: CGWindowID) throws -> WindowRow {
    guard let row = windowRow(id), row.onScreen else {
        throw fail("INPUT_TARGET_LOST", "target window \(id) no longer exists on screen; no input was sent")
    }
    guard inputTargetMatches(row) else {
        throw fail("INPUT_TARGET_LOST", "window \(id) is no longer the exact active input target; no input was sent")
    }
    return row
}

func setAXValueIfPossible(_ element: AXUIElement, _ attribute: CFString, _ value: CFTypeRef) {
    var settable = DarwinBoolean(false)
    guard AXUIElementIsAttributeSettable(element, attribute, &settable) == .success,
          settable.boolValue else { return }
    _ = AXUIElementSetAttributeValue(element, attribute, value)
}

func setAXBooleanIfPossible(_ element: AXUIElement, _ attribute: CFString, _ value: Bool) {
    setAXValueIfPossible(element, attribute, value ? kCFBooleanTrue : kCFBooleanFalse)
}

func matchingAXWindow(_ row: WindowRow, deadline suppliedDeadline: TimeInterval? = nil) throws -> AXUIElement {
    try requireAccessibility()
    let app = axApplication(row.pid)
    let deadline = suppliedDeadline ?? (ProcessInfo.processInfo.systemUptime + maxAXTraversalSeconds)
    guard ProcessInfo.processInfo.systemUptime < deadline else {
        throw fail("UIA_TIMEOUT", "accessibility window matching exceeded its bounded native deadline")
    }
    // The limit belongs at the AX copy boundary. Fetching the complete provider array and applying prefix(64) afterwards would already have materialized unbounded native state.
    let windows = axElementValues(app, attribute: kAXWindowsAttribute as CFString, limit: 64)
    for window in windows {
        guard ProcessInfo.processInfo.systemUptime < deadline else {
            throw fail("UIA_TIMEOUT", "exact accessibility window matching exceeded its bounded native deadline")
        }
        if axWindowNumber(window) == row.id { return window }
    }
    // Chromium may transiently stop publishing AXWindows across navigation while its focused or main AX window remains available. Resolve those independently by exact id or by the same unambiguous PID+geometry proof used elsewhere; never fall back to app identity alone.
    for preferred in [
        axElementAttribute(app, kAXFocusedWindowAttribute as CFString),
        axElementAttribute(app, kAXMainWindowAttribute as CFString)
    ].compactMap({ $0 }) {
        if let exact = axWindowNumber(preferred) {
            if exact == row.id { return preferred }
            continue
        }
        if let bounds = axBounds(preferred),
           convincinglyMatchesWindow(bounds, row.bounds),
           unambiguousWindowID(bounds: bounds, pid: row.pid, rows: allWindowRows(includeMinimized: true)) == row.id {
            return preferred
        }
    }
    var geometryCandidates: [(element: AXUIElement, distance: CGFloat)] = []
    for window in windows {
        guard ProcessInfo.processInfo.systemUptime < deadline else {
            throw fail("UIA_TIMEOUT", "accessibility window matching exceeded its bounded native deadline")
        }
        // Geometry may fill absent identity, but must never override a contradictory AX ID.
        guard axWindowNumber(window) == nil, let bounds = axBounds(window), convincinglyMatchesWindow(bounds, row.bounds) else { continue }
        geometryCandidates.append((window, windowGeometryDistance(bounds, row.bounds)))
    }
    geometryCandidates.sort { $0.distance < $1.distance }
    guard let winner = geometryCandidates.first else {
        throw fail("UIA_FAILED", "no accessibility window convincingly matches window \(row.id)")
    }
    // Chromium windows may overlap with a small cascade offset. A unique four-edge match identifies the target without weakening ambiguous cases.
    let exact = geometryCandidates.filter { approximatelyEqual(axBounds($0.element) ?? .null, row.bounds) }
    if exact.count == 1 { return exact[0].element }
    if exact.count > 1 || (geometryCandidates.count > 1 && geometryCandidates[1].distance - winner.distance < 32) {
        throw fail("UIA_FAILED", "multiple accessibility windows ambiguously match window \(row.id)")
    }
    return winner.element
}

func focusWindow(_ id: CGWindowID) throws -> Bool {
    guard let row = windowRow(id) else { return false }
    try requireAccessibility()
    if focusTargetMatches(row) { return true }
    guard let app = NSRunningApplication(processIdentifier: row.pid) else { return false }
    let window = try matchingAXWindow(row)
    var minimizedSettable = DarwinBoolean(false)
    if AXUIElementIsAttributeSettable(window, kAXMinimizedAttribute as CFString, &minimizedSettable) == .success,
       minimizedSettable.boolValue {
        _ = AXUIElementSetAttributeValue(window, kAXMinimizedAttribute as CFString, kCFBooleanFalse)
    }
    _ = app.activate(options: [.activateIgnoringOtherApps])
    let appElement = axApplication(row.pid)
    setAXBooleanIfPossible(appElement, kAXFrontmostAttribute as CFString, true)
    setAXValueIfPossible(appElement, kAXMainWindowAttribute as CFString, window)
    setAXValueIfPossible(appElement, kAXFocusedWindowAttribute as CFString, window)
    setAXBooleanIfPossible(window, kAXMainAttribute as CFString, true)
    setAXBooleanIfPossible(window, kAXFocusedAttribute as CFString, true)
    _ = AXUIElementPerformAction(window, kAXRaiseAction as CFString)
    let deadline = ProcessInfo.processInfo.systemUptime + 2.0
    var consecutiveMatches = 0
    while ProcessInfo.processInfo.systemUptime < deadline {
        if focusTargetMatches(row) {
            consecutiveMatches += 1
            if consecutiveMatches >= 3 { return true }
        } else {
            consecutiveMatches = 0
        }
        usleep(20_000)
    }
    return false
}

final class UISnapshot {
    let window: CGWindowID
    let windowBounds: CGRect
    let elements: [String: AXUIElement]

    init(window: CGWindowID, windowBounds: CGRect, elements: [String: AXUIElement]) {
        self.window = window
        self.windowBounds = windowBounds
        self.elements = elements
    }
}
