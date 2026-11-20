using ICSharpCode.Decompiler;
using ICSharpCode.Decompiler.CSharp;
using ICSharpCode.Decompiler.CSharp.OutputVisitor;
using ICSharpCode.Decompiler.CSharp.Syntax;
using ICSharpCode.Decompiler.Disassembler;
using ICSharpCode.Decompiler.IL;
using ICSharpCode.Decompiler.Metadata;
using ICSharpCode.Decompiler.Semantics;
using ICSharpCode.Decompiler.TypeSystem;
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Reflection.Metadata;

namespace Decomp.Dotnet;

/// <summary>
///     Writes the C# of a syntax tree with a token for each name of a symbol and for the keyword that declares an
///     operator or an indexer.
/// </summary>
internal sealed class CSharpOutput : ITextOutput, IDisposable
{
    private readonly StringWriter _writer = new(CultureInfo.InvariantCulture);
    private readonly PlainTextOutput _output;
    private readonly DocumentTokens _tokens;
    private readonly CSharpFormattingOptions _formattingOptions;

    // keeps a token only while the token writer writes a name, because the decompiler also passes the symbols of
    // keywords like `string` and of punctuation like the `;` of an accessor
    private bool _isWritingName;

    // starts the token at the name's first text, so the token of a name like `@class` covers the `@` and leaves out the
    // indentation that the output writes before a line's first text
    private int _nameStart;

    private CSharpOutput(Targets targets, CSharpFormattingOptions formattingOptions)
    {
        _output = new(_writer);
        _tokens = new(targets, Rows.CSharpView);
        _formattingOptions = formattingOptions;
    }

    public string IndentationString
    {
        get => _output.IndentationString;
        set => _output.IndentationString = value;
    }

    private int NameLength => _writer.GetStringBuilder().Length - _nameStart;

    /// <summary>
    ///     Writes the C# of a syntax tree with the tokens of its names and their targets.
    /// </summary>
    public static Document Write(SyntaxTree syntaxTree, DecompilerSettings settings, Targets targets)
    {
        using CSharpOutput output = new(targets, settings.CSharpFormattingOptions);
        NameTokenWriter tokenWriter = new(new TextTokenWriter(output, settings), output);

        syntaxTree.AcceptVisitor(new CSharpOutputVisitor(tokenWriter, settings.CSharpFormattingOptions));

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
        MarkNameStart(1);
    }

    public void Write(string text)
    {
        _output.Write(text);
        MarkNameStart(text.Length);
    }

    public void WriteLine()
    {
        _output.WriteLine();
    }

    public void WriteReference(OpCodeInfo opCode, bool omitSuffix = false)
    {
        _output.WriteReference(opCode, omitSuffix);
    }

    public void WriteReference(MetadataFile metadata, Handle handle, string text, string protocol = "decompile", bool isDefinition = false)
    {
        Write(text);
    }

    public void WriteReference(IType type, string text, bool isDefinition = false)
    {
        Write(text);

        if (_isWritingName)
        {
            _tokens.AddType(_nameStart, NameLength, type, isDefinition);
        }
    }

    public void WriteReference(IMember member, string text, bool isDefinition = false)
    {
        Write(text);

        if (_isWritingName)
        {
            _tokens.AddMember(_nameStart, NameLength, member, text, isDefinition);
        }
    }

