using ICSharpCode.Decompiler;
using ICSharpCode.Decompiler.Disassembler;
using ICSharpCode.Decompiler.Metadata;
using ICSharpCode.Decompiler.TypeSystem;
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Reflection.Metadata;
using System.Text;
using System.Threading;

namespace Decomp.Dotnet;

/// <summary>
///     Writes the IL of a type with a token for each opcode, label, parameter, local variable, type and member that the
///     disassembler writes as a reference.
/// </summary>
internal sealed class IlOutput : ITextOutput, IDisposable
{
    private readonly StringWriter _writer = new(CultureInfo.InvariantCulture);
    private readonly PlainTextOutput _output;
    private readonly DocumentTokens _tokens;
    private readonly MetadataModule _module;

    // label -> the indexes of its tokens, because a label gets a target only once a branch uses it and a branch can
    // come after the label
    private readonly Dictionary<(Handle Method, int Offset), List<int>> _labelTokens = [];
    private readonly HashSet<(Handle Method, int Offset)> _branchTargets = [];

    // keeps the method whose IL the output writes, because the disassembler passes the same references for the labels,
    // parameters and local variables of each method
    private Handle _method;

    // keeps the type or the member whose header the output writes until the disassembler writes its name
    private PendingDeclaration? _declaration;

    private IlOutput(MetadataModule module, Targets targets)
    {
        _output = new(_writer);
        _tokens = new(targets, Rows.IlView);
        _module = module;
    }

    public string IndentationString
    {
        get => _output.IndentationString;
        set => _output.IndentationString = value;
    }

    private int Position => _writer.GetStringBuilder().Length;

    /// <summary>
    ///     Writes the IL of a type with the tokens of its references and their targets.
    /// </summary>
    public static Document Write(TypeDefinitionHandle type, MetadataModule module, Targets targets)
    {
        using IlOutput output = new(module, targets);

        new ReflectionDisassembler(output, CancellationToken.None).DisassembleType(module.MetadataFile, type);

        output.FinishDeclaration();
        output.AddLabelTargets();

        return output._tokens.ToDocument(output._writer.ToString());
    }

    public void Indent()
    {
        _output.Indent();
    }

    public void Unindent()
    {
        _output.Unindent();
    }

    public void Write(char ch)
    {
        _output.Write(ch);
    }

    public void Write(string text)
    {
        int position = Position;
        _output.Write(text);

        if (_declaration is not null)
        {
            (int start, int length) = FindWritten(position);
            DeclareName(start, _writer.GetStringBuilder().ToString(start, length));
        }
    }

    public void WriteLine()
    {
        _output.WriteLine();
    }

    public void WriteReference(OpCodeInfo opCode, bool omitSuffix = false)
    {
        FinishDeclaration();
        int position = Position;
        _output.WriteReference(opCode, omitSuffix);
        (int start, int length) = FindWritten(position);

        _tokens.Add(start, length, SymbolKind.Opcode, flags: 0, isDeclaration: false, target: null);
    }

    // starts the declaration of a type or a member at its definition, which the disassembler passes with the text of
    // its directive, like `.method`
    public void WriteReference(MetadataFile metadata, Handle handle, string text, string protocol = "decompile", bool isDefinition = false)
    {
        int position = Position;
        _output.WriteReference(metadata, handle, text, protocol, isDefinition);
        (int start, int length) = FindWritten(position);

        if (isDefinition && handle.Kind == HandleKind.MethodDefinition)
        {
            _method = handle;
        }

        if (metadata != _module.MetadataFile)
        {
            return;
        }

        if (isDefinition)
        {
            StartDeclaration(handle, start, length);

            return;
        }

        switch (handle.Kind)
        {
            case HandleKind.TypeDefinition or HandleKind.TypeReference or HandleKind.TypeSpecification:
                _tokens.AddType(start, length, _module.ResolveType((EntityHandle)handle, default), isDeclaration: false);
                break;
            case HandleKind.MethodDefinition
                or HandleKind.MemberReference
                or HandleKind.MethodSpecification
                or HandleKind.FieldDefinition
                or HandleKind.PropertyDefinition
                or HandleKind.EventDefinition:
                if (_module.ResolveEntity((EntityHandle)handle, default) is IMember member)
                {
                    _tokens.AddMember(start, length, member, text, isDeclaration: false);
                }

                break;
        }
    }

