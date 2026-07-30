using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;

namespace ChatGPT2ApiLauncher.Core;

public static class LanAddressResolver
{
    public static IPAddress? GetPreferred()
    {
        var addresses = NetworkInterface.GetAllNetworkInterfaces()
            .Where(network =>
                network.OperationalStatus == OperationalStatus.Up &&
                network.NetworkInterfaceType is not NetworkInterfaceType.Loopback and not NetworkInterfaceType.Tunnel)
            .SelectMany(network => network.GetIPProperties().UnicastAddresses)
            .Select(address => address.Address);

        return SelectPreferred(addresses);
    }

    public static IPAddress? SelectPreferred(IEnumerable<IPAddress> addresses)
    {
        return addresses
            .Where(IsPrivateLanAddress)
            .OrderBy(GetNetworkPriority)
            .ThenBy(address => address.ToString(), StringComparer.Ordinal)
            .FirstOrDefault();
    }

    public static bool IsPrivateLanAddress(IPAddress address)
    {
        if (address.AddressFamily != AddressFamily.InterNetwork)
        {
            return false;
        }

        var bytes = address.GetAddressBytes();
        return bytes[0] == 10 ||
               (bytes[0] == 172 && bytes[1] is >= 16 and <= 31) ||
               (bytes[0] == 192 && bytes[1] == 168);
    }

    private static int GetNetworkPriority(IPAddress address)
    {
        var first = address.GetAddressBytes()[0];
        return first switch
        {
            192 => 0,
            10 => 1,
            172 => 2,
            _ => 3,
        };
    }
}
