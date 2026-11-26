using System;
using System.Collections.Generic;
using System.Linq;
using LibCpp2IL;
using LibCpp2IL.BinaryStructures;
using LibCpp2IL.Metadata;

namespace Decomp.Il2Cpp;

/// <summary>
///     Represents an entry of a class's runtime generic context by its kind in <see cref="Il2CppRGCTXDataType" />, with
///     the index of the class of a class's entry among the game's classes, or -1.
/// </summary>
internal sealed record RgctxModel(
    int Kind,
    int Class);

/// <summary>
///     Represents a class that code reaches through a metadata global, like the class of a generic type's instance
///     <c>Singleton&lt;Circle&gt;</c>, with its C# text, its type definition's index and its type arguments. The code that
///     a generic type's instances share finds the classes of its own instance in the entries of the class's runtime
///     generic context. The class of an entry doesn't list its own entries.
/// </summary>
internal sealed record ClassModel(
    string Text,
    int Definition,
    List<TypeReference> Arguments,
    List<RgctxModel> Rgctx);

/// <summary>
///     Collects the classes of a game's metadata globals once each, with the entries of their runtime generic contexts
///     for the arguments of each instance.
/// </summary>
internal sealed class GenericClasses(TypeNames names, Dictionary<Il2CppTypeDefinition, int> typeIndexes)
{
    private readonly Dictionary<string, int> _indexes = [];
    private readonly HashSet<int> _withRgctx = [];

    public List<ClassModel> Classes { get; } = [];

    /// <summary>
    ///     Adds the class of a generic type's instance, like the type of a TypeInfo global, and returns its index, or -1
    ///     for a type that isn't an instance with arguments that the engine follows.
    /// </summary>
    public int AddInstance(Il2CppType type)
    {
        if (type.Type != Il2CppTypeEnum.IL2CPP_TYPE_GENERICINST)
        {
            return -1;
        }

        Il2CppGenericClass generic = type.GetGenericClass();

        return Add(generic.TypeDefinition, generic.Context.ClassInst.Types, true);
    }

    /// <summary>
    ///     Adds the class of a generic method's instance, like the class <c>Singleton&lt;Circle&gt;</c> of
    ///     <c>Singleton&lt;Circle&gt;.get_Instance</c>, and returns its index, or -1 for a method of a type that isn't
    ///     generic.
    /// </summary>
    public int AddMethodClass(Il2CppMethodSpec spec)
    {
        Il2CppTypeDefinition? owner = spec.MethodDefinition?.DeclaringType;

        return spec.classIndexIndex < 0 || owner is null ? -1 : Add(owner, spec.GenericClassInst!.Types, true);
    }

    private int Add(Il2CppTypeDefinition definition, Il2CppType[] arguments, bool withRgctx)
    {
        GlobalText text = new(typeIndexes);
        text.AddDefinition(definition);
        text.AddArguments(arguments, argument => text.AddType(argument));

        string key = text.ToString();
        if (!_indexes.TryGetValue(key, out int index))
        {
            index = Classes.Count;
            _indexes[key] = index;
            List<TypeReference> written = arguments.Select(argument => names.Write(argument)).ToList();
            Classes.Add(new(key, typeIndexes.GetValueOrDefault(definition, -1), written, []));
        }

        // adds the entries after the class itself, because an entry can be the class's own instance
        if (withRgctx && _withRgctx.Add(index))
        {
            foreach (Il2CppRGCTXDefinition? entry in ListRgctx(definition))
            {
                Classes[index].Rgctx.Add(WriteEntry(entry, arguments));
            }
        }

        return index;
    }

    // lists no entries for a type whose entries LibCpp2IL can't read, because it throws plain exceptions for any
    // misread and leaves null entries for a code gen module whose entries it couldn't read
    private static Il2CppRGCTXDefinition?[] ListRgctx(Il2CppTypeDefinition definition)
    {
        try
        {
            return definition.RgctXs;
        }
        catch (Exception exception) when (exception is not OutOfMemoryException)
        {
            return [];
        }
    }

