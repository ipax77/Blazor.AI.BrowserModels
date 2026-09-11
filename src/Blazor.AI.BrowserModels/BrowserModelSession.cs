using Microsoft.AspNetCore.Components;
using Microsoft.JSInterop;
using System.Text.Json;
using System.Runtime.CompilerServices;
using System.Threading.Channels;

namespace Blazor.AI.BrowserModels;

// This interop wrapper deliberately propagates failures to its caller, which owns the UI.
#pragma warning disable BL0016

/// <summary>A browser-owned model session. Use BrowserModelButton to initialize it with a user gesture.</summary>
public sealed class BrowserModelSession : IAsyncDisposable
{
    private IJSObjectReference? module;
    private IJSObjectReference? controller;
    private bool disposed;
    private long nextRequestId;
    private int prompting;
    public BrowserModelSessionMode Mode { get; private set; }

    internal async Task AttachAsync<T>(IJSRuntime js, ElementReference button, DotNetObjectReference<T> callback,
        int? topK, double? temperature, ElementReference? samplingPanel, bool enableImages,
        string? systemPrompt, ElementReference? systemPromptInput, BrowserModelSessionMode mode = BrowserModelSessionMode.Conversation) where T : class
    {
        Mode = mode;
        module = await js.InvokeAsync<IJSObjectReference>("import", "./_content/Blazor.AI.BrowserModels/browserModel.js");
        controller = await module.InvokeAsync<IJSObjectReference>("attach", button, callback, new { topK, temperature }, samplingPanel, enableImages, systemPrompt, systemPromptInput, mode == BrowserModelSessionMode.Stateless);
    }

    /// <summary>Reads cached sampling support after attachment, without creating a model or running inference.</summary>
    public ValueTask<BrowserModelSamplingInfo> GetSamplingInfoAsync()
    {
        ObjectDisposedException.ThrowIf(disposed, this);
        return GetController().InvokeAsync<BrowserModelSamplingInfo>("getSamplingInfo");
    }

    /// <summary>Returns unavailable, downloadable, downloading, or available.</summary>
    public ValueTask<string> GetAvailabilityAsync()
    {
        ObjectDisposedException.ThrowIf(disposed, this);
        return GetController().InvokeAsync<string>("availability");
    }

    /// <summary>Reads current metadata from the initialized session without creating a model or running inference.</summary>
    public ValueTask<BrowserModelInfo> GetInfoAsync()
    {
        ObjectDisposedException.ThrowIf(disposed, this);
        return GetController().InvokeAsync<BrowserModelInfo>("getInfo");
    }

    /// <summary>Generates a completed reply; previous prompts remain in Chrome's bounded session context.</summary>
    public async Task<string> PromptAsync(string prompt)
    {
        ObjectDisposedException.ThrowIf(disposed, this);
        RequireMode(BrowserModelSessionMode.Conversation);
        ArgumentException.ThrowIfNullOrWhiteSpace(prompt);
        // The browser aborts inference after two minutes; allow time for transport as well.
        return await GetController().InvokeAsync<string>("prompt", TimeSpan.FromMinutes(3), prompt);
    }

    private IJSObjectReference GetController() => controller
        ?? throw new InvalidOperationException("Initialize the browser model before prompting.");

    /// <summary>Prompts with browser-local attachments; image bytes never pass through .NET.</summary>
    public async Task<string> PromptAsync(string prompt, BrowserModelAttachments attachments)
    {
        ObjectDisposedException.ThrowIf(disposed, this);
        RequireMode(BrowserModelSessionMode.Conversation);
        ArgumentException.ThrowIfNullOrWhiteSpace(prompt);
        ArgumentNullException.ThrowIfNull(attachments);
        return await GetController().InvokeAsync<string>("prompt", TimeSpan.FromMinutes(3), prompt, attachments.GetController(this));
    }

    internal ValueTask<IJSObjectReference> AttachImagesAsync(ElementReference root) =>
        GetController().InvokeAsync<IJSObjectReference>("attachImages", root);

