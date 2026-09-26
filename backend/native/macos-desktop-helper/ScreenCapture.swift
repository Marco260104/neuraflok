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

func validateFrame(_ frame: JSONObject) throws {
    guard let region = rect(frame["region"]) else { throw fail("STALE_FRAME", "the coordinate frame is malformed") }
    if let windowID = number(frame["window"])?.uint32Value {
        // An off-Space window is discovered with AX proof and is activated below.
        guard let row = windowRow(windowID) else {
            throw fail("STALE_FRAME", "target window \(windowID) is no longer available")
        }
        let expected = rect(frame["windowGeometry"]) ?? region
        guard row.bounds.integral == expected.integral else {
            throw fail("STALE_FRAME", "target window \(windowID) moved or resized after the screenshot")
        }
        guard try focusWindow(windowID) else { throw fail("FOCUS_FAILED", "window \(windowID) could not be activated") }
        guard let after = windowRow(windowID), after.onScreen, after.bounds.integral == expected.integral else {
            throw fail("STALE_FRAME", "target window \(windowID) changed geometry or remained off-screen while it was activated")
        }
        _ = try assertFrameTarget(frame)
    } else {
        guard let expectedDisplays = displayTopology(frame["displays"]) else {
            throw fail("STALE_FRAME", "the screen frame has no exact display topology")
        }
        let currentDisplays = try activeDisplayRects()
        guard sameDisplayTopology(expectedDisplays, currentDisplays) else {
            throw fail("STALE_FRAME", "active display topology changed after the screenshot")
        }
        let screen = currentDisplays.reduce(CGRect.null) { $0.union($1) }
        guard screen.contains(region) else { throw fail("STALE_FRAME", "desktop geometry changed after the screenshot") }
    }
}

@discardableResult
func assertFrameTarget(_ frame: JSONObject) throws -> CGWindowID? {
    guard let region = rect(frame["region"]) else { throw fail("STALE_FRAME", "the coordinate frame is malformed") }
    if let windowID = number(frame["window"])?.uint32Value {
        guard let row = windowRow(windowID), row.onScreen else {
            throw fail("STALE_FRAME", "target window \(windowID) is no longer drawable")
        }
        let expected = rect(frame["windowGeometry"]) ?? region
        guard row.bounds.integral == expected.integral else {
            throw fail("STALE_FRAME", "target window \(windowID) moved or resized after the screenshot")
        }
        _ = try assertPointerTarget(windowID)
        return windowID
    }
    guard let expectedDisplays = displayTopology(frame["displays"]) else {
        throw fail("STALE_FRAME", "the screen frame has no exact display topology")
    }
    let currentDisplays = try activeDisplayRects()
    guard sameDisplayTopology(expectedDisplays, currentDisplays) else {
        throw fail("STALE_FRAME", "active display topology changed after the screenshot")
    }
    let screen = currentDisplays.reduce(CGRect.null) { $0.union($1) }
    guard screen.contains(region) else { throw fail("STALE_FRAME", "desktop geometry changed after the screenshot") }
    return nil
}

func shareableContent() throws -> SCShareableContent {
    let semaphore = DispatchSemaphore(value: 0)
    var content: SCShareableContent?
    var failure: Error?
    SCShareableContent.getExcludingDesktopWindows(false, onScreenWindowsOnly: false) { value, error in
        content = value
        failure = error
        semaphore.signal()
    }
    guard semaphore.wait(timeout: .now() + 12) == .success else {
        throw fail("CAPTURE_TIMEOUT", "ScreenCaptureKit did not enumerate shareable content in time")
    }
    if let failure { throw fail("CAPTURE_FAILED", failure.localizedDescription) }
    guard let content else { throw fail("CAPTURE_FAILED", "ScreenCaptureKit returned no shareable content") }
    return content
}

private final class StreamFrameOutput: NSObject, SCStreamOutput, SCStreamDelegate {
    let semaphore = DispatchSemaphore(value: 0)
    let context = CIContext(options: nil)
    var image: CGImage?
    var failure: Error?
    private var finished = false

    private func finish() {
        guard !finished else { return }
        finished = true
        semaphore.signal()
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        failure = error
        finish()
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of outputType: SCStreamOutputType) {
        guard outputType == .screen, sampleBuffer.isValid, let pixelBuffer = sampleBuffer.imageBuffer else { return }
        let ciImage = CIImage(cvPixelBuffer: pixelBuffer)
        image = context.createCGImage(ciImage, from: ciImage.extent)
        finish()
    }
}

