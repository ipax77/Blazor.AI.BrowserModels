using System.Text;
using System.Runtime.CompilerServices;
using System.Text.Json;
using Microsoft.Extensions.AI;

namespace Blazor.AI.BrowserModels;

/// <summary>A text and browser-image client borrowing a stateless browser session. Concurrent requests are rejected.</summary>
public sealed class BrowserModelChatClient : IChatClient
{
    private static readonly ChatClientMetadata Metadata = new("Chrome.PromptAPI");
    private static readonly JsonElement AnyJsonSchema = JsonSerializer.SerializeToElement(new { });
    private readonly BrowserModelSession session;
    private bool disposed;

    public BrowserModelChatClient(BrowserModelSession session)
    {
        ArgumentNullException.ThrowIfNull(session);
        if (session.Mode != BrowserModelSessionMode.Stateless)
            throw new ArgumentException("Initialize BrowserModelButton with Stateless session mode.", nameof(session));
        this.session = session;
    }

    public async Task<ChatResponse> GetResponseAsync(IEnumerable<ChatMessage> messages,
        ChatOptions? options = null, CancellationToken cancellationToken = default)
    {
        var mapped = MapMessages(messages, options, cancellationToken);
        var format = options?.ResponseFormat as ChatResponseFormatJson;
        var reply = await session.PromptMessagesAsync(mapped, format is null ? null : format.Schema ?? AnyJsonSchema, cancellationToken);
        if (format is not null)
        {
            // Parse only constrained replies; no second transcript or JSON reserialization.
            try { using var document = JsonDocument.Parse(reply); }
            catch (JsonException ex) { throw new InvalidOperationException("The browser returned invalid JSON for a structured response.", ex); }
        }
        return new ChatResponse(new ChatMessage(ChatRole.Assistant, reply));
    }

    private List<BrowserModelChatMessage> MapMessages(IEnumerable<ChatMessage> messages, ChatOptions? options, CancellationToken cancellationToken)
    {
        ObjectDisposedException.ThrowIf(disposed, this);
        ArgumentNullException.ThrowIfNull(messages);
        cancellationToken.ThrowIfCancellationRequested();
        ValidateOptions(options);
        var mapped = new List<BrowserModelChatMessage>();
        StringBuilder? instructions = null;
        if (!string.IsNullOrWhiteSpace(options?.Instructions)) instructions = new(options.Instructions);
        var hasConversation = false;
        foreach (var message in messages)
        {
            ArgumentNullException.ThrowIfNull(message);
            if (message.Role != ChatRole.System && message.Role != ChatRole.User && message.Role != ChatRole.Assistant)
                throw new NotSupportedException($"Role '{message.Role}' is not supported by the text adapter.");
            var hasImages = false;
            foreach (var content in message.Contents)
            {
                if (content is BrowserModelImageContent image)
                {
                    if (message.Role != ChatRole.User) throw new NotSupportedException("Images require a user message.");
                    image.Images.GetId(session);
                    hasImages = true;
                }
                else if (content is not TextContent) throw new NotSupportedException("Only text and BrowserModelImageContent are supported. Audio, image bytes and URLs are not supported.");
            }
            // Mixed content uses its ordered parts; avoid concatenating text we would discard.
            var text = hasImages ? "" : message.Text;
            if (!hasImages && string.IsNullOrWhiteSpace(text)) throw new ArgumentException("Messages must contain nonempty text.", nameof(messages));
            if (message.Role == ChatRole.System)
            {
                if (hasConversation) throw new ArgumentException("System messages must precede conversation messages.", nameof(messages));
                if (instructions is null) instructions = new(text);
                else instructions.Append("\n\n").Append(text);
            }
            else
            {
                if (!hasConversation && instructions is not null) mapped.Add(new("system", instructions.ToString()));
                hasConversation = true;
                List<BrowserModelChatPart>? parts = null;
                if (hasImages)
                {
                    parts = new(message.Contents.Count);
                    foreach (var content in message.Contents)
                    {
                        if (content is BrowserModelImageContent image) parts.Add(new("image", image.Images.GetId(session)));
                        else if (content is TextContent t && !string.IsNullOrWhiteSpace(t.Text)) parts.Add(new("text", t.Text));
                    }
                }
                mapped.Add(new(message.Role.Value, hasImages ? "" : text) { Parts = parts });
            }
        }
        if (!hasConversation) throw new ArgumentException("Provide at least one user or assistant message.", nameof(messages));
        return mapped;
    }

    private static void ValidateOptions(ChatOptions? o)
    {
        if (o is null) return;
        if (o.AllowBackgroundResponses == true || o.ContinuationToken is not null)
            throw new NotSupportedException("Browser inference requires a live page and connection. Background responses and continuation tokens are not supported.");
        if (o.ResponseFormat is not null and not ChatResponseFormatText and not ChatResponseFormatJson)
            throw new NotSupportedException("Only text and JSON response formats are supported.");
        if (o.ResponseFormat is ChatResponseFormatJson { Schema: { ValueKind: not JsonValueKind.Object } })
            throw new NotSupportedException("The browser requires a JSON schema object; boolean and scalar schemas are not supported.");
        if (o.Temperature is not null || o.TopK is not null || o.TopP is not null || o.MaxOutputTokens is not null ||
            o.FrequencyPenalty is not null || o.PresencePenalty is not null || o.Seed is not null || o.Reasoning is not null ||
            o.ModelId is not null || o.ConversationId is not null || o.AllowMultipleToolCalls is not null || o.ToolMode is not null ||
            o.Tools is { Count: > 0 } || o.StopSequences is { Count: > 0 } ||
            o.RawRepresentationFactory is not null || o.AdditionalProperties is { Count: > 0 })
            throw new NotSupportedException("The browser text adapter does not support the requested chat options. Configure sampling at browser initialization.");
    }

    public async IAsyncEnumerable<ChatResponseUpdate> GetStreamingResponseAsync(IEnumerable<ChatMessage> messages,
        ChatOptions? options = null, [EnumeratorCancellation] CancellationToken cancellationToken = default)
    {
        var mapped = MapMessages(messages, options, cancellationToken);
        if (options?.ResponseFormat is ChatResponseFormatJson)
            throw new NotSupportedException("Structured output requires GetResponseAsync for completed JSON validation.");
        await foreach (var batch in session.PromptMessagesStreamingAsync(mapped, cancellationToken))
            yield return new ChatResponseUpdate(ChatRole.Assistant, batch);
    }

    public object? GetService(Type serviceType, object? serviceKey = null)
    {
        ObjectDisposedException.ThrowIf(disposed, this);
        ArgumentNullException.ThrowIfNull(serviceType);
        if (serviceKey is not null) return null;
        if (serviceType == typeof(ChatClientMetadata)) return Metadata;
        return serviceType.IsInstanceOfType(this) ? this : null;
    }

    public void Dispose() => disposed = true;
}
