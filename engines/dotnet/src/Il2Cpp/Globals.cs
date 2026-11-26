using System;
using System.Buffers.Binary;
using System.Collections.Generic;
using LibCpp2IL;
using LibCpp2IL.BinaryStructures;
using LibCpp2IL.Elf;
using LibCpp2IL.Metadata;
using LibCpp2IL.Reflection;

namespace Decomp.Il2Cpp;

/// <summary>
///     Represents a global of the binary that IL2CPP fills with a piece of metadata, like a class's
///     <c>Il2CppClass</c> pointer, by its address relative to the image and its kind in
///     <see cref="MetadataUsageType" />. The name is the type's C# name, the method's or field's name, or the generic
///     method's name, with the index of the type definition that it belongs to, or -1. A string literal's global has
///     the literal's index as its definition. The text is the global's C# form, like <c>typeof(Circle)</c> or
///     <c>List&lt;int&gt;.Add</c>, in which the type's name starts at <c>TypeStart</c>. A global of a method or a
///     field has the member's index in its type, or -1. A TypeInfo global of a generic type's instance and the global
///     of a generic type's method have the index of their class among the game's classes, or -1.
/// </summary>
internal sealed record GlobalModel(
    ulong Rva,
    int Kind,
    string Name,
    int Definition,
    int Member,
    string Text,
    int TypeStart,
    int TypeLength,
    List<TextPart> Parts,
    int Class = -1);

/// <summary>
///     Reads the globals of the metadata's usages, through the metadata's usage lists before version 27 and through
///     a search of the binary's writable data from version 27.
/// </summary>
internal static class Globals
{
    public static List<GlobalModel> Read(
        Il2CppMetadata metadata,
        TypeNames names,
        Dictionary<Il2CppTypeDefinition, int> typeIndexes,
        GenericClasses classes)
    {
        IEnumerable<MetadataUsage> usages = metadata.metadataUsageDic is null ? ListFoundUsages() : ListUsages(metadata);
        List<GlobalModel> globals = [];
        foreach (MetadataUsage usage in usages)
        {
            GlobalModel? global = TryWrite(usage, metadata, names, typeIndexes, classes);
            if (global is not null)
            {
                globals.Add(global);
            }
        }

        return globals;
    }

    // reads the usage lists of the metadata itself, because LibCpp2IL's globals before version 27 mark a class's
    // TypeInfo as a type
    private static IEnumerable<MetadataUsage> ListUsages(Il2CppMetadata metadata)
    {
        Il2CppBinary binary = LibCpp2IlMain.Binary!;
        foreach ((uint kind, SortedDictionary<uint, uint> usages) in metadata.metadataUsageDic!)
        {
            foreach ((uint usageIndex, uint value) in usages)
            {
                yield return new((MetadataUsageType)kind, binary.GetRawMetadataUsage(usageIndex), value);
            }
        }
    }

    // reads each pointer of the binary's writable data with an encoded usage in it, like Il2CppDumper, because IL2CPP
    // fills a global with its piece of metadata from the usage's type in the top 3 bits and its index above a set low
    // bit, while LibCpp2IL doesn't search for the globals of version 27 and later
    private static IEnumerable<MetadataUsage> ListFoundUsages()
    {
        Il2CppBinary binary = LibCpp2IlMain.Binary!;
        byte[] bytes = binary.GetRawBinaryContent();
        (List<DataRange> ranges, int pointerSize) = WritableData.List(bytes);

        foreach (DataRange range in ranges)
        {
            for (int offset = range.Start; offset + pointerSize <= range.End; offset += pointerSize)
            {
                ReadOnlySpan<byte> slot = bytes.AsSpan(offset);
                ulong value = pointerSize == 8 ? BinaryPrimitives.ReadUInt64LittleEndian(slot) : BinaryPrimitives.ReadUInt32LittleEndian(slot);
                if ((value & 1) == 0 || value > uint.MaxValue)
                {
                    continue;
                }

                MetadataUsage? usage = MetadataUsage.DecodeMetadataUsage(value, binary.MapRawAddressToVirtual((uint)offset));
                if (usage is not null)
                {
                    yield return usage;
                }
            }
        }
    }

