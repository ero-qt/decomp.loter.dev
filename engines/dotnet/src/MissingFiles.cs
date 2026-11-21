using ICSharpCode.Decompiler;
using ICSharpCode.Decompiler.Metadata;
using ICSharpCode.Decompiler.TypeSystem;
using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection.Metadata;

namespace Decomp.Dotnet;

/// <summary>
///     A file that isn't open and has types that an open file uses, like <c>MissingFile</c> in
///     <c>contract/engine.ts</c>.
/// </summary>
internal sealed record MissingFile(
    string Name,
    string Reason,
    bool IsCompanion);

/// <summary>
///     The missing files of a file and the count of its references that the engine can't read.
/// </summary>
internal sealed record FoundMissingFiles(
    List<MissingFile> Files,
    int SkippedCount);

/// <summary>
///     Finds the assemblies that a file references and that aren't open.
/// </summary>
internal static class MissingFiles
{
    /// <summary>
    ///     Lists the file's assembly references that aren't among the other open files, then the assemblies that open
    ///     facades forward the file's types to, each once and with the version in its reference. Skips and counts a
    ///     reference that the engine can't read, so the others stay listed.
    /// </summary>
    public static FoundMissingFiles Find(PEFile file, IReadOnlyList<PEFile> otherFiles)
    {
        MetadataReader metadata = file.Metadata;
        Dictionary<string, PEFile> openFiles = [];
        foreach (PEFile other in otherFiles)
        {
            openFiles.TryAdd(other.Name, other);
        }

        List<(string Name, string Version)> references = [];
        int skippedCount = 0;
        foreach (AssemblyReferenceHandle handle in metadata.AssemblyReferences)
        {
            try
            {
                references.Add(ReadReference(metadata, handle));
            }
            catch (BadImageFormatException)
            {
                skippedCount++;
            }
        }

        // reads each type reference's forwarders into a list first, so a broken one adds none of them
        foreach (TypeReferenceHandle handle in metadata.TypeReferences)
        {
            try
            {
                references.AddRange([.. FollowForwarders(metadata, handle, openFiles)]);
            }
            catch (BadImageFormatException)
            {
                skippedCount++;
            }
        }

        List<MissingFile> missingFiles = [.. references
            .Where(reference => !openFiles.ContainsKey(reference.Name))
            .DistinctBy(reference => reference.Name)
            .Select(reference => new MissingFile($"{reference.Name}.dll", $"{reference.Version}, not loaded", IsCompanion: false))];

        return new(missingFiles, skippedCount);
    }

    private static (string Name, string Version) ReadReference(MetadataReader metadata, AssemblyReferenceHandle handle)
    {
        System.Reflection.Metadata.AssemblyReference reference = metadata.GetAssemblyReference(handle);

        return (metadata.GetString(reference.Name), reference.Version.ToString());
    }

    // follows a type reference through the open facades that forward its type, because a facade like netstandard
    // forwards types to about 80 assemblies and the file's C# only needs the assemblies of the types that it uses
    private static IEnumerable<(string Name, string Version)> FollowForwarders(
        MetadataReader metadata,
        TypeReferenceHandle handle,
        Dictionary<string, PEFile> openFiles)
    {
        EntityHandle scope = metadata.GetTypeReference(handle).ResolutionScope;
        if (scope.Kind != HandleKind.AssemblyReference)
        {
            yield break;
        }

        FullTypeName typeName = handle.GetFullTypeName(metadata);
        string assemblyName = ReadReference(metadata, (AssemblyReferenceHandle)scope).Name;

        for (int hop = 0; hop < Limits.MaxForwarderHops && openFiles.TryGetValue(assemblyName, out PEFile? facade); hop++)
        {
            ExportedTypeHandle forwarder = facade.GetTypeForwarder(typeName);
            if (forwarder.IsNil)
            {
                yield break;
            }

            EntityHandle implementation = facade.Metadata.GetExportedType(forwarder).Implementation;
            if (implementation.Kind != HandleKind.AssemblyReference)
            {
                yield break;
            }

            (string Name, string Version) target = ReadReference(facade.Metadata, (AssemblyReferenceHandle)implementation);
            assemblyName = target.Name;

            yield return target;
        }
    }
}
