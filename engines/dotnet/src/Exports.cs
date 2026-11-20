using System.Runtime.InteropServices.JavaScript;
using System.Runtime.Versioning;

namespace Decomp.Dotnet;

/// <summary>
///     Exports the methods that the engine's worker calls.
/// </summary>
[SupportedOSPlatform("browser")]
public static partial class Exports
{
    /// <summary>
    ///     Drops every open file, because a new set of handlers in the same runtime starts empty.
    /// </summary>
    [JSExport]
    public static void Reset()
    {
    }
}
