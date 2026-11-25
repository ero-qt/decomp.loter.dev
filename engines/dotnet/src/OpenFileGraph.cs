using ICSharpCode.Decompiler.Metadata;
using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection.Metadata;

namespace Decomp.Dotnet;

/// <summary>
///     Follows the assembly references of the open files.
/// </summary>
internal static class OpenFileGraph
{
    // the assemblies that the decompiler's type system also looks for without a reference to them
    private static readonly HashSet<string> ImplicitNames = ["mscorlib", "netstandard", "System.Runtime", "System.Private.CoreLib"];

    /// <summary>
    ///     Checks whether a file's type system reads an assembly with the name: the file references it, an open file
    ///     that the file reaches through references does, or the type system looks for it by itself. Also true for a
    ///     file whose references aren't readable.
    /// </summary>
    public static bool Reaches(PEFile from, string assemblyName, IReadOnlyCollection<PEFile> openFiles)
    {
        if (ImplicitNames.Contains(assemblyName))
        {
            return true;
        }

        HashSet<PEFile> seenFiles = [from];
        Stack<PEFile> pendingFiles = new([from]);

        while (pendingFiles.TryPop(out PEFile? file))
        {
            if (ReadReferenceNames(file) is not { } names || names.Contains(assemblyName))
            {
                return true;
            }

            foreach (PEFile referenced in openFiles.Where(open => names.Contains(open.Name) && seenFiles.Add(open)))
            {
                pendingFiles.Push(referenced);
            }
        }

        return false;
    }

    private static HashSet<string>? ReadReferenceNames(PEFile file)
    {
        MetadataReader metadata = file.Metadata;

        try
        {
            return [.. metadata.AssemblyReferences.Select(handle => metadata.GetString(metadata.GetAssemblyReference(handle).Name))];
        }
        catch (BadImageFormatException)
        {
            return null;
        }
    }
}
