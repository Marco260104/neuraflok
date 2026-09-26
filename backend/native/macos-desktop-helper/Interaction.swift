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

var nextSnapshotID = 1
var snapshots: [Int: UISnapshot] = [:]
var snapshotOrder: [Int] = []

func rememberSnapshot(window: CGWindowID, windowBounds: CGRect, elements: [String: AXUIElement]) -> Int {
    let id = nextSnapshotID
    nextSnapshotID += 1
    snapshots[id] = UISnapshot(window: window, windowBounds: windowBounds, elements: elements)
    snapshotOrder.append(id)
    while snapshotOrder.count > 16 {
        let removed = snapshotOrder.removeFirst()
        snapshots.removeValue(forKey: removed)
    }
    return id
}

func findUI(
    _ request: JSONObject,
    suppliedWindow: WindowRow? = nil
) throws -> JSONObject {
    // Window matching and control traversal are two phases of one native operation, not two independent six-second allowances. The parent timeout can now safely outlive this one aggregate deadline even though a synchronous addon call is not pre-emptible.
    let deadline = ProcessInfo.processInfo.systemUptime + maxAXTraversalSeconds
    let row: WindowRow
    if let suppliedWindow {
        row = suppliedWindow
    } else if let rawRequested = request["id"], !(rawRequested is NSNull) {
        guard let requested = number(rawRequested)?.uint32Value else {
            throw fail("BAD_REQUEST", "find_ui window id is malformed")
        }
        guard let found = windowRow(requested) else {
            throw fail("WINDOW_NOT_FOUND", "window \(requested) is no longer available")
        }
        row = found
    } else if let foreground = foregroundWindowID(), let found = windowRow(foreground) {
        row = found
    } else {
        throw fail("WINDOW_NOT_FOUND", "no matching visible window is available")
    }
    let root = try matchingAXWindow(row, deadline: deadline)
    let query = string(request["query"]).lowercased()
    let roleFilter = string(request["role"]).lowercased()
    let maxResults = min(100, max(1, int(request["maxResults"], default: 30)))
    let maxVisited = min(10_000, max(maxResults, int(request["maxVisited"], default: 4_000)))
    let screen = try virtualScreenRect()

    var queue: [AXUIElement] = [root]
    var cursor = 0
    var visited = 0
    var returned: [JSONObject] = []
    var retained: [String: AXUIElement] = [:]
    while cursor < queue.count && visited < maxVisited && returned.count < maxResults {
        guard ProcessInfo.processInfo.systemUptime < deadline else {
            throw fail("UIA_TIMEOUT", "accessibility traversal exceeded its bounded native deadline")
        }
        let element = queue[cursor]
        cursor += 1
        visited += 1
        let remainingBudget = max(0, maxVisited - queue.count)
        if remainingBudget > 0 {
            queue.append(contentsOf: axChildren(element, limit: remainingBudget))
        }

        let role = axRole(element)
        let name = axName(element)
        let identifier = boundedAXString(axString(element, kAXIdentifierAttribute as CFString) ?? "")
        let haystack = "\(name) \(role) \(identifier)".lowercased()
        guard (query.isEmpty || haystack.contains(query)),
              (roleFilter.isEmpty || role.lowercased().contains(roleFilter)) else { continue }
        guard let bounds = axBounds(element), bounds.width >= 0, bounds.height >= 0 else { continue }
        let runtimeKey = "e\(visited)"
        retained[runtimeKey] = element
        returned.append([
            "runtimeKey": runtimeKey,
            "name": name,
            "role": role,
            "automationId": identifier,
            "enabled": axBool(element, kAXEnabledAttribute as CFString, default: true),
            "offscreen": bounds.isEmpty || !screen.intersects(bounds),
            "bounds": rectObject(bounds)
        ])
    }

    let snapshotID = rememberSnapshot(window: row.id, windowBounds: row.bounds, elements: retained)
    return [
        "window": Int(row.id),
        "snapshotId": snapshotID,
        "elements": returned,
        "visited": visited,
        "truncated": cursor < queue.count || visited >= maxVisited
    ]
}

func mouseButton(_ name: String) -> CGMouseButton {
    switch name.lowercased() {
    case "right": return .right
    case "middle", "wheel": return .center
    default: return .left
    }
}

func mouseTypes(_ button: CGMouseButton) -> (CGEventType, CGEventType, CGEventType) {
    switch button {
    case .right: return (.rightMouseDown, .rightMouseUp, .rightMouseDragged)
    case .center: return (.otherMouseDown, .otherMouseUp, .otherMouseDragged)
    default: return (.leftMouseDown, .leftMouseUp, .leftMouseDragged)
    }
}

