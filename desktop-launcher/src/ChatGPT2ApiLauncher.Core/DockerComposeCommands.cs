namespace ChatGPT2ApiLauncher.Core;

public static class DockerComposeCommands
{
    public static CommandSpec StartLan(ProjectPaths paths, ComposeLaunchSettings settings)
    {
        return Compose(paths, settings, "up", "-d", "--no-build");
    }

    public static CommandSpec StopLan(ProjectPaths paths, ComposeLaunchSettings settings)
    {
        return Compose(paths, settings, "stop");
    }

    public static CommandSpec DockerInfo(string workingDirectory)
    {
        return new CommandSpec("docker", new[] { "info", "--format", "{{.ServerVersion}}" }, workingDirectory);
    }

    private static CommandSpec Compose(ProjectPaths paths, ComposeLaunchSettings settings, params string[] action)
    {
        var arguments = new List<string>
        {
            "compose",
            "-f",
            paths.ComposeFile,
            "-f",
            paths.LanComposeFile,
        };
        arguments.AddRange(action);
        return new CommandSpec("docker", arguments, paths.RootDirectory, settings.Environment);
    }
}
