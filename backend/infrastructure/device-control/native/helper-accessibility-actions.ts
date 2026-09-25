export const WINDOWS_HELPER_ACTIONS = String.raw`$script:UiActionNames = @('invoke','toggle','select','expand','collapse','focus','scroll_up','scroll_down','scroll_left','scroll_right','scroll_into_view')

function Get-UiActions($element, $current) {
  $actions = New-Object 'System.Collections.Generic.List[string]'
  $supported = @($element.GetSupportedPatterns() | ForEach-Object { $_.Id })
  if ($supported -contains [System.Windows.Automation.InvokePattern]::Pattern.Id) { $actions.Add('invoke') }
  if ($supported -contains [System.Windows.Automation.TogglePattern]::Pattern.Id) { $actions.Add('toggle') }
  if ($supported -contains [System.Windows.Automation.SelectionItemPattern]::Pattern.Id) { $actions.Add('select') }
  if ($supported -contains [System.Windows.Automation.ExpandCollapsePattern]::Pattern.Id) {
    $pattern = [System.Windows.Automation.ExpandCollapsePattern]$element.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern)
    if ($pattern.Current.ExpandCollapseState -ne [System.Windows.Automation.ExpandCollapseState]::LeafNode) {
      $actions.Add('expand'); $actions.Add('collapse')
    }
  }
  if ($supported -contains [System.Windows.Automation.ScrollPattern]::Pattern.Id) {
    $pattern = [System.Windows.Automation.ScrollPattern]$element.GetCurrentPattern([System.Windows.Automation.ScrollPattern]::Pattern)
    if ($pattern.Current.VerticallyScrollable) { $actions.Add('scroll_up'); $actions.Add('scroll_down') }
    if ($pattern.Current.HorizontallyScrollable) { $actions.Add('scroll_left'); $actions.Add('scroll_right') }
  }
  if ($supported -contains [System.Windows.Automation.ScrollItemPattern]::Pattern.Id) { $actions.Add('scroll_into_view') }
  if ($current.IsKeyboardFocusable) { $actions.Add('focus') }
  return @($actions.ToArray())
}

function Invoke-UiAction($element, [string]$action) {
  # Explicit semantic actions never degrade to a click at guessed coordinates.
  $patternId = switch ($action) {
    'invoke' { [System.Windows.Automation.InvokePattern]::Pattern }
    'toggle' { [System.Windows.Automation.TogglePattern]::Pattern }
    'select' { [System.Windows.Automation.SelectionItemPattern]::Pattern }
    { $_ -in @('expand','collapse') } { [System.Windows.Automation.ExpandCollapsePattern]::Pattern }
    { $_ -in @('scroll_up','scroll_down','scroll_left','scroll_right') } { [System.Windows.Automation.ScrollPattern]::Pattern }
    'scroll_into_view' { [System.Windows.Automation.ScrollItemPattern]::Pattern }
    'focus' { $null }
    default { throw "BAD_ACTION: unsupported UI element action $action" }
  }
  if ($action -eq 'focus') {
    if (-not $element.Current.IsKeyboardFocusable) { throw 'UI_ACTION_UNSUPPORTED: element is not keyboard focusable' }
    $element.SetFocus()
    return
  }
  $pattern = $null
  if (-not $element.TryGetCurrentPattern($patternId, [ref]$pattern)) {
    throw "UI_ACTION_UNSUPPORTED: element does not currently support $action"
  }
  switch ($action) {
    'invoke' { ([System.Windows.Automation.InvokePattern]$pattern).Invoke() }
    'toggle' { ([System.Windows.Automation.TogglePattern]$pattern).Toggle() }
    'select' { ([System.Windows.Automation.SelectionItemPattern]$pattern).Select() }
    'expand' { ([System.Windows.Automation.ExpandCollapsePattern]$pattern).Expand() }
    'collapse' { ([System.Windows.Automation.ExpandCollapsePattern]$pattern).Collapse() }
    'scroll_into_view' { ([System.Windows.Automation.ScrollItemPattern]$pattern).ScrollIntoView() }
    { $_ -in @('scroll_up','scroll_down','scroll_left','scroll_right') } {
      $scroll = [System.Windows.Automation.ScrollPattern]$pattern
      $horizontal = [System.Windows.Automation.ScrollAmount]::NoAmount
      $vertical = [System.Windows.Automation.ScrollAmount]::NoAmount
      if ($action -in @('scroll_up','scroll_down')) {
        if (-not $scroll.Current.VerticallyScrollable) { throw 'UI_ACTION_UNSUPPORTED: element is not vertically scrollable' }
        $vertical = if ($action -eq 'scroll_up') { [System.Windows.Automation.ScrollAmount]::LargeDecrement } else { [System.Windows.Automation.ScrollAmount]::LargeIncrement }
      } else {
        if (-not $scroll.Current.HorizontallyScrollable) { throw 'UI_ACTION_UNSUPPORTED: element is not horizontally scrollable' }
        $horizontal = if ($action -eq 'scroll_left') { [System.Windows.Automation.ScrollAmount]::LargeDecrement } else { [System.Windows.Automation.ScrollAmount]::LargeIncrement }
      }
      $scroll.Scroll($horizontal, $vertical)
    }
  }
}

function Get-RequestedClickCount($request) {
  $value = if ($request -is [Collections.IDictionary]) { $request['count'] } else { $request.count }
  if ($null -eq $value) { return 1 }
  if ([double]$value -lt 1 -or [double]$value -gt 3 -or [double]$value -ne [int]$value) { throw 'BAD_ACTION: click count must be an integer between 1 and 3' }
  return [int]$value
}

function Act-UiElement($request) {
  $action = [string]$request.action
  if ($action -notin $script:UiActionNames -and $action -notin @('click','set_value')) {
    throw "BAD_ACTION: unsupported UI element action $action"
  }
  $id = [int64]$request.id
  Assert-InputOwner $id $request.ownerWindow $request.targetApp $request.ownerApp
  $element = Resolve-UiElement $id ([int]$request.snapshotId) ([string]$request.runtimeKey)
  if (-not $element.Current.IsEnabled) { throw "UI_ELEMENT_DISABLED: the referenced element is disabled" }
  if ($action -eq 'set_value') {
    $pattern = $null
    if (-not $element.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$pattern)) {
      throw "UI_VALUE_UNSUPPORTED: the referenced element does not expose ValuePattern"
    }
    $value = [System.Windows.Automation.ValuePattern]$pattern
    if ($value.Current.IsReadOnly) { throw "UI_VALUE_READONLY: the referenced element is read-only" }
    Assert-InputOwner $id $request.ownerWindow $request.targetApp $request.ownerApp
    $value.SetValue([string]$request.value)
    $route = 'uia'
  } elseif ($action -eq 'click') {
    $button = if ($request.button) { [string]$request.button } else { 'left' }
    $count = Get-RequestedClickCount $request
    if ($button -notin @('left','right','middle') -or $count -lt 1 -or $count -gt 3) { throw 'BAD_ACTION: unsupported click button or count' }
    $semanticClick = $button -eq 'left' -and $count -eq 1
    $pattern = $null
    if ($semanticClick -and $element.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$pattern)) {
      Assert-InputOwner $id $request.ownerWindow $request.targetApp $request.ownerApp
      ([System.Windows.Automation.InvokePattern]$pattern).Invoke()
      $route = 'uia'
    } elseif ($semanticClick -and $element.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$pattern)) {
      Assert-InputOwner $id $request.ownerWindow $request.targetApp $request.ownerApp
      ([System.Windows.Automation.TogglePattern]$pattern).Toggle()
      $route = 'uia'
    } elseif ($semanticClick -and $element.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$pattern)) {
      Assert-InputOwner $id $request.ownerWindow $request.targetApp $request.ownerApp
      ([System.Windows.Automation.SelectionItemPattern]$pattern).Select()
      $route = 'uia'
    } else {
      # A semantic control without InvokePattern has to fall back to physical input. Make that last resort explicit and safe: the referenced window, not an overlay at the same desktop coordinates, must be foreground before the pointer goes down.
      Assert-Focused $id
      $r = $element.Current.BoundingRectangle
      if ($r.Width -le 0 -or $r.Height -le 0) { throw "UI_ELEMENT_OFFSCREEN: the referenced element has no clickable bounds" }
      Assert-InputOwner $id $request.ownerWindow $request.targetApp $request.ownerApp
      [NeuraflokWindowsControl]::Click([int][Math]::Round($r.X + $r.Width / 2), [int][Math]::Round($r.Y + $r.Height / 2), $button, $count)
      $route = 'sendinput'
    }
  } else {
    Assert-InputOwner $id $request.ownerWindow $request.targetApp $request.ownerApp
    Invoke-UiAction $element $action
    $route = 'uia'
  }
  return @{ runtimeKey = (Ui-RuntimeKey $element); name = [string]$element.Current.Name; route = $route }
}

`;