func captureImage(filter: SCContentFilter, configuration: SCStreamConfiguration) throws -> CGImage {
    if #available(macOS 14.0, *) {
        let semaphore = DispatchSemaphore(value: 0)
        var image: CGImage?
        var failure: Error?
        SCScreenshotManager.captureImage(contentFilter: filter, configuration: configuration) { value, error in
            image = value
            failure = error
            semaphore.signal()
        }
        guard semaphore.wait(timeout: .now() + 15) == .success else {
            throw fail("CAPTURE_TIMEOUT", "the screenshot did not finish in time")
        }
        if let failure { throw fail("CAPTURE_FAILED", failure.localizedDescription) }
        guard let image else { throw fail("CAPTURE_FAILED", "ScreenCaptureKit returned no image") }
        return image
    }

    let output = StreamFrameOutput()
    let stream = SCStream(filter: filter, configuration: configuration, delegate: output)
    do {
        try stream.addStreamOutput(output, type: .screen, sampleHandlerQueue: DispatchQueue(label: "neuraflok.capture"))
    } catch {
        throw fail("CAPTURE_FAILED", error.localizedDescription)
    }
    let started = DispatchSemaphore(value: 0)
    var startFailure: Error?
    stream.startCapture { error in
        startFailure = error
        started.signal()
    }
    guard started.wait(timeout: .now() + 10) == .success, startFailure == nil else {
        throw fail("CAPTURE_FAILED", startFailure?.localizedDescription ?? "the capture stream did not start")
    }
    guard output.semaphore.wait(timeout: .now() + 15) == .success else {
        stream.stopCapture(completionHandler: nil)
        throw fail("CAPTURE_TIMEOUT", "the capture stream produced no frame")
    }
    stream.stopCapture(completionHandler: nil)
    if let failure = output.failure { throw fail("CAPTURE_FAILED", failure.localizedDescription) }
    guard let image = output.image else { throw fail("CAPTURE_FAILED", "the capture stream produced no image") }
    return image
}

func writePNG(_ image: CGImage, path: String) throws {
    let url = URL(fileURLWithPath: path) as CFURL
    guard let destination = CGImageDestinationCreateWithURL(url, UTType.png.identifier as CFString, 1, nil) else {
        throw fail("CAPTURE_FAILED", "the PNG destination could not be created")
    }
    CGImageDestinationAddImage(destination, image, nil)
    guard CGImageDestinationFinalize(destination) else {
        throw fail("CAPTURE_FAILED", "the PNG file could not be written")
    }
    let attributes = try FileManager.default.attributesOfItem(atPath: path)
    let bytes = (attributes[.size] as? NSNumber)?.intValue ?? Int.max
    guard bytes <= maxEncodedScreenshotBytes else {
        try? FileManager.default.removeItem(atPath: path)
        throw fail(
            "SCREENSHOT_TOO_LARGE",
            "encoded PNG is \(bytes) bytes; limit \(maxEncodedScreenshotBytes) bytes"
        )
    }
}

func scaledDimensions(region: CGRect, maxWidth: Int, nativeWidth: Int? = nil) -> (Int, Int) {
    let ceiling = max(1, maxWidth)
    let available = max(1, nativeWidth ?? Int((region.width * 2).rounded()))
    var width = min(ceiling, available)
    var height = max(1, Int((Double(width) * region.height / region.width).rounded()))
    let pixels = Double(width) * Double(height)
    if pixels > Double(maxDecodedScreenshotPixels) {
        let reduction = sqrt(Double(maxDecodedScreenshotPixels) / pixels)
        width = max(1, Int((Double(width) * reduction).rounded(.down)))
        height = max(1, Int((Double(height) * reduction).rounded(.down)))
    }
    return (width, height)
}

func resizedImage(_ image: CGImage, width: Int, height: Int) throws -> CGImage {
    if image.width == width && image.height == height { return image }
    let colorSpace = CGColorSpaceCreateDeviceRGB()
    guard let context = CGContext(
        data: nil,
        width: width,
        height: height,
        bitsPerComponent: 8,
        bytesPerRow: width * 4,
        space: colorSpace,
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
    ) else { throw fail("CAPTURE_FAILED", "the scaled screenshot buffer could not be created") }
    context.interpolationQuality = .high
    context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
    guard let scaled = context.makeImage() else { throw fail("CAPTURE_FAILED", "the screenshot could not be scaled") }
    return scaled
}