    private RgctxModel WriteEntry(Il2CppRGCTXDefinition? entry, Il2CppType[] arguments)
    {
        if (entry is null)
        {
            return new(0, -1);
        }

        if (entry.type != Il2CppRGCTXDataType.IL2CPP_RGCTX_DATA_CLASS)
        {
            return new((int)entry.type, -1);
        }

        try
        {
            Il2CppType type = LibCpp2IlMain.Binary!.GetType(Il2CppVariableWidthIndex<Il2CppType>.MakeTemporaryForFixedWidthUsage(entry.TypeIndex));
            (Il2CppTypeDefinition Definition, Il2CppType[] Arguments)? resolved = Resolve(type, arguments);

            return new((int)entry.type, resolved is { } found ? Add(found.Definition, found.Arguments, false) : -1);
        }
        catch (Exception exception) when (exception is not OutOfMemoryException)
        {
            return new((int)entry.type, -1);
        }
    }

    /// <summary>
    ///     Finds the class that an entry's type is for an instance's arguments, by the type definition and the
    ///     arguments of the class, or null for a type that the engine doesn't follow, like an array or a generic type
    ///     whose argument nests a parameter.
    /// </summary>
    private static (Il2CppTypeDefinition Definition, Il2CppType[] Arguments)? Resolve(Il2CppType type, Il2CppType[] arguments)
    {
        switch (type.Type)
        {
            case Il2CppTypeEnum.IL2CPP_TYPE_CLASS or Il2CppTypeEnum.IL2CPP_TYPE_VALUETYPE:
                return (type.AsClass(), []);
            case Il2CppTypeEnum.IL2CPP_TYPE_VAR:
                Il2CppType? argument = Substitute(type, arguments);

                return argument is null ? null : Resolve(argument, []);
            case Il2CppTypeEnum.IL2CPP_TYPE_GENERICINST:
                Il2CppGenericClass generic = type.GetGenericClass();
                List<Il2CppType> substituted = [];
                foreach (Il2CppType nested in generic.Context.ClassInst.Types)
                {
                    Il2CppType? found = Substitute(nested, arguments);
                    if (found is null)
                    {
                        return null;
                    }

                    substituted.Add(found);
                }

                return (generic.TypeDefinition, substituted.ToArray());
            default:
                return null;
        }
    }

    // returns the argument of a class's parameter, a type without parameters as it is, or null for a type that nests
    // a parameter, like `List<T>`
    private static Il2CppType? Substitute(Il2CppType type, Il2CppType[] arguments)
    {
        if (type.Type == Il2CppTypeEnum.IL2CPP_TYPE_VAR)
        {
            Il2CppGenericParameter parameter = LibCpp2IlMain.TheMetadata!.GetGenericParameterFromIndex(type.Data.GenericParameterIndex);
            int number = parameter.genericParameterIndexInOwner;

            return number < arguments.Length ? arguments[number] : null;
        }

        return HasParameter(type, 0) ? null : type;
    }

    private static bool HasParameter(Il2CppType type, int depth)
    {
        if (depth > TypeNames.MaxDepth)
        {
            return true;
        }

        return type.Type switch
        {
            Il2CppTypeEnum.IL2CPP_TYPE_VAR or Il2CppTypeEnum.IL2CPP_TYPE_MVAR => true,
            Il2CppTypeEnum.IL2CPP_TYPE_GENERICINST => type.GetGenericClass().Context.ClassInst.Types.Any(nested => HasParameter(nested, depth + 1)),
            Il2CppTypeEnum.IL2CPP_TYPE_SZARRAY or Il2CppTypeEnum.IL2CPP_TYPE_PTR => HasParameter(type.GetEncapsulatedType(), depth + 1),
            Il2CppTypeEnum.IL2CPP_TYPE_ARRAY => HasParameter(type.GetArrayElementType(), depth + 1),
            _ => false,
        };
    }
}