    public void WriteReference(IType type, string text, bool isDefinition = false)
    {
        _output.WriteReference(type, text, isDefinition);
    }

    public void WriteReference(IMember member, string text, bool isDefinition = false)
    {
        _output.WriteReference(member, text, isDefinition);
    }

    // picks the kind by the reference that the disassembler passes, which is a label's offset or a text like
    // `param_1` for a parameter or `loc_0` for a local variable
    public void WriteLocalReference(string text, object reference, bool isDefinition = false, bool isHoverOnly = false)
    {
        FinishDeclaration();
        int position = Position;
        _output.WriteLocalReference(text, reference, isDefinition, isHoverOnly);
        (int start, int length) = FindWritten(position);

        if (reference is int offset)
        {
            AddLabel(start, length, offset, isDefinition);

            return;
        }

        SymbolKind? kind = reference switch
        {
            string name when name.StartsWith("param_", StringComparison.Ordinal) => SymbolKind.Parameter,
            string name when name.StartsWith("loc_", StringComparison.Ordinal) => SymbolKind.Local,
            _ => null,
        };
        if (kind is { } localKind)
        {
            string name = _writer.GetStringBuilder().ToString(start, length);
            _tokens.Add(start, length, localKind, flags: 0, isDefinition, _tokens.FindLocalTarget((_method, reference), () => name));
        }
    }

    public void MarkFoldStart(string collapsedText = "...", bool defaultCollapsed = false, bool isDefinition = false)
    {
    }

    public void MarkDefinitionStart()
    {
    }

    public void MarkFoldEnd()
    {
    }

    public void Dispose()
    {
        _output.Dispose();
        _writer.Dispose();
    }

    // writes the names that the disassembler can write for a definition: a type's name, also with its namespace for a
    // top-level type, or a member's name, each escaped like the disassembler writes it, because a name like `assembly`
    // would match a keyword as it is
    private static string[] WriteNames(MetadataReader metadata, EntityHandle handle)
    {
        string name = handle.Kind switch
        {
            HandleKind.TypeDefinition => metadata.GetString(metadata.GetTypeDefinition((TypeDefinitionHandle)handle).Name),
            HandleKind.MethodDefinition => metadata.GetString(metadata.GetMethodDefinition((MethodDefinitionHandle)handle).Name),
            HandleKind.FieldDefinition => metadata.GetString(metadata.GetFieldDefinition((FieldDefinitionHandle)handle).Name),
            HandleKind.PropertyDefinition => metadata.GetString(metadata.GetPropertyDefinition((PropertyDefinitionHandle)handle).Name),
            _ => metadata.GetString(metadata.GetEventDefinition((EventDefinitionHandle)handle).Name),
        };
        List<string> names = [name];

        if (handle.Kind == HandleKind.TypeDefinition && metadata.GetTypeDefinition((TypeDefinitionHandle)handle) is { Namespace.IsNil: false } type
            && type.GetDeclaringType().IsNil)
        {
            names.Insert(0, $"{metadata.GetString(type.Namespace)}.{name}");
        }

        return [.. names.Select(DisassemblerHelpers.Escape)];
    }

    // finds a name in a written text where it stands alone, not inside a longer word like `float64` for `a`
    private static int FindName(string text, string name)
    {
        for (int index = text.IndexOf(name, StringComparison.Ordinal); index >= 0; index = text.IndexOf(name, index + 1, StringComparison.Ordinal))
        {
            int end = index + name.Length;
            bool startsAlone = index == 0 || char.IsWhiteSpace(text[index - 1]);
            bool endsAlone = end == text.Length || char.IsWhiteSpace(text[end]) || text[end] is '(' or '<';
            if (startsAlone && endsAlone)
            {
                return index;
            }
        }

        return -1;
    }