    // returns null for a usage that LibCpp2IL can't resolve, because it throws plain exceptions for any misread
    private static GlobalModel? TryWrite(
        MetadataUsage usage,
        Il2CppMetadata metadata,
        TypeNames names,
        Dictionary<Il2CppTypeDefinition, int> typeIndexes,
        GenericClasses classes)
    {
        Il2CppBinary binary = LibCpp2IlMain.Binary!;

        // takes an ELF global's address as its RVA like a method's, because an ELF image starts at 0
        ulong rva = binary is ElfFile ? usage.Offset : binary.GetRva(usage.Offset);

        try
        {
            if (!usage.IsValid)
            {
                return null;
            }

            GlobalText text = new(typeIndexes);

            return usage.Type switch
            {
                MetadataUsageType.TypeInfo => WriteType(rva, usage, names, text, "", classes),
                MetadataUsageType.Type => WriteType(rva, usage, names, text, ".TypeHandle", null),
                MetadataUsageType.MethodDef => WriteMethod(rva, usage, usage.AsMethod(), [], [], text, typeIndexes),
                MetadataUsageType.FieldInfo => WriteField(rva, metadata.fieldRefs[usage.RawValue], text, typeIndexes),
                MetadataUsageType.StringLiteral => WriteLiteral(rva, usage, metadata, text),
                MetadataUsageType.MethodRef => WriteMethodReference(rva, usage, usage.AsGenericMethodRef(), text, typeIndexes) with
                {
                    Class = classes.AddMethodClass(binary.GetMethodSpec((int)usage.RawValue)),
                },
                _ => null,
            };
        }
        catch (Exception exception) when (exception is not OutOfMemoryException)
        {
            return null;
        }
    }

    // gives a TypeInfo global of a generic type's instance its class, whose static fields depend on the arguments
    private static GlobalModel WriteType(ulong rva, MetadataUsage usage, TypeNames names, GlobalText text, string after, GenericClasses? classes)
    {
        Il2CppType type = LibCpp2IlMain.Binary!.GetType(Il2CppVariableWidthIndex<Il2CppType>.MakeTemporaryForFixedWidthUsage((int)usage.RawValue));
        TypeReference reference = names.Write(type);

        text.Add("typeof(");
        int typeStart = text.Length;
        text.AddType(type);
        int typeLength = text.Length - typeStart;
        text.Add(")");
        text.Add(after);

        int instance = classes?.AddInstance(type) ?? -1;

        return new(rva, (int)usage.Type, reference.Name, reference.Definition, -1, text.ToString(), typeStart, typeLength, text.Parts, instance);
    }

    // writes a method's global as `Type.Method`, with the type arguments of a generic type's or method's instance
    private static GlobalModel WriteMethod(
        ulong rva,
        MetadataUsage usage,
        Il2CppMethodDefinition method,
        Il2CppTypeReflectionData[] typeArguments,
        Il2CppTypeReflectionData[] methodArguments,
        GlobalText text,
        Dictionary<Il2CppTypeDefinition, int> typeIndexes,
        string? name = null)
    {
        Il2CppTypeDefinition? owner = method.DeclaringType;
        int typeLength = 0;
        if (owner is not null)
        {
            text.AddDefinition(owner);
            text.AddArguments(typeArguments, argument => text.AddType(argument));
            typeLength = text.Length;
            text.Add(".");
        }

        text.AddMember(method.Name ?? "");
        text.AddArguments(methodArguments, argument => text.AddType(argument));

        int definition = owner is null ? -1 : typeIndexes.GetValueOrDefault(owner, -1);
        int member = owner is null ? -1 : Array.IndexOf(owner.Methods ?? [], method);

        return new(rva, (int)usage.Type, name ?? method.Name ?? "", definition, member, text.ToString(), 0, typeLength, text.Parts);
    }

    // keeps LibCpp2IL's form of the reference as the name, like `System.Void System.Collections.Generic.List`1<T>.Add`
    private static GlobalModel WriteMethodReference(
        ulong rva,
        MetadataUsage usage,
        Cpp2IlMethodRef reference,
        GlobalText text,
        Dictionary<Il2CppTypeDefinition, int> typeIndexes)
    {
        return WriteMethod(
            rva,
            usage,
            reference.BaseMethod,
            reference.TypeGenericParams,
            reference.MethodGenericParams,
            text,
            typeIndexes,
            reference.ToString());
    }

    private static GlobalModel WriteField(ulong rva, Il2CppFieldRef fieldRef, GlobalText text, Dictionary<Il2CppTypeDefinition, int> typeIndexes)
    {
        Il2CppTypeDefinition owner = fieldRef.DeclaringTypeDefinition!;
        Il2CppFieldDefinition[] fields = owner.Fields ?? [];
        int fieldIndex = fieldRef.fieldIndex.Value;
        string name = fieldIndex >= 0 && fieldIndex < fields.Length ? fields[fieldIndex].Name ?? "" : "";

        text.AddDefinition(owner);
        int typeLength = text.Length;
        text.Add(".");
        text.AddMember(name);

        int definition = typeIndexes.GetValueOrDefault(owner, -1);

        return new(rva, (int)MetadataUsageType.FieldInfo, name, definition, fieldIndex, text.ToString(), 0, typeLength, text.Parts);
    }

    private static GlobalModel WriteLiteral(ulong rva, MetadataUsage usage, Il2CppMetadata metadata, GlobalText text)
    {
        text.AddLiteral(metadata.GetStringLiteralFromIndex(usage.RawValue));

        return new(rva, (int)usage.Type, "", (int)usage.RawValue, -1, text.ToString(), 0, 0, text.Parts);
    }
}