func postMouse(_ type: CGEventType, point: CGPoint, button: CGMouseButton, clickState: Int64 = 1) throws {
    guard let event = CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: point, mouseButton: button) else {
        throw fail("INPUT_FAILED", "could not create a mouse event")
    }
    event.setIntegerValueField(.mouseEventClickState, value: clickState)
    event.post(tap: .cghidEventTap)
}

func movePointer(_ point: CGPoint) throws {
    try requirePointOnActiveDisplay(point)
    try postMouse(.mouseMoved, point: point, button: .left)
}

func click(_ point: CGPoint, button: CGMouseButton, count: Int, targetWindow: CGWindowID? = nil) throws {
    try requirePointOnActiveDisplay(point)
    let (down, up, _) = mouseTypes(button)
    for clickIndex in 1...count {
        if let targetWindow { _ = try assertPointerTarget(targetWindow, point: point) }
        try postMouse(down, point: point, button: button, clickState: Int64(clickIndex))
        do {
            if let targetWindow { _ = try assertPointerTarget(targetWindow, point: point) }
            try postMouse(up, point: point, button: button, clickState: Int64(clickIndex))
        } catch {
            // Release the button even if focus changed after mouse-down; never leave a system-wide synthetic button held while reporting the target-loss failure.
            try? postMouse(up, point: point, button: button, clickState: Int64(clickIndex))
            throw error
        }
        usleep(35_000)
    }
}

func drag(
    _ xs: [NSNumber],
    _ ys: [NSNumber],
    button: CGMouseButton,
    targetWindow: CGWindowID? = nil
) throws {
    guard xs.count == ys.count, xs.count >= 2 else { throw fail("BAD_ACTION", "drag needs at least two points") }
    let points = zip(xs, ys).map { CGPoint(x: $0.0.doubleValue, y: $0.1.doubleValue) }
    let displays = try activeDisplayRects()
    for point in points { try requirePointOnActiveDisplay(point, displays: displays) }
    let (down, up, dragged) = mouseTypes(button)
    if let targetWindow { _ = try assertPointerTarget(targetWindow, point: points[0]) }
    try postMouse(down, point: points[0], button: button)
    var current = points[0]
    do {
        for point in points.dropFirst() {
            if let targetWindow { _ = try assertPointerTarget(targetWindow, point: point) }
            try postMouse(dragged, point: point, button: button)
            current = point
            usleep(12_000)
        }
        if let targetWindow { _ = try assertPointerTarget(targetWindow, point: points[points.count - 1]) }
        try postMouse(up, point: points[points.count - 1], button: button)
    } catch {
        try? postMouse(up, point: current, button: button)
        throw error
    }
}

let keyCodes: [String: CGKeyCode] = [
    "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9,
    "b": 11, "q": 12, "w": 13, "e": 14, "r": 15, "y": 16, "t": 17,
    "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "=": 24, "9": 25, "7": 26,
    "-": 27, "8": 28, "0": 29, "]": 30, "o": 31, "u": 32, "[": 33, "i": 34, "p": 35,
    "return": 36, "enter": 36, "l": 37, "j": 38, "'": 39, "k": 40, ";": 41, "\\": 42,
    ",": 43, "/": 44, "n": 45, "m": 46, ".": 47, "tab": 48, "space": 49, "`": 50,
    "backspace": 51, "delete": 51, "escape": 53, "esc": 53,
    "command": 55, "cmd": 55, "meta": 55, "shift": 56, "capslock": 57, "option": 58, "alt": 58,
    "control": 59, "ctrl": 59, "rightshift": 60, "rightoption": 61, "rightcontrol": 62,
    "f17": 64, "volumeup": 72, "volumedown": 73, "mute": 74, "f18": 79, "f19": 80,
    "f20": 90, "f5": 96, "f6": 97, "f7": 98, "f3": 99, "f8": 100, "f9": 101,
    "f11": 103, "f13": 105, "f16": 106, "f14": 107, "f10": 109, "f12": 111, "f15": 113,
    "help": 114, "home": 115, "pageup": 116, "forwarddelete": 117, "f4": 118, "end": 119,
    "f2": 120, "pagedown": 121, "f1": 122, "left": 123, "right": 124, "down": 125, "up": 126
]