    private void StartDeclaration(Handle handle, int directiveStart, int directiveLength)
    {
        FinishDeclaration();
        if (handle.Kind is not (HandleKind.TypeDefinition
            or HandleKind.MethodDefinition
            or HandleKind.FieldDefinition
            or HandleKind.PropertyDefinition
            or HandleKind.EventDefinition))
        {
            return;
        }

        EntityHandle entityHandle = (EntityHandle)handle;
        if (_module.ResolveEntity(entityHandle, default) is { } entity)
        {
            string[] names = WriteNames(_module.MetadataFile.Metadata, entityHandle);
            _declaration = new(entity, _tokens.Count, directiveStart, directiveLength, names);
        }
    }

    private void DeclareName(int start, string text)
    {
        foreach (string name in _declaration!.Names)
        {
            if (FindName(text, name) is var index and >= 0)
            {
                AddDeclaration(_declaration.Entity, start + index, name.Length, name);
                _declaration = null;

                return;
            }
        }
    }

    // puts the declaration on the directive when the disassembler didn't write the name before the next header or the
    // body, because each row then still has its declaration
    private void FinishDeclaration()
    {
        if (_declaration is not { } declaration)
        {
            return;
        }

        _declaration = null;
        AddDeclaration(declaration.Entity, declaration.DirectiveStart, declaration.DirectiveLength, text: "");
        _tokens.MoveLastTo(declaration.Token);
    }

    private void AddDeclaration(IEntity entity, int start, int length, string text)
    {
        if (entity is ITypeDefinition type)
        {
            _tokens.AddType(start, length, type, isDeclaration: true);
        }
        else if (entity is IMember member)
        {
            _tokens.AddMember(start, length, member, text, isDeclaration: true);
        }
    }

    private void AddLabel(int start, int length, int offset, bool isDefinition)
    {
        (Handle, int) label = (_method, offset);
        if (!_labelTokens.TryGetValue(label, out List<int>? tokenIndexes))
        {
            tokenIndexes = [];
            _labelTokens.Add(label, tokenIndexes);
        }

        if (!isDefinition)
        {
            _branchTargets.Add(label);
        }

        tokenIndexes.Add(_tokens.Count);
        _tokens.Add(start, length, SymbolKind.Label, flags: 0, isDefinition, target: null);
    }

    // gives the tokens of each label that a branch uses a target, and none to the label of each other instruction,
    // because the page would otherwise keep a local for each instruction
    private void AddLabelTargets()
    {
        foreach (((Handle, int) label, List<int> tokenIndexes) in _labelTokens)
        {
            if (!_branchTargets.Contains(label))
            {
                continue;
            }

            string name = _writer.GetStringBuilder().ToString(_tokens.GetStart(tokenIndexes[0]), _tokens.GetLength(tokenIndexes[0]));
            string target = _tokens.FindLocalTarget(label, () => name);
            foreach (int tokenIndex in tokenIndexes)
            {
                _tokens.SetTarget(tokenIndex, target);
            }
        }
    }

    // finds the text that the output wrote from a position on, without the indentation that it writes before a line's
    // first text
    private (int Start, int Length) FindWritten(int position)
    {
        StringBuilder text = _writer.GetStringBuilder();
        while (position < text.Length && char.IsWhiteSpace(text[position]))
        {
            position++;
        }

        return (position, text.Length - position);
    }

    /// <summary>
    ///     The definition whose name the output waits for, with the index of the token after its directive.
    /// </summary>
    private sealed record PendingDeclaration(
        IEntity Entity,
        int Token,
        int DirectiveStart,
        int DirectiveLength,
        string[] Names);
}
