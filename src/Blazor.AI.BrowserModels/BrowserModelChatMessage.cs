namespace Blazor.AI.BrowserModels;

/// <summary>A text message with a system, user, or assistant role.</summary>
public sealed record BrowserModelChatMessage(string Role, string Content)
{
    /// <summary>Ordered text and browser image references; when present, replaces Content.</summary>
    [System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)]
    public IReadOnlyList<BrowserModelChatPart>? Parts { get; init; }
}

/// <summary>Type is text or image; image Value is an opaque retained-image ID.</summary>
public sealed record BrowserModelChatPart(string Type, string Value);
