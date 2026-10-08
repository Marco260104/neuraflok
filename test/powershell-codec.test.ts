import { describe, expect, it } from 'vitest';
import { cleanPowerShellStderr, encodePowerShellScript } from '../backend/domains/workspace/execution/powershell-codec.js';

describe('PowerShell process codec', () => {
  it('encodes a UTF-8-safe preamble and script using PowerShell UTF-16LE Base64', () => {
    const command = 'Write-Output "café 😀"';
    const decoded = Buffer.from(encodePowerShellScript(command), 'base64').toString('utf16le');

    expect(decoded).toContain('[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)');
    expect(decoded).toContain("$PSDefaultParameterValues['Get-Content:Encoding'] = 'UTF8'");
    expect(decoded).toContain("$ProgressPreference = 'SilentlyContinue'");
    expect(decoded.endsWith(command)).toBe(true);
  });

  it('renders CLIXML error and warning records as decoded text', () => {
    const stderr = '#< CLIXML<Objs><S S="Error">first_x000D__x000A_second &amp; &quot;quoted&quot;</S>' +
      '<S S="Warning">warn &lt;safe&gt;</S></Objs>';

    expect(cleanPowerShellStderr(stderr)).toBe('first\r\nsecond & "quoted"\nwarn <safe>');
  });

  it('preserves incomplete CLIXML and trims ordinary stderr', () => {
    expect(cleanPowerShellStderr('  plain failure  ')).toBe('plain failure');
    expect(cleanPowerShellStderr('prefix #< CLIXML<S S="Error">partial')).toBe('prefix #< CLIXML<S S="Error">partial');
  });
});
