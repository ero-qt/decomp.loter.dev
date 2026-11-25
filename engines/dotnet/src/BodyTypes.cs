using System;
using System.Collections.Immutable;
using System.Linq;
using System.Reflection.Metadata;

namespace Decomp.Dotnet;

/// <summary>
///     Checks the types of a method body's locals, which only the body's local signature names.
/// </summary>
internal static class BodyTypes
{
    /// <summary>
    ///     Checks whether a body has a local whose type has a type that <paramref name="names"/> accepts, like the
    ///     element of an array or a type argument. Skips a signature that isn't readable.
    /// </summary>
    public static bool HasLocal(MetadataReader metadata, MethodBodyBlock body, Func<EntityHandle, bool> names)
    {
        if (body.LocalSignature.IsNil)
        {
            return false;
        }

        try
        {
            return metadata.GetStandaloneSignature(body.LocalSignature).DecodeLocalSignature(new NamedTypes(names), null).Any(isNamed => isNamed);
        }
        catch (BadImageFormatException)
        {
            return false;
        }
    }

    // reads each type of a signature as whether it or a type inside it is named
    private sealed class NamedTypes(
        Func<EntityHandle, bool> names) : ISignatureTypeProvider<bool, object?>
    {
        public bool GetTypeFromDefinition(MetadataReader reader, TypeDefinitionHandle handle, byte rawTypeKind)
        {
            return names(handle);
        }

        public bool GetTypeFromReference(MetadataReader reader, TypeReferenceHandle handle, byte rawTypeKind)
        {
            return names(handle);
        }

        public bool GetTypeFromSpecification(MetadataReader reader, object? genericContext, TypeSpecificationHandle handle, byte rawTypeKind)
        {
            return names(handle);
        }

        public bool GetGenericInstantiation(bool genericType, ImmutableArray<bool> typeArguments)
        {
            return genericType || typeArguments.Any(isNamed => isNamed);
        }

        public bool GetFunctionPointerType(MethodSignature<bool> signature)
        {
            return signature.ReturnType || signature.ParameterTypes.Any(isNamed => isNamed);
        }

        public bool GetModifiedType(bool modifier, bool unmodifiedType, bool isRequired)
        {
            return unmodifiedType;
        }

        public bool GetArrayType(bool elementType, ArrayShape shape)
        {
            return elementType;
        }

        public bool GetSZArrayType(bool elementType)
        {
            return elementType;
        }

        public bool GetByReferenceType(bool elementType)
        {
            return elementType;
        }

        public bool GetPointerType(bool elementType)
        {
            return elementType;
        }

        public bool GetPinnedType(bool elementType)
        {
            return elementType;
        }

        public bool GetPrimitiveType(PrimitiveTypeCode typeCode)
        {
            return false;
        }

        public bool GetGenericMethodParameter(object? genericContext, int index)
        {
            return false;
        }

        public bool GetGenericTypeParameter(object? genericContext, int index)
        {
            return false;
        }
    }
}
