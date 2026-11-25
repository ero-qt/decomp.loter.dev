using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using System.Reflection.Metadata;
using System.Reflection.Metadata.Ecma335;
using System.Reflection.PortableExecutable;
using LibCpp2IL.BinaryStructures;
using LibCpp2IL.Metadata;

namespace Decomp.Il2Cpp;

/// <summary>
///     Writes a module of 1 assembly of the game in LibCpp2IL's state as the bytes of a PE file, which the decompiler
///     reads like an assembly without code. The module has every type of the assembly in the metadata's order, so a type
///     definition's row is its index in the image plus 1, but only the opened type has its fields, methods, properties
///     and events, in the metadata's order too. The other types only get their base type and their virtual methods. A
///     type of another assembly is a type reference to that assembly by its image's name.
/// </summary>
internal sealed partial class StubModule
{
    private readonly GameIndex _index;
    private readonly int _firstType;
    private readonly int _typeCount;
    private readonly int _imageIndex;
    private readonly MetadataBuilder _metadata = new();
    private readonly Dictionary<int, AssemblyReferenceHandle> _assemblies = [];
    private readonly Dictionary<int, TypeReferenceHandle> _typeReferences = [];
    private readonly List<(EntityHandle Owner, int Number, GenericParameterAttributes Attributes, string Name)> _genericParameters = [];
    private readonly List<(EntityHandle Association, MethodSemanticsAttributes Kind, MethodDefinitionHandle Method)> _semantics = [];
    private TypeReferenceHandle? _unknownType;
    private readonly List<int> _methodIndexes = [];
    // the opened type's base types, or null for a module without an opened type, which keeps every virtual method
    private HashSet<int>? _baseTypes;
    private int _nextMethod = 1;
    private int _nextParameter = 1;

    private StubModule(GameIndex index, int imageIndex)
    {
        Il2CppImageDefinition image = index.Metadata.imageDefinitions[imageIndex];
        _index = index;
        _imageIndex = imageIndex;
        _firstType = image.firstTypeIndex.Value;
        _typeCount = (int)image.typeCount;
    }

    /// <summary>
    ///     Writes the module of an image with the members of 1 of its types, or of none for -1, and returns it with the
    ///     index of each method row's method among all methods of the game.
    /// </summary>
    public static (byte[] Bytes, int[] MethodIndexes) Write(GameIndex index, int imageIndex, int openedType)
    {
        StubModule module = new(index, imageIndex);
        byte[] bytes = module.Build(openedType);

        return (bytes, [.. module._methodIndexes]);
    }

    /// <summary>
    ///     Returns the name of an image's assembly, which is the image's name without <c>.dll</c>.
    /// </summary>
    public static string NameAssembly(Il2CppImageDefinition image)
    {
        string name = image.Name ?? "";

        return name.EndsWith(".dll", StringComparison.OrdinalIgnoreCase) ? name[..^4] : name;
    }

    private byte[] Build(int openedType)
    {
        Il2CppImageDefinition image = _index.Metadata.imageDefinitions[_imageIndex];
        string assemblyName = NameAssembly(image);

        _metadata.AddModule(0, _metadata.GetOrAddString(image.Name ?? ""), _metadata.GetOrAddGuid(Guid.Empty), default, default);
        _metadata.AddAssembly(_metadata.GetOrAddString(assemblyName), new(0, 0, 0, 0), default, default, 0, AssemblyHashAlgorithm.None);

        _baseTypes = openedType < 0 ? null : ListBaseTypes(openedType);
        AddTypes(openedType);
        AddGenericParameters();
        AddSemantics();

        MetadataRootBuilder root = new(_metadata);
        ManagedPEBuilder builder = new(PEHeaderBuilder.CreateLibraryHeader(), root, new BlobBuilder());
        BlobBuilder output = new();
        builder.Serialize(output);

        return output.ToArray();
    }

