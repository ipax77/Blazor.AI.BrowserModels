using System.Reflection;
using System.Text.Json;
using Microsoft.Agents.AI;
using Blazor.AI.BrowserModels;
using Microsoft.Extensions.AI;
using Microsoft.JSInterop;
using Xunit;
using Xunit.Abstractions;

namespace Blazor.AI.BrowserModels.Tests;

// The interop mock deliberately propagates failures to exercise the production bridge.
#pragma warning disable BL0016

public sealed class AdapterTests(ITestOutputHelper output)
{
    private static (BrowserModelSession Session, BrowserModelChatClient Client, BrowserInterop Js) Setup()
    {
        var session = new BrowserModelSession();
        var js = new BrowserInterop();
        // Exercise the actual public bridge without requiring a rendered component.
        typeof(BrowserModelSession).GetField("controller", BindingFlags.NonPublic | BindingFlags.Instance)!.SetValue(session, js);
        typeof(BrowserModelSession).GetProperty(nameof(BrowserModelSession.Mode))!.SetValue(session, BrowserModelSessionMode.Stateless);
        return (session, new(session), js);
    }

    [Fact]
    public async Task MapsTextOnceAndCombinesInstructions()
    {
        var h = Setup();
        var enumerations = 0;
        IEnumerable<ChatMessage> Messages()
        {
            Assert.Equal(1, ++enumerations);
            yield return new(ChatRole.System, "First");
            yield return new(ChatRole.System, "Second");
            yield return new(ChatRole.User, "Hello");
            yield return new(ChatRole.Assistant, "Hi");
            yield return new(ChatRole.User, "Follow up");
        }
        var result = await h.Client.GetResponseAsync(Messages(), new() { Instructions = "Configured", ResponseFormat = ChatResponseFormat.Text });
        Assert.Equal("Reply", result.Text);
        Assert.Null(result.ModelId);
        Assert.Null(result.Usage);
        Assert.Equal(new[] { "system", "user", "assistant", "user" }, h.Js.Messages!.Select(m => m.Role));
        Assert.Equal("Configured\n\nFirst\n\nSecond", h.Js.Messages![0].Content);
        Assert.Equal(1, h.Js.PromptCalls);
    }

    [Fact]
    public async Task RealAgentReplaysHistoryAndNewSessionStartsFresh()
    {
        var h = Setup();
        var agent = h.Client.AsAIAgent(instructions: "Be concise.");
        var conversation = await agent.CreateSessionAsync();
        Assert.Equal("Reply", (await agent.RunAsync("First", conversation)).Text);
        Assert.Equal("Reply", (await agent.RunAsync("Second", conversation)).Text);
        Assert.Equal(new[] { "Be concise.", "First", "Reply", "Second" }, h.Js.Messages!.Select(m => m.Content));
        await agent.RunAsync("Fresh", await agent.CreateSessionAsync());
        Assert.Equal(new[] { "Be concise.", "Fresh" }, h.Js.Messages!.Select(m => m.Content));
        Assert.Equal(3, h.Js.PromptCalls);
    }

    [Fact]
    public async Task RejectsUnsupportedMessagesAndModesBeforeInterop()
    {
        var h = Setup();
        await Assert.ThrowsAsync<ArgumentException>(() => h.Client.GetResponseAsync([]));
        await Assert.ThrowsAsync<ArgumentException>(() => h.Client.GetResponseAsync([new(ChatRole.User, " ")]));
        await Assert.ThrowsAsync<ArgumentException>(() => h.Client.GetResponseAsync([new(ChatRole.User, "Hi"), new(ChatRole.System, "Late")]));
        await Assert.ThrowsAsync<NotSupportedException>(() => h.Client.GetResponseAsync([new(ChatRole.Tool, "Result")]));
        await Assert.ThrowsAsync<NotSupportedException>(() => h.Client.GetResponseAsync([new(ChatRole.User, [new DataContent(new byte[] { 1 }, "image/png")])]));
        await Assert.ThrowsAsync<InvalidOperationException>(() => h.Session.PromptAsync("Hi"));
        Assert.Throws<ArgumentException>(() => new BrowserModelChatClient(new BrowserModelSession()));
        Assert.Equal(0, h.Js.PromptCalls);
    }

