using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using System.Reflection;
using System.Reflection.Metadata;
using System.Reflection.Metadata.Ecma335;
using LibCpp2IL.BinaryStructures;
using LibCpp2IL.Metadata;

namespace Decomp.Il2Cpp;

/// <summary>
///     Adds the opened type's members to the stub module and encodes the game's types in their signatures.
/// </summary>
internal sealed partial class StubModule
{
    /// <summary>
    ///     The name of the type that stands for a type that the binary has in a form that the stubs don't encode.
    /// </summary>
    public const string UnknownTypeName = "?";

    // the parameter flag of an `out` parameter, which IL2CPP keeps in the parameter type's attributes
    private const uint OutParameter = 0x2;

    // adds each member of the opened type, with the parameters and generic parameters of its methods
    private void AddMembers(TypeDefinitionHandle owner, int typeIndex, Il2CppTypeDefinition type)
    {
        Il2CppFieldDefinition[] fields = type.Fields ?? [];
        FieldAttributes[] fieldAttributes = _index.HasBinary ? type.FieldAttributes ?? [] : [];
        object?[] defaults = _index.HasBinary ? type.FieldDefaults ?? [] : [];
        for (int index = 0; index < fields.Length; index++)
        {
            if (!_index.HasBinary && type.IsEnumType)
            {
                AddEnumField(owner, fields[index]);

                continue;
            }

            FieldAttributes attributes = index < fieldAttributes.Length ? fieldAttributes[index] : 0;
            FieldDefinitionHandle field = _metadata.AddFieldDefinition(
                attributes,
                _metadata.GetOrAddString(fields[index].Name ?? ""),
                EncodeField(_index.HasBinary ? fields[index].RawFieldType : null));

            if (index < defaults.Length && defaults[index] is { } value && attributes.HasFlag(FieldAttributes.Literal))
            {
                AddConstant(field, value);
            }
        }

        Il2CppMethodDefinition[] methods = type.Methods ?? [];
        int firstMethod = _nextMethod;
        for (int index = 0; index < methods.Length; index++)
        {
            AddMethod(methods[index], _index.FirstMethods[typeIndex] + index, withParameters: true);
        }

        AddProperties(owner, type, methods, firstMethod);
        AddEvents(owner, type, methods, firstMethod);
    }

    // adds the virtual methods of a type without its other members, because the decompiler only writes `override` on a
    // method whose base type has the method it overrides
    private void AddVirtualMethods(int typeIndex, Il2CppTypeDefinition type)
    {
        Il2CppMethodDefinition[] methods = type.Methods ?? [];
        for (int index = 0; index < methods.Length; index++)
        {
            if (methods[index].Attributes.HasFlag(MethodAttributes.Virtual))
            {
                AddMethod(methods[index], _index.FirstMethods[typeIndex] + index, withParameters: false);
            }
        }
    }

    // adds an enum's field without the binary, which has the fields' flags and values, as the value field of an `int`
    // enum or as a constant without a value, because the decompiler only writes an enum's constants
    private void AddEnumField(TypeDefinitionHandle owner, Il2CppFieldDefinition field)
    {
        bool isValue = field.Name == "value__";
        FieldAttributes attributes = isValue
            ? FieldAttributes.Public | FieldAttributes.SpecialName | FieldAttributes.RTSpecialName
            : FieldAttributes.Public | FieldAttributes.Static | FieldAttributes.Literal;
        BlobBuilder signature = new();
        SignatureTypeEncoder encoder = new BlobEncoder(signature).Field().Type();
        if (isValue)
        {
            encoder.Int32();
        }
        else
        {
            encoder.Type(owner, isValueType: true);
        }

        _metadata.AddFieldDefinition(attributes, _metadata.GetOrAddString(field.Name ?? ""), _metadata.GetOrAddBlob(signature));
    }

    // skips a constant that the constant table doesn't take, like an enum's value that LibCpp2IL boxes as the enum
    private void AddConstant(FieldDefinitionHandle field, object value)
    {
        try
        {
            _metadata.AddConstant(field, value);
        }
        catch (ArgumentException)
        {
        }
    }

