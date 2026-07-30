namespace ChatGPT2ApiLauncher.Core;

public sealed record ProjectPaths(string RootDirectory)
{
    public string ComposeFile => Path.Combine(RootDirectory, "docker-compose.yml");

    public string LanComposeFile => Path.Combine(RootDirectory, "docker-compose.lan.yml");

    public static ProjectPaths Discover(string? startDirectory = null)
    {
        var current = new DirectoryInfo(startDirectory ?? AppContext.BaseDirectory);
        while (current is not null)
        {
            var composeFile = Path.Combine(current.FullName, "docker-compose.yml");
            var lanComposeFile = Path.Combine(current.FullName, "docker-compose.lan.yml");
            if (File.Exists(composeFile) && File.Exists(lanComposeFile))
            {
                return new ProjectPaths(current.FullName);
            }

            current = current.Parent;
        }

        throw new DirectoryNotFoundException(
            "Unable to locate docker-compose.yml and docker-compose.lan.yml. Keep the launcher inside the project folder.");
    }
}
