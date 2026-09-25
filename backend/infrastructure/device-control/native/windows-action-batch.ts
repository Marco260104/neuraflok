export const WINDOWS_ACTION_BATCH = String.raw`
function Invoke-ActionBatch($request) {
  $result = @{ ok = $true }
      # Resolve every key before focus, pointer or text effects. A typo in a later chord must not leave the earlier half of a deterministic-invalid batch applied.
      $keyTarget = if ($request.targetWindow) { [int64]$request.targetWindow } else { [NeuraflokWindowsControl]::ForegroundId() }
      foreach ($action in $request.actions) {
        if ($action.type -eq 'focus') { $keyTarget = [int64]$action.window }
        if ($action.type -eq 'keypress') {
          try { $resolved = [NeuraflokWindowsKeys]::Resolve([string[]]$action.keys, $keyTarget) }
          catch { throw $_.Exception.GetBaseException().Message }
          $action | Add-Member -NotePropertyName resolvedKeys -NotePropertyValue $resolved -Force
        }
        if ($action.type -eq 'type' -and [string]$action.text -match '[\r\n]') {
          throw 'MULTILINE_REQUIRES_PASTE: literal multiline text requires the clipboard paste action'
        }
        if ($action.type -eq 'ui_action' -and [string]$action.action -notin $script:UiActionNames) {
          throw "BAD_ACTION: unsupported UI element action $($action.action)"
        }
        if ($action.type -in @('click','click_ui')) { $null = Get-RequestedClickCount $action }
        if ($action.type -eq 'drag' -and $null -ne $action.durationMs -and
            ([double]$action.durationMs -lt 50 -or [double]$action.durationMs -gt 2000 -or [double]$action.durationMs -ne [int]$action.durationMs)) {
          throw 'BAD_ACTION: drag duration must be an integer between 50 and 2000 milliseconds'
        }
      }
      $routes = @()
      $launches = @()
      $completed = 0
      for ($index = 0; $index -lt $request.actions.Count; $index++) {
        $a = $request.actions[$index]
        try {
          $actionTarget = if ($a.type -in @('click_ui','set_value_ui','ui_action','focus')) { [int64]$a.window } elseif ($request.targetWindow) { [int64]$request.targetWindow } elseif ($request.frame.window) { [int64]$request.frame.window } else { 0 }
          Assert-InputOwner $actionTarget $request.ownerWindow $request.targetApp $request.ownerApp
          if ($request.targetWindow -and $a.type -in @('move','click','double_click','scroll','drag','type','keypress')) {
            Assert-Focused ([int64]$request.targetWindow)
            Assert-InputOwner $actionTarget $request.ownerWindow $request.targetApp $request.ownerApp
          }
          # Earlier actions may have changed focus or moved the target. Revalidate at each physical action, including actions after a semantic UI invocation.
          if ($a.type -in @('move','click','double_click','scroll','drag') -and $request.frame) {
            Assert-CoordinateFrame $request.frame
          }
          Assert-InputOwner $actionTarget $request.ownerWindow $request.targetApp $request.ownerApp
          switch ($a.type) {
            'click_ui' {
              $ui = Act-UiElement @{ id = $a.window; snapshotId = $a.snapshotId; runtimeKey = $a.runtimeKey; action = 'click'; button = $a.button; count = (Get-RequestedClickCount $a); ownerWindow = $request.ownerWindow; targetApp = $request.targetApp; ownerApp = $request.ownerApp }
              $routes += $ui.route
            }
            'set_value_ui' {
              $ui = Act-UiElement @{ id = $a.window; snapshotId = $a.snapshotId; runtimeKey = $a.runtimeKey; action = 'set_value'; value = $a.value; ownerWindow = $request.ownerWindow; targetApp = $request.targetApp; ownerApp = $request.ownerApp }
              $routes += $ui.route
            }
            'ui_action' {
              $ui = Act-UiElement @{ id = $a.window; snapshotId = $a.snapshotId; runtimeKey = $a.runtimeKey; action = $a.action; ownerWindow = $request.ownerWindow; targetApp = $request.targetApp; ownerApp = $request.ownerApp }
              $routes += $ui.route
            }
            'launch_app' {
              $launches += Launch-WindowsApp @{ app = $a.app }
              $routes += 'shell'
            }
            'move'         { [NeuraflokWindowsControl]::Move([int]$a.x, [int]$a.y); $routes += 'sendinput' }
            'click'        { [NeuraflokWindowsControl]::Click([int]$a.x, [int]$a.y, $a.button, (Get-RequestedClickCount $a)); $routes += 'sendinput' }
            'double_click' { [NeuraflokWindowsControl]::Click([int]$a.x, [int]$a.y, $a.button, 2); $routes += 'sendinput' }
            'scroll'       { [NeuraflokWindowsControl]::Scroll([int]$a.x, [int]$a.y, [int]$a.scroll_x, [int]$a.scroll_y, [bool]$a.rawWheel); $routes += 'sendinput' }
            'drag'         { $duration = if ($null -ne $a.durationMs) { [int]$a.durationMs } else { 350 }; [NeuraflokWindowsControl]::Drag([int[]]$a.xs, [int[]]$a.ys, $a.button, $duration); $routes += 'sendinput' }
            'type'         { [NeuraflokWindowsControl]::Type([string]$a.text); $routes += 'sendinput' }
            'keypress'     { [NeuraflokWindowsControl]::Press([int[]]$a.resolvedKeys); $routes += 'sendinput' }
            'focus'        { Assert-Focused ([int64]$a.window); Assert-InputOwner ([int64]$a.window) $request.ownerWindow $request.targetApp $request.ownerApp; $routes += 'focus' }
            default        { throw "BAD_ACTION: Unknown action: $($a.type)" }
          }
          $completed += 1
        } catch {
          $message = $_.Exception.Message
          $code = 'HELPER_ERROR'
          if ($message -match '^([A-Z0-9_]+):\s*(.+)') {
            $code = $Matches[1]
            $message = $Matches[2]
          }
          return @{
            ok = $false
            error_code = $code
            message = $message
            completed_count = $completed
            failed_index = $index
            routes = @($routes)
            launches = @($launches)
          }
        }
      }
      $cursor = [NeuraflokWindowsControl]::Cursor() -split ','
      $result.cursor = @{ x = [int]$cursor[0]; y = [int]$cursor[1] }
      $result.foreground = [NeuraflokWindowsControl]::ForegroundId()
      $result.completed_count = $completed
      $result.routes = @($routes)
      $result.launches = @($launches)
  return $result
}
`;
