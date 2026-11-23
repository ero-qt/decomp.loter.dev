using System;
using System.Collections.Generic;
using System.Diagnostics.CodeAnalysis;
using System.Linq;
using LibCpp2IL.BinaryStructures;
using LibCpp2IL.Metadata;

namespace Decomp.Il2Cpp;

/// <summary>
///     Represents a type in a signature by its C# name and the index of the type definition that a click on the name
///     opens, or -1 for a type without one.
/// </summary>
internal sealed record TypeReference(
    string Name,
    int Definition);

/// <summary>
///     Writes the binary's types the way C# writes them, like <c>List&lt;int&gt;[]</c>, with the type definitions'
///     indexes.
/// </summary>
internal sealed class TypeNames(Dictionary<Il2CppTypeDefinition, int> typeIndexes)
{
    /// <summary>
    ///     The deepest nesting of types and of types in types that the engine follows, because crafted metadata can
    ///     nest a type in itself.
    /// </summary>
    public const int MaxDepth = 64;

    // the reference of each type that `Write` wrote, because a game's members share their types
    private readonly Dictionary<Il2CppType, TypeReference> _written = new(ReferenceEqualityComparer.Instance);

    private static readonly Dictionary<Il2CppTypeEnum, string> _keywords = new()
    {
        [Il2CppTypeEnum.IL2CPP_TYPE_VOID] = "void",
        [Il2CppTypeEnum.IL2CPP_TYPE_BOOLEAN] = "bool",
        [Il2CppTypeEnum.IL2CPP_TYPE_CHAR] = "char",
        [Il2CppTypeEnum.IL2CPP_TYPE_I1] = "sbyte",
        [Il2CppTypeEnum.IL2CPP_TYPE_U1] = "byte",
        [Il2CppTypeEnum.IL2CPP_TYPE_I2] = "short",
        [Il2CppTypeEnum.IL2CPP_TYPE_U2] = "ushort",
        [Il2CppTypeEnum.IL2CPP_TYPE_I4] = "int",
        [Il2CppTypeEnum.IL2CPP_TYPE_U4] = "uint",
        [Il2CppTypeEnum.IL2CPP_TYPE_I8] = "long",
        [Il2CppTypeEnum.IL2CPP_TYPE_U8] = "ulong",
        [Il2CppTypeEnum.IL2CPP_TYPE_R4] = "float",
        [Il2CppTypeEnum.IL2CPP_TYPE_R8] = "double",
        [Il2CppTypeEnum.IL2CPP_TYPE_STRING] = "string",
        [Il2CppTypeEnum.IL2CPP_TYPE_OBJECT] = "object",
        [Il2CppTypeEnum.IL2CPP_TYPE_I] = "IntPtr",
        [Il2CppTypeEnum.IL2CPP_TYPE_U] = "UIntPtr",
        [Il2CppTypeEnum.IL2CPP_TYPE_TYPEDBYREF] = "TypedReference",
    };

    /// <summary>
    ///     Finds C#'s keyword or name for a built-in type, like <c>int</c> or <c>IntPtr</c>.
    /// </summary>
    public static bool TryGetKeyword(Il2CppTypeEnum type, [NotNullWhen(true)] out string? keyword)
    {
        return _keywords.TryGetValue(type, out keyword);
    }

    /// <summary>
    ///     Writes a type's reference, with <c>ref </c> before a type that a parameter takes by reference.
    /// </summary>
    public TypeReference Write(Il2CppType type)
    {
        if (!_written.TryGetValue(type, out TypeReference? reference))
        {
            reference = Write(type, 0);
            _written[type] = reference;
        }

        return reference;
    }

    private TypeReference Write(Il2CppType type, int depth)
    {
        TypeReference reference = depth < MaxDepth ? WriteValue(type, depth + 1) : new(type.Type.ToString(), -1);

        return type.Byref == 1 ? reference with { Name = $"ref {reference.Name}" } : reference;
    }

