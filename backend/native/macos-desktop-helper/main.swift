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

func response(for line: String) -> JSONObject {
    do {
        guard let data = line.data(using: .utf8),
              let request = try JSONSerialization.jsonObject(with: data) as? JSONObject else {
            throw fail("BAD_REQUEST", "request is not a JSON object")
        }
        return try handle(request)
    } catch let error as HelperFailure {
        return ["ok": false, "error_code": error.code, "message": error.message]
    } catch {
        return ["ok": false, "error_code": "HELPER_ERROR", "message": error.localizedDescription]
    }
}

func writeResponse(_ response: JSONObject) {
    do {
        let data = try JSONSerialization.data(withJSONObject: response)
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data([0x0A]))
    } catch {
        let fallback = "{\"ok\":false,\"error_code\":\"HELPER_ERROR\",\"message\":\"response serialization failed\"}\n"
        FileHandle.standardOutput.write(Data(fallback.utf8))
    }
}

#if NEURAFLOK_DESKTOP_ADDON
@_cdecl("neuraflok_desktop_handle_json")
public func neuraflokDesktopHandleJSON(_ request: UnsafePointer<CChar>?) -> UnsafeMutablePointer<CChar>? {
    guard let request else { return strdup("{\"ok\":false,\"error_code\":\"BAD_REQUEST\",\"message\":\"missing JSON request\"}") }
    return autoreleasepool {
        let object = response(for: String(cString: request))
        guard let data = try? JSONSerialization.data(withJSONObject: object),
              let json = String(data: data, encoding: .utf8) else {
            return strdup("{\"ok\":false,\"error_code\":\"HELPER_ERROR\",\"message\":\"response serialization failed\"}")
        }
        return strdup(json)
    }
}

@_cdecl("neuraflok_desktop_free_json")
public func neuraflokDesktopFreeJSON(_ value: UnsafeMutablePointer<CChar>?) {
    free(value)
}
#else
@main
enum MacOSDesktopHelperMain {
    static func main() {
        while let line = readLine() {
            if line.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { continue }
            autoreleasepool {
                writeResponse(response(for: line))
            }
        }
    }
}
#endif
