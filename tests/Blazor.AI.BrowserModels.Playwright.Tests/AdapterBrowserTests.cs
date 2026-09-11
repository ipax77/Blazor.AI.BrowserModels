using System.Runtime.CompilerServices;
using System.Text.Json;
using Microsoft.Playwright;
using Xunit;
using static Microsoft.Playwright.Assertions;

namespace Blazor.AI.BrowserModels.Playwright.Tests;

[Collection("Browser")]
public sealed class AdapterBrowserTests(BrowserFixture fixture)
{
    private async Task RunAsync(Func<IPage, Task> test, object? config = null, string view = "scenarios", [CallerMemberName] string name = "test")
    {
        await using var context = await fixture.Browser.NewContextAsync();
        context.SetDefaultTimeout(30_000);
        await context.AddInitScriptAsync("globalThis.__modelConfig = " + JsonSerializer.Serialize(config ?? new { }) + ";\n" +
            await File.ReadAllTextAsync(Path.Combine(AppContext.BaseDirectory, "LanguageModel.fake.js")));
        await context.Tracing.StartAsync(new() { Screenshots = true, Snapshots = true, Sources = true });
        var page = await context.NewPageAsync();
        var diagnostics = new Queue<string>();
        var pageErrors = new List<string>();
        void Log(string value) { if (diagnostics.Count == 100) diagnostics.Dequeue(); diagnostics.Enqueue(value[..Math.Min(value.Length, 2000)]); }
        page.Console += (_, message) => Log(message.Type + ": " + message.Text);
        page.PageError += (_, error) => { if (pageErrors.Count < 20) pageErrors.Add(error); Log(error); };
        page.RequestFailed += (_, request) => Log(request.Url + ": " + request.Failure);
        try
        {
            var response = await page.GotoAsync(fixture.BaseUrl + "?view=" + view);
            Assert.NotNull(response);
            Assert.True(response.Ok);
            await Expect(page.GetByTestId("chat")).ToBeVisibleAsync();
            await test(page);
            Assert.Empty(pageErrors);
            await context.Tracing.StopAsync();
        }
        catch
        {
            var directory = Path.Combine(fixture.Root, "artifacts", "playwright-results", name + "-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(directory);
            try
            {
                await page.ScreenshotAsync(new() { Path = Path.Combine(directory, "failure.png"), FullPage = true });
                await context.Tracing.StopAsync(new() { Path = Path.Combine(directory, "trace.zip") });
                await File.WriteAllLinesAsync(Path.Combine(directory, "browser.log"), diagnostics);
            }
            catch (PlaywrightException) { /* Preserve the original assertion when the page has crashed. */ }
            throw;
        }
    }
    private static async Task InitializeAsync(IPage page)
    {
        await page.GetByRole(AriaRole.Button, new() { Name = "Initialize browser model", Exact = true }).ClickAsync();
        await Expect(page.GetByTestId("state")).ToHaveTextAsync("Ready");
    }
    private static async Task GenerateAsync(IPage page, string prompt = "Hello", string mode = "text", string state = "Completed")
    {
        await page.Locator("#prompt").FillAsync(prompt);
        await page.GetByTestId("mode").SelectOptionAsync(mode);
        await page.GetByTestId("generate").ClickAsync();
        await Expect(page.GetByTestId("state")).ToHaveTextAsync(state);
        await Expect(page.GetByTestId("generate")).ToBeEnabledAsync();
    }
    private static async Task CheckAsync(IPage page, string expression) => await page.WaitForFunctionAsync("() => " + expression);
    private static Task ConfigureAsync(IPage page, object config) => page.EvaluateAsync("config => Object.assign(__model.config, config)", config);

    [Fact]
    public Task PublishedAssetsAndHistoryReplay() => RunAsync(async page =>
    {
        await InitializeAsync(page);
        await GenerateAsync(page, "First turn");
        await GenerateAsync(page, "Second turn");
        await CheckAsync(page, "__model.creates === 1 && __model.clones === 2 && __model.cloneDestroyed === 2 && __model.active === 0");
        Assert.Equal("system,user,assistant,user", await page.EvaluateAsync<string>("__model.calls[1].input.map(m => m.role).join(',')"));
        Assert.Equal("Be helpful and concise. Respond in English.\n\nKeep replies brief.", await page.EvaluateAsync<string>("__model.calls[0].input[0].content"));
        await page.GetByRole(AriaRole.Button, new() { Name = "New conversation", Exact = true }).ClickAsync();
        await GenerateAsync(page, "Fresh turn");
        await CheckAsync(page, "__model.calls[2].input.length === 2 && __model.creates === 1");
        var assets = await page.EvaluateAsync<string[]>("performance.getEntriesByType('resource').map(r => r.name).filter(n => n.includes('/_framework/') || n.includes('/_content/'))");
        Assert.NotEmpty(assets);
        Assert.All(assets, url => Assert.StartsWith(fixture.BaseUrl, url));
        Assert.Contains(assets, url => url.Contains("/_content/Blazor.AI.BrowserModels/browserModel.js"));
        Assert.Contains(assets, url => url.Contains(".wasm"));
    });

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public Task UnavailableModel(bool missing) => RunAsync(async page =>
    {
        await Expect(page.GetByTestId("error")).ToContainTextAsync("unavailable");
        await Expect(page.GetByRole(AriaRole.Button, new() { Name = "Initialize browser model", Exact = true })).ToBeDisabledAsync();
        await CheckAsync(page, "__model.creates === 0");
    }, new { missing, unavailable = !missing });

    [Fact]
    public Task InitializationRetry() => RunAsync(async page =>
    {
        await page.GetByRole(AriaRole.Button, new() { Name = "Initialize browser model", Exact = true }).ClickAsync();
        await Expect(page.GetByTestId("error")).ToContainTextAsync("Initialization failed");
        await ConfigureAsync(page, new { createFail = false });
        await InitializeAsync(page);
        await GenerateAsync(page);
        await CheckAsync(page, "__model.creates === 2 && __model.clones === 1 && __model.cloneDestroyed === 1");
    }, new { createFail = true });

    [Fact]
    public Task MissingCloneFailsExplicitly() => RunAsync(async page =>
    {
        await InitializeAsync(page);
        await GenerateAsync(page, state: "Failed");
        await Expect(page.GetByTestId("error")).ToContainTextAsync("cloning");
        await CheckAsync(page, "__model.clones === 0 && __model.calls.length === 0");
    }, new { noClone = true });

    [Fact]
    public Task StreamingIsBatchedAndHistoryCommitted() => RunAsync(async page =>
    {
        await InitializeAsync(page);
        await GenerateAsync(page, mode: "stream");
        await Expect(page.GetByTestId("reply")).ToHaveTextAsync(new string('x', 96));
        await Expect(page.GetByTestId("stream-metrics")).ToHaveTextAsync("3 batches; maximum 32 characters");
        await GenerateAsync(page, "Follow-up");
        await CheckAsync(page, "__model.calls[1].input[2].content.length === 96 && __model.active === 0");
    });

    [Fact]
    public Task LargeStreamingChunksPreserveUnicodeWithinBatchLimit() => RunAsync(async page =>
    {
        await InitializeAsync(page);
        await GenerateAsync(page, mode: "stream");
        await Expect(page.GetByTestId("reply")).ToHaveTextAsync(new string('x', 4095) + "😀" + new string('y', 4096));
        await Expect(page.GetByTestId("stream-metrics")).ToHaveTextAsync("3 batches; maximum 4096 characters");
        await CheckAsync(page, "__model.cloneDestroyed === 1 && __model.active === 0");
    }, new { chunks = 1, chunk = new string('x', 4095) + "😀" + new string('y', 4096) });

    [Fact]
    public Task AnyJsonUsesEmptyConstraintAndAcceptsScalar() => RunAsync(async page =>
    {
        await InitializeAsync(page);
        await GenerateAsync(page, mode: "json-any");
        await Expect(page.GetByTestId("reply")).ToHaveTextAsync("42");
        await CheckAsync(page, "JSON.stringify(__model.calls[0].constraint) === '{}' && __model.cloneDestroyed === 1");
    }, new { reply = "42" });

    [Theory]
    [InlineData("text")]
    [InlineData("stream")]
    public Task CancellationConcurrentRejectionAndRecovery(string mode) => RunAsync(async page =>
    {
        await InitializeAsync(page);
        await page.GetByTestId("mode").SelectOptionAsync(mode);
        await page.GetByTestId("generate").ClickAsync();
        await CheckAsync(page, "__model.calls.length === 1");
        await page.GetByTestId("concurrent").ClickAsync();
        await Expect(page.GetByTestId("scenario-result")).ToContainTextAsync("already being generated");
        await page.GetByRole(AriaRole.Button, new() { Name = "Cancel", Exact = true }).ClickAsync();
        await Expect(page.GetByTestId("state")).ToHaveTextAsync("Canceled");
        await CheckAsync(page, "__model.aborted === 1 && __model.cloneDestroyed === 1 && __model.clones === 1");
        if (mode == "stream") await CheckAsync(page, "__model.streamCanceled === 1");
        await ConfigureAsync(page, new { hold = false });
        await GenerateAsync(page, "Retry");
        await CheckAsync(page, "__model.calls[1].input.length === 2 && __model.active === 0");
    }, new { hold = true });

    [Fact]
    public Task EarlyStreamDisposalReleasesCloneWithoutHistory() => RunAsync(async page =>
    {
        await InitializeAsync(page);
        await page.GetByRole(AriaRole.Checkbox, new() { Name = "Stop after first stream batch" }).CheckAsync();
        await GenerateAsync(page, mode: "stream", state: "Stopped early");
        await CheckAsync(page, "__model.cloneDestroyed === 1 && __model.active === 0 && __model.streamCanceled === 1");
        await Expect(page.GetByTestId("history-count")).ToHaveTextAsync("1");
        await ConfigureAsync(page, new { hold = false });
        await GenerateAsync(page, "Retry");
        await CheckAsync(page, "__model.calls[1].input.length === 2");
    }, new { hold = true, chunk = new string('x', 4096) });

    [Fact]
    public Task StructuredOutputAndConstraintIsolation() => RunAsync(async page =>
    {
        await InitializeAsync(page);
        await GenerateAsync(page, mode: "json");
        await Expect(page.GetByTestId("reply")).ToContainTextAsync("Local inference");
        await CheckAsync(page, "__model.calls[0].constraint.properties.title.type === 'string'");
        await GenerateAsync(page);
        await CheckAsync(page, "__model.calls[1].constraint === null");
        await ConfigureAsync(page, new { reply = "not json" });
        await GenerateAsync(page, mode: "json", state: "Failed");
        await Expect(page.GetByTestId("error")).ToContainTextAsync("invalid JSON");
        await CheckAsync(page, "__model.calls.length === 3 && __model.cloneDestroyed === 3");
        await ConfigureAsync(page, new { reply = "Recovered" });
        await GenerateAsync(page);
        await CheckAsync(page, "__model.calls[3].input.length === 6 && __model.calls[3].constraint === null");
    });

    [Theory]
    [InlineData("text", "OperationError")]
    [InlineData("stream", "OperationError")]
    [InlineData("json", "NotSupportedError")]
    public Task BrowserFailureCleansUpAndDoesNotCommit(string mode, string errorName) => RunAsync(async page =>
    {
        await InitializeAsync(page);
        await GenerateAsync(page, mode: mode, state: "Failed");
        await CheckAsync(page, "__model.cloneDestroyed === 1 && __model.calls.length === 1 && __model.active === 0");
        await Expect(page.GetByTestId("history-count")).ToHaveTextAsync("1");
        await ConfigureAsync(page, new { fail = "" });
        await GenerateAsync(page);
        await CheckAsync(page, "__model.calls[1].input.length === 2");
    }, new { fail = "Model failed", errorName });

    [Fact]
    public Task ImagesRemainBrowserOwnedAndSurviveRetryAndReplay() => RunAsync(async page =>
    {
        await InitializeAsync(page);
        await page.Locator("input[type=file]").SetInputFilesAsync(new FilePayload { Name = "pixel.png", MimeType = "image/png", Buffer = Convert.FromBase64String("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=") });
        await CheckAsync(page, "__model.liveUrls === 1");
        await GenerateAsync(page, state: "Failed");
        await Expect(page.GetByTestId("pending-images")).ToBeVisibleAsync();
        await CheckAsync(page, "__model.liveUrls === 0 && __model.calls[0].input[1].content[1].value.blob");
        await ConfigureAsync(page, new { fail = "" });
        await GenerateAsync(page, "Retry image");
        await GenerateAsync(page, "Follow up");
        await CheckAsync(page, "__model.calls[2].input[1].content[0].type === 'text' && __model.calls[2].input[1].content[1].value.name === 'pixel.png'");
        await page.GetByRole(AriaRole.Button, new() { Name = "New conversation", Exact = true }).ClickAsync();
        await page.GetByTestId("expired-image").ClickAsync();
        await Expect(page.GetByTestId("scenario-result")).ToContainTextAsync("expired");
        await CheckAsync(page, "__model.clones === 3");
    }, new { fail = "Model failed" });

    [Fact]
    public Task AdapterAndComponentHaveSeparateOwnership() => RunAsync(async page =>
    {
        await InitializeAsync(page);
        await page.GetByTestId("replace-client").ClickAsync();
        await Expect(page.GetByTestId("scenario-result")).ToContainTextAsync("Disposed adapter rejected");
        await CheckAsync(page, "__model.clones === 0");
        await GenerateAsync(page);
        await CheckAsync(page, "__model.creates === 1 && __model.seedDestroyed === 0");
        await ConfigureAsync(page, new { hold = true });
        await page.GetByTestId("generate").ClickAsync();
        await CheckAsync(page, "__model.active === 1");
        await page.GetByTestId("mount").ClickAsync();
        await CheckAsync(page, "__model.seedDestroyed === 1 && __model.cloneDestroyed === 2 && __model.active === 0 && __model.liveUrls === 0");
        await ConfigureAsync(page, new { hold = false });
        await page.GetByTestId("mount").ClickAsync();
        await InitializeAsync(page);
        await GenerateAsync(page);
        await CheckAsync(page, "__model.creates === 2");
        await page.Locator("input[type=file]").SetInputFilesAsync(new FilePayload { Name = "preview.png", MimeType = "image/png", Buffer = Convert.FromBase64String("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=") });
        await CheckAsync(page, "__model.liveUrls === 1");
        await page.GetByTestId("mount").ClickAsync();
        await CheckAsync(page, "__model.liveUrls === 0 && __model.seedDestroyed === 2");
    });

    [Fact]
    public Task AgentFrameworkReplaysAndResetsHistory() => RunAsync(async page =>
    {
        await InitializeAsync(page);
        await GenerateAsync(page, "Agent first");
        await GenerateAsync(page, "Agent second", "stream");
        await CheckAsync(page, "__model.calls[1].input.map(m => m.role).join(',') === 'system,user,assistant,user'");
        await page.GetByRole(AriaRole.Button, new() { Name = "New conversation", Exact = true }).ClickAsync();
        await GenerateAsync(page, "Fresh agent turn");
        await CheckAsync(page, "__model.calls[2].input.length === 2 && __model.creates === 1");
    }, view: "agent");
}
