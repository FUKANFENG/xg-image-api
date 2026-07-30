using System.Net;

namespace ChatGPT2ApiLauncher.Core;

public sealed record ComposeLaunchSettings(IReadOnlyDictionary<string, string> Environment)
{
    public static ComposeLaunchSettings ForLan(IPAddress address, int port)
    {
        if (!LanAddressResolver.IsPrivateLanAddress(address))
        {
            throw new ArgumentException("A private IPv4 LAN address is required.", nameof(address));
        }

        var panel = ServiceEndpoints.LanPanel(address, port);
        return new ComposeLaunchSettings(new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["CHATGPT2API_LAN_BIND_ADDRESS"] = "0.0.0.0",
            ["CHATGPT2API_LAN_BASE_URL"] = panel.ToString().TrimEnd('/'),
        });
    }
}
