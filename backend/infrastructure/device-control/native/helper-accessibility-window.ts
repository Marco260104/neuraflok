import { BROWSER_PROCESS_PATTERN } from './browser-chords.js';

export const WINDOWS_HELPER_WINDOW = String.raw`function Get-WindowRows {
  $rows = @()
  foreach ($line in [NeuraflokWindowsControl]::Windows()) {
    $rows += Convert-WindowRow $line
  }
  return $rows
}

function Convert-WindowRow([string]$line) {
  if ([string]::IsNullOrEmpty($line)) { return $null }
  $f = $line -split ([char]31)
  return @{
    id = [int64]$f[0]; title = $f[1]; process = $f[2]
    x = [int]$f[3]; y = [int]$f[4]; width = [int]$f[5]; height = [int]$f[6]; state = $f[7]
    app = $f[8]; processId = [uint32]$f[9]; processPath = $f[10]; appUserModelId = $f[11]; dpi = [int]$f[12]
  }
}

function Get-WindowRow([int64]$id) {
  return Convert-WindowRow ([NeuraflokWindowsControl]::Window($id))
}

function Get-ScreenRect {
  $s = [NeuraflokWindowsControl]::Screen() -split ','
  return @{
    virtual = @{ x = [int]$s[0]; y = [int]$s[1]; width = [int]$s[2]; height = [int]$s[3] }
    primary = @{ x = 0; y = 0; width = [int]$s[4]; height = [int]$s[5] }
  }
}

function Try-Focus([int64]$id) {
  if ([NeuraflokWindowsControl]::InputIsFocused($id)) { return $true }
  $null = [NeuraflokWindowsControl]::Focus($id)
  # Activation is asynchronous for some windows. Confirm the actual foreground state and stop as soon as it lands, including when SetForegroundWindow returned false. That immediate result does not replace the target's actual foreground postcondition.
  $timer = [Diagnostics.Stopwatch]::StartNew()
  do {
    if ([NeuraflokWindowsControl]::InputIsFocused($id)) { return $true }
    Start-Sleep -Milliseconds 10
  } while ($timer.ElapsedMilliseconds -lt 250)
  return $false
}

function Assert-Focused([int64]$id) {
  if (-not (Try-Focus $id)) {
    $foreground = [NeuraflokWindowsControl]::ForegroundId()
    throw "FOCUS_FAILED: requested $id but foreground is $foreground after asking Windows to activate it. Inspect list_windows and the target's owned dialogs before retrying."
  }
}

function Ui-RuntimeKey($element) {
  try { return (@($element.GetRuntimeId()) -join '.') } catch { return '' }
}

function Get-UiRoot([int64]$id) {
  $root = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]$id)
  if ($null -eq $root) { throw "UIA_FAILED: no accessible window with id $id" }
  if ($root.Current.ClassName -ne 'Chrome_WidgetWin_1') { return $root }
  $window = Get-WindowRow $id
  if ($null -eq $window) { throw "UIA_FAILED: window $id disappeared during observation" }
  if ($window.process -notmatch '${BROWSER_PROCESS_PATTERN.source}') { return $root }

  # Chromium also exposes legacy renderer HWNDs as direct children. They retain old tabs, plausible bounds and even IsOffscreen=false. BrowserRootView owns the current browser UI, including its address bar and selected document. Select that exact provider before spending the bounded element traversal.
  $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
  $child = $walker.GetFirstChild($root)
  $browserRoot = $null
  $visited = 0
  while ($null -ne $child -and $visited -lt 128) {
    $visited += 1
    if ($child.Current.ClassName -eq 'BrowserRootView') {
      if ($null -ne $browserRoot) { throw 'UIA_FAILED: multiple browser UI roots; use the screenshot instead' }
      $browserRoot = $child
    }
    $child = $walker.GetNextSibling($child)
  }
  if ($null -ne $child -or $null -eq $browserRoot) {
    throw 'UIA_FAILED: current browser UI root is unavailable; use the screenshot instead'
  }
  return $browserRoot
}

`;
