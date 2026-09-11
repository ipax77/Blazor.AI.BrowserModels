using Microsoft.Extensions.AI;

namespace Blazor.AI.BrowserModels;

/// <summary>Browser-owned images for in-memory agent history. Bytes never cross JS interop.</summary>
public sealed class BrowserModelImageContent : AIContent
{
    public BrowserModelImageContent(BrowserModelImageReference images)
    {
        ArgumentNullException.ThrowIfNull(images);
        Images = images;
    }
    public BrowserModelImageReference Images { get; }
}
