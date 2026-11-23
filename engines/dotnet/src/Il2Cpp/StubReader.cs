using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Reflection;
using System.Reflection.Metadata;
using System.Reflection.Metadata.Ecma335;
using System.Text;
using Decomp.Dotnet;
using ICSharpCode.Decompiler;
using ICSharpCode.Decompiler.CSharp;
using ICSharpCode.Decompiler.CSharp.Syntax;
using ICSharpCode.Decompiler.TypeSystem;
using LibCpp2IL.Metadata;

namespace Decomp.Il2Cpp;

/// <summary>
///     A type's document like the .NET engine's <see cref="DocumentReply" />, with each method's row key and the start
///     of the line of its empty body's <c>}</c>, 2 values for each method, where the worker puts the method's C.
/// </summary>
internal sealed record StubDocumentReply(
    string Text,
    byte[] Tokens,
    List<string> Targets,
    List<string> Locals,
    int[] Bodies);

/// <summary>
///     Writes the C# of a game's types and the hovers of their symbols with the .NET engine's decompiler, from the stub
///     module of each type.
/// </summary>
internal static class StubReader
{
    // writes a record's constructor and properties as members like the .NET engine, because each row then has a
    // declaration
    private static readonly DecompilerSettings _settings = new()
    {
        ThrowOnAssemblyResolveErrors = false,
        UsePrimaryConstructorSyntax = false,
        UsePrimaryConstructorSyntaxForNonRecordTypes = false,
    };

    // the lines above a stub without the binary, which keeps the types of the members
    private const string MissingTypesNote =
        "// Load GameAssembly.dll or libil2cpp.so to show type information.\n// Types show as object until then.";

    /// <summary>
    ///     Writes the C# of a type without its nested types, which have their own documents, and with an empty body for
    ///     each method, because the game doesn't have the methods' IL. Each accessor that the compiler didn't write gets
    ///     an empty body too when <paramref name="expandsAccessors" /> is set, for the worker to fill with its code.
    /// </summary>
    /// <exception cref="ArgumentException">The game doesn't have a type with the index.</exception>
    /// <exception cref="BadImageFormatException">The decompiler can't write the type's C#.</exception>
    public static StubDocumentReply ReadCSharp(int fileId, GameIndex index, GameStubs stubs, int typeIndex, bool expandsAccessors)
    {
        if (typeIndex < 0 || typeIndex >= index.Metadata.typeDefs.Length)
        {
            throw new ArgumentException($"The game doesn't have a type with the index {typeIndex}.");
        }

        // wraps the decompiler's exception because it throws many types for metadata that it can't read
        try
        {
            OpenedStub opened = stubs.Open(index, typeIndex, _settings);
            CSharpDecompiler decompiler = new(opened.TypeSystem, _settings);
            TypeDefinitionHandle handle = MetadataTokens.TypeDefinitionHandle(typeIndex - opened.Stub.FirstType + 1);
            SyntaxTree syntaxTree = decompiler.DecompileTypes([handle]);
            RemoveNestedTypes(syntaxTree);
            GiveEmptyBodies(syntaxTree, expandsAccessors);

            StubTargets targets = new(fileId, stubs, index);
            List<(IMethod Method, int Offset)> emptyBodies = [];
            Dotnet.Document document = CSharpOutput.Write(syntaxTree, _settings, targets, emptyBodies);
            List<int> bodies = [];
            foreach ((IMethod method, int offset) in emptyBodies)
            {
                if (targets.FindKey(method.MemberDefinition) is int key)
                {
                    bodies.AddRange([key, offset]);
                }
            }

            (Dotnet.Document noted, int[] notedBodies) = index.HasBinary ? (document, [.. bodies]) : AddNote(document, [.. bodies]);

            return RemoveMissingValueComments(noted, notedBodies);
        }
        catch (Exception exception) when (exception is not ArgumentException)
        {
            throw new BadImageFormatException($"The engine can't write the C# of {index.Metadata.typeDefs[typeIndex].Name}.", exception);
        }
    }

