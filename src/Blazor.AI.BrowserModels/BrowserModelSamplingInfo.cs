using System.Text.Json.Serialization;

namespace Blazor.AI.BrowserModels;

/// <summary>Whether numeric sampling is exposed and its limits could be read.</summary>
[JsonConverter(typeof(JsonStringEnumConverter<BrowserModelSamplingSupport>))]
public enum BrowserModelSamplingSupport { Unknown, Supported, Unsupported }

/// <summary>Cached browser sampling limits. Null values are not exposed or could not be read.</summary>
public sealed record BrowserModelSamplingInfo
{
    public BrowserModelSamplingSupport Support { get; init; }
    public int? DefaultTopK { get; init; }
    public int? MaxTopK { get; init; }
    public double? DefaultTemperature { get; init; }
    public double? MaxTemperature { get; init; }
}
