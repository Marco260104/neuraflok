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

func handle(_ request: JSONObject) throws -> JSONObject {
    let operation = string(request["op"])
    var result: JSONObject = ["ok": true]
    switch operation {
    case "warm":
        result["ready"] = true
        result["screenPermission"] = CGPreflightScreenCaptureAccess()
        result["accessibilityPermission"] = AXIsProcessTrusted()
    case "cursor":
        result["cursor"] = cursorObject()
        result["foreground"] = foregroundWindowID().map(Int.init) ?? 0
    case "windows":
        let foreground = foregroundWindowID()
        result["windows"] = allWindowRows().map { $0.json(foreground: foreground) }
        result["screen"] = rectObject(try virtualScreenRect())
    case "active":
        let foreground = foregroundWindowID()
        result["window"] = foreground.flatMap(windowRow)?.json(foreground: foreground) ?? NSNull()
        result["screen"] = rectObject(try virtualScreenRect())
    case "focus":
        let id = CGWindowID(int(request["id"]))
        result["focused"] = try focusWindow(id)
        result["foreground"] = foregroundWindowID().map(Int.init) ?? 0
    case "find_ui":
        result.merge(try findUI(request)) { _, new in new }
    case "act_ui":
        result.merge(try actUI(request)) { _, new in new }
    case "capture":
        result.merge(try capture(request)) { _, new in new }
    case "snapshot":
        let id = number(request["id"])?.uint32Value ?? foregroundWindowID()
        guard let id, let row = windowRow(id) else {
            throw fail("WINDOW_NOT_FOUND", "no matching visible window is available")
        }
        result["window"] = row.json(foreground: foregroundWindowID())
        if bool(request["includeScreenshot"]) {
            result.merge(try capture(request, forcedWindow: id)) { _, new in new }
        }
        if bool(request["includeUi"]) {
            do {
                let ui = try findUI(request, suppliedWindow: row)
                for key in ["snapshotId", "elements", "visited", "truncated"] {
                    result[key] = ui[key]
                }
            } catch let error as HelperFailure where error.code == "ACCESSIBILITY_PERMISSION_REQUIRED" {
                result["uiUnavailable"] = ["code": error.code, "message": error.message]
            }
        }
    case "act":
        try requireAccessibility()
        let frame = request["frame"] as? JSONObject
        if let frame { try validateFrame(frame) }
        let frameWindow = number(frame?["window"])?.uint32Value
        // A successful semantic or explicit focus step becomes the authority for later keyboard input in this same batch. The later input still re-proves exact focus; carrying the id prevents a frame-less click_ref -> type sequence from degrading into an unscoped global HID event.
        var inputWindow = frameWindow
        let actions = request["actions"] as? [JSONObject] ?? []
        var routes: [String] = []
        var completed = 0
        for (index, action) in actions.enumerated() {
            do {
                let type = string(action["type"])
                switch type {
                case "click_ui", "set_value_ui":
                    guard let actionWindow = number(action["window"])?.uint32Value else {
                        throw fail("BAD_ACTION", "semantic action has no target window")
                    }
                    if let frameWindow, frameWindow != actionWindow {
                        throw fail(
                            "TARGET_WINDOW_CONFLICT",
                            "semantic action targets window \(actionWindow), but frame targets window \(frameWindow)"
                        )
                    }
                    var uiRequest = action
                    uiRequest["id"] = action["window"]
                    uiRequest["action"] = type == "click_ui" ? "click" : "set_value"
                    uiRequest["value"] = action["value"]
                    let reply = try actUI(uiRequest)
                    routes.append(string(reply["route"], default: "uia"))
                    inputWindow = actionWindow
                case "move":
                    if let frame { _ = try assertFrameTarget(frame) }
                    try movePointer(CGPoint(x: int(action["x"]), y: int(action["y"])))
                    routes.append("sendinput")
                case "click", "double_click":
                    if let frame { _ = try assertFrameTarget(frame) }
                    try click(
                        CGPoint(x: int(action["x"]), y: int(action["y"])),
                        button: mouseButton(string(action["button"])),
                        count: type == "double_click" ? 2 : 1,
                        targetWindow: frameWindow
                    )
                    routes.append("sendinput")
                case "scroll":
                    if let frame { _ = try assertFrameTarget(frame) }
                    let scrollPoint = CGPoint(x: int(action["x"]), y: int(action["y"]))
                    try movePointer(scrollPoint)
                    if let frame { _ = try assertFrameTarget(frame) }
                    if let frameWindow { _ = try assertPointerTarget(frameWindow, point: scrollPoint) }
                    guard let event = CGEvent(
                        scrollWheelEvent2Source: nil,
                        units: .line,
                        wheelCount: 2,
                        wheel1: Int32(-int(action["scroll_y"])),
                        wheel2: Int32(int(action["scroll_x"])),
                        wheel3: 0
                    ) else { throw fail("INPUT_FAILED", "could not create a scroll event") }
                    event.post(tap: .cghidEventTap)
                    routes.append("sendinput")
                case "drag":
                    if let frame { _ = try assertFrameTarget(frame) }
                    try drag(
                        action["xs"] as? [NSNumber] ?? [],
                        action["ys"] as? [NSNumber] ?? [],
                        button: mouseButton(string(action["button"])),
                        targetWindow: frameWindow
                    )
                    routes.append("sendinput")
                case "type":
                    if let inputWindow { _ = try assertInputTarget(inputWindow) }
                    try typeText(string(action["text"]), targetWindow: inputWindow)
                    routes.append("sendinput")
                case "keypress":
                    if let inputWindow { _ = try assertInputTarget(inputWindow) }
                    try pressKeys(action["keys"] as? [String] ?? [], targetWindow: inputWindow)
                    routes.append("sendinput")
                case "focus":
                    let requested = CGWindowID(int(action["window"]))
                    if let frameWindow, frameWindow != requested {
                        throw fail(
                            "TARGET_WINDOW_CONFLICT",
                            "focus targets window \(requested), but frame targets window \(frameWindow)"
                        )
                    }
                    guard try focusWindow(requested) else {
                        throw fail("FOCUS_FAILED", "the requested window could not be activated")
                    }
                    routes.append("focus")
                    inputWindow = requested
                default:
                    throw fail("BAD_ACTION", "unknown action \(type)")
                }
                completed += 1
            } catch let error as HelperFailure {
                return [
                    "ok": false,
                    "error_code": error.code,
                    "message": error.message,
                    "completed_count": completed,
                    "failed_index": index,
                    "routes": routes
                ]
            }
        }
        result["cursor"] = cursorObject()
        result["foreground"] = foregroundWindowID().map(Int.init) ?? 0
        result["completed_count"] = completed
        result["routes"] = routes
    default:
        throw fail("BAD_REQUEST", "unknown operation \(operation)")
    }
    return result
}