    // adds a row for each type of the image with its members, its nesting and its generic parameters
    private void AddTypes(int openedType)
    {
        int nextField = 1;
        for (int row = 1; row <= _typeCount; row++)
        {
            int typeIndex = _firstType + row - 1;
            Il2CppTypeDefinition type = _index.Metadata.typeDefs[typeIndex];
            bool isOpened = typeIndex == openedType;
            Il2CppTypeDefinition? declaringType = type.DeclaringTypeIndex.IsNull ? null : type.DeclaringType;

            EntityHandle baseType = EncodeKindBaseType(typeIndex, type);
            TypeDefinitionHandle handle = _metadata.AddTypeDefinition(
                (TypeAttributes)type.Flags,
                _metadata.GetOrAddString(declaringType is null ? type.Namespace ?? "" : ""),
                _metadata.GetOrAddString(type.Name ?? ""),
                baseType,
                MetadataTokens.FieldDefinitionHandle(nextField),
                MetadataTokens.MethodDefinitionHandle(_nextMethod));

            if (declaringType is not null && _index.TypeIndexes.TryGetValue(declaringType, out int declaringIndex) && !IsNestedInItself(typeIndex))
            {
                _metadata.AddNestedType(handle, MetadataTokens.TypeDefinitionHandle(declaringIndex - _firstType + 1));
            }

            foreach (Il2CppGenericParameter parameter in type.GenericContainer?.GenericParameters ?? [])
            {
                _genericParameters.Add((handle, parameter.genericParameterIndexInOwner, parameter.Attributes, parameter.Name ?? ""));
            }

            if (isOpened)
            {
                AddInterfaces(handle, type);
                AddMembers(handle, typeIndex, type);
                nextField += type.Fields?.Length ?? 0;
            }
            else if (_index.HasBinary && (_baseTypes is null || _baseTypes.Contains(typeIndex)))
            {
                AddVirtualMethods(typeIndex, type);
            }
        }
    }

    // lists the opened type's base types, whose virtual methods the decompiler needs to write `override`, because the
    // virtual methods of every type of a large assembly take long to encode on each read
    private HashSet<int> ListBaseTypes(int openedType)
    {
        HashSet<int> baseTypes = [];
        Il2CppTypeDefinition type = _index.Metadata.typeDefs[openedType];
        while (_index.HasBinary && !type.ParentIndex.IsNull && baseTypes.Count < TypeNames.MaxDepth)
        {
            int baseIndex = FindDefinition(type.RawBaseType);
            if (baseIndex < 0 || !baseTypes.Add(baseIndex))
            {
                break;
            }

            type = _index.Metadata.typeDefs[baseIndex];
        }

        return baseTypes;
    }

    // finds the index of a type's definition, also of a generic type's instance, or -1
    private int FindDefinition(Il2CppType? type)
    {
        Il2CppTypeDefinition? definition = type?.Type switch
        {
            Il2CppTypeEnum.IL2CPP_TYPE_CLASS or Il2CppTypeEnum.IL2CPP_TYPE_VALUETYPE => type.AsClass(),
            Il2CppTypeEnum.IL2CPP_TYPE_GENERICINST => type.GetGenericClass().TypeDefinition,
            _ => null,
        };

        return definition is not null && _index.TypeIndexes.TryGetValue(definition, out int index) ? index : -1;
    }

    // checks whether a type's declaring types lead back to it, which only crafted metadata does, because the decompiler
    // would follow them forever
    private bool IsNestedInItself(int typeIndex)
    {
        Il2CppTypeDefinition type = _index.Metadata.typeDefs[typeIndex];
        for (int depth = 0; depth < TypeNames.MaxDepth && !type.DeclaringTypeIndex.IsNull; depth++)
        {
            type = type.DeclaringType!;
            if (_index.TypeIndexes.GetValueOrDefault(type, -1) == typeIndex)
            {
                return true;
            }
        }

        return !type.DeclaringTypeIndex.IsNull;
    }

    // gives a type its base type from the binary, or else the base type that sets its kind from the metadata's flags
    private EntityHandle EncodeKindBaseType(int typeIndex, Il2CppTypeDefinition type)
    {
        if (_index.HasBinary)
        {
            return EncodeBaseType(type);
        }

        string? baseName = type switch
        {
            { IsInterface: true } => null,
            { IsEnumType: true } => "Enum",
            { IsValueType: true } => "ValueType",
            _ when typeIndex == _index.FindCoreType("Object") => null,
            _ => "Object",
        };
        int baseIndex = baseName is null ? -1 : _index.FindCoreType(baseName);

        return baseIndex < 0 ? default : EncodeDefinition(baseIndex);
    }

