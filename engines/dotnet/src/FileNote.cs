using System.Collections.Generic;
using System.Globalization;

namespace Decomp.Dotnet;

/// <summary>
///     The parts of a file that the engine leaves out, for the note on the file's row.
/// </summary>
internal sealed record FileNote(
    int SkippedSymbols,
    int SkippedReferences,
    bool IsScanCut,
    bool AreStringsCut)
{
    /// <summary>
    ///     Writes the note, like <c>first 50,000 strings listed</c>, or an empty note for a file that the engine reads
    ///     whole.
    /// </summary>
    public override string ToString()
    {
        string[] counts =
        [
            .. CountText(SkippedSymbols, "symbol", "symbols"),
            .. CountText(SkippedReferences, "reference", "references"),
        ];
        List<string> parts = [];

        if (counts.Length > 0)
        {
            parts.Add($"{string.Join(" and ", counts)} that the engine can't read not shown");
        }

        if (IsScanCut)
        {
            parts.Add(string.Create(CultureInfo.InvariantCulture, $"users searched in the first {Limits.MaxIlBytes:N0} bytes of IL"));
        }

        if (AreStringsCut)
        {
            parts.Add(string.Create(CultureInfo.InvariantCulture, $"first {Limits.MaxStrings:N0} strings listed"));
        }

        return string.Join("; ", parts);
    }

    private static string[] CountText(int count, string one, string many)
    {
        return count switch
        {
            0 => [],
            1 => [$"1 {one}"],
            _ => [$"{count} {many}"],
        };
    }
}
