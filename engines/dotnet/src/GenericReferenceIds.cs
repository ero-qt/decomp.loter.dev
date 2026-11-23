using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using System.Reflection.Metadata;
using System.Reflection.Metadata.Ecma335;

namespace Decomp.Dotnet;

/// <summary>
///     Writes the ID strings of the methods that a file calls on instances of generic types, both with the type
///     arguments in place of the type parameters, like <c>Lib.Box{System.Int32}.Put(System.Int32)</c>, and like the
///     definition, like <c>Lib.Box`1.Put(`0)</c>. The decompiler's method of a type outside the open files only has the
///     first, because it puts the type arguments into the parameters.
/// </summary>
internal static class GenericReferenceIds
{
    /// <summary>
    ///     Maps the ID string with the type arguments to the definition's, both without the kind, for each method
    ///     reference whose parent is a generic instance. Leaves out a reference that the engine can't read and a pair
    ///     of references with the same ID string but different definitions.
    /// </summary>
    public static Dictionary<string, string> Read(MetadataReader metadata)
    {
        Dictionary<string, string> definitions = [];
        HashSet<string> ambiguous = [];

        foreach (MemberReferenceHandle handle in metadata.MemberReferences)
        {
            if (Write(metadata, metadata.GetMemberReference(handle)) is not var (instance, definition))
            {
                continue;
            }

            if (!definitions.TryAdd(instance, definition) && definitions[instance] != definition)
            {
                ambiguous.Add(instance);
            }
        }

        foreach (string instance in ambiguous)
        {
            definitions.Remove(instance);
        }

        return definitions;
    }

    // catches every exception because the signature decoder throws many types for a blob that it can't read
    private static (string Instance, string Definition)? Write(MetadataReader metadata, MemberReference reference)
    {
        if (reference.Parent.Kind != HandleKind.TypeSpecification || reference.GetKind() != MemberReferenceKind.Method)
        {
            return null;
        }

        try
        {
            IdTypeNames names = new(metadata);
            SignatureDecoder<string, ImmutableArray<string>> decoder = new(names, metadata, genericContext: default);
            TypeSpecification parentType = metadata.GetTypeSpecification((TypeSpecificationHandle)reference.Parent);
            BlobReader parent = metadata.GetBlobReader(parentType.Signature);
            if (parent.ReadSignatureTypeCode() != SignatureTypeCode.GenericTypeInstance)
            {
                return null;
            }

            // reads the generic instance of ECMA-335 II.23.2.12: class or valuetype, the generic type and the arguments
            parent.ReadSignatureTypeCode();
            string genericType = names.GetTypeName(parent.ReadTypeHandle());
            ImmutableArray<string>.Builder typeArguments = ImmutableArray.CreateBuilder<string>();
            for (int count = parent.ReadCompressedInteger(); typeArguments.Count < count;)
            {
                typeArguments.Add(decoder.DecodeType(ref parent));
            }

            string name = metadata.GetString(reference.Name).Replace('.', '#');
            MethodSignature<string> definition = reference.DecodeMethodSignature(names, genericContext: default);
            MethodSignature<string> instance = reference.DecodeMethodSignature(names, typeArguments.ToImmutable());
            string typeParameters = definition.GenericParameterCount > 0 ? $"``{definition.GenericParameterCount}" : "";

            return (
                $"{IdTypeNames.Instantiate(genericType, typeArguments.ToImmutable())}.{name}{typeParameters}{WriteParameters(instance)}",
                $"{genericType}.{name}{typeParameters}{WriteParameters(definition)}");
        }
        catch (Exception)
        {
            return null;
        }
    }

    private static string WriteParameters(MethodSignature<string> signature)
    {
        return signature.ParameterTypes.Length > 0 ? $"({string.Join(',', signature.ParameterTypes)})" : "";
    }
}