    public void WriteLocalReference(string text, object reference, bool isDefinition = false, bool isHoverOnly = false)
    {
        Write(text);

        if (_isWritingName && GetLocalKind(reference) is { } kind)
        {
            _tokens.Add(_nameStart, NameLength, kind, flags: 0, isDefinition, FindLocalTarget(reference));
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

    // gives a local function the kind of a method because the decompiler passes it like a local variable
    private static SymbolKind? GetLocalKind(object reference)
    {
        return reference switch
        {
            ILVariable { Kind: VariableKind.Parameter } => SymbolKind.Parameter,
            ILVariable => SymbolKind.Local,
            IMethod => SymbolKind.Method,
            _ => null,
        };
    }

    private void MarkNameStart(int textLength)
    {
        if (_isWritingName && _nameStart < 0)
        {
            _nameStart = _writer.GetStringBuilder().Length - textLength;
        }
    }

    // numbers a parameter of an indexer by the indexer and the parameter's position, so the indexer's declaration and
    // the copies of the parameter in its accessors share 1 target
    private string FindLocalTarget(object reference)
    {
        if (reference is ILVariable { Kind: VariableKind.Parameter, Index: int index } parameter
            && parameter.Function?.Method?.AccessorOwner is IProperty { IsIndexer: true } indexer)
        {
            reference = (indexer.MemberDefinition, index);
        }

        return _tokens.FindLocalTarget(reference, () => WriteLocalDeclaration(reference));
    }

    // writes the type of a parameter or a local variable with the name that the token writer writes, because the
    // decompiler can write another name than the variable's, like a verbatim name
    private string WriteLocalDeclaration(object reference)
    {
        IType? type = reference switch
        {
            ILVariable variable => variable.Type,
            (IProperty { Parameters: var parameters }, int index) when index < parameters.Count => parameters[index].Type,
            _ => null,
        };

        if (type is null)
        {
            return reference is IMethod method ? new CSharpAmbience().ConvertSymbol(method) : "";
        }

        string name = _writer.GetStringBuilder().ToString(_nameStart, NameLength);

        return $"{Signatures.WriteType(type, _formattingOptions)} {name}";
    }

    /// <summary>
    ///     Marks the names that it writes for the output, and the keywords that declare an operator or an indexer.
    /// </summary>
    private sealed class NameTokenWriter(
        TokenWriter decoratedWriter,
        CSharpOutput output) : DecoratingTokenWriter(decoratedWriter)
    {
        private readonly Stack<AstNode> _nodes = [];

        public override void StartNode(AstNode node)
        {
            _nodes.Push(node);
            base.StartNode(node);
        }

        public override void EndNode(AstNode node)
        {
            base.EndNode(node);
            _nodes.Pop();
        }

        public override void WriteIdentifier(Identifier identifier)
        {
            int tokenCount = output._tokens.Count;

            WriteName(() => base.WriteIdentifier(identifier));

            if (identifier.Parent is MethodDeclaration { Parent: LocalFunctionDeclarationStatement statement } declaration
                && statement.GetResolveResult() is MemberResolveResult { Member: var localFunction })
            {
                output._tokens.ReplaceLocalDeclaration(localFunction.MemberDefinition, WriteLocalFunction(declaration));
            }

            if (output._tokens.Count == tokenCount && output._nameStart >= 0 && GetUnreferencedKind(identifier) is { } kind)
            {
                bool isDeclaration = identifier.Parent is TypeParameterDeclaration or ParameterDeclaration;
                ResolveResult? resolveResult = identifier.Parent?.GetResolveResult();
                IType? unknownType = resolveResult is TypeResolveResult { Type.Kind: TypeKind.Unknown } ? resolveResult.Type : null;
                string? target = unknownType is null ? FindIndexerParameterTarget(identifier) : output._tokens.Targets.FindTypeTarget(unknownType);
                output._tokens.Add(output._nameStart, output.NameLength, kind, flags: 0, isDeclaration, target);
            }
        }

        // declares an operator at its `operator` keyword and an indexer at its `this` keyword, because C# writes them
        // without a name
        public override void WriteKeyword(string keyword)
        {
            _nodes.TryPeek(out AstNode? node);
            bool isDeclaringKeyword = node is OperatorDeclaration && keyword == "operator" || node is IndexerDeclaration && keyword == "this";
            if (!isDeclaringKeyword || node!.GetSymbol() is not IMember member)
            {
                base.WriteKeyword(keyword);

                return;
            }

            int tokenCount = output._tokens.Count;

            WriteName(() => base.WriteKeyword(keyword));

            if (output._tokens.Count == tokenCount && output._nameStart >= 0)
            {
                output._tokens.AddMember(output._nameStart, output.NameLength, member, keyword, isDeclaration: true);
            }
        }

        // finds the kind of a name that the decompiler writes without a symbol, like a type parameter, a parameter of a
        // method without a body or a type of an assembly that isn't open
        private static SymbolKind? GetUnreferencedKind(Identifier identifier)
        {
            return identifier.Parent switch
            {
                TypeParameterDeclaration => SymbolKind.TypeParameter,
                ParameterDeclaration => SymbolKind.Parameter,
                SimpleType { Parent: Constraint constraint } type when constraint.TypeParameter == type => SymbolKind.TypeParameter,
                { } parent when parent.GetResolveResult() is TypeResolveResult { Type.Kind: TypeKind.TypeParameter } => SymbolKind.TypeParameter,
                { } parent when parent.GetResolveResult() is TypeResolveResult { Type: { Kind: TypeKind.Unknown } type }
                    => SymbolClassifier.GetKind(type),
                _ => null,
            };
        }

        // writes a local function's declaration from the syntax because the decompiler gives the declaration's
        // parameters other names than the method in the metadata
        private static string WriteLocalFunction(MethodDeclaration declaration)
        {
            string typeParameters = declaration.TypeParameters.Count == 0 ? "" : $"<{string.Join(", ", declaration.TypeParameters)}>";

            return $"{declaration.ReturnType} {declaration.Name}{typeParameters}({string.Join(", ", declaration.Parameters)})";
        }

        private void WriteName(Action write)
        {
            output._nameStart = -1;
            output._isWritingName = true;
            write();
            output._isWritingName = false;
        }

        private string? FindIndexerParameterTarget(Identifier identifier)
        {
            if (identifier.Parent is not ParameterDeclaration { Parent: IndexerDeclaration declaration } parameter
                || declaration.GetSymbol() is not IProperty indexer)
            {
                return null;
            }

            return output.FindLocalTarget((indexer.MemberDefinition, declaration.Parameters.TakeWhile(other => other != parameter).Count()));
        }
    }
}
