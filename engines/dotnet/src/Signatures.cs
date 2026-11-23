using ICSharpCode.Decompiler;
using ICSharpCode.Decompiler.CSharp;
using ICSharpCode.Decompiler.CSharp.OutputVisitor;
using ICSharpCode.Decompiler.CSharp.Syntax;
using ICSharpCode.Decompiler.Disassembler;
using ICSharpCode.Decompiler.Metadata;
using ICSharpCode.Decompiler.Output;
using ICSharpCode.Decompiler.Semantics;
using ICSharpCode.Decompiler.TypeSystem;
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Reflection.Metadata;
using System.Reflection.Metadata.Ecma335;
using System.Threading;

namespace Decomp.Dotnet;

/// <summary>
///     The hover text of a symbol, like <c>Description</c> in <c>contract/engine.ts</c>.
/// </summary>
internal sealed record Description(
    string Text,
    string? Container,
    List<string[]> Facts,
    string? MissingFile);

/// <summary>
///     The views of the engine's documents.
/// </summary>
internal enum View
{
    CSharp,
    Il,
}

/// <summary>
///     Writes the C# signatures and the IL headers of symbols for their hover texts.
/// </summary>
internal static class Signatures
{
    // writes a type or a member like its declaration, without the body that the standard flags add as `;` or accessors
    private static readonly CSharpAmbience _signatureAmbience = new()
    {
        ConversionFlags = (ConversionFlags.StandardConversionFlags & ~ConversionFlags.ShowBody)
            | ConversionFlags.SupportRecordClasses
            | ConversionFlags.SupportRecordStructs,
    };

    private static readonly CSharpAmbience _containerAmbience = new()
    {
        ConversionFlags = ConversionFlags.UseFullyQualifiedEntityNames | ConversionFlags.ShowTypeParameterList,
    };

    /// <summary>
    ///     Describes a type or a member from its definition in the language of a view, with its token and, for a method
    ///     or a field with data, its RVA. Without <paramref name="writesExtern" />, a member without a body doesn't get
    ///     <c>extern</c>, for an engine whose members only lack the body that it doesn't have.
    /// </summary>
    public static Description Describe(IEntity entity, View view, CSharpFormattingOptions options, bool writesExtern = true)
    {
        string text = (view, entity) switch
        {
            (View.Il, _) => WriteIlHeader(entity),
            (_, IField { DeclaringType.Kind: TypeKind.Enum } field) => WriteEnumMember(field),
            _ => WriteDeclaration(entity, options, writesExtern),
        };
        EntityHandle handle = entity.MetadataToken;
        int address = entity.ParentModule?.MetadataFile?.Metadata is { } metadata ? ReadRelativeVirtualAddress(metadata, handle) : 0;

        List<string[]> facts = [["token", string.Create(CultureInfo.InvariantCulture, $"0x{MetadataTokens.GetToken(handle):X8}")]];
        if (address != 0)
        {
            facts.Add(["RVA", string.Create(CultureInfo.InvariantCulture, $"0x{address:X4}")]);
        }

        return new(text, FindContainer(entity), facts, MissingFile: null);
    }

    /// <summary>
    ///     Describes a symbol of an assembly that isn't open from its ID string, with the name of its type for a
    ///     constructor, because the engine doesn't have the symbol's declaration.
    /// </summary>
    /// <returns>The description, or <see langword="null"/> for an ID string that isn't of a type or a member.</returns>
    public static Description? DescribeOutside(string idString, string? missingFile)
    {
        if (idString.Length < 2 || idString[1] != ':' || !"TMFPE".Contains(idString[0], StringComparison.Ordinal))
        {
            return null;
        }

        string fullName = idString[2..].Split('(')[0];
        int nameStart = fullName.AsSpan().LastIndexOf('.') + 1;
        string? container = nameStart == 0 ? null : fullName[..(nameStart - 1)];
        string name = fullName[nameStart..].Split('`')[0];

        if (name is "#ctor" or "#cctor" && container is not null)
        {
            name = container[(container.LastIndexOf('.') + 1)..].Split('`')[0];
        }

        return new(name, container, [], missingFile);
    }

    /// <summary>
    ///     Writes a type like the C# of a document writes it, with the types that contain a nested type.
    /// </summary>
    public static string WriteType(IType type, CSharpFormattingOptions options)
    {
        using StringWriter writer = new(CultureInfo.InvariantCulture);
        NestedTypeTokenWriter tokenWriter = new(new TextWriterTokenWriter(writer), options, entity: null);

        tokenWriter.WriteType(type);

        return writer.ToString();
    }