let modifierFlags: [String: CGEventFlags] = [
    "command": .maskCommand,
    "shift": .maskShift,
    "rightshift": .maskShift,
    "option": .maskAlternate,
    "rightoption": .maskAlternate,
    "control": .maskControl,
    "rightcontrol": .maskControl,
    "capslock": .maskAlphaShift
]

func normalizedKeyName(_ name: String) -> String {
    switch name.lowercased() {
    case "cmd", "meta": return "command"
    case "alt": return "option"
    case "ctrl": return "control"
    case "esc": return "escape"
    default: return name.lowercased()
    }
}

func isSystemShortcut(_ names: [String]) -> Bool {
    let keys = Set(names)
    if !keys.isDisjoint(with: ["volumeup", "volumedown", "mute"]) { return true }
    if keys.contains(where: { name in
        guard name.hasPrefix("f"), let value = Int(name.dropFirst()) else { return false }
        return (1...20).contains(value)
    }) { return true }
    if keys.contains("command") && (keys.contains("tab") || keys.contains("space")) { return true }
    if keys.contains("command") && keys.contains("option") && keys.contains("escape") { return true }
    if keys.contains("control") && !keys.isDisjoint(with: ["left", "right", "up", "down"]) { return true }
    if keys.contains("control") && keys.contains("space") { return true }
    if keys.contains("command") && keys.contains("shift") && !keys.isDisjoint(with: ["3", "4", "5"]) { return true }
    return false
}

struct ResolvedKey {
    let code: CGKeyCode
    let requiredFlags: CGEventFlags
}

struct KeyboardLayoutSnapshot {
    let data: Data
    let kbdType: UInt32
}

private final class KeyboardLayoutBox {
    var snapshot: KeyboardLayoutSnapshot?
}

/** Reads the active key layout on the main queue. Text Services input-source lookups are main-queue-affine. Reached from anywhere else macOS does not return an error: `dispatch_assert_queue` fails and raises EXC_BREAKPOINT, taking the host process with it, below anything Swift or JS can catch. The addon is entered on a Node worker thread, so the hop belongs here rather than in every caller. Not `DispatchQueue.main.sync`: that deadlocks when already on main and waits forever when the main thread is busy, trading the crash for a hang. Running inline covers the first, the bounded wait covers the second. The layout bytes are copied because they belong to the input source, which is released when this returns; UCKeyTranslate then reads the copy off-main. */
func currentKeyboardLayout() -> KeyboardLayoutSnapshot? {
    func read() -> KeyboardLayoutSnapshot? {
        guard let source = TISCopyCurrentKeyboardLayoutInputSource()?.takeRetainedValue() else { return nil }
        guard let rawData = TISGetInputSourceProperty(source, kTISPropertyUnicodeKeyLayoutData) else { return nil }
        let data = unsafeBitCast(rawData, to: CFData.self)
        guard let bytes = CFDataGetBytePtr(data) else { return nil }
        return KeyboardLayoutSnapshot(
            data: Data(bytes: bytes, count: CFDataGetLength(data)),
            kbdType: UInt32(LMGetKbdType())
        )
    }
    if Thread.isMainThread { return read() }
    let box = KeyboardLayoutBox()
    let done = DispatchSemaphore(value: 0)
    DispatchQueue.main.async {
        box.snapshot = read()
        done.signal()
    }
    guard done.wait(timeout: .now() + 2.0) == .success else { return nil }
    return box.snapshot
}

func currentLayoutKey(for logicalName: String, in snapshot: KeyboardLayoutSnapshot) -> ResolvedKey? {
    return snapshot.data.withUnsafeBytes { raw -> ResolvedKey? in
        guard let base = raw.baseAddress else { return nil }
        let layout = base.assumingMemoryBound(to: UCKeyboardLayout.self)
        let modifierCandidates: [(carbon: UInt32, event: CGEventFlags)] = [
            (0, []),
            (UInt32(shiftKey >> 8), .maskShift),
            (UInt32(optionKey >> 8), .maskAlternate),
            (UInt32((shiftKey | optionKey) >> 8), [.maskShift, .maskAlternate])
        ]

        for candidate in modifierCandidates {
            for rawCode in 0..<128 {
                var deadKeyState: UInt32 = 0
                var actualLength = 0
                var characters = Array<UniChar>(repeating: 0, count: 8)
                let status = characters.withUnsafeMutableBufferPointer { buffer in
                    UCKeyTranslate(
                        layout,
                        UInt16(rawCode),
                        UInt16(kUCKeyActionDisplay),
                        candidate.carbon,
                        snapshot.kbdType,
                        OptionBits(kUCKeyTranslateNoDeadKeysMask),
                        &deadKeyState,
                        buffer.count,
                        &actualLength,
                        buffer.baseAddress!
                    )
                }
                guard status == noErr, actualLength > 0 else { continue }
                let rendered = characters.withUnsafeBufferPointer {
                    String(utf16CodeUnits: $0.baseAddress!, count: Int(actualLength))
                }
                if rendered.lowercased() == logicalName.lowercased() {
                    return ResolvedKey(code: CGKeyCode(rawCode), requiredFlags: candidate.event)
                }
            }
        }
        return nil
    }
}