    // adds a method without a body, plus the rows of its parameters when asked, with its index among the game's methods
    private void AddMethod(Il2CppMethodDefinition method, int methodIndex, bool withParameters)
    {
        List<Il2CppParameterDefinition> parameters = ModelWriter.ListParameters(_index.Metadata, method);
        bool isInstance = !method.Attributes.HasFlag(MethodAttributes.Static);
        BlobBuilder signature = new();
        new BlobEncoder(signature)
            .MethodSignature(SignatureCallingConvention.Default, method.GenericContainer?.genericParameterCount ?? 0, isInstance)
            .Parameters(parameters.Count, out ReturnTypeEncoder returnType, out ParametersEncoder parameterTypes);
        EncodeReturn(returnType, _index.HasBinary ? method.RawReturnType : null);

        List<ParameterAttributes> parameterAttributes = [];
        foreach (Il2CppParameterDefinition parameter in parameters)
        {
            Il2CppType? parameterType = _index.HasBinary ? parameter.RawType : null;
            EncodeParameter(parameterTypes.AddParameter(), parameterType);
            parameterAttributes.Add(parameterType is not null && (parameterType.Attrs & OutParameter) != 0 ? ParameterAttributes.Out : 0);
        }

        // leaves out the method's implementation flags, like `InternalCall`, because they're about code that the game
        // doesn't have as IL
        MethodDefinitionHandle handle = _metadata.AddMethodDefinition(
            method.Attributes,
            MethodImplAttributes.IL,
            _metadata.GetOrAddString(method.Name ?? ""),
            _metadata.GetOrAddBlob(signature),
            -1,
            MetadataTokens.ParameterHandle(_nextParameter));
        _methodIndexes.Add(methodIndex);
        _nextMethod++;

        for (int index = 0; withParameters && index < parameters.Count; index++)
        {
            _metadata.AddParameter(parameterAttributes[index], _metadata.GetOrAddString(parameters[index].Name ?? ""), index + 1);
            _nextParameter++;
        }

        foreach (Il2CppGenericParameter parameter in method.GenericContainer?.GenericParameters ?? [])
        {
            _genericParameters.Add((handle, parameter.genericParameterIndexInOwner, parameter.Attributes, parameter.Name ?? ""));
        }
    }

    // gives a property the parameters of its getter, or of its setter without the value, so an indexer keeps them
    private void AddProperties(TypeDefinitionHandle owner, Il2CppTypeDefinition type, Il2CppMethodDefinition[] methods, int firstMethod)
    {
        Il2CppPropertyDefinition[] properties = type.Properties ?? [];
        if (properties.Length == 0)
        {
            return;
        }

        _metadata.AddPropertyMap(owner, MetadataTokens.PropertyDefinitionHandle(1));
        foreach (Il2CppPropertyDefinition property in properties)
        {
            Il2CppMethodDefinition? getter = property.Getter;
            Il2CppMethodDefinition? setter = property.Setter;
            List<Il2CppParameterDefinition> parameters = getter is not null
                ? ModelWriter.ListParameters(_index.Metadata, getter)
                : setter is not null ? [.. ModelWriter.ListParameters(_index.Metadata, setter).SkipLast(1)] : [];
            bool isInstance = !(getter ?? setter)?.Attributes.HasFlag(MethodAttributes.Static) ?? true;

            BlobBuilder signature = new();
            new BlobEncoder(signature)
                .PropertySignature(isInstance)
                .Parameters(parameters.Count, out ReturnTypeEncoder returnType, out ParametersEncoder parameterTypes);
            EncodeReturn(returnType, _index.HasBinary ? property.RawPropertyType : null);
            foreach (Il2CppParameterDefinition parameter in parameters)
            {
                EncodeParameter(parameterTypes.AddParameter(), _index.HasBinary ? parameter.RawType : null);
            }

            PropertyDefinitionHandle handle = _metadata.AddProperty(
                (PropertyAttributes)property.attrs,
                _metadata.GetOrAddString(property.Name ?? ""),
                _metadata.GetOrAddBlob(signature));
            AddAccessor(handle, MethodSemanticsAttributes.Getter, getter, methods, firstMethod);
            AddAccessor(handle, MethodSemanticsAttributes.Setter, setter, methods, firstMethod);
        }
    }

