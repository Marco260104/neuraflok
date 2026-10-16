import { WINDOWS_CAPTURE_PLATFORM_SOURCE } from './windows-capture-platform.js';
import { WINDOWS_CAPTURE_PIXELS_SOURCE } from './windows-capture-pixels.js';
import { WINDOWS_CAPTURE_SESSION_SOURCE } from './windows-capture-session.js';

export const WINDOWS_CAPTURE_SOURCE = [
  WINDOWS_CAPTURE_PLATFORM_SOURCE,
  WINDOWS_CAPTURE_PIXELS_SOURCE,
  WINDOWS_CAPTURE_SESSION_SOURCE
].join('\n');

/** Compiles the capture implementation once against the Windows runtime metadata. */
export const WINDOWS_CAPTURE_BOOTSTRAP = String.raw`
function Initialize-WindowsCapture {
if ('NeuraflokWindowsCapture' -as [type]) { return }
$captureRuntime = [System.Runtime.InteropServices.RuntimeEnvironment]::GetRuntimeDirectory()
$captureReferences = @('System.dll', 'System.Core.dll', 'System.Runtime.dll', 'System.Runtime.WindowsRuntime.dll', 'System.Drawing.dll') | ForEach-Object { Join-Path $captureRuntime $_ }
$captureReferences += Get-ChildItem -LiteralPath (Join-Path $env:windir 'System32\WinMetadata') -Filter '*.winmd' | ForEach-Object { $_.FullName }
# Add-Type tries to load WinMD files as CLR assemblies before compilation. Invoke the same Framework compiler through CodeDOM to preserve their WinRT metadata.
$captureCompiler = New-Object Microsoft.CSharp.CSharpCodeProvider
try {
$captureParameters = New-Object System.CodeDom.Compiler.CompilerParameters
$captureParameters.GenerateInMemory = $true
$captureParameters.ReferencedAssemblies.AddRange([string[]]$captureReferences)
$captureCompiled = $captureCompiler.CompileAssemblyFromSource($captureParameters, [string[]]@(@'
${WINDOWS_CAPTURE_SOURCE}
'@))
if ($captureCompiled.Errors.HasErrors) {
  throw ('CAPTURE_FAILED: Windows capture compilation failed: ' + (($captureCompiled.Errors | ForEach-Object { $_.ErrorText }) -join '; '))
}
$null = $captureCompiled.CompiledAssembly
} finally { $captureCompiler.Dispose() }
}
`;