func resolveKey(_ name: String, in snapshot: KeyboardLayoutSnapshot?) throws -> ResolvedKey {
    if name.count == 1 {
        guard let snapshot else {
            throw fail("INPUT_FAILED", "the active keyboard layout could not be read in time")
        }
        guard let resolved = currentLayoutKey(for: name, in: snapshot) else {
            throw fail("BAD_KEY", "active keyboard layout does not expose logical key \(name)")
        }
        return resolved
    }
    guard let code = keyCodes[name] else { throw fail("BAD_KEY", "unknown key \(name)") }
    return ResolvedKey(code: code, requiredFlags: [])
}

func pressKeys(_ names: [String], targetWindow: CGWindowID? = nil) throws {
    let normalized = names.map(normalizedKeyName)
    // One snapshot for the whole chord, taken before any window authority is resolved: the existing revalidations still sit immediately before the events they guard.
    let layout = normalized.contains { $0.count == 1 } ? currentKeyboardLayout() : nil
    let resolved = try normalized.map { try resolveKey($0, in: layout) }
    let globalShortcut = isSystemShortcut(normalized)
    guard let source = CGEventSource(stateID: .privateState) else {
        throw fail("INPUT_FAILED", "could not create a keyboard event source")
    }
    var targetPID: pid_t?
    if let targetWindow { targetPID = try assertInputTarget(targetWindow).pid }

    func postKey(_ code: CGKeyCode, keyDown: Bool, flags: CGEventFlags) throws {
        guard let event = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: keyDown) else {
            throw fail("INPUT_FAILED", "could not create a keyboard event")
        }
        event.flags = flags
        if globalShortcut { event.post(tap: .cghidEventTap) }
        else if let targetPID { event.postToPid(targetPID) }
        else { event.post(tap: .cghidEventTap) }
    }

    var flags: CGEventFlags = []
    let modifierIndices = normalized.indices.filter { modifierFlags[normalized[$0]] != nil }
    let ordinaryIndices = normalized.indices.filter { modifierFlags[normalized[$0]] == nil }
    var pressedModifierIndices: [Int] = []
    do {
        if let targetWindow { targetPID = try assertInputTarget(targetWindow).pid }
        for index in modifierIndices {
            guard let flag = modifierFlags[normalized[index]] else { continue }
            flags.insert(flag)
            try postKey(resolved[index].code, keyDown: true, flags: flags)
            pressedModifierIndices.append(index)
        }
        // A window transition while modifiers are down must abort before the ordinary key.
        if let targetWindow { targetPID = try assertInputTarget(targetWindow).pid }
        for index in ordinaryIndices {
            try postKey(resolved[index].code, keyDown: true, flags: flags.union(resolved[index].requiredFlags))
        }
        usleep(35_000)
        for index in ordinaryIndices.reversed() {
            try postKey(resolved[index].code, keyDown: false, flags: flags.union(resolved[index].requiredFlags))
        }
        for index in pressedModifierIndices.reversed() {
            guard let flag = modifierFlags[normalized[index]] else { continue }
            flags.remove(flag)
            try postKey(resolved[index].code, keyDown: false, flags: flags)
        }
    } catch {
        for index in pressedModifierIndices.reversed() {
            guard let flag = modifierFlags[normalized[index]] else { continue }
            flags.remove(flag)
            try? postKey(resolved[index].code, keyDown: false, flags: flags)
        }
        throw error
    }
}

