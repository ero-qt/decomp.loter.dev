using System.Runtime.InteropServices.JavaScript;
using System.Runtime.Versioning;
using System.Threading.Tasks;

namespace Decomp.Dotnet;

/// <summary>
///     Exports the methods that the engine's worker calls. Each method returns its reply as JSON, like
///     <c>{ "value": true, "error": null }</c>.
/// </summary>
[SupportedOSPlatform("browser")]
public static partial class Exports
{
    private static readonly Session _session = new();

    /// <summary>
    ///     Closes every open file, because a new set of handlers in the same runtime starts empty.
    /// </summary>
    [JSExport]
    public static void Reset()
    {
        _session.Reset();
    }

    [JSExport]
    public static string Open(int fileId, string name, byte[] bytes)
    {
        return ReplyJson.Write(() => _session.Open(fileId, name, bytes));
    }

    [JSExport]
    public static string Close(int fileId)
    {
        return ReplyJson.Write(() => _session.Close(fileId));
    }

    [JSExport]
    public static Task<string> List(int fileId)
    {
        return ReplyJson.WriteAsync(() => _session.ListAsync(fileId), ReplyJson.Default.ReplyListingReply);
    }

    [JSExport]
    public static Task<string> ReadCSharp(int fileId, int key)
    {
        return ReplyJson.WriteAsync(
            async () => DocumentReply.From(await _session.ReadCSharpAsync(fileId, key)),
            ReplyJson.Default.ReplyDocumentReply);
    }

    [JSExport]
    public static Task<string> ReadIl(int fileId, int key)
    {
        return ReplyJson.WriteAsync(
            async () => DocumentReply.From(await _session.ReadIlAsync(fileId, key)),
            ReplyJson.Default.ReplyDocumentReply);
    }

    /// <summary>
    ///     Describes a symbol in the view <c>il</c> or else in the view <c>csharp</c>, because the worker refuses the
    ///     other views.
    /// </summary>
    [JSExport]
    public static string Describe(string target, string view)
    {
        View describedView = view == "il" ? View.Il : View.CSharp;

        return ReplyJson.Write(() => _session.Describe(target, describedView), ReplyJson.Default.ReplyDescription);
    }

    [JSExport]
    public static string Resolve(string target)
    {
        return ReplyJson.Write(() => _session.Resolve(target), ReplyJson.Default.ReplyString);
    }

    [JSExport]
    public static Task<string> FindUsers(string target)
    {
        return ReplyJson.WriteAsync(() => _session.FindUsersAsync(target), ReplyJson.Default.ReplyListString);
    }

    [JSExport]
    public static Task<string> ListStrings(int fileId)
    {
        return ReplyJson.WriteAsync(() => _session.ListStringsAsync(fileId), ReplyJson.Default.ReplyListStringUse);
    }

    /// <summary>
    ///     Stops the running call at its next check, which throws in the call.
    /// </summary>
    [JSExport]
    public static void Cancel()
    {
        _session.Cancel();
    }
}
