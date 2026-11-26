using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Reflection;
using System.Text;
using AssetRipper.Primitives;
using LibCpp2IL;
using LibCpp2IL.BinaryStructures;
using LibCpp2IL.Elf;
using LibCpp2IL.Metadata;
using LibCpp2IL.Reflection;

namespace Decomp.Il2Cpp;

/// <summary>
///     Writes the model of the game that LibCpp2IL read last. The model leaves out the types and addresses without
///     a <see cref="TypeNames" />, which needs the binary.
/// </summary>
internal sealed class ModelWriter(Il2CppMetadata metadata, TypeNames? names)
{
    /// <summary>
    ///     Maps each type definition to its index in the metadata.
    /// </summary>
    public static Dictionary<Il2CppTypeDefinition, int> IndexTypes(Il2CppMetadata metadata)
    {
        Dictionary<Il2CppTypeDefinition, int> typeIndexes = new(ReferenceEqualityComparer.Instance);
        for (int index = 0; index < metadata.typeDefs.Length; index++)
        {
            typeIndexes[metadata.typeDefs[index]] = index;
        }

        return typeIndexes;
    }

    public GameModel Write(int fileVersion, bool isLayoutGuessed, UnityVersion unityVersion)
    {
        Dictionary<Il2CppTypeDefinition, int> typeIndexes = IndexTypes(metadata);
        int[] declaringTypes = Enumerable.Repeat(-1, metadata.typeDefs.Length).ToArray();
        foreach (Il2CppTypeDefinition type in metadata.typeDefs)
        {
            foreach (Il2CppTypeDefinition nested in type.NestedTypes ?? [])
            {
                declaringTypes[typeIndexes[nested]] = typeIndexes[type];
            }
        }

        List<ImageModel> images = metadata.imageDefinitions
            .Select(image => new ImageModel(image.Name ?? "", image.firstTypeIndex.Value, (int)image.typeCount))
            .ToList();
        List<TypeModel> types = metadata.typeDefs.Select((type, index) => WriteType(type, declaringTypes[index])).ToList();
        List<string> strings = Enumerable.Range(0, metadata.stringLiterals.Length)
            .Select(index => metadata.GetStringLiteralFromIndex((uint)index))
            .ToList();

        string layout = metadata.MetadataVersion.ToString(CultureInfo.InvariantCulture);

        int pointerSize = names is null ? 0 : LibCpp2IlMain.Binary!.is32Bit ? 4 : 8;
        GenericClasses? classes = names is null ? null : new(names, typeIndexes);
        List<GlobalModel> globals = classes is null ? [] : Globals.Read(metadata, names!, typeIndexes, classes);

        return new(
            fileVersion,
            layout,
            isLayoutGuessed,
            unityVersion.ToString(),
            pointerSize,
            images,
            types,
            strings,
            globals,
            classes?.Classes ?? []);
    }

    private TypeModel WriteType(Il2CppTypeDefinition type, int declaringType)
    {
        Il2CppMethodDefinition[] methods = type.Methods ?? [];
        List<PropertyModel> properties = (type.Properties ?? [])
            .Select(property => new PropertyModel(
                property.Name ?? "",
                Array.IndexOf(methods, property.Getter),
                Array.IndexOf(methods, property.Setter)))
            .ToList();

        return new(
            type.Namespace ?? "",
            type.Name ?? "",
            declaringType,
            (uint)type.Attributes,
            type.IsValueType,
            type.IsEnumType,
            TypeNames.ListOwnGenericParameters(type),
            WriteReference(() => type.RawBaseType),
            WriteFields(type),
            methods.Select(WriteMethod).ToList(),
            properties);
    }

    private List<FieldModel> WriteFields(Il2CppTypeDefinition type)
    {
        Il2CppFieldDefinition[] fields = type.Fields ?? [];
        if (names is null)
        {
            return fields.Select(field => new FieldModel(field.Name ?? "", null, null, null, null)).ToList();
        }

        return fields.Select((field, index) => WriteField(type, field, index)).ToList();
    }

