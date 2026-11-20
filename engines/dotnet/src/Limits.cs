using System;
using System.Collections.Generic;
using System.Reflection.Metadata;
using System.Reflection.Metadata.Ecma335;

namespace Decomp.Dotnet;

/// <summary>
///     Limits what a hostile assembly can make the engine do.
/// </summary>
internal static class Limits
{
    /// <summary>
    ///     Limits nesting to 256 levels because under Bun the worker takes about 0.5 s for a call at 256 levels, 5 s
    ///     and 238 MB at 1,000 levels and overflows the stack at 1,500.
    /// </summary>
    public const int MaxNestingDepth = 256;

    /// <summary>
    ///     Follows a type through at most 16 assemblies that forward it, like the decompiler, because a broken chain of
    ///     forwarders can go on without end.
    /// </summary>
    public const int MaxForwarderHops = 16;

    /// <summary>
    ///     Stops a file's scan before the body that passes 8,000,000 bytes of IL, about 5 times the 1,483,174 of the
    ///     browser runtime's System.Private.CoreLib, because the scan keeps the instructions with a token of every body
    ///     that it reads.
    /// </summary>
    public const int MaxIlBytes = 8_000_000;

    /// <summary>
    ///     Lists at most 50,000 strings of a file, about 8 times the 5,986 of ICSharpCode.Decompiler, because the
    ///     worker sends every string to the page.
    /// </summary>
    public const int MaxStrings = 50_000;

    /// <summary>
    ///     Cuts a string after 1,000 characters, more than twice the 429 of System.Private.CoreLib's longest string,
    ///     because quick open shows a string on 1 line.
    /// </summary>
    public const int MaxStringLength = 1_000;

    private const string CycleError = "has types that are nested in each other.";

    private static readonly string _depthError = $"has types that are nested more than {MaxNestingDepth} levels deep.";

    /// <summary>
    ///     Finds the error of types that are nested in a cycle or deeper than <see cref="MaxNestingDepth"/>.
    /// </summary>
    /// <returns>
    ///     The error without the file's name, or <see langword="null"/> for nesting that the engine reads.
    /// </returns>
    /// <exception cref="BadImageFormatException">An enclosing type is past the end of the TypeDef table.</exception>
    public static string? FindNestingError(MetadataReader metadata)
    {
        foreach (TypeDefinitionHandle type in metadata.TypeDefinitions)
        {
            HashSet<TypeDefinitionHandle> enclosingTypes = [];

            for (TypeDefinitionHandle enclosing = GetDeclaringType(metadata, type);
                 !enclosing.IsNil;
                 enclosing = GetDeclaringType(metadata, enclosing))
            {
                // throws for a row past the table's end because the metadata reader reads the row without a check
                if (MetadataTokens.GetRowNumber(enclosing) > metadata.TypeDefinitions.Count)
                {
                    throw new BadImageFormatException();
                }

                // refuses a cycle because the decompiler builds a nested type's name from its enclosing type's name and
                // overflows the stack on a cycle
                if (!enclosingTypes.Add(enclosing))
                {
                    return CycleError;
                }

                if (enclosingTypes.Count > MaxNestingDepth)
                {
                    return _depthError;
                }
            }
        }

        // type -> the levels of nested types below it, or -1 while the check walks its nested types
        Dictionary<TypeDefinitionHandle, int> levels = [];

        foreach (TypeDefinitionHandle type in metadata.TypeDefinitions)
        {
            if (FindNestedTypeError(metadata, type, depth: 0, levels) is { } error)
            {
                return error;
            }
        }

        return null;
    }

    // checks the nesting again from the outside in because the decompiler walks the nested types of a type that it
    // writes, which the metadata reader finds with another lookup of the NestedClass rows than the enclosing type
    private static string? FindNestedTypeError(
        MetadataReader metadata,
        TypeDefinitionHandle type,
        int depth,
        Dictionary<TypeDefinitionHandle, int> levels)
    {
        if (levels.TryGetValue(type, out int knownLevels))
        {
            return knownLevels < 0 ? CycleError : FindDepthError(depth + knownLevels);
        }

        if (FindDepthError(depth) is { } depthError)
        {
            return depthError;
        }

        levels.Add(type, -1);
        int typeLevels = 0;

        foreach (TypeDefinitionHandle nestedType in metadata.GetTypeDefinition(type).GetNestedTypes())
        {
            // skips a nested type that the TypeDef table doesn't have because the decompiler throws for it on its own
            if (nestedType.IsNil || MetadataTokens.GetRowNumber(nestedType) > metadata.TypeDefinitions.Count)
            {
                continue;
            }

            if (FindNestedTypeError(metadata, nestedType, depth + 1, levels) is { } error)
            {
                return error;
            }

            typeLevels = Math.Max(typeLevels, levels[nestedType] + 1);
        }

        levels[type] = typeLevels;

        return null;
    }

    private static string? FindDepthError(int depth)
    {
        return depth > MaxNestingDepth ? _depthError : null;
    }

    private static TypeDefinitionHandle GetDeclaringType(MetadataReader metadata, TypeDefinitionHandle type)
    {
        return metadata.GetTypeDefinition(type).GetDeclaringType();
    }
}
