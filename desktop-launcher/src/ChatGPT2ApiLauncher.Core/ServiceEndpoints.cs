using System.Net;

namespace ChatGPT2ApiLauncher.Core;

public static class ServiceEndpoints
{
    private const string DesktopRefreshParameter = "desktop_refresh";

    public static Uri Health(int port) => Build("127.0.0.1", port, "/health");

    public static Uri LocalPanel(int port) => Build("127.0.0.1", port, "/");

    public static Uri LanPanel(IPAddress address, int port) => Build(address.ToString(), port, "/");

    /// <summary>
    /// Creates a unique panel URL so the embedded WebView requests the current HTML entrypoint
    /// after a local deployment instead of continuing to run an older cached JavaScript bundle.
    /// </summary>
    public static Uri WithDesktopRefreshToken(Uri panelUri, string? token = null)
    {
        ArgumentNullException.ThrowIfNull(panelUri);
        if (!panelUri.IsAbsoluteUri)
        {
            throw new ArgumentException("Panel URL must be absolute.", nameof(panelUri));
        }

        var builder = new UriBuilder(panelUri);
        var queryParts = builder.Query
            .TrimStart('?')
            .Split('&', StringSplitOptions.RemoveEmptyEntries)
            .Where(part => !part.StartsWith($"{DesktopRefreshParameter}=", StringComparison.OrdinalIgnoreCase))
            .ToList();
        var refreshToken = string.IsNullOrWhiteSpace(token)
            ? Guid.NewGuid().ToString("N")
            : token;
        queryParts.Add($"{DesktopRefreshParameter}={Uri.EscapeDataString(refreshToken)}");
        builder.Query = string.Join("&", queryParts);
        return builder.Uri;
    }

    private static Uri Build(string host, int port, string path)
    {
        if (port is < 1 or > 65535)
        {
            throw new ArgumentOutOfRangeException(nameof(port));
        }

        return new UriBuilder(Uri.UriSchemeHttp, host, port, path).Uri;
    }
}