    /// <summary>
    ///     Describes the type or member of a row key like the .NET engine, with the facts of IL2CPP's metadata, like a
    ///     type's index, a field's offset and the addresses of a method's code, without the token, because a stub's
    ///     tokens aren't the tokens of a real assembly.
    /// </summary>
    /// <returns>The description, or <see langword="null" /> for a key without a type or a member.</returns>
    /// <exception cref="BadImageFormatException">The decompiler can't read the symbol.</exception>
    public static Description? Describe(GameIndex index, GameStubs stubs, int key)
    {
        if (FindSymbol(index, key) is not var (typeIndex, kind, number, facts))
        {
            return null;
        }

        // wraps the decompiler's exception because it throws many types for metadata that it can't read
        try
        {
            OpenedStub opened = stubs.Open(index, typeIndex, _settings);
            EntityHandle handle = kind switch
            {
                HandleKind.FieldDefinition => MetadataTokens.FieldDefinitionHandle(number + 1),
                HandleKind.MethodDefinition => MetadataTokens.MethodDefinitionHandle(Array.IndexOf(opened.Stub.MethodIndexes, number) + 1),
                HandleKind.PropertyDefinition => MetadataTokens.PropertyDefinitionHandle(number + 1),
                _ => MetadataTokens.TypeDefinitionHandle(typeIndex - opened.Stub.FirstType + 1),
            };
            IEntity entity = opened.TypeSystem.MainModule.ResolveEntity(handle, default);
            Description description = Signatures.Describe(entity, View.CSharp, _settings.CSharpFormattingOptions, writesExtern: false);

            return description with { Facts = facts };
        }
        catch (Exception exception)
        {
            throw new BadImageFormatException($"The engine can't read the symbol with the key {key}.", exception);
        }
    }

    // finds the type of a key, the kind of the key's symbol with its index in its type, or a method's index among all
    // methods of the game, and the symbol's facts
    private static (int TypeIndex, HandleKind Kind, int Number, List<string[]> Facts)? FindSymbol(GameIndex index, int key)
    {
        Il2CppTypeDefinition[] types = index.Metadata.typeDefs;
        if (key is >= 0 and < RowKeys.Field)
        {
            return key < types.Length ? (key, HandleKind.TypeDefinition, key, DescribeType(types[key], key)) : null;
        }

        if (FindMember(index.FirstFields, key - RowKeys.Field, type => types[type].FieldCount) is var (fieldType, field))
        {
            return (fieldType, HandleKind.FieldDefinition, field, DescribeField(index, types[fieldType], field));
        }

        if (FindMember(index.FirstMethods, key - RowKeys.Method, type => types[type].MethodCount) is var (methodType, method))
        {
            Il2CppMethodDefinition definition = types[methodType].Methods![method];

            return (methodType, HandleKind.MethodDefinition, key - RowKeys.Method, DescribeMethod(index, definition));
        }

        if (FindMember(index.FirstProperties, key - RowKeys.Property, type => types[type].PropertyCount) is var (propertyType, property))
        {
            Il2CppPropertyDefinition definition = types[propertyType].Properties![property];

            return (propertyType, HandleKind.PropertyDefinition, property, DescribeProperty(index, definition));
        }

        return null;
    }

    // finds the type of a member's index among all members of a kind, which is the last type whose members start at or
    // before the index and has enough members
    private static (int Type, int IndexInType)? FindMember(int[] firsts, int memberIndex, Func<int, int> countMembers)
    {
        if (memberIndex < 0 || memberIndex >= RowKeys.Field || firsts.Length == 0)
        {
            return null;
        }

        int low = 0;
        int high = firsts.Length - 1;
        while (low < high)
        {
            int middle = (low + high + 1) / 2;
            if (firsts[middle] <= memberIndex)
            {
                low = middle;
            }
            else
            {
                high = middle - 1;
            }
        }

        int indexInType = memberIndex - firsts[low];

        return indexInType < countMembers(low) ? (low, indexInType) : null;
    }

    private static List<string[]> DescribeType(Il2CppTypeDefinition type, int typeIndex)
    {
        return [["TypeDefIndex", typeIndex.ToString(CultureInfo.InvariantCulture)]];
    }

    // writes a negative offset, like a thread static field's -1, as the 32-bit value that IL2CPP keeps
    private static List<string[]> DescribeField(GameIndex index, Il2CppTypeDefinition type, int field)
    {
        List<string[]> facts = [];
        bool isConstant = index.HasBinary && (type.FieldAttributes ?? [])[field].HasFlag(FieldAttributes.Literal);
        if (index.HasBinary && !isConstant)
        {
            facts.Add(["offset", ModelWriter.FormatHex((uint)type.FieldInfos![field].FieldOffset)]);
        }

        return facts;
    }

    private static List<string[]> DescribeMethod(GameIndex index, Il2CppMethodDefinition method)
    {
        List<string[]> facts = [];
        if (index.HasBinary && method.MethodPointer != 0)
        {
            facts.Add(["RVA", ModelWriter.FormatHex(ModelWriter.FindRva(method))]);
            facts.Add(["VA", ModelWriter.FormatHex(method.MethodPointer)]);
            facts.Add(["offset", ModelWriter.FormatHex((ulong)method.MethodOffsetInFile)]);
        }

        return facts;
    }