    /// <summary>
    ///     Writes a type definition the way C# refers to it, with its declaring types and its generic parameters, like
    ///     <c>Dictionary&lt;TKey, TValue&gt;.Entry</c>.
    /// </summary>
    public string WriteDefinitionName(Il2CppTypeDefinition definition, IEnumerable<string>? genericArguments = null, int depth = 0)
    {
        string name = (definition.Name ?? "").Split('`')[0];
        List<string> arguments = (genericArguments ?? ListGenericParameters(definition)).ToList();
        Il2CppTypeDefinition? declaringType = depth < MaxDepth ? definition.DeclaringType : null;
        int outerCount = declaringType is null ? 0 : Math.Min(ListGenericParameters(declaringType).Count, arguments.Count);
        List<string> ownArguments = arguments[outerCount..];
        string generics = ownArguments.Count > 0 ? $"<{string.Join(", ", ownArguments)}>" : "";

        return declaringType is null
            ? $"{name}{generics}"
            : $"{WriteDefinitionName(declaringType, arguments[..outerCount], depth + 1)}.{name}{generics}";
    }

    /// <summary>
    ///     Lists a type's own generic parameters, without the parameters of its declaring types, which the metadata
    ///     repeats first on a nested type.
    /// </summary>
    public static List<string> ListOwnGenericParameters(Il2CppTypeDefinition definition)
    {
        int outerCount = definition.DeclaringType is null ? 0 : ListGenericParameters(definition.DeclaringType).Count;

        return ListGenericParameters(definition).Skip(outerCount).ToList();
    }

    private TypeReference WriteValue(Il2CppType type, int depth)
    {
        if (_keywords.TryGetValue(type.Type, out string? keyword))
        {
            return new(keyword, -1);
        }

        return type.Type switch
        {
            Il2CppTypeEnum.IL2CPP_TYPE_CLASS or Il2CppTypeEnum.IL2CPP_TYPE_VALUETYPE => WriteDefinition(type.AsClass()),
            Il2CppTypeEnum.IL2CPP_TYPE_GENERICINST => WriteGenericInstance(type.GetGenericClass(), depth),
            Il2CppTypeEnum.IL2CPP_TYPE_SZARRAY => WriteWithSuffix(type.GetEncapsulatedType(), "[]", depth),
            Il2CppTypeEnum.IL2CPP_TYPE_ARRAY => WriteWithSuffix(type.GetArrayElementType(), $"[{new string(',', type.GetArrayRank() - 1)}]", depth),
            Il2CppTypeEnum.IL2CPP_TYPE_PTR => WriteWithSuffix(type.GetEncapsulatedType(), "*", depth),
            Il2CppTypeEnum.IL2CPP_TYPE_VAR or Il2CppTypeEnum.IL2CPP_TYPE_MVAR => new(type.GetGenericParamName(), -1),
            _ => new(type.Type.ToString(), -1),
        };
    }

    private TypeReference WriteDefinition(Il2CppTypeDefinition definition)
    {
        return new(WriteDefinitionName(definition), typeIndexes.GetValueOrDefault(definition, -1));
    }

    private TypeReference WriteGenericInstance(Il2CppGenericClass generic, int depth)
    {
        IEnumerable<string> arguments = generic.Context.ClassInst.Types.Select(argument => Write(argument, depth).Name);

        return new(WriteDefinitionName(generic.TypeDefinition, arguments), typeIndexes.GetValueOrDefault(generic.TypeDefinition, -1));
    }

    // keeps the element's definition, so a click on `Circle[]` opens `Circle`
    private TypeReference WriteWithSuffix(Il2CppType element, string suffix, int depth)
    {
        TypeReference reference = Write(element, depth);

        return reference with { Name = $"{reference.Name}{suffix}" };
    }

    private static List<string> ListGenericParameters(Il2CppTypeDefinition definition)
    {
        return ModelWriter.ListGenericParameters(definition.GenericContainer);
    }
}
