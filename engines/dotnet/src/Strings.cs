using ICSharpCode.Decompiler.Metadata;
using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection.Metadata;
using System.Reflection.Metadata.Ecma335;
using System.Threading.Tasks;

namespace Decomp.Dotnet;

/// <summary>
///     A string in an open file, like <c>StringUse</c> in <c>contract/engine.ts</c>.
/// </summary>
internal sealed record StringUse(
    string Text,
    string? User);

/// <summary>
///     Lists the strings that a file's <c>ldstr</c> instructions load.
/// </summary>
internal static class Strings
{
    // ldstr and its token
    private const int LoadSize = 5;

    /// <summary>
    ///     Lists each string once for each method that loads it, with the row of the method's code as its user, in the
    ///     order of the methods and of their IL. Cuts a long string with <see cref="Limits.CutString"/> and stops
    ///     after <see cref="Limits.MaxStrings"/> strings. Checks the cancellation before each method body and each
    ///     string.
    /// </summary>
    /// <exception cref="CanceledCallException">The worker canceled the call.</exception>
    public static async Task<List<StringUse>> ListAsync(SearchedFile file, Cancellation cancellation)
    {
        UserRows userRows = new(file);
        List<TokenInstruction> instructions = await MethodBodyScanner.ReadTokenInstructionsAsync(file.File, cancellation);
        List<StringUse> strings = [];

        foreach ((string text, MethodDefinitionHandle method) in ListLoads(file.File.Metadata, instructions).Take(Limits.MaxStrings))
        {
            await cancellation.CheckAsync();
            strings.Add(new(text, userRows.FindMethodUser(method)));
        }

        return strings;
    }

    /// <summary>
    ///     Checks whether a file has more strings than <see cref="ListAsync"/> lists, without a scan when its IL is too
    ///     short for them.
    /// </summary>
    /// <exception cref="CanceledCallException">The worker canceled the call.</exception>
    public static async Task<bool> IsCutAsync(PEFile file, Cancellation? cancellation)
    {
        if (MethodBodyScanner.ListBodies(file).IlBytes <= (long)Limits.MaxStrings * LoadSize)
        {
            return false;
        }

        List<TokenInstruction> instructions = await MethodBodyScanner.ReadTokenInstructionsAsync(file, cancellation);

        return ListLoads(file.Metadata, instructions).Skip(Limits.MaxStrings).Any();
    }

    // lists each string once for each method that loads it, cut at Limits.MaxStringLength characters
    private static IEnumerable<(string Text, MethodDefinitionHandle Method)> ListLoads(MetadataReader metadata, List<TokenInstruction> instructions)
    {
        int heapSize = metadata.GetHeapSize(HeapIndex.UserString);
        Dictionary<int, string> texts = [];
        HashSet<(string Text, MethodDefinitionHandle Method)> listed = [];

        foreach (TokenInstruction instruction in instructions)
        {
            // reads the token's kind from its top byte, which has the number of the handle's kind
            if (instruction.OpCode != ILOpCode.Ldstr || instruction.Token >>> 24 != (int)HandleKind.UserString)
            {
                continue;
            }

            UserStringHandle handle = (UserStringHandle)MetadataTokens.Handle(instruction.Token);
            int offset = MetadataTokens.GetHeapOffset(handle);
            if (offset >= heapSize)
            {
                continue;
            }

            // reads each string of the heap once because the methods of a hostile file can all load 1 large string
            if (!texts.TryGetValue(offset, out string? text))
            {
                if (ReadUserString(metadata, handle) is not { } read)
                {
                    continue;
                }

                texts[offset] = text = Limits.CutString(read);
            }

            if (listed.Add((text, instruction.Method)))
            {
                yield return (text, instruction.Method);
            }
        }
    }

    // doesn't read a string whose bytes run past the heap, so the file's other strings stay listed
    private static string? ReadUserString(MetadataReader metadata, UserStringHandle handle)
    {
        try
        {
            return metadata.GetUserString(handle);
        }
        catch (BadImageFormatException)
        {
            return null;
        }
    }
}