    // gives a property the addresses of its accessors' code, because the stub writes the accessors as keywords, which
    // don't have a hover
    private static List<string[]> DescribeProperty(GameIndex index, Il2CppPropertyDefinition property)
    {
        List<string[]> facts = [];
        (string Keyword, Il2CppMethodDefinition? Accessor)[] accessors = [("get", property.Getter), ("set", property.Setter)];
        foreach ((string keyword, Il2CppMethodDefinition? accessor) in accessors)
        {
            if (index.HasBinary && accessor is not null && accessor.MethodPointer != 0)
            {
                facts.Add([$"{keyword} RVA", ModelWriter.FormatHex(ModelWriter.FindRva(accessor))]);
            }
        }

        return facts;
    }

    // leaves out the types nested in the written type, because each of them has its own row with its own document
    private static void RemoveNestedTypes(SyntaxTree syntaxTree)
    {
        foreach (TypeDeclaration nested in syntaxTree.Descendants.OfType<TypeDeclaration>().Where(type => type.Parent is TypeDeclaration).ToList())
        {
            nested.Remove();
        }
    }

    // puts the note about the missing types above the C#, and moves the tokens and bodies after it
    private static (Dotnet.Document Document, int[] Bodies) AddNote(Dotnet.Document document, int[] bodies)
    {
        int length = MissingTypesNote.Length + 1;
        int[] tokens = [.. document.Tokens];
        for (int token = 0; token < tokens.Length; token += 5)
        {
            tokens[token] += length;
        }

        int[] movedBodies = [.. bodies.Select((value, position) => position % 2 == 1 ? value + length : value)];

        return (document with { Text = $"{MissingTypesNote}\n{document.Text}", Tokens = tokens }, movedBodies);
    }

    // leaves out the line that the decompiler writes above an enum's constant without its value, because the game's
    // metadata alone doesn't have the values, and moves the tokens and bodies after each line back
    private static StubDocumentReply RemoveMissingValueComments(Dotnet.Document document, int[] bodies)
    {
        const string Comment = "// error: enumerator has no value";
        if (!document.Text.Contains(Comment, StringComparison.Ordinal))
        {
            return WriteReply(document, bodies);
        }

        StringBuilder text = new();
        List<(int Start, int Length)> removed = [];
        int lineStart = 0;
        foreach (string line in document.Text.Split('\n'))
        {
            if (line.Trim() == Comment)
            {
                removed.Add((lineStart, line.Length + 1));
            }
            else
            {
                text.Append(line).Append('\n');
            }

            lineStart += line.Length + 1;
        }

        int MoveBack(int offset)
        {
            return offset - removed.Where(line => line.Start < offset).Sum(line => line.Length);
        }

        int[] tokens = [.. document.Tokens];
        for (int token = 0; token < tokens.Length; token += 5)
        {
            tokens[token] = MoveBack(tokens[token]);
        }

        int[] movedBodies = [.. bodies.Select((value, position) => position % 2 == 1 ? MoveBack(value) : value)];

        return WriteReply(document with { Text = text.ToString(0, text.Length - 1), Tokens = tokens }, movedBodies);
    }

    private static StubDocumentReply WriteReply(Dotnet.Document document, int[] bodies)
    {
        DocumentReply reply = DocumentReply.From(document);

        return new(reply.Text, reply.Tokens, reply.Targets, reply.Locals, bodies);
    }

    // turns the `extern` that the decompiler writes on a member without a body into an empty body, or on a property or
    // an event into empty bodies of its accessors when asked, or else into nothing, which reads like `{ get; set; }`,
    // also for an auto-property, because its accessors only read and write its backing field
    private static void GiveEmptyBodies(SyntaxTree syntaxTree, bool expandsAccessors)
    {
        IEnumerable<EntityDeclaration> externDeclarations = syntaxTree.Descendants
            .OfType<EntityDeclaration>()
            .Where(entity => entity.HasModifier(Modifiers.Extern));
        foreach (EntityDeclaration declaration in externDeclarations)
        {
            declaration.Modifiers &= ~Modifiers.Extern;

            switch (declaration)
            {
                case MethodDeclaration method:
                    method.Body = new BlockStatement();
                    break;
                case ConstructorDeclaration constructor:
                    constructor.Body = new BlockStatement();
                    break;
                case DestructorDeclaration destructor:
                    destructor.Body = new BlockStatement();
                    break;
                case OperatorDeclaration @operator:
                    @operator.Body = new BlockStatement();
                    break;
                case PropertyDeclaration or IndexerDeclaration or CustomEventDeclaration when expandsAccessors && !IsAutoProperty(declaration):
                    foreach (Accessor accessor in declaration.Children.OfType<Accessor>())
                    {
                        accessor.Body = new BlockStatement();
                    }

                    break;
            }
        }
    }

    // finds a property with the backing field that the compiler gives the type of an auto-property
    private static bool IsAutoProperty(EntityDeclaration declaration)
    {
        return declaration.GetSymbol() is IProperty { DeclaringTypeDefinition: { } type } property
            && type.Fields.Any(field => field.Name == $"<{property.Name}>k__BackingField");
    }
}
