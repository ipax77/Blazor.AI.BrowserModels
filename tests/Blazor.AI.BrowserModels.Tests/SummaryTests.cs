using System.Text.Json;
using Microsoft.Extensions.AI;
using Xunit;
using Summary = Blazor.AI.BrowserModels.Sample.Components.Pages.Agents.Summary;

namespace Blazor.AI.BrowserModels.Tests;

public sealed class SummaryTests
{
    [Fact]
    public void SchemaAndParserAgreeOnPropertyNames()
    {
        var schema = Summary.Format.Schema!.Value;
        var properties = schema.GetProperty("properties");
        Assert.True(properties.TryGetProperty("title", out _));
        Assert.True(properties.TryGetProperty("keyPoints", out _));
        var json = """{"title":"Browser AI","keyPoints":["Runs locally","Supports JSON"]}""";
        // Reproduce the previous failure with the package's default generated schema.
        Assert.True(ChatResponseFormat.ForJsonSchema<Summary>().Schema!.Value.GetProperty("properties").TryGetProperty("title", out _));
        Assert.Throws<JsonException>(() => JsonSerializer.Deserialize<Summary>(json));
        var result = Summary.Parse(json);
        Assert.Equal("Browser AI", result.Title);
        Assert.Equal(new[] { "Runs locally", "Supports JSON" }, result.KeyPoints);
    }

    [Theory]
    [InlineData("{}")]
    [InlineData("null")]
    [InlineData("{\"title\":\"Missing points\"}")]
    [InlineData("{\"keyPoints\":[]}")]
    [InlineData("{\"title\":\" \",\"keyPoints\":[\"Point\"]}")]
    [InlineData("{\"title\":\"Title\",\"keyPoints\":null}")]
    [InlineData("{\"title\":\"Title\",\"keyPoints\":[null]}")]
    [InlineData("{\"title\":\"Title\",\"keyPoints\":[\" \"]}")]
    [InlineData("not json")]
    public void InvalidSummaryStillFails(string json) =>
        Assert.Throws<JsonException>(() => Summary.Parse(json));
}