    private EntityHandle EncodeBaseType(Il2CppTypeDefinition type)
    {
        Il2CppType? baseType = type.ParentIndex.IsNull ? null : type.RawBaseType;

        return baseType is null ? default : EncodeTypeHandle(baseType);
    }

    private void AddInterfaces(TypeDefinitionHandle handle, Il2CppTypeDefinition type)
    {
        if (!_index.HasBinary)
        {
            return;
        }

        foreach (Il2CppType face in type.RawInterfaces ?? [])
        {
            _metadata.AddInterfaceImplementation(handle, EncodeTypeHandle(face));
        }
    }

    // adds the generic parameters sorted by their owner, which the table needs
    private void AddGenericParameters()
    {
        IEnumerable<(EntityHandle Owner, int Number, GenericParameterAttributes Attributes, string Name)> sorted = _genericParameters
            .OrderBy(parameter => CodedIndex.TypeOrMethodDef(parameter.Owner))
            .ThenBy(parameter => parameter.Number);

        foreach ((EntityHandle owner, int number, GenericParameterAttributes attributes, string name) in sorted)
        {
            _metadata.AddGenericParameter(owner, attributes, _metadata.GetOrAddString(name), number);
        }
    }

    // adds the accessors of the properties and events sorted by their owner, which the table needs
    private void AddSemantics()
    {
        foreach ((EntityHandle association, MethodSemanticsAttributes kind, MethodDefinitionHandle method) in _semantics
            .OrderBy(semantic => CodedIndex.HasSemantics(semantic.Association)))
        {
            _metadata.AddMethodSemantics(association, kind, method);
        }
    }

    /// <summary>
    ///     Returns the handle of a type definition of the game, a definition in this module or a reference to the
    ///     definition's assembly, through its declaring type for a nested type.
    /// </summary>
    private EntityHandle EncodeDefinition(int typeIndex, int depth = 0)
    {
        if (_index.ImageOfType[typeIndex] == _imageIndex)
        {
            return MetadataTokens.TypeDefinitionHandle(typeIndex - _firstType + 1);
        }

        if (_typeReferences.TryGetValue(typeIndex, out TypeReferenceHandle reference))
        {
            return reference;
        }

        Il2CppTypeDefinition type = _index.Metadata.typeDefs[typeIndex];
        Il2CppTypeDefinition? declaringType = type.DeclaringTypeIndex.IsNull || depth >= TypeNames.MaxDepth ? null : type.DeclaringType;
        EntityHandle scope = declaringType is not null && _index.TypeIndexes.TryGetValue(declaringType, out int declaringIndex)
            ? EncodeDefinition(declaringIndex, depth + 1)
            : EncodeAssembly(_index.ImageOfType[typeIndex]);

        reference = _metadata.AddTypeReference(
            scope,
            _metadata.GetOrAddString(declaringType is null ? type.Namespace ?? "" : ""),
            _metadata.GetOrAddString(type.Name ?? ""));
        _typeReferences.Add(typeIndex, reference);

        return reference;
    }

    private AssemblyReferenceHandle EncodeAssembly(int imageIndex)
    {
        if (!_assemblies.TryGetValue(imageIndex, out AssemblyReferenceHandle handle))
        {
            string name = NameAssembly(_index.Metadata.imageDefinitions[imageIndex]);
            handle = _metadata.AddAssemblyReference(_metadata.GetOrAddString(name), new(0, 0, 0, 0), default, default, 0, default);
            _assemblies.Add(imageIndex, handle);
        }

        return handle;
    }

    // stands for a type that the stubs don't encode, as a type that the decompiler doesn't find
    private TypeReferenceHandle EncodeUnknownType()
    {
        _unknownType ??= _metadata.AddTypeReference(EntityHandle.ModuleDefinition, default, _metadata.GetOrAddString(UnknownTypeName));

        return _unknownType.Value;
    }
}