func captureWindow(
    _ windowID: CGWindowID,
    maxWidth: Int,
    content: SCShareableContent,
    expectedGeometry: CGRect
) throws -> (CGImage, CGRect) {
    guard #available(macOS 14.0, *) else {
        // Pre-14 direct window capture cannot disable the window shadow. Returning that shadow-bearing bitmap against the shadow-free WindowServer frame would make every screenshot coordinate dishonest, so visible windows use the screen fallback.
        throw fail("CAPTURE_GEOMETRY_UNSAFE", "shadow-free direct window capture requires macOS 14")
    }
    guard let window = content.windows.first(where: { $0.windowID == windowID }) else {
        throw fail("WINDOW_NOT_FOUND", "no window with id \(windowID) is available for capture")
    }
    let region = window.frame
    guard approximatelyEqual(region, expectedGeometry) else {
        throw fail("STALE_FRAME", "window \(windowID) changed geometry before capture")
    }
    let (width, height) = scaledDimensions(region: region, maxWidth: maxWidth)
    let configuration = SCStreamConfiguration()
    configuration.width = width
    configuration.height = height
    configuration.showsCursor = true
    configuration.ignoreShadowsSingleWindow = true
    let filter = SCContentFilter(desktopIndependentWindow: window)
    let image = try captureImage(filter: filter, configuration: configuration)
    return (try resizedImage(image, width: width, height: height), region)
}

func captureDisplay(_ display: SCDisplay, maxWidth: Int) throws -> (CGImage, CGRect) {
    let region = display.frame
    let (width, height) = scaledDimensions(region: region, maxWidth: maxWidth, nativeWidth: display.width)
    let configuration = SCStreamConfiguration()
    if #available(macOS 13.0, *) {
        configuration.width = width
        configuration.height = height
    } else {
        // The 12.3 SDK surface cannot bound the decoded allocation before the first frame. Reject a native 5K/6K source rather than materialising it inside Electron and only discovering after the fact that it exceeded the advertised pixel ceiling.
        guard Double(display.width) * Double(display.height) <= Double(maxDecodedScreenshotPixels) else {
            throw fail("SCREEN_TOO_LARGE", "native display capture exceeds the decoded-pixel budget on macOS 12")
        }
    }
    configuration.showsCursor = true
    let filter = SCContentFilter(display: display, excludingApplications: [], exceptingWindows: [])
    let image = try captureImage(filter: filter, configuration: configuration)
    return (try resizedImage(image, width: width, height: height), region)
}

func captureComposite(
    region target: CGRect,
    maxWidth: Int,
    displays: [SCDisplay],
    expectedDisplays: [CGRect]
) throws -> CGImage {
    let (outputWidth, outputHeight) = scaledDimensions(region: target, maxWidth: maxWidth)
    let scale = CGFloat(outputWidth) / target.width
    let colorSpace = CGColorSpaceCreateDeviceRGB()
    guard let context = CGContext(
        data: nil,
        width: outputWidth,
        height: outputHeight,
        bitsPerComponent: 8,
        bytesPerRow: outputWidth * 4,
        space: colorSpace,
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
    ) else { throw fail("CAPTURE_FAILED", "the composite screenshot buffer could not be created") }
    context.setFillColor(NSColor.black.cgColor)
    context.fill(CGRect(x: 0, y: 0, width: outputWidth, height: outputHeight))

    for display in displays where display.frame.intersects(target) {
        guard sameDisplayTopology(expectedDisplays, try activeDisplayRects()) else {
            throw fail("STALE_FRAME", "active display topology changed while screenshot capture was in progress")
        }
        let (image, displayRegion) = try captureDisplay(display, maxWidth: display.width)
        guard sameDisplayTopology(expectedDisplays, try activeDisplayRects()) else {
            throw fail("STALE_FRAME", "active display topology changed while screenshot capture was in progress")
        }
        let intersection = displayRegion.intersection(target)
        guard !intersection.isNull, !intersection.isEmpty else { continue }
        let imageScaleX = CGFloat(image.width) / displayRegion.width
        let imageScaleY = CGFloat(image.height) / displayRegion.height
        let source = CGRect(
            x: (intersection.minX - displayRegion.minX) * imageScaleX,
            y: (intersection.minY - displayRegion.minY) * imageScaleY,
            width: intersection.width * imageScaleX,
            height: intersection.height * imageScaleY
        ).integral
        guard let cropped = image.cropping(to: source) else { continue }
        let destination = CGRect(
            x: (intersection.minX - target.minX) * scale,
            y: CGFloat(outputHeight) - ((intersection.minY - target.minY + intersection.height) * scale),
            width: intersection.width * scale,
            height: intersection.height * scale
        )
        context.draw(cropped, in: destination)
    }
    guard let image = context.makeImage() else { throw fail("CAPTURE_FAILED", "the composite screenshot was empty") }
    return image
}

