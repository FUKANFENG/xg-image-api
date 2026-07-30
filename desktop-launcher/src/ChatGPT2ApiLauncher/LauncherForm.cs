using ChatGPT2ApiLauncher.Core;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace ChatGPT2ApiLauncher;

internal sealed class LauncherForm : Form
{
    private readonly DesktopAppOptions _options;
    private readonly DockerService _dockerService = new();
    private readonly WebView2 _webView = new() { Dock = DockStyle.Fill };
    private readonly Panel _loadingPanel = new() { Dock = DockStyle.Fill };
    private readonly Label _loadingLabel = new()
    {
        AutoSize = true,
        MaximumSize = new Size(720, 0),
        TextAlign = ContentAlignment.MiddleCenter,
    };
    private readonly ToolStripTextBox _serverAddress = new()
    {
        AutoSize = false,
        Width = 380,
    };
    private readonly ToolStripButton _connectButton = new("连接");
    private readonly ToolStripButton _reloadButton = new("刷新");
    private readonly ToolStripButton _startButton = new("启动服务");
    private readonly ToolStripButton _stopButton = new("停止服务");
    private readonly ToolStripButton _copyLanButton = new("复制局域网地址");
    private readonly ToolStripButton _firewallButton = new("启用局域网防火墙");
    private readonly ToolStripButton _shortcutButton = new("创建桌面快捷方式");
    private readonly ToolStripStatusLabel _serviceStatus = new();
    private readonly ToolStripStatusLabel _detailStatus = new() { Spring = true, TextAlign = ContentAlignment.MiddleLeft };
    private readonly string _webViewDataFolder;
    private ProjectPaths? _paths;
    private Uri? _lanPanel;
    private Uri? _panelUri;
    private Uri? _lastCommittedUri;
    private bool _isForcingFullNavigation;
    private bool _webViewReady;

    public LauncherForm(DesktopAppOptions options)
    {
        _options = options;
        Text = options.StartsLocalService ? "ChatGPT2API 桌面版" : "ChatGPT2API 局域网客户端";
        StartPosition = FormStartPosition.CenterScreen;
        MinimumSize = new Size(980, 680);
        Size = new Size(1280, 820);
        Icon = System.Drawing.Icon.ExtractAssociatedIcon(Application.ExecutablePath) ?? SystemIcons.Application;
        _webViewDataFolder = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "ChatGPT2API-Desktop",
            options.StartsLocalService ? "host" : "client");

        _serverAddress.Text = options.PanelUri.ToString();
        _serviceStatus.Text = options.StartsLocalService ? "服务：准备启动" : "客户端模式：不启动 Docker";
        _detailStatus.Text = "正在初始化桌面面板…";

        BuildLoadingPanel();
        Controls.Add(_webView);
        Controls.Add(_loadingPanel);
        Controls.Add(BuildStatusStrip());
        Controls.Add(BuildToolStrip());
        SetBusy(true);