    // reads a field's attributes, offset and constant like LibCpp2IL's `FieldInfos`, which reads the attributes of
    // all the type's fields again for each field, so a class of thousands of fields takes seconds
    private FieldModel WriteField(Il2CppTypeDefinition type, Il2CppFieldDefinition field, int index)
    {
        Il2CppBinary binary = LibCpp2IlMain.Binary!;
        FieldAttributes attributes = (FieldAttributes)binary.GetType(field.typeIndex).Attrs;
        bool isStatic = (attributes & FieldAttributes.Static) != 0;
        int offset = binary.GetFieldOffsetFromIndex(type.TypeIndex, index, field.FieldIndex, type.IsValueType, isStatic);
        Il2CppFieldDefaultValue? defaultValue = (attributes & FieldAttributes.HasDefault) != 0
            ? metadata.GetFieldDefaultValueFromIndex(field.FieldIndex)
            : null;

        return new(field.Name ?? "", WriteReference(() => field.RawFieldType), (uint)attributes, offset, FormatConstant(defaultValue?.Value));
    }

    private MethodModel WriteMethod(Il2CppMethodDefinition method)
    {
        List<ParameterModel> parameters = ListParameters(metadata, method)
            .Select(parameter => new ParameterModel(parameter.Name ?? "", WriteReference(() => parameter.RawType)))
            .ToList();
        bool hasCode = names is not null && method.MethodPointer != 0;

        return new(
            method.Name ?? "",
            (uint)method.Attributes,
            WriteReference(() => method.RawReturnType),
            parameters,
            ListGenericParameters(method.GenericContainer),
            hasCode ? FindRva(method) : null);
    }

    // reads the type only with the binary, because LibCpp2IL's type lookups need the binary
    private TypeReference? WriteReference(Func<Il2CppType?> readType)
    {
        Il2CppType? type = names is null ? null : readType();

        return type is null ? null : names!.Write(type);
    }

    /// <summary>
    ///     Reads a method's parameters from the metadata, because LibCpp2IL's own list waits for the binary.
    /// </summary>
    public static List<Il2CppParameterDefinition> ListParameters(Il2CppMetadata metadata, Il2CppMethodDefinition method)
    {
        List<Il2CppParameterDefinition> parameters = [];
        for (int index = 0; index < method.parameterCount && method.parameterStart.IsNonNull; index++)
        {
            int parameterIndex = method.parameterStart.Value + index;
            parameters.Add(metadata.GetParameterDefinitionFromIndex(
                Il2CppVariableWidthIndex<Il2CppParameterDefinition>.MakeTemporaryForFixedWidthUsage(parameterIndex)));
        }

        return parameters;
    }

    /// <summary>
    ///     Lists the names of a generic container's parameters, or none without a container.
    /// </summary>
    public static List<string> ListGenericParameters(Il2CppGenericContainer? container)
    {
        return container?.GenericParameters.Select(parameter => parameter.Name ?? "").ToList() ?? [];
    }

    /// <summary>
    ///     Finds the address of a method's code relative to the image. Takes an ELF method's address, because an ELF
    ///     image starts at 0 and LibCpp2IL's RVA of an ELF method is its offset in the file.
    /// </summary>
    public static ulong FindRva(Il2CppMethodDefinition method)
    {
        return LibCpp2IlMain.Binary is ElfFile ? method.MethodPointer : method.Rva;
    }

    public static string FormatHex(ulong value)
    {
        return $"0x{value:x}";
    }

    // writes a constant like C# source does, because the stubs show it after the field's name
    private static string? FormatConstant(object? value)
    {
        return value switch
        {
            null => null,
            string text => $"\"{EscapeLiteral(text, '"')}\"",
            char character => $"'{EscapeLiteral(character.ToString(), '\'')}'",
            bool flag => flag ? "true" : "false",
            IFormattable number => number.ToString(null, CultureInfo.InvariantCulture),
            _ => value.ToString(),
        };
    }

    // escapes the backslash, the quote and the control characters like C# source, because a raw line break would end
    // the stub's line
    private static string EscapeLiteral(string text, char quote)
    {
        StringBuilder builder = new();
        foreach (char character in text)
        {
            builder.Append(character switch
            {
                '\\' => @"\\",
                '\n' => @"\n",
                '\r' => @"\r",
                '\t' => @"\t",
                '\0' => @"\0",
                _ when character == quote => $"\\{quote}",
                _ when char.IsControl(character) => $"\\u{(int)character:x4}",
                _ => character.ToString(),
            });
        }

        return builder.ToString();
    }
}
