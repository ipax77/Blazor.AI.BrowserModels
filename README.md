# Blazor.AI.BrowserModels

`Blazor.AI.BrowserModels` connects Blazor applications to language models exposed by the browser's Prompt API. Its primary API is `BrowserModelChatClient`, an implementation of `Microsoft.Extensions.AI.IChatClient` supporting completed and streamed text, structured JSON, and browser-owned image input.

Inference runs on the user's device. No API key, hosted model, database, or server-side inference service is required.

> [!NOTE]
> This is a preview package targeting .NET 11. Browser support also depends on the installed model, hardware, storage, browser policy, and the page being served from localhost or HTTPS. See Chrome's [Prompt API documentation](https://developer.chrome.com/docs/ai/prompt-api) for current requirements.

## Install

```powershell
dotnet add package Blazor.AI.BrowserModels --version 0.1.0-preview.1
```

The package includes its browser modules as static web assets; consumers do not need Node.js or a separate JavaScript build.

## Use `BrowserModelChatClient`

Initialize a stateless browser session from a user gesture and keep the component mounted while the client is in use:

```razor
@using Blazor.AI.BrowserModels
@using Microsoft.Extensions.AI

<BrowserModelButton SessionMode="BrowserModelSessionMode.Stateless"
                    OnReady="ModelReady"
                    OnError="ModelFailed" />

@code {
    private BrowserModelChatClient? chatClient;
    private string? error;

    private void ModelReady(BrowserModelSession session)
        => chatClient = new BrowserModelChatClient(session);

    private void ModelFailed(string message) => error = message;

    private async Task<string> AskAsync(string prompt)
    {
        ChatResponse response = await chatClient!.GetResponseAsync(
            [new ChatMessage(ChatRole.User, prompt)]);
        return response.Text;
    }
}
```

`BrowserModelButton` owns the browser session. Disposing `BrowserModelChatClient` releases only the adapter; removing the button releases the model session.

### Streaming

```csharp
await foreach (ChatResponseUpdate update in chatClient.GetStreamingResponseAsync(
    [new ChatMessage(ChatRole.User, "Explain local inference briefly.")],
    cancellationToken: cancellationToken))
{
    Console.Write(update.Text);
}
```

Streaming uses bounded batches and backpressure. Dispose an enumerator when stopping early so its browser reader and cloned model session are released promptly.

### Structured output

```csharp
var options = new ChatOptions
{
    ResponseFormat = ChatResponseFormat.ForJsonSchema<Summary>()
};

ChatResponse response = await chatClient.GetResponseAsync(
    [new ChatMessage(ChatRole.User, "Summarize this release.")], options);

public sealed record Summary(string Title, string[] KeyPoints);
```

The browser receives the JSON schema as its response constraint. The client validates returned JSON syntax; callers remain responsible for deserializing and validating application-specific requirements.

### Images

Enable image input and place the attachment component around the prompt editor:

```razor
<BrowserModelButton SessionMode="BrowserModelSessionMode.Stateless"
                    EnableImages="true" OnReady="ModelReady" />

<BrowserModelAttachments @ref="attachments" Session="session">
    <textarea @bind="prompt"></textarea>
</BrowserModelAttachments>
```

Capture the browser-owned selection and add it to a user message:

```csharp
BrowserModelImageReference? images = await session.RetainImagesAsync(attachments);
var message = new ChatMessage(ChatRole.User, "Describe these images.");
if (images is not null)
    message.Contents.Add(new BrowserModelImageContent(images));

ChatResponse response = await chatClient.GetResponseAsync([message]);
```

PNG, JPEG, and WebP files remain in the browser; their bytes are not copied through .NET interop. A selection accepts up to four files of 10 MiB each, and a model session retains at most 16 files or 64 MiB. Call `ClearImagesAsync` when resetting the corresponding chat history.

### Microsoft Agent Framework

Applications using `Microsoft.Agents.AI` can adapt the same client:

```csharp
var agent = chatClient.AsAIAgent(instructions: "Be helpful and concise.");
var conversation = await agent.CreateSessionAsync();
var reply = await agent.RunAsync("Hello", conversation);
```

## Samples

Run the standalone WebAssembly sample:

```powershell
dotnet run --project src/Blazor.AI.BrowserModels.Wasm --urls http://localhost:5188
```

Or run the Interactive Server sample:

```powershell
dotnet run --project src/Blazor.AI.BrowserModels.Sample
```

Open the displayed localhost URL in a compatible desktop Chrome installation and initialize the model. The WebAssembly sample includes completed and streaming chat, structured responses, image input, and Agent Framework scenarios.

## Runtime constraints

- Generation requires the owning page and browser connection to remain alive. Closing, reloading, freezing, or losing the circuit can interrupt a request; requests cannot resume in the background.
- Stateless chat replays the supplied history into one short-lived clone per request. Long histories increase model CPU work, context usage, and Blazor transport traffic.
- Only one request may use a browser session at a time. Unsupported roles, content, tools, per-request sampling, background responses, and continuation tokens fail before inference.
- Cancellation is request-scoped and best effort when the page is suspended. A browser-side two-minute timeout protects active pages.
- Image references belong to their original live session and must not be serialized or reused across reloads.
- In Interactive Server apps, text messages and replies cross the Blazor connection. Image bytes stay browser-local. The library does not persist or explicitly log prompts.

## Build and test

The repository pins its preview .NET SDK in `global.json`. Node.js 22.12 or newer is needed only when changing the TypeScript sources.

```powershell
npm ci
npm run typecheck
npm test
npm run build
dotnet build Blazor.AI.BrowserModels.slnx -c Release
dotnet test tests/Blazor.AI.BrowserModels.Tests -c Release --no-build
dotnet test tests/Blazor.AI.BrowserModels.Playwright.Tests -c Release --no-build --filter 'Category!=RealModel'
dotnet pack src/Blazor.AI.BrowserModels -c Release --no-build -o artifacts/packages
```

Generated modules under `src/Blazor.AI.BrowserModels/wwwroot` are committed so package consumers do not require a JavaScript toolchain. The [Playwright test guide](tests/Blazor.AI.BrowserModels.Playwright.Tests/README.md) documents deterministic browser tests and optional real-model checks.

## License

[MIT](LICENSE)
