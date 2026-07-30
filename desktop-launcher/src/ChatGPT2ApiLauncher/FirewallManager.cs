using System.ComponentModel;
using System.Diagnostics;
using System.Text;

namespace ChatGPT2ApiLauncher;

internal static class FirewallManager
{
    private const string RuleName = "ChatGPT2API LAN (TCP 3000)";

    public static async Task<string> EnsurePrivateLanRuleAsync(CancellationToken cancellationToken)
    {
        var script = $$"""
            $ErrorActionPreference = 'Stop'
            $ruleName = '{{RuleName}}'
            $existing = Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue
            if (-not $existing) {
                New-NetFirewallRule -DisplayName $ruleName -Group 'ChatGPT2API' -Direction Inbound -Action Allow -Protocol TCP -LocalPort 3000 -RemoteAddress LocalSubnet -Profile Private -Enabled True | Out-Null
            }
            """;
        var encodedScript = Convert.ToBase64String(Encoding.Unicode.GetBytes(script));
        var startInfo = new ProcessStartInfo
        {
            FileName = "powershell.exe",
            Arguments = $"-NoProfile -ExecutionPolicy Bypass -EncodedCommand {encodedScript}",
            UseShellExecute = true,
            Verb = "runas",
            WindowStyle = ProcessWindowStyle.Hidden,
        };

        try
        {
            using var process = Process.Start(startInfo)
                ?? throw new InvalidOperationException("Unable to start the Windows Firewall configuration process.");
            await Task.Run(process.WaitForExit, cancellationToken);
            if (process.ExitCode != 0)
            {
                throw new InvalidOperationException("Windows Firewall configuration failed.");
            }

            return "Windows Firewall now permits TCP 3000 from the private local subnet.";
        }
        catch (Win32Exception exception) when (exception.NativeErrorCode == 1223)
        {
            return "Windows Firewall permission was cancelled. LAN clients may remain blocked until it is enabled.";
        }
    }
}
