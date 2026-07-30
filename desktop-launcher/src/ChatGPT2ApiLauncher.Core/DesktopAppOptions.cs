namespace ChatGPT2ApiLauncher.Core;

public sealed record DesktopAppOptions(bool StartsLocalService, Uri PanelUri)
{
    private const int DefaultServicePort = 3000;

    public static DesktopAppOptions Parse(string[]? args)
    {
        if (args is null || args.Length == 0)
        {
            return new DesktopAppOptions(true, ServiceEndpoints.LocalPanel(DefaultServicePort));
        }

        if (args.Length != 2 || !string.Equals(args[0], "--server-url", StringComparison.OrdinalIgnoreCase))
        {
            throw new ArgumentException("用法：ChatGPT2API-LAN-Launcher.exe [--server-url http://局域网服务器:3000]");
        }

        if (!Uri.TryCreate(args[1], UriKind.Absolute, out var panelUri)
            || string.IsNullOrWhiteSpace(panelUri.Host)
            || !string.IsNullOrEmpty(panelUri.UserInfo)
            || (panelUri.Scheme != Uri.UriSchemeHttp && panelUri.Scheme != Uri.UriSchemeHttps))
        {
            throw new ArgumentException("--server-url 必须是不含账号密码的完整 http 或 https 地址，例如 http://xg-host.local:3000。");
        }

        return new DesktopAppOptions(false, panelUri);
    }
}