func typeText(_ text: String, targetWindow: CGWindowID? = nil) throws {
    guard let source = CGEventSource(stateID: .privateState) else {
        throw fail("INPUT_FAILED", "could not create a keyboard event source")
    }
    let units = Array(text.utf16)
    var cursor = 0
    while cursor < units.count {
        var end = min(units.count, cursor + 32)
        if end < units.count, end > cursor,
           units[end - 1] >= 0xD800, units[end - 1] <= 0xDBFF,
           units[end] >= 0xDC00, units[end] <= 0xDFFF {
            end -= 1
        }
        let chunk = Array(units[cursor..<end])
        guard let down = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: true),
              let up = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: false) else {
            throw fail("INPUT_FAILED", "could not create a text input event")
        }
        chunk.withUnsafeBufferPointer { pointer in
            down.keyboardSetUnicodeString(stringLength: chunk.count, unicodeString: pointer.baseAddress!)
            up.keyboardSetUnicodeString(stringLength: chunk.count, unicodeString: pointer.baseAddress!)
        }
        if let targetWindow {
            let target = try assertInputTarget(targetWindow)
            down.postToPid(target.pid)
            up.postToPid(target.pid)
        } else {
            down.post(tap: .cghidEventTap)
            up.post(tap: .cghidEventTap)
        }
        cursor = end
    }
}

func cursorObject() -> JSONObject {
    let location = CGEvent(source: nil)?.location ?? .zero
    return ["x": Int(location.x.rounded()), "y": Int(location.y.rounded())]
}

func actUI(_ request: JSONObject) throws -> JSONObject {
    try requireAccessibility()
    let snapshotID = int(request["snapshotId"])
    let runtimeKey = string(request["runtimeKey"])
    guard let snapshot = snapshots[snapshotID] else {
        throw fail(
            "STALE_UI_SNAPSHOT",
            "UI snapshot \(snapshotID) is no longer retained; retained snapshots: \(snapshotOrder.map(String.init).joined(separator: ","))"
        )
    }
    let requestedWindow = number(request["id"])?.uint32Value
    guard snapshot.window == requestedWindow else {
        throw fail(
            "STALE_UI_SNAPSHOT",
            "UI snapshot \(snapshotID) belongs to window \(snapshot.window), but the action requested window \(requestedWindow.map(String.init) ?? "missing")"
        )
    }
    guard let element = snapshot.elements[runtimeKey] else {
        throw fail("UNKNOWN_UI_REF", "the UI element no longer exists in snapshot \(snapshotID)")
    }
    guard let currentWindow = windowRow(snapshot.window),
          axPID(element) == currentWindow.pid,
          owningAXWindowID(element, pid: currentWindow.pid) == snapshot.window else {
        throw fail(
            "STALE_UI_SNAPSHOT",
            "the referenced accessibility control no longer belongs to snapshot window \(snapshot.window)"
        )
    }
    // Mutation requires an explicitly readable true value. Missing, untyped or timed-out AXEnabled evidence is not permission to click through the uncertainty.
    guard axBool(element, kAXEnabledAttribute as CFString, default: false) else {
        throw fail("UI_ACTION_DISABLED", "the referenced accessibility control is disabled")
    }
    let action = string(request["action"])
    var route = "uia"
    if action == "set_value" {
        var settable = DarwinBoolean(false)
        guard AXUIElementIsAttributeSettable(element, kAXValueAttribute as CFString, &settable) == .success,
              settable.boolValue,
              AXUIElementSetAttributeValue(element, kAXValueAttribute as CFString, string(request["value"]) as CFTypeRef) == .success else {
            throw fail("UI_ACTION_FAILED", "the control does not expose a settable value")
        }
    } else if action == "click" {
        if AXUIElementPerformAction(element, kAXPressAction as CFString) != .success {
            guard try focusWindow(snapshot.window) else {
                throw fail("FOCUS_FAILED", "snapshot window \(snapshot.window) could not be activated")
            }
            guard let live = windowRow(snapshot.window),
                  live.bounds.integral == snapshot.windowBounds.integral else {
                throw fail("STALE_UI_SNAPSHOT", "the UI snapshot window moved or resized")
            }
            guard let bounds = axBounds(element), !bounds.isEmpty else {
                throw fail("UI_ACTION_FAILED", "the control exposes neither AXPress nor usable bounds")
            }
            guard let row = windowRow(snapshot.window),
                  row.onScreen,
                  row.bounds.insetBy(dx: -24, dy: -24).contains(CGPoint(x: bounds.midX, y: bounds.midY)) else {
                throw fail("STALE_UI_SNAPSHOT", "the control is no longer inside snapshot window \(snapshot.window)")
            }
            try click(
                CGPoint(x: bounds.midX, y: bounds.midY),
                button: .left,
                count: 1,
                targetWindow: snapshot.window
            )
            route = "sendinput"
        }
    } else {
        throw fail("BAD_ACTION", "unknown UI action \(action)")
    }
    return ["runtimeKey": runtimeKey, "name": axName(element), "route": route]
}
