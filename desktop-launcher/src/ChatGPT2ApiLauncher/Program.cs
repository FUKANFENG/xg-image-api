using ChatGPT2ApiLauncher.Core;

namespace ChatGPT2ApiLauncher;

internal static class Program
{
    [STAThread]
    private static void Main(string[] args)
    {
        ApplicationConfiguration.Initialize();
        try
        {
            Application.Run(new LauncherForm(DesktopAppOptions.Parse(args)));
        }
        catch (ArgumentException exception)
        {
            MessageBox.Show(exception.Message, "ChatGPT2API 桌面版", MessageBoxButtons.OK, MessageBoxIcon.Warning);
        }
    }
}