    private void AddEvents(TypeDefinitionHandle owner, Il2CppTypeDefinition type, Il2CppMethodDefinition[] methods, int firstMethod)
    {
        Il2CppEventDefinition[] events = type.Events ?? [];
        if (events.Length == 0)
        {
            return;
        }

        _metadata.AddEventMap(owner, MetadataTokens.EventDefinitionHandle(1));
        foreach (Il2CppEventDefinition @event in events)
        {
            Il2CppType? eventType = _index.HasBinary ? @event.RawType : null;
            EventDefinitionHandle handle = _metadata.AddEvent(
                _index.HasBinary ? @event.EventAttributes : 0,
                _metadata.GetOrAddString(@event.Name ?? ""),
                eventType is null ? EncodeObjectSpecification() : EncodeTypeHandle(eventType));
            AddAccessor(handle, MethodSemanticsAttributes.Adder, @event.Adder, methods, firstMethod);
            AddAccessor(handle, MethodSemanticsAttributes.Remover, @event.Remover, methods, firstMethod);
            AddAccessor(handle, MethodSemanticsAttributes.Raiser, @event.Invoker, methods, firstMethod);
        }
    }

    private void AddAccessor(
        EntityHandle association,
        MethodSemanticsAttributes kind,
        Il2CppMethodDefinition? accessor,
        Il2CppMethodDefinition[] methods,
        int firstMethod)
    {
        int index = accessor is null ? -1 : Array.IndexOf(methods, accessor);
        if (index >= 0)
        {
            _semantics.Add((association, kind, MetadataTokens.MethodDefinitionHandle(firstMethod + index)));
        }
    }

    private BlobHandle EncodeField(Il2CppType? type)
    {
        BlobBuilder signature = new();
        EncodeType(new BlobEncoder(signature).Field().Type(isByRef: type?.Byref == 1), type);

        return _metadata.GetOrAddBlob(signature);
    }

    private void EncodeReturn(ReturnTypeEncoder encoder, Il2CppType? type)
    {
        if (type?.Type == Il2CppTypeEnum.IL2CPP_TYPE_VOID)
        {
            encoder.Void();
        }
        else
        {
            EncodeType(encoder.Type(isByRef: type?.Byref == 1), type);
        }
    }

    private void EncodeParameter(ParameterTypeEncoder encoder, Il2CppType? type)
    {
        EncodeType(encoder.Type(isByRef: type?.Byref == 1), type);
    }

    // encodes `object` as a type specification, which stands for an event's type without the binary
    private TypeSpecificationHandle EncodeObjectSpecification()
    {
        BlobBuilder signature = new();
        new BlobEncoder(signature).TypeSpecificationSignature().Object();

        return _metadata.AddTypeSpecification(_metadata.GetOrAddBlob(signature));
    }

    // encodes a type as the handle of a definition or a reference, or of a type specification for any other type
    private EntityHandle EncodeTypeHandle(Il2CppType type)
    {
        if (type.Type is Il2CppTypeEnum.IL2CPP_TYPE_CLASS or Il2CppTypeEnum.IL2CPP_TYPE_VALUETYPE
            && _index.TypeIndexes.TryGetValue(type.AsClass(), out int typeIndex))
        {
            return EncodeDefinition(typeIndex);
        }

        BlobBuilder signature = new();
        EncodeType(new BlobEncoder(signature).TypeSpecificationSignature(), type);

        return _metadata.AddTypeSpecification(_metadata.GetOrAddBlob(signature));
    }

