import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const helperDirectory = path.join(process.cwd(), 'backend/native/macos-desktop-helper');
const swift = readdirSync(helperDirectory).filter(file => file.endsWith('.swift')).sort().map(file => readFileSync(path.join(helperDirectory, file), 'utf8')).join('\n');
const preparation = readFileSync(path.join(process.cwd(), 'scripts/prepare-macos-desktop-helper.mjs'), 'utf8');
const nativeDirectory = path.join(process.cwd(), 'backend/infrastructure/device-control/native');
const computer = readdirSync(nativeDirectory).filter(file => file.endsWith('.ts')).sort().map(file => readFileSync(path.join(nativeDirectory, file), 'utf8')).join('\n');
const screenshots = readFileSync(path.join(nativeDirectory, 'screenshots.ts'), 'utf8');
const actions = readFileSync(path.join(nativeDirectory, 'actions.ts'), 'utf8');
const frameStore = readFileSync(path.join(process.cwd(), 'backend/infrastructure/device-control/native/frame-store.ts'), 'utf8');
const macOSAccess = readFileSync(path.join(process.cwd(), 'backend/infrastructure/device-control/native/macos-access.ts'), 'utf8');
const desktopOutput = readFileSync(path.join(process.cwd(), 'backend/infrastructure/tool-gateway/protocol/tools-desktop-macos/shared.ts'), 'utf8');

