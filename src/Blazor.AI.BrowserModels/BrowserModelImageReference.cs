namespace Blazor.AI.BrowserModels;

/// <summary>An opaque, session-local reference to retained browser images. Never persist it.</summary>
public sealed class BrowserModelImageReference
{
    internal BrowserModelImageReference(BrowserModelSession owner, string id) { Owner = owner; Id = id; }
    internal BrowserModelSession Owner { get; }
    public string Id { get; }
    public string GetId(BrowserModelSession session) => ReferenceEquals(session, Owner)
        ? Id : throw new ArgumentException("The images belong to another browser session.", nameof(session));
}
