export const WINDOWS_HELPER_OBSERVER = String.raw`function Find-UiElements($request) {
  $id = if ($request.id) { [int64]$request.id } else { [NeuraflokWindowsControl]::ForegroundId() }
  try {
    $root = Get-UiRoot $id
  } catch {
    throw "UIA_FAILED: cannot inspect window $id. $($_.Exception.Message)"
  }

  $query = ([string]$request.query).Trim().ToLowerInvariant()
  $role = ([string]$request.role).Trim().ToLowerInvariant()
  $limit = if ($request.maxResults) { [Math]::Min(100, [Math]::Max(1, [int]$request.maxResults)) } else { 30 }
  $visitLimit = if ($request.maxVisited) { [Math]::Min(10000, [Math]::Max($limit, [int]$request.maxVisited)) } else { 3000 }
  $found = @()
  $handles = New-Object 'System.Collections.Generic.List[object]'
  $visited = 0
  $documentText = $null
  $selectedText = $null
  $focusedElement = $null
  $textPattern = $null
  $textPriority = 0
  $browserDocument = $root.Current.ClassName -eq 'BrowserRootView'
  $depthLimited = $false
  try {
    # ControlView avoids the enormous raw Chromium implementation tree. TreeWalker lets the limit bound traversal work as well as output; FindAll(Descendants) materialised the full tree before maxResults could stop it. CacheRequest fetches the projection properties in bulk rather than paying one cross-process provider call for every Current field.
    $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
    $cache = New-Object System.Windows.Automation.CacheRequest
    $cache.TreeScope = [System.Windows.Automation.TreeScope]::Element
    $cache.Add([System.Windows.Automation.AutomationElement]::NameProperty)
    $cache.Add([System.Windows.Automation.AutomationElement]::AutomationIdProperty)
    $cache.Add([System.Windows.Automation.AutomationElement]::ControlTypeProperty)
    $cache.Add([System.Windows.Automation.AutomationElement]::IsEnabledProperty)
    $cache.Add([System.Windows.Automation.AutomationElement]::IsOffscreenProperty)
    $cache.Add([System.Windows.Automation.AutomationElement]::BoundingRectangleProperty)
    $cache.Add([System.Windows.Automation.AutomationElement]::HasKeyboardFocusProperty)
    $cache.Add([System.Windows.Automation.AutomationElement]::IsKeyboardFocusableProperty)
    $cache.Add([System.Windows.Automation.AutomationElement]::IsPasswordProperty)
    $cache.Add([System.Windows.Automation.SelectionItemPattern]::IsSelectedProperty)
    $stack = New-Object System.Collections.Stack
    $element = $walker.GetFirstChild($root, $cache)
    $depth = 1
    while ($null -ne $element -and $found.Count -lt $limit -and $visited -lt $visitLimit) {
      $visited += 1
      try {
        $current = $element.Cached
        $name = [string]$current.Name
        $automationId = [string]$current.AutomationId
        $control = [string]$current.ControlType.ProgrammaticName
        if ($control.StartsWith('ControlType.')) { $control = $control.Substring(12) }
        $matches = (-not $query -or $name.ToLowerInvariant().Contains($query) -or $automationId.ToLowerInvariant().Contains($query))
        $matches = $matches -and (-not $role -or $control.ToLowerInvariant().Contains($role))
        if ($matches) {
          $r = $current.BoundingRectangle
          $hasBounds = $r.Width -gt 0 -and $r.Height -gt 0 -and -not [double]::IsInfinity($r.X) -and -not [double]::IsInfinity($r.Y)
          $availableActions = @()
          try { $availableActions = @(Get-UiActions $element $current) } catch { }
          # UIA Invoke/Toggle/Select/Scroll can work without a drawable rectangle, for example in minimized windows or virtualized lists. Retain their exact semantic identity; zero bounds never authorize a physical click.
          if ($hasBounds -or $availableActions.Count -gt 0) {
            $runtimeKey = Ui-RuntimeKey $element
            $entry = @{
              runtimeKey = $runtimeKey
              name = $name
              role = $control
              automationId = $automationId
              enabled = [bool]$current.IsEnabled
              offscreen = [bool]$current.IsOffscreen
              focused = [bool]$current.HasKeyboardFocus
              depth = $depth
              actions = $availableActions
              bounds = if ($hasBounds) { @{
                x = [int][Math]::Round($r.X); y = [int][Math]::Round($r.Y)
                width = [int][Math]::Round($r.Width); height = [int][Math]::Round($r.Height)
              } } else { @{ x = 0; y = 0; width = 0; height = 0 } }
            }
            try {
              $selected = $element.GetCachedPropertyValue([System.Windows.Automation.SelectionItemPattern]::IsSelectedProperty, $true)
              if ($selected -is [bool]) { $entry.selected = $selected }
            } catch { }
            if ($current.HasKeyboardFocus) { $focusedElement = $runtimeKey }
            $found += $entry
            $handles.Add($element)
            # Select within this traversal, then read just one provider. Browser toolbar editors precede the page and must never become document_text. Native editors remain useful when no Document provider is observed.
            $priority = if (-not $hasBounds -or $current.IsPassword) { 0 }
              elseif ($control -eq 'Document') { 3 }
              elseif ($browserDocument) { 0 }
              elseif ($current.HasKeyboardFocus) { 2 }
              elseif ($control -eq 'Edit') { 1 }
              else { 0 }
            if ($priority -gt $textPriority) {
              try {
                $candidate = $null
                if ($element.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern, [ref]$candidate)) {
                  $textPattern = [System.Windows.Automation.TextPattern]$candidate
                  $textPriority = $priority
                }
              } catch { }
            }
          }
        }
      } catch { }

      $sibling = $null
      try { $sibling = $walker.GetNextSibling($element, $cache) } catch { }
      if ($null -ne $sibling) { $stack.Push(@{ element = $sibling; depth = $depth }) }
      $child = $null
      if ($depth -lt 64) { try { $child = $walker.GetFirstChild($element, $cache) } catch { } } else { $depthLimited = $true }
      if ($null -ne $child) {
        $element = $child
        $depth += 1
      } elseif ($stack.Count -gt 0) {
        $next = $stack.Pop()
        $element = $next.element
        $depth = $next.depth
      } else {
        $element = $null
      }
    }
  } catch {
    throw "UIA_FAILED: $($_.Exception.Message)"
  }
  if ($null -ne $textPattern) {
    try {
      $budget = 8000
      $selection = New-Object System.Text.StringBuilder
      $ranges = @($textPattern.GetSelection())
      foreach ($range in ($ranges | Select-Object -First 4)) {
        $remaining = [Math]::Min(2000 - $selection.Length, $budget)
        if ($remaining -le 0) { break }
        $part = $range.GetText($remaining)
        $null = $selection.Append($part)
        $budget -= $part.Length
      }
      $selectedText = $selection.ToString()
      $documentText = $textPattern.DocumentRange.GetText($budget)
    } catch { }
  }
  $snapshotId = Remember-UiSnapshot $id $root $handles
  return @{
    window = $id
    snapshotId = $snapshotId
    elements = @($found)
    visited = $visited
    truncated = ($null -ne $element -or $stack.Count -gt 0 -or $depthLimited)
    document_text = $documentText
    selected_text = $selectedText
    focused_element = $focusedElement
  }
}

`;