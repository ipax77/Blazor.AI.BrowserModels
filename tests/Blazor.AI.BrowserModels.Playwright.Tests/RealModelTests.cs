using Microsoft.Playwright;
using Xunit;
using static Microsoft.Playwright.Assertions;

namespace Blazor.AI.BrowserModels.Playwright.Tests;

public sealed class RealModelFactAttribute : FactAttribute
{
    public RealModelFactAttribute()
    {
        if (Environment.GetEnvironmentVariable("PWTESTS_RealModel") != "1") Skip = "Opt in with PWTESTS_RealModel=1 and a prepared Chrome test profile.";
    }
}

[Collection("Browser")]
public sealed class RealModelTests(BrowserFixture fixture)
{
    [RealModelFact]
    [Trait("Category", "RealModel")]
    public async Task RealChromeCompletedStreamingAndJson()
    {
        var context = fixture.RealContext ?? throw new InvalidOperationException("Real Chrome profile was not initialized.");
        var page = await context.NewPageAsync();
        page.SetDefaultTimeout(180_000);
        await context.Tracing.StartAsync(new() { Screenshots = true, Snapshots = true });
        try
        {
            await page.GotoAsync(fixture.BaseUrl);
            await Expect(page.GetByTestId("chat")).ToBeVisibleAsync();
            Assert.True(await page.EvaluateAsync<bool>("typeof LanguageModel !== 'undefined'"), "Chrome's Prompt API is unavailable. Prepare the dedicated profile before running real-model tests.");
            await page.GetByRole(AriaRole.Button, new() { Name = "Initialize browser model", Exact = true }).ClickAsync();
            await Expect(page.GetByTestId("state")).ToHaveTextAsync("Ready", new() { Timeout = 180_000 });
            foreach (var mode in new[] { "text", "stream", "json" })
            {
                await page.GetByRole(AriaRole.Button, new() { Name = "New conversation", Exact = true }).ClickAsync();
                await page.Locator("#prompt").FillAsync("Summarize this: Local inference keeps prompts on the device and can work offline. Provide a title and two key points.");
                await page.GetByTestId("mode").SelectOptionAsync(mode);
                await page.GetByTestId("generate").ClickAsync();
                await Expect(page.GetByTestId("state")).ToHaveTextAsync("Completed", new() { Timeout = 180_000 });
                Assert.False(string.IsNullOrWhiteSpace(await page.GetByTestId("reply").TextContentAsync()));
                if (mode == "json")
                {
                    using var json = System.Text.Json.JsonDocument.Parse((await page.GetByTestId("raw-json").TextContentAsync())!);
                    Assert.False(string.IsNullOrWhiteSpace(json.RootElement.GetProperty("title").GetString()));
                    Assert.Equal(System.Text.Json.JsonValueKind.Array, json.RootElement.GetProperty("keyPoints").ValueKind);
                }
            }
            await context.Tracing.StopAsync();
        }
        catch
        {
            var directory = Path.Combine(fixture.Root, "artifacts", "playwright-results", "real-model");
            Directory.CreateDirectory(directory);
            await page.ScreenshotAsync(new() { Path = Path.Combine(directory, "failure.png"), FullPage = true });
            await context.Tracing.StopAsync(new() { Path = Path.Combine(directory, "trace.zip") });
            throw;
        }
        finally { await page.CloseAsync(); }
    }
}