    /// <summary>Moves selected images into bounded browser retention. Returns null when none are selected.
    /// Retain the result for retries; reset releases all references. Requires Stateless mode.</summary>
    public async Task<BrowserModelImageReference?> RetainImagesAsync(BrowserModelAttachments attachments)
    {
        ObjectDisposedException.ThrowIf(disposed, this);
        RequireMode(BrowserModelSessionMode.Stateless);
        ArgumentNullException.ThrowIfNull(attachments);
        var id = await GetController().InvokeAsync<string?>("retainImages", attachments.GetController(this));
        return id is null ? null : new(this, id);
    }

    /// <summary>Releases all retained and selected images. Reset agent history alongside this call.</summary>
    public ValueTask ClearImagesAsync()
    {
        ObjectDisposedException.ThrowIf(disposed, this);
        RequireMode(BrowserModelSessionMode.Stateless);
        return GetController().InvokeVoidAsync("clearImages");
    }

    private void RequireMode(BrowserModelSessionMode expected)
    {
        if (Mode != expected) throw new InvalidOperationException($"This operation requires {expected} session mode.");
    }

    /// <summary>Prompts an isolated clone with a complete text history. Only one request may run at a time.</summary>
    public Task<string> PromptMessagesAsync(IReadOnlyList<BrowserModelChatMessage> messages, CancellationToken cancellationToken = default) =>
        PromptMessagesAsync(messages, null, cancellationToken);

    /// <summary>Constrains output with a JSON schema object. The browser validates schema support and compliance.</summary>
    public Task<string> PromptMessagesAsync(IReadOnlyList<BrowserModelChatMessage> messages, JsonElement? responseConstraint, CancellationToken cancellationToken)
        => ExecuteMessagesAsync(messages, responseConstraint, cancellationToken);

    private async Task<string> ExecuteMessagesAsync(IReadOnlyList<BrowserModelChatMessage> messages,
        JsonElement? responseConstraint, CancellationToken cancellationToken, DotNetObjectReference<StreamReceiver>? receiver = null)
    {
        ObjectDisposedException.ThrowIf(disposed, this);
        RequireMode(BrowserModelSessionMode.Stateless);
        ArgumentNullException.ThrowIfNull(messages);
        if (responseConstraint is { ValueKind: not JsonValueKind.Object })
            throw new NotSupportedException("The browser requires a JSON schema object as its response constraint.");
        if (messages.Count == 0) throw new ArgumentException("Provide a nonempty conversation.", nameof(messages));
        for (var i = 0; i < messages.Count; i++)
        {
            var message = messages[i];
            if (message is null || (message.Parts is null && string.IsNullOrWhiteSpace(message.Content)) ||
                (message.Role != "user" && message.Role != "assistant" && !(message.Role == "system" && i == 0)))
                throw new ArgumentException("Use nonempty text with user/assistant roles and at most one leading system message.", nameof(messages));
            if (message.Parts is { } parts)
            {
                if (message.Role != "user" || parts.Count == 0)
                    throw new ArgumentException("Only user messages support image parts.", nameof(messages));
                foreach (var part in parts)
                    if (part is null || (part.Type != "text" && part.Type != "image") || string.IsNullOrWhiteSpace(part.Value))
                        throw new ArgumentException("Provide nonempty text or retained image references.", nameof(messages));
            }
        }
        cancellationToken.ThrowIfCancellationRequested();
        var target = GetController();
        if (Interlocked.CompareExchange(ref prompting, 1, 0) != 0)
            throw new InvalidOperationException("A reply is already being generated.");
        try
        {
            var id = Interlocked.Increment(ref nextRequestId).ToString(System.Globalization.CultureInfo.InvariantCulture);
            // Dispatch first: ordered interop ensures cancellation cannot arrive before request registration.
            var pending = receiver is not null
                ? target.InvokeAsync<string>("promptMessages", TimeSpan.FromMinutes(3), messages, id, null, receiver)
                : responseConstraint is null
                ? target.InvokeAsync<string>("promptMessages", TimeSpan.FromMinutes(3), messages, id)
                : target.InvokeAsync<string>("promptMessages", TimeSpan.FromMinutes(3), messages, id, responseConstraint);
            using var registration = cancellationToken.CanBeCanceled
                ? cancellationToken.Register(static state =>
                {
                    var (controller, requestId) = ((IJSObjectReference, string))state!;
                    _ = CancelAsync(controller, requestId);
                }, (target, id))
                : default;
            try
            {
                var result = await pending;
                cancellationToken.ThrowIfCancellationRequested();
                return result;
            }
            catch (Exception) when (cancellationToken.IsCancellationRequested)
            {
                throw new OperationCanceledException(cancellationToken);
            }
        }
        finally { Volatile.Write(ref prompting, 0); }
    }

