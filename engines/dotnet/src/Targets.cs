using ICSharpCode.Decompiler.Documentation;
using ICSharpCode.Decompiler.Metadata;
using ICSharpCode.Decompiler.TypeSystem;
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Reflection.Metadata;
using System.Reflection.Metadata.Ecma335;
using System.Text.RegularExpressions;

namespace Decomp.Dotnet;

/// <summary>
///     Finds the targets of the symbols that a document of a file uses: <c>&lt;file id&gt;:&lt;key in hex&gt;</c> for a
///     row of an open file and <c>|&lt;assembly name&gt;|&lt;ID string&gt;</c> for a symbol outside the open files.
/// </summary>
/// <param name="file">The file whose document uses the symbols.</param>
/// <param name="findFileId">Finds the id of an open file, or <see langword="null"/> for a file that isn't open.</param>
/// <param name="hasRow">Checks whether the rows of the open file with an id have a key.</param>
/// <param name="findHiddenViews">Finds the views that hide the row with a key in the open file with an id.</param>
internal sealed partial class Targets(
    MetadataFile file,
    Func<MetadataFile, int?> findFileId,
    Func<int, int, bool> hasRow,
    Func<int, int, int> findHiddenViews)
{
    // top-level type name -> the name of the assembly that the file references it from, read on the first type from
    // another assembly
    private Dictionary<string, string>? _referencedTypeAssemblies;

    // the ID string of a method on a generic instance -> the definition's, both without the kind, read on the first
    // such method from another assembly
    private Dictionary<string, string>? _genericReferenceIds;

    /// <summary>
    ///     Reads the file id and the key of a row target, like <c>1:6000012</c>.
    /// </summary>
    public static (int FileId, int Key)? ParseRowTarget(string target)
    {
        Match match = RowTargetPattern().Match(target);

        return match.Success && int.TryParse(match.Groups[1].ValueSpan, CultureInfo.InvariantCulture, out int fileId)
            ? (fileId, (int)uint.Parse(match.Groups[2].ValueSpan, NumberStyles.HexNumber, CultureInfo.InvariantCulture))
            : null;
    }

    /// <summary>
    ///     Reads the assembly name and the ID string of an outside target, like <c>|Shapes|M:Shapes.Shape.Area</c>.
    /// </summary>
    public static (string AssemblyName, string IdString)? ParseOutsideTarget(string target)
    {
        int separator = target.IndexOf('|', 1);

        return target.StartsWith('|') && separator > 0 ? (target[1..separator], target[(separator + 1)..]) : null;
    }

    /// <summary>
    ///     Checks whether a target is a row target whose row a view hides, with the view's bit in the hidden views.
    /// </summary>
    public bool IsHiddenIn(string target, int view)
    {
        return ParseRowTarget(target) is var (fileId, key) && (findHiddenViews(fileId, key) & view) != 0;
    }

    public static string FormatRowTarget(int fileId, int key)
    {
        return string.Create(CultureInfo.InvariantCulture, $"{fileId}:{key:x}");
    }

    /// <summary>
    ///     Finds the target of a type, or <see langword="null"/> for a type parameter, which only its declaring type or
    ///     method has.
    /// </summary>
    public string? FindTypeTarget(IType type)
    {
        return type.GetDefinitionOrUnknown() switch
        {
            ITypeDefinition definition => FindTarget(definition),
            { Kind: TypeKind.Unknown } unknown => FindOutsideTarget(unknown, $"T:{IdStringProvider.GetTypeName(unknown)}"),
            _ => null,
        };
    }

    /// <summary>
    ///     Finds the target of a type or a member through its definition, because a member of a generic type that the
    ///     text uses with type arguments is a copy of the definition. A symbol of an open file without a row doesn't
    ///     get a target.
    /// </summary>
    public string? FindTarget(IEntity entity)
    {
        IEntity definition = entity is IMember member ? member.MemberDefinition : entity;

        if (definition.ParentModule is MetadataModule module && findFileId(module.MetadataFile) is { } fileId)
        {
            int key = MetadataTokens.GetToken(definition.MetadataToken);

            return !definition.MetadataToken.IsNil && hasRow(fileId, key) ? FormatRowTarget(fileId, key) : null;
        }

        return definition switch
        {
            ITypeDefinition type => FindOutsideTarget(type, $"T:{IdStringProvider.GetTypeName(type)}"),
            IMember outsideMember when outsideMember.DeclaringType.GetDefinitionOrUnknown() is { } declaringType
                => FindOutsideTarget(declaringType, WriteIdString(outsideMember, declaringType)),
            _ => null,
        };
    }

    // writes the ID string of a member from its signature, because the decompiler writes ID strings only from metadata,
    // which a member of an assembly that isn't open doesn't have, and takes a method of a generic instance from the
    // file's method reference, because the decompiler puts the type arguments into its parameters
    private string WriteIdString(IMember member, ITypeDefinitionOrUnknown declaringType)
    {
        char kind = member switch { IField => 'F', IProperty => 'P', IEvent => 'E', _ => 'M' };
        string typeParameters = member is IMethod { TypeParameters.Count: > 0 and int count } ? $"``{count}" : "";
        string parameters = member is IParameterizedMember { Parameters: [_, ..] list }
            ? $"({string.Join(',', list.Select(parameter => IdStringProvider.GetTypeName(parameter.Type)))})"
            : "";
        string name = member.Name.Replace('.', '#');
        string instance = $"{IdStringProvider.GetTypeName(member.DeclaringType)}.{name}{typeParameters}{parameters}";

        _genericReferenceIds ??= GenericReferenceIds.Read(file.Metadata);
        if (member is IMethod && member.DeclaringType.TypeArguments.Count > 0 && _genericReferenceIds.TryGetValue(instance, out string? definition))
        {
            return $"{kind}:{definition}";
        }

        return $"{kind}:{IdStringProvider.GetTypeName(declaringType)}.{name}{typeParameters}{parameters}";
    }

    // doesn't write a target for an assembly name with `|`, because ParseOutsideTarget ends the name at the first `|`
    private string? FindOutsideTarget(ITypeDefinitionOrUnknown type, string idString)
    {
        string assemblyName = FindOutsideAssemblyName(type);

        return assemblyName.Contains('|') ? null : $"|{assemblyName}|{idString}";
    }

    // takes the assembly's name from the file's type reference because the decompiler doesn't have an assembly for a
    // type of an assembly that isn't open, and the core library's name for a type without a type reference because only
    // the core library has the types that an attribute uses without their assembly's name
    private string FindOutsideAssemblyName(ITypeDefinitionOrUnknown type)
    {
        Dictionary<string, string> assemblies = ReadReferencedTypeAssemblies();

        return assemblies.TryGetValue(type.FullTypeName.TopLevelTypeName.ReflectionName, out string? name)
            ? name
            : assemblies.GetValueOrDefault("System.Object", "");
    }

    private Dictionary<string, string> ReadReferencedTypeAssemblies()
    {
        if (_referencedTypeAssemblies is not null)
        {
            return _referencedTypeAssemblies;
        }

        MetadataReader metadata = file.Metadata;
        _referencedTypeAssemblies = [];

        foreach (TypeReferenceHandle handle in metadata.TypeReferences)
        {
            // skips a type reference that the metadata reader can't read, so a broken row costs only its target
            try
            {
                TypeReference reference = metadata.GetTypeReference(handle);
                if (reference.ResolutionScope.Kind == HandleKind.AssemblyReference)
                {
                    AssemblyReferenceHandle assemblyHandle = (AssemblyReferenceHandle)reference.ResolutionScope;
                    System.Reflection.Metadata.AssemblyReference assembly = metadata.GetAssemblyReference(assemblyHandle);
                    TopLevelTypeName typeName = new(metadata.GetString(reference.Namespace), metadata.GetString(reference.Name));
                    _referencedTypeAssemblies.TryAdd(typeName.ReflectionName, metadata.GetString(assembly.Name));
                }
            }
            catch (BadImageFormatException)
            {
            }
        }

        return _referencedTypeAssemblies;
    }

    [GeneratedRegex("^([0-9]+):([0-9a-f]{1,8})$")]
    private static partial Regex RowTargetPattern();
}