// writes types like IdStringProvider.GetTypeName, with a class type parameter as its type argument when the generic
// context has the type arguments and as `0 without them
file sealed class IdTypeNames(
    MetadataReader metadata) : ISignatureTypeProvider<string, ImmutableArray<string>>
{
    private int _specificationDepth;

    public static string Instantiate(string genericType, ImmutableArray<string> typeArguments)
    {
        int arity = genericType.LastIndexOf('`');

        return $"{(arity > 0 ? genericType[..arity] : genericType)}{{{string.Join(',', typeArguments)}}}";
    }

    public string GetTypeName(EntityHandle handle)
    {
        return handle.Kind switch
        {
            HandleKind.TypeDefinition => GetTypeFromDefinition(metadata, (TypeDefinitionHandle)handle, rawTypeKind: 0),
            HandleKind.TypeReference => GetTypeFromReference(metadata, (TypeReferenceHandle)handle, rawTypeKind: 0),
            _ => throw new BadImageFormatException("A generic instance's type isn't a TypeDef or a TypeRef."),
        };
    }

    public string GetPrimitiveType(PrimitiveTypeCode typeCode)
    {
        return $"System.{typeCode}";
    }

    public string GetTypeFromDefinition(MetadataReader reader, TypeDefinitionHandle handle, byte rawTypeKind)
    {
        TypeDefinition type = reader.GetTypeDefinition(handle);
        string name = reader.GetString(type.Name);
        TypeDefinitionHandle declaringType = type.GetDeclaringType();

        return declaringType.IsNil
            ? Join(reader.GetString(type.Namespace), name)
            : $"{GetTypeFromDefinition(reader, declaringType, rawTypeKind)}.{name}";
    }

    public string GetTypeFromReference(MetadataReader reader, TypeReferenceHandle handle, byte rawTypeKind)
    {
        return WriteReferenceName(reader, handle, depth: 0);
    }

    public string GetTypeFromSpecification(
        MetadataReader reader,
        ImmutableArray<string> genericContext,
        TypeSpecificationHandle handle,
        byte rawTypeKind)
    {
        // stops at the nesting limit because a TypeSpec can contain itself and the decoder recurses into it, which
        // overflows the stack
        if (_specificationDepth >= Limits.MaxNestingDepth)
        {
            throw new BadImageFormatException("A TypeSpec is nested too deep.");
        }

        _specificationDepth++;

        try
        {
            return reader.GetTypeSpecification(handle).DecodeSignature(this, genericContext);
        }
        finally
        {
            _specificationDepth--;
        }
    }

    public string GetGenericInstantiation(string genericType, ImmutableArray<string> typeArguments)
    {
        return Instantiate(genericType, typeArguments);
    }

    public string GetGenericTypeParameter(ImmutableArray<string> genericContext, int index)
    {
        return !genericContext.IsDefault && index < genericContext.Length ? genericContext[index] : $"`{index}";
    }

    public string GetGenericMethodParameter(ImmutableArray<string> genericContext, int index)
    {
        return $"``{index}";
    }

    public string GetSZArrayType(string elementType)
    {
        return $"{elementType}[]";
    }

    public string GetArrayType(string elementType, ArrayShape shape)
    {
        return $"{elementType}[{string.Join(',', Enumerable.Repeat("0:", shape.Rank))}]";
    }

    public string GetByReferenceType(string elementType)
    {
        return $"{elementType}@";
    }

    public string GetPointerType(string elementType)
    {
        return $"{elementType}*";
    }

    public string GetPinnedType(string elementType)
    {
        return elementType;
    }

    public string GetModifiedType(string modifier, string unmodifiedType, bool isRequired)
    {
        return unmodifiedType;
    }

    public string GetFunctionPointerType(MethodSignature<string> signature)
    {
        return "System.IntPtr";
    }

    // stops at the nesting limit because a TypeRef can be its own scope, which overflows the stack
    private static string WriteReferenceName(MetadataReader reader, TypeReferenceHandle handle, int depth)
    {
        if (depth > Limits.MaxNestingDepth)
        {
            throw new BadImageFormatException("A TypeRef is nested too deep.");
        }

        TypeReference type = reader.GetTypeReference(handle);
        string name = reader.GetString(type.Name);

        return type.ResolutionScope.Kind == HandleKind.TypeReference
            ? $"{WriteReferenceName(reader, (TypeReferenceHandle)type.ResolutionScope, depth + 1)}.{name}"
            : Join(reader.GetString(type.Namespace), name);
    }

    private static string Join(string space, string name)
    {
        return space.Length > 0 ? $"{space}.{name}" : name;
    }
}
