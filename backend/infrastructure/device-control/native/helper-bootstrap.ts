import { WINDOWS_CAPTURE_BOOTSTRAP } from './windows-capture.js';
import { WINDOWS_APP_IDENTITY_SOURCE } from './windows-app-identity.js';
import { WINDOWS_KEYS_SOURCE } from './windows-keys.js';
import { WINDOWS_CONTROL_INTEROP_SOURCE } from './windows-control-interop.js';
import { WINDOWS_CONTROL_INPUT_SOURCE } from './windows-control-input.js';
import { WINDOWS_CONTROL_WINDOWS_SOURCE } from './windows-control-windows.js';
import { WINDOWS_CONTROL_CAPTURE_SOURCE } from './windows-control-capture.js';

export const WINDOWS_HELPER_BOOTSTRAP = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
# Without this the reply is written in the console codepage, and any window title with a non-ASCII character comes back as mojibake.
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
# And the same in the other direction, which was missing. Requests are written to this process's stdin as UTF-8, but [Console]::In decodes them through the legacy OEM input codepage, so every non-ASCII character in a request was corrupted before ConvertFrom-Json ever saw it: an em dash (E2 80 94) arrived as three CP437 characters and was then typed into the target window exactly as mangled. That hits every textual argument the helper takes — type, set_value, UIA queries — not only keystrokes.
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Text;

${WINDOWS_CONTROL_INTEROP_SOURCE}
${WINDOWS_CONTROL_INPUT_SOURCE}
${WINDOWS_CONTROL_WINDOWS_SOURCE}
${WINDOWS_CONTROL_CAPTURE_SOURCE}
${WINDOWS_KEYS_SOURCE}
${WINDOWS_APP_IDENTITY_SOURCE}
'@ -ReferencedAssemblies System.Drawing

${WINDOWS_CAPTURE_BOOTSTRAP}

# The app passes its process id so its own windows are never listed or targeted. A helper started without it, as in tests, sees every window.
if ($env:NEURAFLOK_APP_PID -match '^[0-9]+$') { [NeuraflokWindowsControl]::OwnPid = [uint32]$env:NEURAFLOK_APP_PID }

# Requests arrive as one JSON object per stdin line. The process stays alive, so the expensive Add-Type/C# compilation above happens once instead of on every MCP call. Model-supplied text is data parsed by ConvertFrom-Json and is never evaluated as PowerShell source.

`;