describe('macOS desktop safety hardening', () => {
  it('compiles every native helper module into both helper artifacts', () => {
    for (const file of ['NativeRuntime.swift', 'WindowSystem.swift', 'Interaction.swift', 'ScreenCapture.swift', 'RequestRouter.swift', 'main.swift']) {
      expect(preparation).toContain(`'${file}'`);
    }
    expect(preparation.match(/\.\.\.sources/g)).toHaveLength(2);
  });

  it('requires exact Workspace, WindowServer and AX agreement for physical input', () => {
    expect(swift).toContain('func windowServerFrontWindowID');
    expect(swift).toContain('func focusedAXWindowID');
    expect(swift).toContain('func focusedAXElementWindowID');
    expect(swift).toContain('func assertPointerTarget');
    expect(swift).toContain('func assertInputTarget');
    expect(swift).toContain('func assertFrameTarget');
    expect(swift).toContain('let reportedOnScreen = number(item[kCGWindowIsOnscreen as String])?.boolValue');
    expect(swift).toContain('let missingOnScreenFallback = reportedOnScreen == nil && onScreenIDs.contains(id) && !title.isEmpty');
    expect(swift).toContain('let onScreen = reportedOnScreen ?? missingOnScreenFallback');
    expect(swift).toMatch(/func focusTargetMatches[\s\S]*frontmostPID\(\) == row\.pid[\s\S]*focusedAXWindowID\(for: row\.pid, rows: rows\) == row\.id/);
    expect(swift).toMatch(/func focusWindow[\s\S]*focusTargetMatches\(row\)/);
    expect(swift).toMatch(/func pointerTargetMatches[\s\S]*frontmostPID\(\) == row\.pid/);
    expect(swift).toMatch(/func pointerTargetMatches[\s\S]*windowServerFrontWindowID\(rows: rows\) == row\.id/);
    expect(swift).toMatch(/func pointerTargetMatches[\s\S]*focusedAXWindowID\(for: row\.pid, rows: rows\) == row\.id/);
    expect(swift).toMatch(/func pointerTargetMatches[\s\S]*windowServerTopWindowID\(at: point\) == row\.id/);
    // Keyboard input keeps the full proof, including the focused control's own window.
    const keyboardProof = swift.slice(swift.indexOf('func inputTargetMatches'), swift.indexOf('func assertPointerTarget'));
    expect(keyboardProof).toContain('frontmostPID() == row.pid');
    expect(keyboardProof).toContain('windowServerFrontWindowID(rows: rows) == row.id');
    expect(keyboardProof).toContain('focusedAXWindowID(for: row.pid, rows: rows) == row.id');
    expect(keyboardProof).toContain('focusedAXElementWindowID(for: row.pid, rows: rows) == row.id');
  });

  it('falls back to Workspace only when system-wide AX reports an invalid focused-app pid', () => {
    expect(swift).toMatch(/kAXFocusedApplicationAttribute[\s\S]*let pid = axPID\(focused\),[\s\S]*pid > 0[\s\S]*return pid/);
    expect(swift).toMatch(/func frontmostPID[\s\S]*return NSWorkspace\.shared\.frontmostApplication\?\.processIdentifier/);
  });

  it('keeps AX-proven off-Space windows discoverable without weakening pointer proof', () => {
    expect(swift).toContain('func offscreenAXWindowStates');
    expect(swift).toContain('let offscreenStates = offscreenAXWindowStates(in: rows)');
    expect(swift).toContain('guard let minimized = offscreenStates[row.id] else { return nil }');
    expect(swift).toContain('"state": id == foreground ? "foreground" : (minimized ? "minimized" : "open")');
    expect(swift).toMatch(/offscreenAXWindowStates[\s\S]*unambiguousWindowID\(bounds: bounds, pid: pid, rows: rows\)/);
    expect(swift).toMatch(/matchingAXWindow[\s\S]*kAXFocusedWindowAttribute[\s\S]*unambiguousWindowID/);
    expect(swift).toMatch(/func pointerTargetMatches[\s\S]*windowServerFrontWindowID\(rows: rows\) == row\.id/);
  });

  it('rejects contradictory positive AX ids before geometry fallback', () => {
    expect(swift).toContain('id = rows.contains(where: { $0.id == exact && $0.pid == pid }) ? exact : nil');
    expect(swift).toMatch(/if let exact = axWindowNumber\(preferred\)[\s\S]*if exact == row\.id[\s\S]*continue/);
    expect(swift).toContain('guard axWindowNumber(window) == nil, let bounds = axBounds(window)');
  });

  it('includes floating windows in point occlusion proof', () => {
    const start = swift.indexOf('func windowServerTopWindowID');
    const end = swift.indexOf('func pointerTargetMatches');
    const proof = swift.slice(start, end);
    expect(proof).not.toContain('eligible.contains(id)');
    expect(proof).toContain('let dockBackdrop = layer == 20 && owner == "Dock" && name == "Dock"');
    expect(proof).toContain('if dockBackdrop { continue }');
    expect(proof).not.toContain('int(item[kCGWindowLayer as String]) == 0');
    expect(proof).toContain('bounds.contains(point)');
  });

  it('allows only AX-proven off-Space frames to activate before requiring on-screen pointer proof', () => {
    expect(swift).toMatch(/func validateFrame[\s\S]*guard let row = windowRow\(windowID\) else[\s\S]*focusWindow\(windowID\)[\s\S]*after\.onScreen[\s\S]*assertFrameTarget\(frame\)/);
    expect(swift).toMatch(/func assertFrameTarget[\s\S]*guard let row = windowRow\(windowID\), row\.onScreen/);
    expect(swift).toMatch(/func assertPointerTarget[\s\S]*guard let row = windowRow\(id\), row\.onScreen/);
  });

  it('never drives another app through Apple Events or an unproven WindowServer row', () => {
    expect(swift).not.toContain('NSAppleScript');
    expect(swift).not.toContain('rawWindowRow');
    expect(swift).toMatch(/func focusWindow[\s\S]*guard let row = windowRow\(id\) else \{ return false \}/);
    expect(swift).toMatch(/func focusWindow[\s\S]*consecutiveMatches >= 3/);
  });

  it('revalidates a window-bound frame at every physical mutation boundary', () => {
    expect(swift).toMatch(/case "move":[\s\S]*assertFrameTarget\(frame\)[\s\S]*movePointer/);
    expect(swift).toMatch(/case "click", "double_click":[\s\S]*assertFrameTarget\(frame\)[\s\S]*targetWindow: frameWindow/);
    expect(swift).toMatch(/case "scroll":[\s\S]*assertFrameTarget\(frame\)[\s\S]*event\.post/);
    expect(swift).toMatch(/case "drag":[\s\S]*assertFrameTarget\(frame\)[\s\S]*targetWindow: frameWindow/);
    expect(swift).toMatch(/func click[\s\S]*assertPointerTarget\(targetWindow, point: point\)/);
    expect(swift).toMatch(/func drag[\s\S]*assertPointerTarget\(targetWindow, point:/);
  });

  it('bounds AX-derived strings and keeps surrogate pairs in one text event', () => {
    expect(swift).toContain('let maxAXStringCharacters = 4_096');
    expect(swift).toContain('return boundedAXString(value)');
    expect(swift).toContain('boundedAXString(axString(element, kAXIdentifierAttribute');
    expect(swift).toContain('units[end - 1] >= 0xD800');
    expect(swift).toContain('units[end] >= 0xDC00');
    expect(swift).toContain('end -= 1');
  });

  it('carries explicit modifier flags on synthesized shortcut events', () => {
    expect(swift).toContain('let modifierFlags: [String: CGEventFlags]');
    expect(swift).toContain('event.flags = flags');
    expect(swift).toContain('CGEventSource(stateID: .privateState)');
    expect(swift).toContain('TISCopyCurrentKeyboardLayoutInputSource');
    expect(swift).toContain('UCKeyTranslate');
    expect(swift).toContain('active keyboard layout does not expose logical key');
    expect(preparation).toMatch(/'-framework',\s*'Carbon'/);
    const pressKeysProof = swift.slice(swift.indexOf('func pressKeys'), swift.indexOf('func typeText'));
    expect(pressKeysProof).toContain('targetPID = try assertInputTarget(targetWindow).pid');
  });

  it('routes system shortcuts globally and rejects disabled semantic controls', () => {
    expect(swift).toContain('func isSystemShortcut');
    expect(swift).toContain('if globalShortcut { event.post(tap: .cghidEventTap) }');
    expect(swift).toContain('UI_ACTION_DISABLED');
    expect(swift).toContain('the referenced accessibility control is disabled');
    expect(swift).toContain('axBool(element, kAXEnabledAttribute as CFString, default: false)');
    expect(swift).toContain('["volumeup", "volumedown", "mute"]');
    expect(swift).toContain('(1...20).contains(value)');
  });

  it('rejects physical points that fall between active displays', () => {
    expect(swift).toContain('func activeDisplayRects');
    expect(swift).toContain('func requirePointOnActiveDisplay');
    expect(swift).toContain('OUTSIDE_ACTIVE_DISPLAY');
    expect(swift).toContain('for point in points { try requirePointOnActiveDisplay(point, displays: displays) }');
  });

  it('keeps old ScreenCaptureKit allocations bounded and window geometry honest', () => {
    expect(swift).toMatch(/if #available\(macOS 13\.0, \*\) \{\s*configuration\.width = width\s*configuration\.height = height/);
    expect(swift).toContain('CAPTURE_GEOMETRY_UNSAFE');
    expect(swift).toContain('configuration.ignoreShadowsSingleWindow = true');
    expect(swift).toContain('native display capture exceeds the decoded-pixel budget on macOS 12');
    expect(swift).toContain('let maxEncodedScreenshotBytes = 6_242_304');
    expect(screenshots).toContain('export const MAX_SCREENSHOT_PNG_BYTES');
    expect(screenshots).toContain('SCREENSHOT_TOO_LARGE: encoded PNG');
  });

  it('bounds native AX messaging, traversal breadth and aggregate traversal time', () => {
    expect(swift).toContain('AXUIElementSetMessagingTimeout(system, 1.0)');
    expect(swift).toContain('let maxAXTraversalSeconds = 6.0');
    expect(swift).toContain('accessibility traversal exceeded its bounded native deadline');
    expect(swift).toContain('AXUIElementCopyAttributeValues');
    expect(swift).toContain('axChildren(element, limit: remainingBudget)');
    expect(swift).toContain('axElementValues(app, attribute: kAXWindowsAttribute as CFString, limit: 64)');
    expect(swift).not.toContain('windows.prefix(64)');
    expect(swift).toContain('matchingAXWindow(row, deadline: deadline)');
  });

  it('validates AX value types and the live owning window of every semantic ref', () => {
    expect(swift).toMatch(/func axPoint[\s\S]*CFGetTypeID\(value\) == AXValueGetTypeID\(\)/);
    expect(swift).toMatch(/func axSize[\s\S]*CFGetTypeID\(value\) == AXValueGetTypeID\(\)/);
    expect(swift).toContain('func unambiguousWindowID');
    expect(swift).toContain('func owningAXWindowID');
    expect(swift).toContain('axPID(element) == currentWindow.pid');
    expect(swift).toMatch(/func actUI[\s\S]*owningAXWindowID\(element, pid: currentWindow\.pid\) == snapshot\.window/);
  });

  it('binds screen frames to the exact active-display topology', () => {
    expect(swift).toContain('func sameDisplayTopology');
    expect(swift).toContain('let contentDisplayRects = content.displays.map(\\.frame)');
    expect(swift).toContain('sameDisplayTopology(displayRects, contentDisplayRects)');
    expect(swift).toContain('active display topology changed while screenshot capture was in progress');
    expect(swift).toContain('active display topology changed while screenshot was captured');
    expect(swift).toContain('"displays": displayTopologyObject(displayRects)');
    expect(swift).toContain('active display topology changed after the screenshot');
    expect(frameStore).toContain('displayTopology: Rect[] | null');
    expect(actions).toContain('displays: frame.displayTopology');
  });

  it('keeps explicit UI and captured-pixel target identities fail-closed', () => {
    expect(swift).toMatch(/rawRequested = request\["id"\][\s\S]*WINDOW_NOT_FOUND/);
    expect(swift).toContain('window \\(requested) is no longer available');
    expect(screenshots).toMatch(/screenshotFromReply\(reply, file, opts\.crop \? null : opts\.window \?\? null\)/);
    expect(computer).not.toContain('lastFrame?.windowId ?? null : cropFrame?.windowId');
    expect(screenshots).toContain("const frameWindow = captureMode === 'window' ? requestedWindow : null");
    expect(computer).toContain('windowId: frame.windowId');
    expect(computer).toContain("frame.captureMode !== 'screen_fallback'");
  });

  it('keeps every valid upscaled image pixel inside its desktop frame', () => {
    expect(actions).toContain('const upper = Math.max(lower, Math.ceil(origin + extent) - 1)');
    expect(actions).toContain('clampMappedCoordinate(Math.round(frame.region.x + x / frame.scale)');
    expect(actions).toContain('clampMappedCoordinate(Math.round(frame.region.y + y / frame.scale)');
  });

  it('budgets the actual combined Desktop text and image response', () => {
    expect(desktopOutput).toContain("Buffer.byteLength(JSON.stringify(result), 'utf8')");
    expect(desktopOutput).toContain('MAX_MCP_RESPONSE_BYTES - MCP_RESPONSE_ENVELOPE_RESERVE_BYTES');
    expect(desktopOutput).toContain('DESKTOP_RESULT_TOO_LARGE');
  });

  it('carries proven semantic and explicit focus targets into later keyboard input', () => {
    expect(swift).toContain('var inputWindow = frameWindow');
    expect(swift).toMatch(/case "click_ui", "set_value_ui":[\s\S]*inputWindow = actionWindow/);
    expect(swift).toMatch(/case "type":[\s\S]*assertInputTarget\(inputWindow\)[\s\S]*targetWindow: inputWindow/);
    expect(swift).toMatch(/case "keypress":[\s\S]*assertInputTarget\(inputWindow\)[\s\S]*targetWindow: inputWindow/);
    expect(swift).toMatch(/case "focus":[\s\S]*inputWindow = requested/);
  });

  it('publishes only the newest overlapping macOS permission refresh', () => {
    expect(macOSAccess).toContain('macOSDesktopAccessRefreshGeneration');
    expect(macOSAccess).toContain('generation === macOSDesktopAccessRefreshGeneration');
  });

  it('keeps permission prompting in Electron and native execution fail-closed', () => {
    expect(swift).toContain('Swift code inside the Electron process on a Node Worker');
    expect(swift).toContain('Electron owns prompting through systemPreferences');
    expect(swift).not.toContain('AXIsProcessTrustedWithOptions');
    expect(swift).not.toContain('older unsigned/ad-hoc build');
  });
});