    // writes the directive that starts the type's or the member's IL, without its body
    private static string WriteIlHeader(IEntity entity)
    {
        using StringWriter writer = new(CultureInfo.InvariantCulture);
        ReflectionDisassembler disassembler = new(new PlainTextOutput(writer), CancellationToken.None);
        MetadataFile file = entity.ParentModule!.MetadataFile!;
        EntityHandle handle = entity.MetadataToken;

        switch (handle.Kind)
        {
            case HandleKind.TypeDefinition:
                disassembler.DisassembleTypeHeader(file, (TypeDefinitionHandle)handle);
                break;
            case HandleKind.MethodDefinition:
                disassembler.DisassembleMethodHeader(file, (MethodDefinitionHandle)handle);
                break;
            case HandleKind.FieldDefinition:
                disassembler.DisassembleFieldHeader(file, (FieldDefinitionHandle)handle);
                break;
            case HandleKind.PropertyDefinition:
                disassembler.DisassemblePropertyHeader(file, (PropertyDefinitionHandle)handle);
                break;
            case HandleKind.EventDefinition:
                disassembler.DisassembleEventHeader(file, (EventDefinitionHandle)handle);
                break;
        }

        return writer.ToString().Trim();
    }

    private static string WriteEnumMember(IField field)
    {
        return string.Create(CultureInfo.InvariantCulture, $"{field.DeclaringType.Name}.{field.Name} = {field.GetConstantValue()}");
    }

    private static string WriteDeclaration(IEntity entity, CSharpFormattingOptions options, bool writesExtern)
    {
        using StringWriter writer = new(CultureInfo.InvariantCulture);
        NestedTypeTokenWriter tokenWriter = new(new TextWriterTokenWriter(writer), options, writesExtern ? entity : null);

        _signatureAmbience.ConvertSymbol(entity, tokenWriter, options);

        return writer.ToString();
    }

    private static int ReadRelativeVirtualAddress(MetadataReader metadata, EntityHandle handle)
    {
        return handle.Kind switch
        {
            HandleKind.MethodDefinition => metadata.GetMethodDefinition((MethodDefinitionHandle)handle).RelativeVirtualAddress,
            HandleKind.FieldDefinition => metadata.GetFieldDefinition((FieldDefinitionHandle)handle).GetRelativeVirtualAddress(),
            _ => 0,
        };
    }

    private static string? FindContainer(IEntity entity)
    {
        if (entity.DeclaringTypeDefinition is { } declaringType)
        {
            return _containerAmbience.ConvertSymbol(declaringType);
        }

        return entity is ITypeDefinition { Namespace.Length: > 0 } type ? type.Namespace : null;
    }

    /// <summary>
    ///     Writes the types that contain a nested type before its name and the <c>extern</c> of a member without a
    ///     body, which the ambience leaves out.
    /// </summary>
    private sealed class NestedTypeTokenWriter(
        TokenWriter decoratedWriter,
        CSharpFormattingOptions options,
        IEntity? entity) : DecoratingTokenWriter(decoratedWriter)
    {
        // adds the modifier to the declaration before the ambience writes the declaration's modifiers
        public override void StartNode(AstNode node)
        {
            if (node is EntityDeclaration { Parent: null } declaration && entity is IMember member && IsExtern(member))
            {
                declaration.Modifiers |= Modifiers.Extern;
            }

            base.StartNode(node);
        }

        public override void WriteIdentifier(Identifier identifier)
        {
            if (identifier.Parent is SimpleType type && type.GetResolveResult() is TypeResolveResult { Type.DeclaringType: { } declaringType })
            {
                WriteType(declaringType);
                WriteToken(".");
            }

            base.WriteIdentifier(identifier);
        }

        public void WriteType(IType type)
        {
            TypeSystemAstBuilder builder = new() { AlwaysUseShortTypeNames = true, AddResolveResultAnnotations = true };

            builder.ConvertType(type).AcceptVisitor(new CSharpOutputVisitor(this, options));
        }

        // finds a member without a body like the decompiler, which writes it with `extern`
        private static bool IsExtern(IMember member)
        {
            bool hasBody = member switch
            {
                IMethod method => method.HasBody,
                IProperty property => property.Getter?.HasBody == true || property.Setter?.HasBody == true,
                IEvent @event => @event.AddAccessor?.HasBody == true || @event.RemoveAccessor?.HasBody == true,
                _ => true,
            };

            return !hasBody && !member.IsAbstract && member.DeclaringType.Kind is not (TypeKind.Interface or TypeKind.Delegate);
        }
    }
}