func capture(_ request: JSONObject, forcedWindow: CGWindowID? = nil) throws -> JSONObject {
    try requireScreenCapture()
    let file = string(request["file"])
    guard !file.isEmpty else { throw fail("BAD_REQUEST", "capture needs an output file") }
    let maxWidth = min(2_560, max(1, int(request["maxWidth"], default: 1_280)))
    let displayRects = try activeDisplayRects()
    let screen = displayRects.reduce(CGRect.null) { $0.union($1) }
    let content = try shareableContent()
    let contentDisplayRects = content.displays.map(\.frame)
    guard sameDisplayTopology(displayRects, contentDisplayRects) else {
        throw fail("STALE_FRAME", "active display topology changed before screenshot capture began")
    }
    let requestedWindow = forcedWindow ?? number(request["id"])?.uint32Value

    let image: CGImage
    let region: CGRect
    let captureMode: String
    var capturedWindowGeometry: CGRect?
    if let requestedWindow {
        guard let row = windowRow(requestedWindow) else {
            throw fail("WINDOW_NOT_FOUND", "no window with id \(requestedWindow) is available")
        }
        capturedWindowGeometry = row.bounds
        do {
            (image, region) = try captureWindow(
                requestedWindow,
                maxWidth: maxWidth,
                content: content,
                expectedGeometry: row.bounds
            )
            captureMode = "window"
        } catch let error as HelperFailure {
            let canUseVisibleFallback = row.onScreen && [
                "WINDOW_NOT_FOUND",
                "CAPTURE_FAILED",
                "CAPTURE_TIMEOUT",
                "CAPTURE_GEOMETRY_UNSAFE"
            ].contains(error.code)
            guard canUseVisibleFallback else { throw error }
            region = row.bounds
            image = try captureComposite(
                region: region,
                maxWidth: maxWidth,
                displays: content.displays,
                expectedDisplays: displayRects
            )
            captureMode = "screen_fallback"
        }
        guard let fresh = windowRow(requestedWindow), approximatelyEqual(fresh.bounds, row.bounds) else {
            throw fail("STALE_FRAME", "window \(requestedWindow) moved or resized while it was captured")
        }
    } else if let requestedRegion = rect(request["region"]) {
        region = requestedRegion
        image = try captureComposite(
            region: region,
            maxWidth: maxWidth,
            displays: content.displays,
            expectedDisplays: displayRects
        )
        captureMode = "screen"
    } else if bool(request["full"]) {
        region = screen
        image = try captureComposite(
            region: region,
            maxWidth: maxWidth,
            displays: content.displays,
            expectedDisplays: displayRects
        )
        captureMode = "screen"
    } else {
        guard let display = content.displays.first(where: { $0.displayID == CGMainDisplayID() }) ?? content.displays.first else {
            throw fail("SCREEN_UNAVAILABLE", "ScreenCaptureKit reported no display")
        }
        (image, region) = try captureDisplay(display, maxWidth: maxWidth)
        captureMode = "screen"
    }
    guard sameDisplayTopology(displayRects, try activeDisplayRects()) else {
        throw fail("STALE_FRAME", "active display topology changed while screenshot was captured")
    }
    try writePNG(image, path: file)
    var response: JSONObject = [
        "region": rectObject(region),
        "image": ["width": image.width, "height": image.height],
        "screen": rectObject(screen),
        "displays": displayTopologyObject(displayRects),
        "focused": requestedWindow == nil ? NSNull() : foregroundWindowID() == requestedWindow,
        "captureMode": captureMode
    ]
    if let capturedWindowGeometry {
        response["windowGeometry"] = rectObject(capturedWindowGeometry)
    }
    return response
}
