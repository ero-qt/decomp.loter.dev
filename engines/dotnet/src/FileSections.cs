using ICSharpCode.Decompiler.Metadata;
using ICSharpCode.Decompiler.TypeSystem;
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Reflection;
using System.Reflection.Metadata;
using System.Reflection.Metadata.Ecma335;
using System.Reflection.PortableExecutable;
using AssemblyReference = System.Reflection.Metadata.AssemblyReference;

namespace Decomp.Dotnet;

/// <summary>
///     A row in a section of a file's tree, like a referenced assembly with its version.
/// </summary>
internal sealed record SectionRow(
    SymbolKind Kind,
    int Flags,
    int Key,
    string Name,
    string Detail);

/// <summary>
///     A section of a file's tree before its namespaces, like ILSpy's References and Resources.
/// </summary>
internal sealed record Section(
    string Name,
    int Key,
    List<SectionRow> Rows);

/// <summary>
///     Lists and describes the sections of a file's tree: the assemblies that the file references and its resources. A
///     section's key is its metadata table in the top byte with the row number 0, which no metadata token has, and a
///     row's key in a section is the metadata token of its reference or resource.
/// </summary>
internal static class FileSections
{
    private const int TableShift = 24;

    /// <summary>
    ///     Checks whether a key is a section's key or the key of a row in a section.
    /// </summary>
    public static bool IsSectionKey(int key)
    {
        return (key >>> TableShift) is (int)TableIndex.AssemblyRef or (int)TableIndex.ManifestResource;
    }

    /// <summary>
    ///     Lists the sections that have rows, each section's rows in the metadata's order.
    /// </summary>
    public static List<Section> List(MetadataFile file)
    {
        MetadataReader metadata = file.Metadata;
        List<SectionRow> references = [];
        foreach (AssemblyReferenceHandle handle in metadata.AssemblyReferences)
        {
            AssemblyReference reference = metadata.GetAssemblyReference(handle);
            string version = reference.Version.ToString();
            references.Add(new(SymbolKind.Reference, Flags: 0, MetadataTokens.GetToken(handle), metadata.GetString(reference.Name), version));
        }

        List<SectionRow> resources = [];
        foreach (ManifestResourceHandle handle in metadata.ManifestResources)
        {
            ManifestResource resource = metadata.GetManifestResource(handle);
            int visibility = (int)(IsPublic(resource) ? Accessibility.Public : Accessibility.Private);
            string size = ReadLength(file, resource) is { } length ? WriteSize(length) : "";
            resources.Add(new(SymbolKind.Resource, visibility, MetadataTokens.GetToken(handle), metadata.GetString(resource.Name), size));
        }

        List<Section> sections =
        [
            new("References", GetKey(TableIndex.AssemblyRef), references),
            new("Resources", GetKey(TableIndex.ManifestResource), resources),
        ];

        return [.. sections.Where(section => section.Rows.Count > 0)];
    }

    /// <summary>
    ///     Describes a section with its name, a referenced assembly with its full name and its version, and a resource
    ///     with its name, its size and its visibility.
    /// </summary>
    /// <param name="findMissingFile">Finds an assembly's missing file, or null while no file lists it.</param>
    public static Description Describe(MetadataFile file, int key, string name, Func<string, string?> findMissingFile)
    {
        MetadataReader metadata = file.Metadata;
        string token = string.Create(CultureInfo.InvariantCulture, $"0x{key:X8}");
        int rowNumber = key & ((1 << TableShift) - 1);

        if (rowNumber == 0)
        {
            return new(name, Container: null, [], MissingFile: null);
        }

        if (key >>> TableShift == (int)TableIndex.AssemblyRef)
        {
            AssemblyReference reference = metadata.GetAssemblyReference(MetadataTokens.AssemblyReferenceHandle(rowNumber));
            AssemblyName assemblyName = reference.GetAssemblyName();
            List<string[]> referenceFacts = [["token", token], ["version", reference.Version.ToString()]];

            return new(assemblyName.FullName, Container: null, referenceFacts, findMissingFile(metadata.GetString(reference.Name)));
        }

        ManifestResource resource = metadata.GetManifestResource(MetadataTokens.ManifestResourceHandle(rowNumber));
        List<string[]> facts = [["token", token]];
        if (ReadLength(file, resource) is { } length)
        {
            facts.Add(["size", WriteSize(length)]);
        }

        facts.Add(["visibility", IsPublic(resource) ? "public" : "private"]);

        return new(metadata.GetString(resource.Name), Container: null, facts, MissingFile: null);
    }

    private static int GetKey(TableIndex table)
    {
        return (int)table << TableShift;
    }

    private static bool IsPublic(ManifestResource resource)
    {
        return (resource.Attributes & ManifestResourceAttributes.VisibilityMask) == ManifestResourceAttributes.Public;
    }

    // reads the length that ECMA-335 II.24.2.4 puts before an embedded resource's bytes, and none for a resource in
    // another file, because the file doesn't have that resource's bytes, or for a resource whose bytes run past the
    // resources directory
    private static int? ReadLength(MetadataFile file, ManifestResource resource)
    {
        if (!resource.Implementation.IsNil || file is not PEFile { Reader.PEHeaders.CorHeader: { } header } peFile)
        {
            return null;
        }

        DirectoryEntry directory = header.ResourcesDirectory;
        if (resource.Offset > directory.Size - sizeof(int))
        {
            return null;
        }

        PEMemoryBlock block = peFile.Reader.GetSectionData(directory.RelativeVirtualAddress + (int)resource.Offset);
        if (block.Length < sizeof(int))
        {
            return null;
        }

        int length = block.GetReader().ReadInt32();

        return length >= 0 && resource.Offset + sizeof(int) + length <= directory.Size ? length : null;
    }

    private static string WriteSize(long length)
    {
        return string.Create(CultureInfo.InvariantCulture, $"{length:N0} bytes");
    }
}