        _connectButton.Click += async (_, _) => await ConnectAsync();
        _reloadButton.Click += (_, _) => ReloadPanel();
        _startButton.Click += async (_, _) => await StartLocalServiceAsync();
        _stopButton.Click += async (_, _) => await StopLocalServiceAsync();
        _copyLanButton.Click += (_, _) => CopyLanAddress();
        _firewallButton.Click += async (_, _) => await ConfigureFirewallAsync();
        _shortcutButton.Click += (_, _) => CreateDesktopShortcut();
        Shown += async (_, _) => await InitializeAsync();
        FormClosed += (_, _) => _dockerService.Dispose();
    }

    private ToolStrip BuildToolStrip()
    {
        var toolbar = new ToolStrip
        {
            Dock = DockStyle.Top,
            GripStyle = ToolStripGripStyle.Hidden,
            Padding = new Padding(8, 6, 8, 6),
        };

        toolbar.Items.Add(new ToolStripLabel("服务器："));
        toolbar.Items.Add(_serverAddress);
        toolbar.Items.Add(_connectButton);
        toolbar.Items.Add(_reloadButton);

        if (_options.StartsLocalService)
        {
            toolbar.Items.Add(new ToolStripSeparator());
            toolbar.Items.Add(_startButton);
            toolbar.Items.Add(_stopButton);
            toolbar.Items.Add(_copyLanButton);
            toolbar.Items.Add(_firewallButton);
        }

        toolbar.Items.Add(new ToolStripSeparator());
        toolbar.Items.Add(_shortcutButton);
        return toolbar;
    }

    private StatusStrip BuildStatusStrip()
    {
        var status = new StatusStrip { Dock = DockStyle.Bottom };
        status.Items.Add(_serviceStatus);
        status.Items.Add(new ToolStripStatusLabel { Text = " | " });
        status.Items.Add(_detailStatus);
        return status;
    }

    private void BuildLoadingPanel()
    {
        _loadingPanel.BackColor = SystemColors.Window;
        var layout = new TableLayoutPanel
        {
            Dock = DockStyle.Fill,
            ColumnCount = 1,
            RowCount = 1,
        };
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        layout.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        layout.Controls.Add(_loadingLabel, 0, 0);
        _loadingLabel.Anchor = AnchorStyles.None;
        _loadingPanel.Controls.Add(layout);
        ShowLoading("正在初始化内嵌桌面面板…");
    }

    private async Task InitializeAsync()
    {
        try
        {
            await EnsureWebViewAsync();
            if (_options.StartsLocalService)
            {
                await StartLocalServiceAsync();
            }
            else
            {
                NavigateToPanel(_options.PanelUri, "正在连接局域网服务…");
            }
        }
        catch (Exception exception)
        {
            ShowNativeError(exception.Message);
        }
        finally
        {
            SetBusy(false);
        }
    }

    private async Task EnsureWebViewAsync()
    {
        if (_webViewReady)
        {
            return;
        }

        try
        {
            Directory.CreateDirectory(_webViewDataFolder);
            var environment = await CoreWebView2Environment.CreateAsync(userDataFolder: _webViewDataFolder);
            await _webView.EnsureCoreWebView2Async(environment);
            _webView.CoreWebView2.NewWindowRequested += HandleNewWindowRequested;
            _webView.CoreWebView2.SourceChanged += HandleSourceChanged;
            _webView.CoreWebView2.NavigationCompleted += HandleNavigationCompleted;
            _webViewReady = true;
        }
        catch (Exception exception)
        {
            throw new InvalidOperationException(
                "无法初始化 Windows WebView2 运行时。请安装或修复 Microsoft Edge WebView2 Runtime 后重试。",
                exception);
        }
    }

    private void HandleNewWindowRequested(object? sender, CoreWebView2NewWindowRequestedEventArgs eventArgs)
    {
        eventArgs.NewWindow = _webView.CoreWebView2;
        eventArgs.Handled = true;
    }

    private void HandleSourceChanged(object? sender, CoreWebView2SourceChangedEventArgs eventArgs)
    {
        if (_isForcingFullNavigation || _webView.CoreWebView2 is null ||
            !Uri.TryCreate(_webView.CoreWebView2.Source, UriKind.Absolute, out var changedUri) ||
            !DesktopNavigationPolicy.ShouldForceFullNavigation(
                _lastCommittedUri,
                changedUri,
                eventArgs.IsNewDocument))
        {
            return;
        }

        _isForcingFullNavigation = true;
        ShowLoading("正在完整加载页面…");
        _detailStatus.Text = "检测到站内页面切换，正在使用兼容导航模式…";
        _webView.CoreWebView2.Navigate(changedUri.AbsoluteUri);
    }

    private void HandleNavigationCompleted(object? sender, CoreWebView2NavigationCompletedEventArgs eventArgs)
    {
        _isForcingFullNavigation = false;
        if (eventArgs.IsSuccess)
        {
            if (_webView.CoreWebView2 is not null &&
                Uri.TryCreate(_webView.CoreWebView2.Source, UriKind.Absolute, out var committedUri))
            {
                _lastCommittedUri = committedUri;
            }
            _loadingPanel.Visible = false;
            _detailStatus.Text = "页面已加载。";
            return;
        }

        ShowNativeError($"无法打开 {_serverAddress.Text}（错误代码：{eventArgs.WebErrorStatus}）。");
    }

    private async Task StartLocalServiceAsync()
    {
        await RunBusyAsync(async progress =>
        {
            ShowLoading("正在启动 Docker Desktop 和 ChatGPT2API…");
            var result = await _dockerService.StartLanAsync(RequirePaths(), progress, CancellationToken.None);
            _lanPanel = result.LanPanel;
            _serviceStatus.Text = "服务：运行中（局域网已启用）";
            NavigateToPanel(result.LocalPanel, "服务已启动，正在打开内嵌面板…");
        });
    }

    private async Task StopLocalServiceAsync()
    {
        await RunBusyAsync(async _ =>
        {
            await _dockerService.StopLanAsync(RequirePaths(), CancellationToken.None);
            _serviceStatus.Text = "服务：已停止";
            _detailStatus.Text = "ChatGPT2API 服务已停止。";
            ShowLoading("服务已停止。需要时点击“启动服务”即可重新打开内嵌面板。");
        });
    }

    private async Task ConnectAsync()
    {
        try
        {
            var options = DesktopAppOptions.Parse(new[] { "--server-url", _serverAddress.Text });
            await EnsureWebViewAsync();
            NavigateToPanel(options.PanelUri, "正在连接指定服务…");
            if (!_options.StartsLocalService)
            {
                _serviceStatus.Text = "客户端模式：已连接到指定服务器";
            }
        }
        catch (Exception exception)
        {
            ShowNativeError(exception.Message);
        }
    }

    private void NavigateToPanel(Uri panelUri, string detail)
    {
        _panelUri = panelUri;
        _serverAddress.Text = panelUri.ToString();
        _detailStatus.Text = detail;
        ShowLoading(detail);
        _webView.Source = ServiceEndpoints.WithDesktopRefreshToken(panelUri);
    }

    private void ReloadPanel()
    {
        if (!_webViewReady || _panelUri is null)
        {
            return;
        }

        NavigateToPanel(_panelUri, "正在刷新并同步最新页面…");
    }

    private async Task ConfigureFirewallAsync()
    {
        await RunBusyAsync(async _ =>
        {
            _detailStatus.Text = "等待 Windows 防火墙权限…";
            _detailStatus.Text = await FirewallManager.EnsurePrivateLanRuleAsync(CancellationToken.None);
        });
    }

    private void CopyLanAddress()
    {
        var panelUri = _lanPanel;
        if (panelUri is null)
        {
            var address = LanAddressResolver.GetPreferred();
            if (address is not null)
            {
                panelUri = ServiceEndpoints.LanPanel(address, 3000);
            }
        }

        if (panelUri is null)
        {
            MessageBox.Show(this, "未检测到可用的局域网 IPv4 地址。", Text, MessageBoxButtons.OK, MessageBoxIcon.Warning);
            return;
        }

        Clipboard.SetText(panelUri.ToString().TrimEnd('/'));
        _detailStatus.Text = "局域网地址已复制，可供其他电脑的桌面客户端使用。";
    }

    private void CreateDesktopShortcut()
    {
        try
        {
            var workingDirectory = _options.StartsLocalService ? RequirePaths().RootDirectory : AppContext.BaseDirectory;
            var arguments = _options.StartsLocalService
                ? null
                : $"--server-url \"{DesktopAppOptions.Parse(new[] { "--server-url", _serverAddress.Text }).PanelUri}\"";
            var shortcut = DesktopShortcut.Create(Application.ExecutablePath, workingDirectory, arguments);
            _detailStatus.Text = $"已创建桌面快捷方式：{shortcut}";
        }
        catch (Exception exception)
        {
            ShowNativeError(exception.Message);
        }
    }

    private async Task RunBusyAsync(Func<IProgress<string>, Task> operation)
    {
        SetBusy(true);
        var progress = new Progress<string>(message => _detailStatus.Text = message);
        try
        {
            await operation(progress);
        }
        catch (Exception exception)
        {
            ShowNativeError(exception.Message);
        }
        finally
        {
            SetBusy(false);
        }
    }

    private ProjectPaths RequirePaths()
    {
        return _paths ??= ProjectPaths.Discover(AppContext.BaseDirectory);
    }

    private void SetBusy(bool busy)
    {
        foreach (var button in new[]
        {
            _connectButton,
            _reloadButton,
            _startButton,
            _stopButton,
            _copyLanButton,
            _firewallButton,
            _shortcutButton,
        })
        {
            button.Enabled = !busy;
        }

        UseWaitCursor = busy;
    }

    private void ShowLoading(string message)
    {
        _loadingLabel.Text = message;
        _loadingPanel.Visible = true;
    }

    private void ShowNativeError(string message)
    {
        _serviceStatus.Text = "服务：需要处理";
        _detailStatus.Text = message;
        ShowLoading(message);
    }
}
