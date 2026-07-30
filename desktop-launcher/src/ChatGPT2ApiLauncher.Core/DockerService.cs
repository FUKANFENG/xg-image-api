using System.Diagnostics;
using System.Net;

namespace ChatGPT2ApiLauncher.Core;

public sealed record ServiceStatus(bool DockerReady, bool ServiceReady, string Detail);

public sealed record LaunchResult(IPAddress LanAddress, Uri LocalPanel, Uri LanPanel);

public sealed class DockerService : IDisposable
{
    private const int ServicePort = 3000;
    private readonly IProcessRunner _processRunner;
    private readonly HttpClient _httpClient;

    public DockerService(IProcessRunner? processRunner = null, HttpClient? httpClient = null)
    {
        _processRunner = processRunner ?? new ProcessRunner();
        _httpClient = httpClient ?? new HttpClient { Timeout = TimeSpan.FromSeconds(3) };
    }

    public async Task<ServiceStatus> GetStatusAsync(ProjectPaths paths, CancellationToken cancellationToken)
    {
        if (!await IsDockerReadyAsync(paths.RootDirectory, cancellationToken))
        {
            return new ServiceStatus(false, false, "Docker Desktop is not ready.");
        }

        var serviceReady = await IsHealthyAsync(cancellationToken);
        return new ServiceStatus(true, serviceReady, serviceReady ? "Service is ready." : "Service is stopped or starting.");
    }

    public async Task<LaunchResult> StartLanAsync(
        ProjectPaths paths,
        IProgress<string>? progress,
        CancellationToken cancellationToken)
    {
        var address = LanAddressResolver.GetPreferred()
            ?? throw new InvalidOperationException("No private IPv4 LAN address was found. Connect this computer to the LAN first.");
        var settings = ComposeLaunchSettings.ForLan(address, ServicePort);

        progress?.Report("Checking Docker Desktop...");
        await EnsureDockerReadyAsync(paths.RootDirectory, progress, cancellationToken);

        progress?.Report("Starting ChatGPT2API for LAN access...");
        var result = await _processRunner.RunAsync(DockerComposeCommands.StartLan(paths, settings), cancellationToken);
        if (result.ExitCode != 0)
        {
            throw new InvalidOperationException(DescribeCommandFailure("Docker Compose start failed.", result));
        }

        progress?.Report("Waiting for the local health check...");
        await WaitForHealthAsync(cancellationToken);
        progress?.Report("Service is ready.");

        return new LaunchResult(address, ServiceEndpoints.LocalPanel(ServicePort), ServiceEndpoints.LanPanel(address, ServicePort));
    }

    public async Task StopLanAsync(ProjectPaths paths, CancellationToken cancellationToken)
    {
        var address = LanAddressResolver.GetPreferred()
            ?? IPAddress.Parse("192.168.0.1");
        var settings = ComposeLaunchSettings.ForLan(address, ServicePort);
        var result = await _processRunner.RunAsync(DockerComposeCommands.StopLan(paths, settings), cancellationToken);
        if (result.ExitCode != 0)
        {
            throw new InvalidOperationException(DescribeCommandFailure("Docker Compose stop failed.", result));
        }
    }

    public void Dispose()
    {
        _httpClient.Dispose();
    }

    private async Task EnsureDockerReadyAsync(
        string workingDirectory,
        IProgress<string>? progress,
        CancellationToken cancellationToken)
    {
        if (await IsDockerReadyAsync(workingDirectory, cancellationToken))
        {
            return;
        }

        var desktopPath = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),
            "Docker",
            "Docker",
            "Docker Desktop.exe");
        if (!File.Exists(desktopPath))
        {
            throw new FileNotFoundException("Docker Desktop was not found. Install and start Docker Desktop first.", desktopPath);
        }

        progress?.Report("Starting Docker Desktop...");
        Process.Start(new ProcessStartInfo
        {
            FileName = desktopPath,
            UseShellExecute = true,
            WindowStyle = ProcessWindowStyle.Hidden,
        });

        for (var attempt = 1; attempt <= 45; attempt++)
        {
            await Task.Delay(TimeSpan.FromSeconds(2), cancellationToken);
            if (await IsDockerReadyAsync(workingDirectory, cancellationToken))
            {
                return;
            }
        }

        throw new TimeoutException("Docker Desktop did not become ready within 90 seconds.");
    }

    private async Task<bool> IsDockerReadyAsync(string workingDirectory, CancellationToken cancellationToken)
    {
        try
        {
            var result = await _processRunner.RunAsync(DockerComposeCommands.DockerInfo(workingDirectory), cancellationToken);
            return result.ExitCode == 0;
        }
        catch (Exception) when (!cancellationToken.IsCancellationRequested)
        {
            return false;
        }
    }

    private async Task<bool> IsHealthyAsync(CancellationToken cancellationToken)
    {
        try
        {
            using var response = await _httpClient.GetAsync(ServiceEndpoints.Health(ServicePort), cancellationToken);
            return response.IsSuccessStatusCode;
        }
        catch (HttpRequestException)
        {
            return false;
        }
        catch (TaskCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            return false;
        }
    }

    private async Task WaitForHealthAsync(CancellationToken cancellationToken)
    {
        for (var attempt = 1; attempt <= 30; attempt++)
        {
            if (await IsHealthyAsync(cancellationToken))
            {
                return;
            }

            await Task.Delay(TimeSpan.FromSeconds(2), cancellationToken);
        }

        throw new TimeoutException("ChatGPT2API did not pass its local health check within 60 seconds.");
    }

    private static string DescribeCommandFailure(string prefix, CommandResult result)
    {
        var detail = string.IsNullOrWhiteSpace(result.StandardError)
            ? result.StandardOutput
            : result.StandardError;
        detail = detail.Trim();
        return string.IsNullOrWhiteSpace(detail) ? prefix : $"{prefix} {detail}";
    }
}
