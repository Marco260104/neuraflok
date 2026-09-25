export const WINDOWS_REQUEST_CHANNEL = String.raw`
while (($line = [Console]::In.ReadLine()) -ne $null) {
  if ([string]::IsNullOrWhiteSpace($line)) { continue }
  try {
    $request = $line | ConvertFrom-Json
    $reply = Handle-Request $request
  } catch {
    $message = $_.Exception.Message
    $code = 'HELPER_ERROR'
    if ($message -match '^([A-Z0-9_]+):\s*(.+)') {
      $code = $Matches[1]
      $message = $Matches[2]
    }
    $reply = @{ ok = $false; error_code = $code; message = $message }
  }
  [Console]::Out.WriteLine(($reply | ConvertTo-Json -Depth 8 -Compress))
  [Console]::Out.Flush()
}
`;
