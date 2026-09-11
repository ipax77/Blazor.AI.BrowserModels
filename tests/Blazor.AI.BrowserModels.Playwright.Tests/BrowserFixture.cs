using System.Diagnostics;
using System.Net;
using System.Text.RegularExpressions;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.StaticFiles;
using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Logging;
using Microsoft.Playwright;
using Xunit;

namespace Blazor.AI.BrowserModels.Playwright.Tests;

[CollectionDefinition("Browser", DisableParallelization = true)]
public sealed class BrowserCollection : ICollectionFixture<BrowserFixture>;

public sealed class BrowserFixture : IAsyncLifetime
{
    private WebApplication? host;
    private IPlaywright? playwright;
    public IBrowser Browser { get; private set; } = null!;
    public IBrowserContext? RealContext { get; private set; }
    public string BaseUrl { get; private set; } = "";
    public string Root { get; } = FindRoot();
    public async Task InitializeAsync()
    {
        Microsoft.Playwright.Assertions.SetDefaultExpectTimeout(30_000);
        try
        {
            var external = Environment.GetEnvironmentVariable("PWTESTS_SampleBaseUrl");
            if (!string.IsNullOrWhiteSpace(external))
            {
                var uri = new Uri(external, UriKind.Absolute);
                if (uri.Scheme is not ("http" or "https") || uri.Query.Length != 0 || uri.Fragment.Length != 0)
                    throw new ArgumentException("PWTESTS_SampleBaseUrl must be an HTTP(S) application root without query or fragment.");
                BaseUrl = uri.AbsoluteUri.TrimEnd('/') + "/";
            }
            else
            {
                var output = Environment.GetEnvironmentVariable("PWTESTS_PublishedAppPath");
                if (string.IsNullOrWhiteSpace(output))
                {
                    output = Path.Combine(Root, "artifacts", "playwright-app", "wwwroot");
                    await PublishAsync(Path.GetDirectoryName(output)!);
                    var index = Path.Combine(output, "index.html");
                    await File.WriteAllTextAsync(index, (await File.ReadAllTextAsync(index)).Replace("<base href=\"/\"", "<base href=\"/playwright/\"", StringComparison.Ordinal));
                }
                output = Path.GetFullPath(output, Root);
                var html = await File.ReadAllTextAsync(Path.Combine(output, "index.html"));
                var basePath = Regex.Match(html, "<base href=\"([^\"]+)\"").Groups[1].Value;
                if (!basePath.StartsWith('/') || !basePath.EndsWith('/')) throw new InvalidOperationException("Published app needs an absolute base path ending in '/'.");
                var builder = WebApplication.CreateSlimBuilder();
                builder.Logging.ClearProviders();
                builder.WebHost.ConfigureKestrel(options => options.Listen(IPAddress.Loopback, 0));
                host = builder.Build();
                var types = new FileExtensionContentTypeProvider();
                types.Mappings[".wasm"] = "application/wasm";
                types.Mappings[".dat"] = "application/octet-stream";
                var provider = new PhysicalFileProvider(output);
                host.Lifetime.ApplicationStopped.Register(provider.Dispose);
                var prefix = basePath.TrimEnd('/');
                host.UseDefaultFiles(new DefaultFilesOptions { FileProvider = provider, RequestPath = prefix });
                host.UseStaticFiles(new StaticFileOptions { FileProvider = provider, RequestPath = prefix, ContentTypeProvider = types });
                await host.StartAsync();
                BaseUrl = host.Urls.Single().TrimEnd('/') + basePath;
            }
            using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(15) };
            using var ready = await http.GetAsync(BaseUrl);
            ready.EnsureSuccessStatusCode();
            var expected = Environment.GetEnvironmentVariable("PWTESTS_ExpectedCommit");
            if (!string.IsNullOrWhiteSpace(expected))
            {
                var actual = await http.GetStringAsync(BaseUrl + "commit.txt?expected=" + Uri.EscapeDataString(expected));
                Assert.Equal(expected, actual.Trim());
            }
            playwright = await Microsoft.Playwright.Playwright.CreateAsync();
            Browser = await playwright.Chromium.LaunchAsync();
            if (Environment.GetEnvironmentVariable("PWTESTS_RealModel") == "1")
            {
                var profile = Environment.GetEnvironmentVariable("PWTESTS_ChromeUserDataDir");
                if (string.IsNullOrWhiteSpace(profile)) throw new InvalidOperationException("Real model tests require PWTESTS_ChromeUserDataDir pointing to a prepared dedicated Chrome test profile.");
                RealContext = await playwright.Chromium.LaunchPersistentContextAsync(Path.GetFullPath(profile), new() { Channel = "chrome", Headless = false });
            }
        }
        catch { await DisposeAsync(); throw; }
    }
    private async Task PublishAsync(string output)
    {
        var info = new ProcessStartInfo("dotnet") { WorkingDirectory = Root, UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true };
        foreach (var arg in new[] { "publish", "src/Blazor.AI.BrowserModels.Wasm", "-c", "Release", "-o", output, "--nologo" }) info.ArgumentList.Add(arg);
        using var process = Process.Start(info) ?? throw new InvalidOperationException("Could not start dotnet publish.");
        var log = new Queue<string>();
        async Task Drain(StreamReader reader)
        {
            while (await reader.ReadLineAsync() is { } line)
                lock (log) { if (log.Count == 100) log.Dequeue(); log.Enqueue(line); }
        }
        var drains = Task.WhenAll(Drain(process.StandardOutput), Drain(process.StandardError));
        using var timeout = new CancellationTokenSource(TimeSpan.FromMinutes(5));
        try { await process.WaitForExitAsync(timeout.Token); }
        catch { if (!process.HasExited) process.Kill(entireProcessTree: true); throw; }
        await drains;
        if (process.ExitCode != 0) throw new InvalidOperationException("WASM publish failed:\n" + string.Join('\n', log));
    }
    public async Task DisposeAsync()
    {
        if (RealContext is not null) await RealContext.CloseAsync();
        if (Browser is not null) await Browser.CloseAsync();
        playwright?.Dispose();
        if (host is not null) await host.DisposeAsync();
    }
    private static string FindRoot()
    {
        for (var dir = new DirectoryInfo(AppContext.BaseDirectory); dir is not null; dir = dir.Parent)
            if (File.Exists(Path.Combine(dir.FullName, "Blazor.AI.BrowserModels.slnx"))) return dir.FullName;
        throw new DirectoryNotFoundException("Could not find Blazor.AI.BrowserModels.slnx.");
    }
}
