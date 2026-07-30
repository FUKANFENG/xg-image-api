using System.Net;
using ChatGPT2ApiLauncher.Core;

var tests = new (string Name, Action Run)[]
{
    ("Selects a private LAN address before public or loopback addresses", SelectsPrivateLanAddress),
    ("Builds the LAN Compose environment without exposing the auth key", BuildsLanComposeEnvironment),
    ("Builds a health endpoint from the configured local port", BuildsHealthEndpoint),
    ("Adds a cache-busting token while preserving panel query parameters", AddsCacheBustingToken),
    ("Upgrades a same-origin soft route change to a full document navigation", UpgradesSoftRouteChange),
    ("Builds a no-build Compose command with the LAN override", BuildsNoBuildComposeCommand),
    ("Discovers the project root from a nested launcher directory", DiscoversProjectRoot),
    ("Defaults to an embedded local desktop panel", DefaultsToEmbeddedLocalPanel),
    ("Uses a LAN server URL in client mode without starting Docker", UsesLanServerUrlInClientMode),
    ("Rejects a non-web server URL", RejectsNonWebServerUrl),
    ("Rejects credentials embedded in a server URL", RejectsCredentialBearingServerUrl),
};

var failures = new List<string>();
foreach (var test in tests)
{
    try
    {
        test.Run();
        Console.WriteLine($"PASS {test.Name}");
    }
    catch (Exception exception)
    {
        failures.Add($"FAIL {test.Name}: {exception.Message}");
    }
}

foreach (var failure in failures)
{
    Console.Error.WriteLine(failure);
}

return failures.Count == 0 ? 0 : 1;

static void SelectsPrivateLanAddress()
{
    var selected = LanAddressResolver.SelectPreferred(new[]
    {
        IPAddress.Loopback,
        IPAddress.Parse("8.8.8.8"),
        IPAddress.Parse("192.168.12.34"),
        IPAddress.Parse("10.0.0.9"),
    });

    AssertEqual("192.168.12.34", selected?.ToString());
}

static void BuildsLanComposeEnvironment()
{
    var environment = ComposeLaunchSettings.ForLan(IPAddress.Parse("192.168.12.34"), 3000).Environment;

    AssertEqual("0.0.0.0", environment["CHATGPT2API_LAN_BIND_ADDRESS"]);
    AssertEqual("http://192.168.12.34:3000", environment["CHATGPT2API_LAN_BASE_URL"]);
    AssertFalse(environment.ContainsKey("CHATGPT2API_AUTH_KEY"));
}

static void BuildsHealthEndpoint()
{
    var endpoint = ServiceEndpoints.Health(3000);

    AssertEqual("http://127.0.0.1:3000/health", endpoint.ToString().TrimEnd('/'));
}

static void AddsCacheBustingToken()
{
    var panel = new Uri("http://127.0.0.1:3000/settings?tab=keys&desktop_refresh=old");
    var refreshed = ServiceEndpoints.WithDesktopRefreshToken(panel, "new-build");

    AssertEqual("tab=keys&desktop_refresh=new-build", refreshed.Query.TrimStart('?'));
}

static void UpgradesSoftRouteChange()
{
    var committed = new Uri("http://127.0.0.1:3000/inspiration/");
    var changed = new Uri("http://127.0.0.1:3000/tools/");

    AssertTrue(DesktopNavigationPolicy.ShouldForceFullNavigation(
        committed,
        changed,
        isNewDocument: false));
    AssertFalse(DesktopNavigationPolicy.ShouldForceFullNavigation(
        committed,
        changed,
        isNewDocument: true));
    AssertFalse(DesktopNavigationPolicy.ShouldForceFullNavigation(
        committed,
        new Uri("https://example.com/tools/"),
        isNewDocument: false));
    AssertFalse(DesktopNavigationPolicy.ShouldForceFullNavigation(
        committed,
        new Uri("http://127.0.0.1:3000/inspiration/#templates"),
        isNewDocument: false));
    AssertTrue(DesktopNavigationPolicy.ShouldForceFullNavigation(
        committed,
        new Uri("http://127.0.0.1:3000/inspiration/?category=portrait"),
        isNewDocument: false));
    AssertFalse(DesktopNavigationPolicy.ShouldForceFullNavigation(
        committed,
        committed,
        isNewDocument: false));
}

static void BuildsNoBuildComposeCommand()
{
    var root = Path.Combine(Path.GetTempPath(), $"chatgpt2api-{Guid.NewGuid():N}");
    var paths = new ProjectPaths(root);
    var command = DockerComposeCommands.StartLan(
        paths,
        ComposeLaunchSettings.ForLan(IPAddress.Parse("192.168.12.34"), 3000));

    AssertEqual("docker", command.FileName);
    AssertTrue(command.Arguments.SequenceEqual(new[]
    {
        "compose",
        "-f",
        paths.ComposeFile,
        "-f",
        paths.LanComposeFile,
        "up",
        "-d",
        "--no-build",
    }));
}

static void DiscoversProjectRoot()
{
    var root = Path.Combine(Path.GetTempPath(), $"chatgpt2api-{Guid.NewGuid():N}");
    var nested = Path.Combine(root, "desktop-launcher", "dist");
    Directory.CreateDirectory(nested);
    try
    {
        File.WriteAllText(Path.Combine(root, "docker-compose.yml"), "services: {}");
        File.WriteAllText(Path.Combine(root, "docker-compose.lan.yml"), "services: {}");

        var discovered = ProjectPaths.Discover(nested);

        AssertEqual(root, discovered.RootDirectory);
    }
    finally
    {
        Directory.Delete(root, recursive: true);
    }
}

static void DefaultsToEmbeddedLocalPanel()
{
    var options = DesktopAppOptions.Parse(Array.Empty<string>());

    AssertTrue(options.StartsLocalService);
    AssertEqual("http://127.0.0.1:3000/", options.PanelUri.ToString());
}

static void UsesLanServerUrlInClientMode()
{
    var options = DesktopAppOptions.Parse(new[] { "--server-url", "http://xg-host.local:3000" });

    AssertFalse(options.StartsLocalService);
    AssertEqual("http://xg-host.local:3000/", options.PanelUri.ToString());
}

static void RejectsNonWebServerUrl()
{
    AssertThrows<ArgumentException>(() => DesktopAppOptions.Parse(new[] { "--server-url", "file:///C:/" }));
}

static void RejectsCredentialBearingServerUrl()
{
    AssertThrows<ArgumentException>(() => DesktopAppOptions.Parse(new[] { "--server-url", "http://user:password@xg-host.local:3000" }));
}

static void AssertEqual<T>(T expected, T actual)
{
    if (!EqualityComparer<T>.Default.Equals(expected, actual))
    {
        throw new InvalidOperationException($"Expected '{expected}', got '{actual}'.");
    }
}

static void AssertFalse(bool value)
{
    if (value)
    {
        throw new InvalidOperationException("Expected false.");
    }
}

static void AssertTrue(bool value)
{
    if (!value)
    {
        throw new InvalidOperationException("Expected true.");
    }
}

static void AssertThrows<TException>(Action action)
    where TException : Exception
{
    try
    {
        action();
    }
    catch (TException)
    {
        return;
    }

    throw new InvalidOperationException($"Expected {typeof(TException).Name}.");
}
