export const WINDOWS_HELPER_SNAPSHOTS = String.raw`$script:UiSnapshots = [ordered]@{}
$script:NextUiSnapshotId = 1
# One helper serves every chat, so this cap is shared across a whole swarm: with sixteen, thirteen workers taking turns evicted each other's newest snapshot before its owner could act on a ref from it (forty STALE_UI_SNAPSHOT refusals on 2026-09-01). A snapshot holds element handles, not screenshots, so keeping a few per worker is cheap.
$script:MaxUiSnapshots = 96

function Remember-UiSnapshot([int64]$id, $root, $elements) {
  $snapshotId = $script:NextUiSnapshotId
  $script:NextUiSnapshotId += 1
  $byRuntimeKey = @{}
  foreach ($element in $elements) {
    $key = Ui-RuntimeKey $element
    if ($key -and -not $byRuntimeKey.ContainsKey($key)) { $byRuntimeKey[$key] = $element }
  }
  $snapshotKey = "s$snapshotId"
  $script:UiSnapshots[$snapshotKey] = @{
    window = $id
    rootRuntimeKey = (Ui-RuntimeKey $root)
    elements = $byRuntimeKey
  }
  while ($script:UiSnapshots.Count -gt $script:MaxUiSnapshots) {
    $oldest = @($script:UiSnapshots.Keys)[0]
    $script:UiSnapshots.Remove($oldest)
  }
  return $snapshotId
}

function Resolve-UiElement([int64]$id, [int]$snapshotId, [string]$runtimeKey) {
  $snapshot = $script:UiSnapshots["s$snapshotId"]
  if ($null -eq $snapshot -or [int64]$snapshot.window -ne $id) {
    throw "STALE_UI_SNAPSHOT: UI snapshot $snapshotId is no longer active for window $id. Call observe on the window again and use a ref from that reply."
  }
  $element = $snapshot.elements[$runtimeKey]
  if ($null -eq $element) {
    throw "UI_ELEMENT_GONE: the referenced UI element is not part of snapshot $snapshotId. Use a ref printed by that snapshot, or observe the window again."
  }
  try {
    $root = Get-UiRoot $id
  } catch {
    throw "UIA_FAILED: cannot inspect window $id. $($_.Exception.Message)"
  }
  try {
    if ((Ui-RuntimeKey $root) -ne [string]$snapshot.rootRuntimeKey) {
      throw "STALE_UI_SNAPSHOT: window $id no longer has the UIA root from snapshot $snapshotId. Call observe on the window again and use a ref from that reply."
    }
    # Reading Current is the liveness check. The element object itself is the cached handle; never rescan by RuntimeId, because Microsoft permits RuntimeId reuse over time.
    $null = $element.Current.IsEnabled
    if ((Ui-RuntimeKey $element) -ne $runtimeKey) {
      throw "STALE_UI_REF: the cached element identity changed"
    }
    # A live legacy provider is not proof that its old tab is still displayed. Revalidate membership in the same current UI root before semantic input.
    $parent = $element
    $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
    for ($depth = 0; $depth -le 64 -and $null -ne $parent; $depth++) {
      if ((Ui-RuntimeKey $parent) -eq [string]$snapshot.rootRuntimeKey) { return $element }
      $parent = $walker.GetParent($parent)
    }
    throw 'STALE_UI_REF: the element is no longer in the observed window UI; observe again'
  } catch {
    $message = $_.Exception.Message
    if ($message -match '^[A-Z0-9_]+:') { throw $message }
    throw "UI_ELEMENT_GONE: the referenced UI element is no longer present. Call observe on the window again and use a ref from that reply."
  }
}

`;