    [Fact]
    public async Task RejectsUnsupportedOptionsBeforeInterop()
    {
        var h = Setup();
        ChatOptions[] options = [new() { Temperature = 0.5f },
            new() { TopK = 2 }, new() { MaxOutputTokens = 10 }, new() { ModelId = "other" },
            new() { ConversationId = "remote" }, new() { AllowBackgroundResponses = true },
            new() { Tools = [AIFunctionFactory.Create(() => "tool")] }, new() { AdditionalProperties = new() { ["unknown"] = 1 } }];
        foreach (var option in options)
            await Assert.ThrowsAsync<NotSupportedException>(() => h.Client.GetResponseAsync([new(ChatRole.User, "Hi")], option));
        Assert.Equal(0, h.Js.PromptCalls);
        await Assert.ThrowsAsync<NotSupportedException>(async () =>
        {
            await foreach (var _ in h.Client.GetStreamingResponseAsync([new(ChatRole.User, "Hi")], new() { ResponseFormat = ChatResponseFormat.Json })) { }
        });
    }

    [Fact]
    public async Task JsonAndSchemaFormatsUseOneInteropAndDoNotLeakIntoTextRequests()
    {
        var h = Setup();
        h.Js.Reply = "{\"Title\":\"Hello\"}";
        await h.Client.GetResponseAsync([new(ChatRole.User, "Hi")], new() { ResponseFormat = ChatResponseFormat.Json });
        Assert.Equal("{}", h.Js.Constraint!.Value.GetRawText());
        var format = ChatResponseFormat.ForJsonSchema<TypedReply>();
        var response = await h.Client.GetResponseAsync([new(ChatRole.User, "Hi")], new() { ResponseFormat = format });
        Assert.Equal(format.Schema!.Value.GetRawText(), h.Js.Constraint!.Value.GetRawText());
        Assert.Equal("Hello", JsonSerializer.Deserialize<TypedReply>(response.Text)!.Title);
        await h.Client.GetResponseAsync([new(ChatRole.User, "Hi")]);
        Assert.Null(h.Js.Constraint);
        Assert.Equal(3, h.Js.PromptCalls);
    }

    [Theory]
    [InlineData("true")]
    [InlineData("[]")]
    [InlineData("42")]
    public async Task UnsupportedSchemaRootsFailBeforeInterop(string schema)
    {
        var h = Setup();
        using var document = JsonDocument.Parse(schema);
        await Assert.ThrowsAsync<NotSupportedException>(() => h.Client.GetResponseAsync([new(ChatRole.User, "Hi")],
            new() { ResponseFormat = ChatResponseFormat.ForJsonSchema(document.RootElement) }));
        Assert.Equal(0, h.Js.PromptCalls);
    }

    [Theory]
    [InlineData("not json")]
    [InlineData("```json\n{}\n```")]
    [InlineData("{} {}")]
    public async Task InvalidJsonFailsWithoutRetryAndAgentHistoryRecovers(string invalid)
    {
        var h = Setup();
        h.Js.Reply = invalid;
        var agent = h.Client.AsAIAgent();
        var conversation = await agent.CreateSessionAsync();
        var options = new ChatClientAgentRunOptions { ChatOptions = new() { ResponseFormat = ChatResponseFormat.ForJsonSchema<TypedReply>() } };
        var error = await Assert.ThrowsAsync<InvalidOperationException>(() => agent.RunAsync("Invalid turn", conversation, options));
        Assert.Contains("invalid JSON", error.Message);
        Assert.Equal(1, h.Js.PromptCalls);
        h.Js.Reply = "{\"Title\":\"Recovered\"}";
        var result = await agent.RunAsync("Retry", conversation, options);
        Assert.Equal("Recovered", JsonSerializer.Deserialize<TypedReply>(result.Text)!.Title);
        Assert.DoesNotContain(h.Js.Messages!, message => message.Content == invalid || message.Content == "Invalid turn");
        Assert.NotNull(h.Js.Constraint);
    }