    private void EncodeType(SignatureTypeEncoder encoder, Il2CppType? type, int depth = 0)
    {
        // writes a member's type without the binary as `object`, because the binary has the types
        if (type is null)
        {
            encoder.Object();

            return;
        }

        switch (type.Type)
        {
            case Il2CppTypeEnum.IL2CPP_TYPE_BOOLEAN:
                encoder.Boolean();
                break;
            case Il2CppTypeEnum.IL2CPP_TYPE_CHAR:
                encoder.Char();
                break;
            case Il2CppTypeEnum.IL2CPP_TYPE_I1:
                encoder.SByte();
                break;
            case Il2CppTypeEnum.IL2CPP_TYPE_U1:
                encoder.Byte();
                break;
            case Il2CppTypeEnum.IL2CPP_TYPE_I2:
                encoder.Int16();
                break;
            case Il2CppTypeEnum.IL2CPP_TYPE_U2:
                encoder.UInt16();
                break;
            case Il2CppTypeEnum.IL2CPP_TYPE_I4:
                encoder.Int32();
                break;
            case Il2CppTypeEnum.IL2CPP_TYPE_U4:
                encoder.UInt32();
                break;
            case Il2CppTypeEnum.IL2CPP_TYPE_I8:
                encoder.Int64();
                break;
            case Il2CppTypeEnum.IL2CPP_TYPE_U8:
                encoder.UInt64();
                break;
            case Il2CppTypeEnum.IL2CPP_TYPE_R4:
                encoder.Single();
                break;
            case Il2CppTypeEnum.IL2CPP_TYPE_R8:
                encoder.Double();
                break;
            case Il2CppTypeEnum.IL2CPP_TYPE_STRING:
                encoder.String();
                break;
            case Il2CppTypeEnum.IL2CPP_TYPE_OBJECT:
                encoder.Object();
                break;
            case Il2CppTypeEnum.IL2CPP_TYPE_I:
                encoder.IntPtr();
                break;
            case Il2CppTypeEnum.IL2CPP_TYPE_U:
                encoder.UIntPtr();
                break;
            case Il2CppTypeEnum.IL2CPP_TYPE_TYPEDBYREF:
                encoder.Builder.WriteByte((byte)SignatureTypeCode.TypedReference);
                break;
            default:
                EncodeComposedType(encoder, type, depth);
                break;
        }
    }

    // encodes the types that refer to other types. A type that LibCpp2IL can't read or that nests deeper than
    // `MaxDepth` becomes the unknown type.
    private void EncodeComposedType(SignatureTypeEncoder encoder, Il2CppType type, int depth)
    {
        if (depth >= TypeNames.MaxDepth)
        {
            encoder.Type(EncodeUnknownType(), isValueType: false);

            return;
        }

        switch (type.Type)
        {
            case Il2CppTypeEnum.IL2CPP_TYPE_CLASS or Il2CppTypeEnum.IL2CPP_TYPE_VALUETYPE
                when _index.TypeIndexes.TryGetValue(type.AsClass(), out int typeIndex):
                encoder.Type(EncodeDefinition(typeIndex), type.Type == Il2CppTypeEnum.IL2CPP_TYPE_VALUETYPE);
                break;
            case Il2CppTypeEnum.IL2CPP_TYPE_GENERICINST
                when type.GetGenericClass() is { TypeDefinition: { } definition } generic
                && _index.TypeIndexes.TryGetValue(definition, out int genericIndex):
                Il2CppType[] arguments = generic.Context.ClassInst.Types;
                GenericTypeArgumentsEncoder argumentEncoder = encoder.GenericInstantiation(
                    EncodeDefinition(genericIndex),
                    arguments.Length,
                    definition.IsValueType);
                foreach (Il2CppType argument in arguments)
                {
                    EncodeType(argumentEncoder.AddArgument(), argument, depth + 1);
                }

                break;
            case Il2CppTypeEnum.IL2CPP_TYPE_SZARRAY:
                EncodeType(encoder.SZArray(), type.GetEncapsulatedType(), depth + 1);
                break;
            case Il2CppTypeEnum.IL2CPP_TYPE_ARRAY:
                encoder.Array(out SignatureTypeEncoder element, out ArrayShapeEncoder shape);
                EncodeType(element, type.GetArrayElementType(), depth + 1);
                shape.Shape(type.GetArrayRank(), ImmutableArray<int>.Empty, ImmutableArray<int>.Empty);
                break;
            case Il2CppTypeEnum.IL2CPP_TYPE_PTR when type.GetEncapsulatedType() is { Type: Il2CppTypeEnum.IL2CPP_TYPE_VOID }:
                encoder.VoidPointer();
                break;
            case Il2CppTypeEnum.IL2CPP_TYPE_PTR:
                EncodeType(encoder.Pointer(), type.GetEncapsulatedType(), depth + 1);
                break;
            case Il2CppTypeEnum.IL2CPP_TYPE_VAR:
                encoder.GenericTypeParameter(type.GetGenericParameterDef().genericParameterIndexInOwner);
                break;
            case Il2CppTypeEnum.IL2CPP_TYPE_MVAR:
                encoder.GenericMethodTypeParameter(type.GetGenericParameterDef().genericParameterIndexInOwner);
                break;
            default:
                encoder.Type(EncodeUnknownType(), isValueType: false);
                break;
        }
    }
}
