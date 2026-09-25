export const WINDOWS_CAPTURE_REQUESTS = String.raw`
function Capture-Target($request, [Nullable[int64]]$forcedWindow) {
  $screen = Get-ScreenRect
  $id = if ($null -ne $forcedWindow) { [int64]$forcedWindow } elseif ($request.id) { [int64]$request.id } else { $null }
  $mode = 'screen'
  $focused = $null
  $windowGeometry = $null
  if ($request.region) {
    $x = [int]$request.region.x; $y = [int]$request.region.y
    $w = [int]$request.region.width; $h = [int]$request.region.height
  } elseif ($null -ne $id) {
    try { $r = [NeuraflokWindowsControl]::Rect([int64]$id) -split ',' } catch {
      throw "WINDOW_NOT_FOUND: window $id is no longer open, so there is nothing to capture. Call list_windows for the current windows."
    }
    $x = [int]$r[0]; $y = [int]$r[1]; $w = [int]$r[2]; $h = [int]$r[3]
    $windowGeometry = @{ x = $x; y = $y; width = $w; height = $h }
    $focused = ([NeuraflokWindowsControl]::ForegroundId() -eq [int64]$id)
  } elseif ($request.full) {
    $x = [int]$screen.virtual.x; $y = [int]$screen.virtual.y
    $w = [int]$screen.virtual.width; $h = [int]$screen.virtual.height
  } else {
    $x = 0; $y = 0; $w = [int]$screen.primary.width; $h = [int]$screen.primary.height
  }
  if ($w -le 0 -or $h -le 0) { throw "CAPTURE_FAILED: target has no drawable area" }
  $maxW = if ($request.maxWidth) { [int]$request.maxWidth } else { 0 }
  $out = $null
  # Capture the named window's compositor surface, never pixels of an occluding window. DWM excludes invisible resize borders, so preserve outer geometry separately.
  if ($null -ne $id -and $request.file) {
    if ($request.ownerWindow -and -not [NeuraflokWindowsControl]::IsRelatedWindow([int64]$id, [int64]$request.ownerWindow)) {
      throw 'RELATED_WINDOW_GONE: popup no longer belongs to the observed window'
    }
    Initialize-WindowsCapture
    try {
      $direct = [NeuraflokWindowsCapture]::Capture([int64]$id, $maxW, [string]$request.file) -split ','
    } catch {
      # PowerShell wraps C# exceptions in invocation text; retain the native error code so callers distinguish stale geometry from a transport/helper failure.
      throw $_.Exception.GetBaseException().Message
    }
    $after = [NeuraflokWindowsControl]::Rect([int64]$id) -split ','
    if ([int]$after[0] -ne $windowGeometry.x -or [int]$after[1] -ne $windowGeometry.y -or
        [int]$after[2] -ne $windowGeometry.width -or [int]$after[3] -ne $windowGeometry.height) {
      throw 'STALE_FRAME: window geometry changed during capture'
    }
    if ($request.ownerWindow -and -not [NeuraflokWindowsControl]::IsRelatedWindow([int64]$id, [int64]$request.ownerWindow)) {
      throw 'RELATED_WINDOW_GONE: popup ownership changed during capture'
    }
    $x = [int]$direct[0]; $y = [int]$direct[1]; $w = [int]$direct[2]; $h = [int]$direct[3]
    $out = @($direct[4], $direct[5])
    $mode = 'window'
  }
  if ($null -eq $out) {
    $out = [NeuraflokWindowsControl]::Capture($x, $y, $w, $h, $maxW, [string]$request.file) -split ','
  }
  return @{
    region = @{ x = $x; y = $y; width = $w; height = $h }
    image = @{ width = [int]$out[0]; height = [int]$out[1] }
    screen = $screen.virtual
    focused = $focused
    captureMode = $mode
    windowGeometry = $windowGeometry
  }
}

function Assert-InputOwner([int64]$target, $owner, $targetApp, $ownerApp) {
  if ($targetApp) {
    $targetRow = Get-WindowRow $target
    if ($null -eq $targetRow -or $targetRow.app -cne [string]$targetApp) {
      throw 'WINDOW_APP_MISMATCH: input target no longer belongs to the observed application'
    }
  }
  if ($ownerApp) {
    $ownerRow = if ($owner) { Get-WindowRow ([int64]$owner) } else { $null }
    if ($null -eq $ownerRow -or $ownerRow.app -cne [string]$ownerApp) {
      throw 'WINDOW_APP_MISMATCH: input owner no longer belongs to the observed application'
    }
  }
  if ($owner -and ($target -le 0 -or ($target -ne [int64]$owner -and -not [NeuraflokWindowsControl]::IsRelatedWindow($target, [int64]$owner)))) {
    throw 'RELATED_WINDOW_GONE: input target no longer belongs to the observed window'
  }
}

function Assert-CoordinateFrame($frame) {
  $region = $frame.region
  if ($frame.window) {
    $id = [int64]$frame.window
    Assert-InputOwner $id $frame.ownerWindow $frame.targetApp $frame.ownerApp
    $geometry = if ($frame.windowGeometry) { $frame.windowGeometry } else { $region }
    $row = Get-WindowRow $id
    if ($null -eq $row -or $row.state -eq 'minimized') {
      throw "STALE_FRAME: target window $id is no longer drawable"
    }
    if ($row.x -ne [int]$geometry.x -or $row.y -ne [int]$geometry.y -or $row.width -ne [int]$geometry.width -or $row.height -ne [int]$geometry.height) {
      throw "STALE_FRAME: target window $id moved or resized after frame $($frame.id)"
    }
    # A background snapshot is safe to observe, but physical coordinates must land on that exact window rather than on an overlay. Focus only here, on the mutating path.
    Assert-Focused $id
    Assert-InputOwner $id $frame.ownerWindow $frame.targetApp $frame.ownerApp
    $after = Get-WindowRow $id
    if ($null -eq $after -or $after.x -ne [int]$geometry.x -or $after.y -ne [int]$geometry.y -or $after.width -ne [int]$geometry.width -or $after.height -ne [int]$geometry.height) {
      throw "STALE_FRAME: target window $id changed geometry while it was activated"
    }
    return
  }
  $screen = Get-ScreenRect
  $right = [int]$region.x + [int]$region.width
  $bottom = [int]$region.y + [int]$region.height
  if ([int]$region.x -lt [int]$screen.virtual.x -or [int]$region.y -lt [int]$screen.virtual.y -or
      $right -gt ([int]$screen.virtual.x + [int]$screen.virtual.width) -or
      $bottom -gt ([int]$screen.virtual.y + [int]$screen.virtual.height)) {
    throw "STALE_FRAME: desktop geometry changed after frame $($frame.id)"
  }
}
`;
