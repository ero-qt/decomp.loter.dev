using ICSharpCode.Decompiler.TypeSystem;
using System;
using System.Collections.Generic;
using System.Globalization;

namespace Decomp.Dotnet;

/// <summary>
///     A document as the worker reads it, with 5 values for each token like <c>Document</c> in
///     <c>contract/document.ts</c>: start, length, kind, flags and the index of its target or -1.
/// </summary>
internal sealed record Document(
    string Text,
    int[] Tokens,
    List<string> Targets,
    List<string> Locals);

/// <summary>
///     Collects the tokens and the targets of a document while an output writes its text.
/// </summary>
/// <param name="targets">Finds the targets of the document's symbols.</param>
/// <param name="view">The bit of the document's view in the views that hide a row.</param>
internal sealed class DocumentTokens(
    ISymbolTargets targets,
    int view)
{
    private const int ValuesPerToken = 5;
    private const int FlagsValue = 3;
    private const int TargetValue = 4;

    private readonly List<int> _values = [];
    private readonly List<string> _targetTexts = [];
    private readonly List<string> _locals = [];

    // target -> its index in the targets
    private readonly Dictionary<string, int> _targetIndexes = [];

    // the reference that the decompiler passes for each name of a local -> the local's number
    private readonly Dictionary<object, int> _localNumbers = [];

    public int Count => _values.Count / ValuesPerToken;

    public ISymbolTargets Targets => targets;

    /// <summary>
    ///     Adds a token with the flags of its symbol, plus the declaration modifier for the token that declares the
    ///     symbol. A token of a row that the view hides doesn't get the modifier, because the page shows no such row.
    /// </summary>
    public void Add(int start, int length, SymbolKind kind, int flags, bool isDeclaration, string? target)
    {
        bool declares = isDeclaration && (target is null || !targets.IsHiddenIn(target, view));
        int declaration = declares ? (int)SymbolModifiers.Declaration : 0;

        _values.AddRange([start, length, (int)kind, flags | declaration, AddTarget(target)]);
    }

    public int GetStart(int token)
    {
        return _values[token * ValuesPerToken];
    }

    public int GetLength(int token)
    {
        return _values[token * ValuesPerToken + 1];
    }

    /// <summary>
    ///     Points a token that the output added earlier at a target.
    /// </summary>
    public void SetTarget(int token, string target)
    {
        _values[token * ValuesPerToken + TargetValue] = AddTarget(target);
    }

    /// <summary>
    ///     Moves the last token before the token at an index, for a token whose place the output only finds after it
    ///     wrote later tokens.
    /// </summary>
    public void MoveLastTo(int token)
    {
        int last = _values.Count - ValuesPerToken;
        int[] moved = [.. _values.GetRange(last, ValuesPerToken)];

        _values.RemoveRange(last, ValuesPerToken);
        _values.InsertRange(token * ValuesPerToken, moved);
    }

    public void AddType(int start, int length, IType type, bool isDeclaration)
    {
        int flags = type.GetDefinition() is { } definition ? SymbolClassifier.GetFlags(definition) : 0;

        Add(start, length, SymbolClassifier.GetKind(type), flags, isDeclaration, targets.FindTypeTarget(type));
    }

    /// <summary>
    ///     Adds the token of a member, with the kind of its type for the name of a constructor or a finalizer because
    ///     C# writes them with the type's name.
    /// </summary>
    public void AddMember(int start, int length, IMember member, string text, bool isDeclaration)
    {
        SymbolKind kind = member is IMethod { IsConstructor: true } or IMethod { IsDestructor: true } && text is not (".ctor" or ".cctor" or "")
            ? SymbolClassifier.GetKind(member.DeclaringType)
            : SymbolClassifier.GetKind(member);

        Add(start, length, kind, SymbolClassifier.GetFlags(member), isDeclaration, targets.FindTarget(member));
    }

    /// <summary>
    ///     Finds the <c>L:&lt;number&gt;</c> target of a local, like a parameter, a local variable or a local function,
    ///     and writes its declaration on its first name.
    /// </summary>
    public string FindLocalTarget(object reference, Func<string> writeDeclaration)
    {
        if (!_localNumbers.TryGetValue(reference, out int number))
        {
            number = _localNumbers.Count;
            _localNumbers.Add(reference, number);
            _locals.Add(writeDeclaration());
        }

        return string.Create(CultureInfo.InvariantCulture, $"L:{number}");
    }

    public void ReplaceLocalDeclaration(object reference, string declaration)
    {
        if (_localNumbers.TryGetValue(reference, out int number))
        {
            _locals[number] = declaration;
        }
    }

    /// <summary>
    ///     Returns the document of the text with the tokens. A local without a declaration token loses its target,
    ///     because the page shows a local's declaration from the document.
    /// </summary>
    public Document ToDocument(string text)
    {
        int[] tokens = [.. _values];
        HashSet<int> declaredTargets = [];
        for (int token = 0; token < tokens.Length; token += ValuesPerToken)
        {
            if ((tokens[token + FlagsValue] & (int)SymbolModifiers.Declaration) != 0)
            {
                declaredTargets.Add(tokens[token + TargetValue]);
            }
        }

        for (int token = 0; token < tokens.Length; token += ValuesPerToken)
        {
            int target = tokens[token + TargetValue];
            if (target >= 0 && _targetTexts[target].StartsWith("L:", StringComparison.Ordinal) && !declaredTargets.Contains(target))
            {
                tokens[token + TargetValue] = -1;
            }
        }

        return new(text, tokens, _targetTexts, _locals);
    }

    private int AddTarget(string? target)
    {
        if (target is null)
        {
            return -1;
        }

        if (!_targetIndexes.TryGetValue(target, out int index))
        {
            index = _targetTexts.Count;
            _targetTexts.Add(target);
            _targetIndexes.Add(target, index);
        }

        return index;
    }
}
