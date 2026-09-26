export const WINDOWS_REQUEST_ROUTER = String.raw`
function Handle-Request($request) {
  [NeuraflokWindowsControl]::EnsureDpiAware()
  $result = @{ ok = $true }
  switch ($request.op) {
    'warm' {
      # Touch both Win32 and UIA without reading pixels or changing focus. Connector startup can pay Add-Type and provider initialization before the first model-facing action.
      $null = [NeuraflokWindowsControl]::ForegroundId()
      $null = [System.Windows.Automation.AutomationElement]::RootElement.Current.ProcessId
      $result.ready = $true
    }
    'cursor' {
      $cursor = [NeuraflokWindowsControl]::Cursor() -split ','
      $result.cursor = @{ x = [int]$cursor[0]; y = [int]$cursor[1] }
      $result.foreground = [NeuraflokWindowsControl]::ForegroundId()
    }
    'windows' {
      $screen = Get-ScreenRect
      $result.windows = @(Get-WindowRows)
      $result.screen = $screen.virtual
    }
    'apps' {
      $apps = Get-WindowsApps $request
      foreach ($key in $apps.Keys) { $result[$key] = $apps[$key] }
    }
    'active' {
      $screen = Get-ScreenRect
      $foreground = [NeuraflokWindowsControl]::ForegroundId()
      $result.window = Get-WindowRow $foreground
      $result.screen = $screen.virtual
    }
    'find_ui' {
      $ui = Find-UiElements $request
      $result.window = $ui.window
      $result.snapshotId = $ui.snapshotId
      $result.elements = @($ui.elements)
      $result.visited = $ui.visited
      $result.truncated = $ui.truncated
      $result.document_text = $ui.document_text
      $result.selected_text = $ui.selected_text
      $result.focused_element = $ui.focused_element
    }
    'act_ui' {
      $ui = Act-UiElement $request
      $result.runtimeKey = $ui.runtimeKey
      $result.name = $ui.name
      $result.route = $ui.route
    }
    'capture' {
      $capture = Capture-Target $request $null
      foreach ($key in $capture.Keys) { $result[$key] = $capture[$key] }
    }
    'snapshot' {
      $id = if ($request.id) { [int64]$request.id } else { [NeuraflokWindowsControl]::ForegroundId() }
      $window = Get-WindowRow $id
      if ($null -eq $window) { throw "WINDOW_NOT_FOUND: no matching visible window is available" }
      $result.window = $window
      if ($request.includeRelated) {
        $result.relatedWindows = @([NeuraflokWindowsControl]::RelatedWindows($id) | ForEach-Object { Convert-WindowRow $_ })
      }
      if ($request.includeScreenshot) {
        try {
          $capture = Capture-Target $request ([Nullable[int64]]$id)
          foreach ($key in $capture.Keys) { $result[$key] = $capture[$key] }
        } catch {
          $message = $_.Exception.GetBaseException().Message
          # A missing compositor surface does not invalidate this window's UIA provider. Keep both channels in this transaction; never restore/focus the user's window. Geometry, identity and screenshot-only failures still require a fresh observation.
          if (-not $request.includeUi -or $message -notmatch '^CAPTURE_FAILED:') { throw }
          $result.screenshotUnavailable = @{ code = 'CAPTURE_FAILED'; message = $message.Substring(0, [Math]::Min(500, $message.Length)) }
        }
      }
      if ($request.includeUi) {
        $uiRequest = @{
          id = $id
          query = if ($request.query) { $request.query } else { '' }
          role = if ($request.role) { $request.role } else { '' }
          maxResults = $request.maxResults
          maxVisited = $request.maxVisited
        }
        try {
          $ui = Find-UiElements $uiRequest
          $result.snapshotId = $ui.snapshotId
          $result.elements = @($ui.elements)
          $result.visited = $ui.visited
          $result.truncated = $ui.truncated
          $result.document_text = $ui.document_text
          $result.selected_text = $ui.selected_text
          $result.focused_element = $ui.focused_element
        } catch {
          # Accessibility is optional observation metadata. Preserve successful pixels when an application provider cannot expose its controls.
          $result.uiUnavailable = @{ code = 'UIA_FAILED'; message = $_.Exception.Message }
          $result.elements = @()
        }
      }
      if ($result.screenshotUnavailable -and $result.uiUnavailable) {
        throw ($result.screenshotUnavailable.message + '; UIA_FAILED: ' + $result.uiUnavailable.message)
      }
    }
    'focus' {
      $id = [int64]$request.id
      $result.focused = (Try-Focus $id)
      $result.foreground = [NeuraflokWindowsControl]::ForegroundId()
    }
    'act' {
      return Invoke-ActionBatch $request
    }
    default { throw "BAD_REQUEST: Unknown op: $($request.op)" }
  }
  return $result
}
`;