    /// <summary>Streams bounded text batches from an isolated clone. Dispose the enumerator to abort early.
    /// Structured output uses PromptMessagesAsync so JSON can be validated after completion.</summary>
    public async IAsyncEnumerable<string> PromptMessagesStreamingAsync(IReadOnlyList<BrowserModelChatMessage> messages,
        [EnumeratorCancellation] CancellationToken cancellationToken = default)
    {
        using var lifetime = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        using var receiverCancellation = new CancellationTokenSource();
        var receiver = new StreamReceiver(receiverCancellation.Token);
        using var reference = DotNetObjectReference.Create(receiver);
        var completion = ProduceAsync();
        try
        {
            await foreach (var batch in receiver.Reader.ReadAllAsync(cancellationToken))
            {
                cancellationToken.ThrowIfCancellationRequested();
                yield return batch;
            }
        }
        finally
        {
            // Send browser cancellation before releasing a blocked callback. Otherwise its failure
            // could complete the interop and unregister cancellation before the abort is dispatched.
            await lifetime.CancelAsync();
            await receiverCancellation.CancelAsync();
            await completion;
        }

        async Task ProduceAsync()
        {
            try
            {
                await ExecuteMessagesAsync(messages, null, lifetime.Token, reference);
                receiver.Complete(null);
            }
            catch (Exception error) { receiver.Complete(error); }
        }
    }

    // One queued batch and one awaiting acknowledgement; never accumulate the output transcript.
    public sealed class StreamReceiver
    {
        private readonly CancellationToken cancellationToken;
        private readonly Channel<string> channel = Channel.CreateBounded<string>(new BoundedChannelOptions(1)
        { SingleReader = true, SingleWriter = true, FullMode = BoundedChannelFullMode.Wait });
        internal StreamReceiver(CancellationToken cancellationToken) => this.cancellationToken = cancellationToken;
        internal ChannelReader<string> Reader => channel.Reader;
        internal void Complete(Exception? error) => channel.Writer.TryComplete(error);

        [JSInvokable]
        public Task ReceiveAsync(string text)
        {
            if (string.IsNullOrEmpty(text) || text.Length > 4096)
                throw new ArgumentException("Streaming batches must contain 1-4096 UTF-16 code units.", nameof(text));
            return channel.Writer.WriteAsync(text, cancellationToken).AsTask();
        }
    }

    private static async Task CancelAsync(IJSObjectReference target, string id)
    {
        try { await target.InvokeVoidAsync("cancelPrompt", id); }
        catch (Exception ex) when (ex is JSException or OperationCanceledException or ObjectDisposedException) { }
    }

    public async ValueTask DisposeAsync()
    {
        if (disposed) return;
        disposed = true;
        try
        {
            if (controller is not null)
            {
                await controller.InvokeVoidAsync("dispose");
                await controller.DisposeAsync();
            }
            if (module is not null) await module.DisposeAsync();
        }
        catch (JSDisconnectedException) { /* DOM removal/pagehide also releases browser resources. */ }
        catch (TaskCanceledException) { /* The circuit may already be shutting down. */ }
    }
}
