namespace Blazor.AI.BrowserModels;

/// <summary>A snapshot of browser model metadata. Null values are not exposed by the browser.</summary>
public sealed record BrowserModelInfo
{
    /// <summary>Whether this session was initialized with image input enabled.</summary>
    public bool SupportsImages { get; init; }

    /// <summary>Effective session Top K, or null when not exposed.</summary>
    public int? TopK { get; init; }

    /// <summary>Effective session Temperature, or null when not exposed.</summary>
    public double? Temperature { get; init; }

    /// <summary>The underlying model identifier, when exposed; not an inferred product label.</summary>
    public string? Name { get; init; }

    /// <summary>Model download size in bytes, when exposed; not RAM use or required free disk space.</summary>
    public long? SizeBytes { get; init; }

    /// <summary>Maximum session context in tokens, when exposed.</summary>
    public double? ContextWindowTokens { get; init; }

    /// <summary>Tokens currently occupied, including retained conversation history; not cumulative billing usage.</summary>
    public double? ContextUsageTokens { get; init; }
}