    public sealed class TypedReply { public required string Title { get; init; } }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task CancellationAbortsMatchingRequestAndReleasesGate(bool structured)
    {
        var h = Setup();
        ChatOptions? options = structured ? new() { ResponseFormat = ChatResponseFormat.Json } : null;
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => h.Client.GetResponseAsync([new(ChatRole.User, "Hi")], cancellationToken: cancellation.Token));
        Assert.Equal(0, h.Js.PromptCalls);
        using var active = new CancellationTokenSource();
        h.Js.Pending = new(TaskCreationOptions.RunContinuationsAsynchronously);
        var pending = h.Client.GetResponseAsync([new(ChatRole.User, "Hi")], options, active.Token);
        await Assert.ThrowsAsync<InvalidOperationException>(() => h.Client.GetResponseAsync([new(ChatRole.User, "Concurrent")]));
        active.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => pending);
        Assert.Equal(h.Js.RequestId, h.Js.CanceledId);
        h.Js.Pending = null;
        Assert.Equal("Reply", (await h.Client.GetResponseAsync([new(ChatRole.User, "Retry")])).Text);
    }

    [Fact]
    public async Task MetadataAndDisposalDoNotOwnBrowserSession()
    {
        var h = Setup();
        var metadata = Assert.IsType<ChatClientMetadata>(h.Client.GetService(typeof(ChatClientMetadata)));
        Assert.Equal("Chrome.PromptAPI", metadata.ProviderName);
        Assert.Null(metadata.DefaultModelId);
        Assert.Same(h.Client, h.Client.GetService(typeof(IChatClient)));
        Assert.Null(h.Client.GetService(typeof(IChatClient), "key"));
        h.Client.Dispose();
        await Assert.ThrowsAsync<ObjectDisposedException>(() => h.Client.GetResponseAsync([]));
        Assert.False(h.Js.Disposed);
        Assert.Equal("Reply", await h.Session.PromptMessagesAsync([new("user", "Still alive")]));
        await h.Session.DisposeAsync();
        Assert.True(h.Js.Disposed);
    }

    [Fact]
    public async Task BrowserFailureReleasesGateAndCanceledCompletedRequestDoesNotSendAbort()
    {
        var h = Setup();
        h.Js.Pending = new(TaskCreationOptions.RunContinuationsAsynchronously);
        var pending = h.Client.GetResponseAsync([new(ChatRole.User, "Fails")]);
        h.Js.Pending.SetException(new JSException("Browser failure"));
        await Assert.ThrowsAsync<JSException>(() => pending);
        h.Js.Pending = null;
        using var completed = new CancellationTokenSource();
        await h.Client.GetResponseAsync([new(ChatRole.User, "Retry")], cancellationToken: completed.Token);
        completed.Cancel();
        Assert.Null(h.Js.CanceledId);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    [InlineData(false, true)]
    public async Task MockedAllocationAndInteropMeasurement(bool structured, bool images = false)
    {
        var h = Setup();
        ChatMessage[] messages = [new(ChatRole.User, "Hello")];
        if (images) messages[0].Contents.Add(new BrowserModelImageContent(ImageReference(h.Session)));
        ChatOptions? options = structured ? new() { ResponseFormat = ChatResponseFormat.ForJsonSchema<TypedReply>() } : null;
        if (structured) h.Js.Reply = "{\"Title\":\"Hello\"}";
        for (var i = 0; i < 100; i++) await h.Client.GetResponseAsync(messages, options);
        var before = GC.GetAllocatedBytesForCurrentThread();
        var calls = h.Js.PromptCalls;
        for (var i = 0; i < 1000; i++) await h.Client.GetResponseAsync(messages, options);
        var bytes = GC.GetAllocatedBytesForCurrentThread() - before;
        Assert.Equal(1000, h.Js.PromptCalls - calls);
        output.WriteLine($"Synchronous mocked {(images ? "image" : structured ? "JSON" : "text")} request: {bytes / 1000.0:N0} allocated bytes/request; 1 prompt interop/request; no metadata calls.");
    }

    private static BrowserModelImageReference ImageReference(BrowserModelSession session) =>
        (BrowserModelImageReference)Activator.CreateInstance(typeof(BrowserModelImageReference),
            BindingFlags.Instance | BindingFlags.NonPublic, null, [session, "opaque-id"], null)!;

    [Fact]
    public async Task RealAgentReplaysOrderedImageReferencesWithoutBytes()
    {
        var h = Setup();
        var image = new BrowserModelImageContent(ImageReference(h.Session));
        var agent = h.Client.AsAIAgent();
        var conversation = await agent.CreateSessionAsync();
        await agent.RunAsync(new ChatMessage(ChatRole.User, [new TextContent("Before"), image, new TextContent("After")]), conversation);
        await agent.RunAsync("Compare again", conversation);
        Assert.Equal(3, h.Js.Messages!.Count);
        Assert.Equal(new[] { "text", "image", "text" }, h.Js.Messages[0].Parts!.Select(p => p.Type));
        Assert.Equal(new[] { "Before", "opaque-id", "After" }, h.Js.Messages[0].Parts!.Select(p => p.Value));
        Assert.Equal("", h.Js.Messages[0].Content);
        var json = JsonSerializer.Serialize(h.Js.Messages);
        Assert.DoesNotContain("Owner", json);
        Assert.DoesNotContain("image/png", json);
        Assert.Equal(2, h.Js.PromptCalls);
        await agent.RunAsync("Fresh", await agent.CreateSessionAsync());
        Assert.Single(h.Js.Messages!);
        Assert.Null(h.Js.Messages![0].Parts);
    }

    [Fact]
    public async Task RejectsForeignImagesNonUserImagesAndAudioBeforeInterop()
    {
        var h = Setup();
        var image = new BrowserModelImageContent(ImageReference(h.Session));
        await Assert.ThrowsAsync<ArgumentException>(() => Setup().Client.GetResponseAsync([new(ChatRole.User, [image])]));
        foreach (var role in new[] { ChatRole.System, ChatRole.Assistant })
            await Assert.ThrowsAsync<NotSupportedException>(() => h.Client.GetResponseAsync([new(role, [image])]));
        await Assert.ThrowsAsync<NotSupportedException>(() => h.Client.GetResponseAsync([new(ChatRole.User, [new DataContent(new byte[] { 1 }, "audio/wav")])]));
        Assert.Equal(0, h.Js.PromptCalls);
        await h.Client.GetResponseAsync([new(ChatRole.User, [image])]);
        Assert.Equal("image", Assert.Single(h.Js.Messages![0].Parts!).Type);
    }

    [Fact]
    public async Task FailedImageAgentRunRetriesWithoutDuplicatingHistory()
    {
        var h = Setup();
        var agent = h.Client.AsAIAgent();
        var conversation = await agent.CreateSessionAsync();
        var message = new ChatMessage(ChatRole.User, [new BrowserModelImageContent(ImageReference(h.Session))]);
        h.Js.Reply = "invalid json";
        await Assert.ThrowsAsync<InvalidOperationException>(() => agent.RunAsync(message, conversation,
            new ChatClientAgentRunOptions { ChatOptions = new() { ResponseFormat = ChatResponseFormat.Json } }));
        h.Js.Reply = "Reply";
        await agent.RunAsync(message, conversation);
        Assert.Single(h.Js.Messages!);
        Assert.Single(h.Js.Messages![0].Parts!);
        Assert.Equal(2, h.Js.PromptCalls);
    }
    [Fact]
    public async Task StreamingAgentCommitsCompleteHistoryAndReplaysImages()
    {
        var h = Setup();
        var agent = h.Client.AsAIAgent(instructions: "Be concise.");
        var conversation = await agent.CreateSessionAsync();
        var text = new System.Text.StringBuilder();
        var message = new ChatMessage(ChatRole.User, [new TextContent("First"), new BrowserModelImageContent(ImageReference(h.Session))]);
        await foreach (var update in agent.RunStreamingAsync(message, conversation)) text.Append(update.Text);
        Assert.Equal("Reply", text.ToString());
        await agent.RunAsync("Second", conversation);
        Assert.Equal(new[] { "Be concise.", "", "Reply", "Second" }, h.Js.Messages!.Select(m => m.Content));
        Assert.Equal("image", h.Js.Messages![1].Parts![1].Type);
        Assert.Equal(2, h.Js.PromptCalls);
        Assert.Null(h.Js.CanceledId);
    }

    [Fact]
    public async Task StreamingBackpressureEarlyDisposalAndRetry()
    {
        var h = Setup();
        h.Js.Batches = Enumerable.Repeat("chunk", 100).ToArray();
        await using (var enumerator = h.Client.GetStreamingResponseAsync([new(ChatRole.User, "First")]).GetAsyncEnumerator())
        {
            Assert.True(await enumerator.MoveNextAsync());
            Assert.Equal("chunk", enumerator.Current.Text);
            await Assert.ThrowsAsync<InvalidOperationException>(() => h.Client.GetResponseAsync([new(ChatRole.User, "Overlap")]));
            Assert.InRange(Volatile.Read(ref h.Js.Acknowledged), 1, 2);
        }
        Assert.Equal(h.Js.RequestId, h.Js.CanceledId);
        Assert.Equal("Reply", (await h.Client.GetResponseAsync([new(ChatRole.User, "Retry")])).Text);
    }

    [Fact]
    public async Task StreamingFailureDoesNotCommitPartialAgentHistory()
    {
        var h = Setup();
        var agent = h.Client.AsAIAgent();
        var conversation = await agent.CreateSessionAsync();
        h.Js.StreamError = new JSException("Stream failed");
        await Assert.ThrowsAsync<JSException>(async () =>
        {
            await foreach (var _ in agent.RunStreamingAsync("Failed turn", conversation)) { }
        });
        await agent.RunAsync("Retry", conversation);
        Assert.Single(h.Js.Messages!);
        Assert.Equal("Retry", h.Js.Messages![0].Content);
    }

    [Fact]
    public async Task StreamingCancellationAndInvalidBatchesReleaseGate()
    {
        var h = Setup();
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(async () =>
        {
            await foreach (var _ in h.Client.GetStreamingResponseAsync([new(ChatRole.User, "Hi")], cancellationToken: cancellation.Token)) { }
        });
        Assert.Equal(0, h.Js.PromptCalls);
        h.Js.Batches = [new string('x', 4097)];
        await Assert.ThrowsAsync<ArgumentException>(async () =>
        {
            await foreach (var _ in h.Client.GetStreamingResponseAsync([new(ChatRole.User, "Hi")])) { }
        });
        Assert.Equal("Reply", (await h.Client.GetResponseAsync([new(ChatRole.User, "Retry")])).Text);
    }

    [Fact]
    public async Task StreamingActiveCancellationAndAgentEarlyExitDoNotCommitHistory()
    {
        var h = Setup();
        h.Js.Batches = Enumerable.Repeat("chunk", 100).ToArray();
        var agent = h.Client.AsAIAgent();
        var conversation = await agent.CreateSessionAsync();
        using var cancellation = new CancellationTokenSource();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(async () =>
        {
            await foreach (var _ in agent.RunStreamingAsync("Canceled turn", conversation, cancellationToken: cancellation.Token))
                cancellation.Cancel();
        });
        Assert.Equal(h.Js.RequestId, h.Js.CanceledId);
        await foreach (var _ in agent.RunStreamingAsync("Abandoned turn", conversation)) break;
        Assert.Equal(h.Js.RequestId, h.Js.CanceledId);
        await agent.RunAsync("Retry", conversation);
        Assert.Equal("Retry", Assert.Single(h.Js.Messages!).Content);
    }

    [Fact]
    public async Task MockedStreamingAllocationAndInteropMeasurement()
    {
        var h = Setup();
        h.Js.Batches = ["Reply"];
        ChatMessage[] messages = [new(ChatRole.User, "Hello")];
        for (var i = 0; i < 100; i++)
            await foreach (var _ in h.Client.GetStreamingResponseAsync(messages)) { }
        var before = GC.GetAllocatedBytesForCurrentThread();
        var calls = h.Js.PromptCalls;
        for (var i = 0; i < 1000; i++)
            await foreach (var _ in h.Client.GetStreamingResponseAsync(messages)) { }
        var bytes = GC.GetAllocatedBytesForCurrentThread() - before;
        Assert.Equal(1000, h.Js.PromptCalls - calls);
        Assert.Null(h.Js.CanceledId);
        output.WriteLine($"Synchronous one-batch mocked streaming: {bytes / 1000.0:N0} bytes/request; one prompt interop + one callback/request. Excludes transport, serialization, framework and browser allocations.");
    }

    [Theory]
    [InlineData(false, false)]
    [InlineData(true, false)]
    [InlineData(false, true)]
    [InlineData(true, true)]
    public async Task BackgroundAndContinuationFailBeforeEnumeratingHistoryOrInterop(bool streaming, bool continuation)
    {
        var h = Setup();
        var options = continuation
            ? new ChatOptions { AllowBackgroundResponses = false, ContinuationToken = ResponseContinuationToken.FromBytes(new byte[] { 1 }) }
            : new ChatOptions { AllowBackgroundResponses = true };
        IEnumerable<ChatMessage> UnexpectedHistory()
        {
            Assert.Fail("Unsupported background requests must fail before history mapping.");
            yield break;
        }
        var error = await Assert.ThrowsAsync<NotSupportedException>(async () =>
        {
            if (streaming)
                await foreach (var _ in h.Client.GetStreamingResponseAsync(UnexpectedHistory(), options)) { }
            else await h.Client.GetResponseAsync(UnexpectedHistory(), options);
        });
        Assert.Contains("live page and connection", error.Message);
        Assert.Equal(0, h.Js.PromptCalls);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task AgentBackgroundFlagIsRejectedAndExplicitForegroundHasNoContinuation(bool streaming)
    {
        var h = Setup();
        var agent = h.Client.AsAIAgent();
        var conversation = await agent.CreateSessionAsync();
        var options = new AgentRunOptions { AllowBackgroundResponses = true };
        await Assert.ThrowsAsync<NotSupportedException>(async () =>
        {
            if (streaming)
                await foreach (var _ in agent.RunStreamingAsync("Background", conversation, options)) { }
            else await agent.RunAsync("Background", conversation, options);
        });
        Assert.Equal(0, h.Js.PromptCalls);
        options.AllowBackgroundResponses = false;
        if (streaming)
        {
            var text = new System.Text.StringBuilder();
            await foreach (var update in agent.RunStreamingAsync("Foreground", conversation, options))
            {
                Assert.Null(update.ContinuationToken);
                text.Append(update.Text);
            }
            Assert.Equal("Reply", text.ToString());
        }
        else
        {
            var response = await agent.RunAsync("Foreground", conversation, options);
            // Verify absence of resumability in the pinned Agent Framework version.
#pragma warning disable MEAI001
            Assert.Null(response.ContinuationToken);
#pragma warning restore MEAI001
            Assert.Equal("Reply", response.Text);
        }
        Assert.Equal("Foreground", Assert.Single(h.Js.Messages!).Content);
        Assert.Equal(1, h.Js.PromptCalls);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task DisconnectedInteropFailsWithoutRetryOrPartialHistory(bool streaming)
    {
        var h = Setup();
        var agent = h.Client.AsAIAgent();
        var conversation = await agent.CreateSessionAsync();
        if (streaming) h.Js.StreamError = new JSDisconnectedException("Circuit lost");
        else
        {
            h.Js.Pending = new(TaskCreationOptions.RunContinuationsAsynchronously);
            h.Js.Pending.SetException(new JSDisconnectedException("Circuit lost"));
        }
        await Assert.ThrowsAsync<JSDisconnectedException>(async () =>
        {
            if (streaming)
                await foreach (var _ in agent.RunStreamingAsync("Lost turn", conversation)) { }
            else await agent.RunAsync("Lost turn", conversation);
        });
        Assert.Equal(1, h.Js.PromptCalls);
        h.Js.Pending = null;
        h.Js.StreamError = null;
        // Restoring the mock verifies failure/gate/history behavior, not real circuit recovery.
        await agent.RunAsync("Fresh attempt", conversation);
        Assert.Equal("Fresh attempt", Assert.Single(h.Js.Messages!).Content);
    }

    private sealed class BrowserInterop : IJSObjectReference
    {
        public IReadOnlyList<BrowserModelChatMessage>? Messages;
        public int PromptCalls;
        public string? RequestId;
        public string? CanceledId;
        public bool Disposed;
        public TaskCompletionSource<string>? Pending;
        public string Reply = "Reply";
        public JsonElement? Constraint;
        public ValueTask<TValue> InvokeAsync<TValue>(string identifier, object?[]? args) => InvokeAsync<TValue>(identifier, default, args);
        public ValueTask<TValue> InvokeAsync<TValue>(string identifier, CancellationToken cancellationToken, object?[]? args)
        {
            if (identifier == "promptMessages")
            {
                PromptCalls++;
                Messages = (IReadOnlyList<BrowserModelChatMessage>)args![0]!;
                RequestId = (string)args[1]!;
                Constraint = args.Length > 2 ? (JsonElement?)args[2] : null;
                if (args.Length > 3 && args[3] is DotNetObjectReference<BrowserModelSession.StreamReceiver> receiver)
                    return new(StreamAsync<TValue>(receiver.Value));
                return Pending is null ? ValueTask.FromResult((TValue)(object)Reply) : new(WaitAsync<TValue>(Pending.Task));
            }
            if (identifier == "cancelPrompt")
            {
                CanceledId = (string)args![0]!;
                if (CanceledId == RequestId) Pending?.TrySetException(new JSException("Aborted"));
            }
            return ValueTask.FromResult(default(TValue)!);
        }
        public string[] Batches = ["Re", "ply"];
        public int Acknowledged;
        public Exception? StreamError;
        private async Task<T> StreamAsync<T>(BrowserModelSession.StreamReceiver receiver)
        {
            foreach (var batch in Batches)
            {
                await receiver.ReceiveAsync(batch);
                Interlocked.Increment(ref Acknowledged);
            }
            if (StreamError is not null) throw StreamError;
            return (T)(object)"";
        }
        private static async Task<T> WaitAsync<T>(Task<string> pending) => (T)(object)await pending;
        public ValueTask DisposeAsync() { Disposed = true; return ValueTask.CompletedTask; }
    }
}
