using System.Runtime.InteropServices;

namespace ChatGPT2ApiLauncher;

internal static class DesktopShortcut
{
    public static string Create(string targetPath, string workingDirectory, string? arguments = null)
    {
        var desktop = Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory);
        var shortcutPath = Path.Combine(desktop, "ChatGPT2API LAN Launcher.lnk");
        var shellType = Type.GetTypeFromProgID("WScript.Shell")
            ?? throw new PlatformNotSupportedException("Windows Script Host is unavailable.");
        dynamic? shell = null;
        dynamic? shortcut = null;
        try
        {
            shell = Activator.CreateInstance(shellType)
                ?? throw new InvalidOperationException("Unable to create Windows Script Host.");
            shortcut = shell.CreateShortcut(shortcutPath);
            shortcut.TargetPath = targetPath;
            shortcut.Arguments = arguments ?? string.Empty;
            shortcut.WorkingDirectory = workingDirectory;
            shortcut.Description = "Open the embedded ChatGPT2API desktop application";
            shortcut.IconLocation = targetPath;
            shortcut.Save();
            return shortcutPath;
        }
        finally
        {
            if (shortcut is not null && Marshal.IsComObject(shortcut))
            {
                Marshal.FinalReleaseComObject(shortcut);
            }

            if (shell is not null && Marshal.IsComObject(shell))
            {
                Marshal.FinalReleaseComObject(shell);
            }
        }
    }
}
