using ICSharpCode.Decompiler;
using ICSharpCode.Decompiler.CSharp.OutputVisitor;
using ICSharpCode.Decompiler.Metadata;
using ICSharpCode.Decompiler.Output;
using ICSharpCode.Decompiler.TypeSystem;
using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection.Metadata.Ecma335;
using System.Threading.Tasks;

namespace Decomp.Dotnet;

/// <summary>
///     The rows of a file's tree with 5 values for each row, like <c>Rows</c> in <c>contract/rows.ts</c>: kind, flags,
///     parent, key and the views that hide the row, and the count of symbols that the engine can't read.
/// </summary>
internal sealed record Rows(
    int[] Values,
    List<string> Names,
    List<string> Details,
    int SkippedCount)
{
    private const int ValuesPerRow = 5;

    /// <summary>
    ///     The bit of the view csharp in the views that hide a row, which is the manifest's first view.
    /// </summary>
    public const int CSharpView = 1;

    /// <summary>
    ///     The bit of the view il in the views that hide a row, which is the manifest's second view.
    /// </summary>
    public const int IlView = 2;

    // key -> the index of its row, built on the first lookup
    private Dictionary<int, int>? _indexes;

    public int? FindIndex(int key)
    {
        if (_indexes is null)
        {
            _indexes = [];
            for (int index = 0; index < Names.Count; index++)
            {
                _indexes.Add(Values[index * ValuesPerRow + 3], index);
            }
        }

        return _indexes.TryGetValue(key, out int found) ? found : null;
    }

    public int GetFlags(int index)
    {
        return Values[index * ValuesPerRow + 1];
    }

    public int GetHiddenViews(int index)
    {
        return Values[index * ValuesPerRow + 4];
    }
}

/// <summary>
///     Lists the sections of a module and the namespaces, types and members that C# declares, the sections first, each
///     namespace before its first type and each type before its members and nested types.
/// </summary>
internal sealed class SymbolRows(
    MetadataFile file,
    DecompilerSettings settings)
{
    // writes a member with its type parameters and parameter types, like `Map<TResult>(Func<T, TResult>)`, because
    // overloads then differ
    private static readonly CSharpAmbience _memberAmbience = new()
    {
        ConversionFlags = ConversionFlags.ShowTypeParameterList | ConversionFlags.ShowParameterList,
    };

    // writes a type with only its type parameters, because the parameter list of a delegate isn't part of its name
    private static readonly CSharpAmbience _typeAmbience = new() { ConversionFlags = ConversionFlags.ShowTypeParameterList };

    private readonly List<int> _values = [];
    private readonly List<string> _names = [];
    private readonly List<string> _details = [];

    private readonly HashSet<int> _keys = [];

    private int _skippedCount;

    // namespace -> the index of its row
    private readonly Dictionary<string, int> _namespaceRows = [];

    /// <summary>
    ///     Checks whether a row's key is a namespace's number, whose top byte is 0 where a metadata token has its
    ///     table.
    /// </summary>
    public static bool IsNamespaceKey(int key)
    {
        return key >>> 24 == 0;
    }

    /// <summary>
    ///     Lists the rows of a module, with a check of the cancellation before each top-level type.
    /// </summary>
    public static async ValueTask<Rows> ListAsync(MetadataFile file, IModule module, DecompilerSettings settings, Cancellation? cancellation)
    {
        SymbolRows rows = new(file, settings);

        foreach (Section section in FileSections.List(file))
        {
            int sectionRow = rows.Add(SymbolKind.Section, flags: 0, parent: -1, section.Key, section.Name, detail: "", hiddenViews: 0);
            foreach (SectionRow row in section.Rows)
            {
                rows.Add(row.Kind, row.Flags, sectionRow, row.Key, row.Name, row.Detail, hiddenViews: 0);
            }
        }

        foreach (ITypeDefinition type in module.TopLevelTypeDefinitions)
        {
            if (cancellation is not null)
            {
                await cancellation.CheckAsync();
            }

            // leaves out the first TypeDef row without members because ECMA-335 II.22.37 makes it the `<Module>` type,
            // which every module has
            if (MetadataTokens.GetRowNumber(type.MetadataToken) != 1 || type.Members.Any())
            {
                rows.AddType(type, rows.FindNamespaceRow(type.Namespace), SymbolModifiers.Document, parentHiddenViews: 0);
            }
        }

        return new([.. rows._values], rows._names, rows._details, rows._skippedCount);
    }

    // writes the value of an enum member and of a constant because the tree shows it beside the name
    private static string WriteDetail(IMember member)
    {
        return member is IField { IsConst: true } field && field.GetConstantValue() is { } value
            ? TextWriterTokenWriter.PrintPrimitiveValue(value)
            : "";
    }

    // puts a type of the global namespace at the top because the global namespace doesn't have a name to show, and
    // numbers the namespaces from 1 because a key with the top byte 0 isn't a metadata token
    private int FindNamespaceRow(string name)
    {
        if (name.Length == 0)
        {
            return -1;
        }

        if (!_namespaceRows.TryGetValue(name, out int row))
        {
            row = Add(SymbolKind.Namespace, flags: 0, parent: -1, key: _namespaceRows.Count + 1, name, detail: "", hiddenViews: 0);
            _namespaceRows.Add(name, row);
        }

        return row;
    }

    // hides a type or a member that C# doesn't declare in the view csharp, and the rows in a hidden type, because only
    // the view il declares them, and skips a type that a crafted NestedClass table nests in a second type, because each
    // row needs a key of its own
    private void AddType(ITypeDefinition type, int parent, SymbolModifiers document, int parentHiddenViews)
    {
        int key = MetadataTokens.GetToken(type.MetadataToken);
        if (!_keys.Add(key))
        {
            _skippedCount++;

            return;
        }

        int hiddenViews = 0;
        int? typeRow = AddReadable(() =>
        {
            hiddenViews = parentHiddenViews | (DeclarationRules.IsDeclared(file, type, settings) ? 0 : Rows.CSharpView);

            return Add(
                SymbolClassifier.GetKind(type),
                SymbolClassifier.GetFlags(type) | (int)document,
                parent,
                key,
                _typeAmbience.ConvertSymbol(type),
                detail: "",
                hiddenViews);
        });
        if (typeRow is not int row)
        {
            return;
        }

        foreach (IMember member in type.Members)
        {
            int memberRow = AddMember(member, row, hiddenViews);
            foreach (IMethod accessor in ListAccessors(member))
            {
                AddMember(accessor, memberRow, hiddenViews);
            }
        }

        foreach (ITypeDefinition nestedType in type.NestedTypes)
        {
            AddType(nestedType, row, SymbolModifiers.None, hiddenViews);
        }
    }

    // lists the accessors of a property or an event for rows below it, like ILSpy's tree, because the type's members
    // leave them out
    private static IEnumerable<IMethod> ListAccessors(IMember member)
    {
        IMethod?[] accessors = member switch
        {
            IProperty property => [property.Getter, property.Setter],
            IEvent @event => [@event.AddAccessor, @event.RemoveAccessor, @event.InvokeAccessor],
            _ => [],
        };

        return accessors.OfType<IMethod>();
    }

    // skips a member without a token or with a token that already has a row, like an accessor that 2 properties share
    // in a crafted file, because each row needs a key of its own
    private int AddMember(IMember member, int parent, int typeHiddenViews)
    {
        int key = MetadataTokens.GetToken(member.MetadataToken);
        if (member.MetadataToken.IsNil || !_keys.Add(key))
        {
            return parent;
        }

        int? memberRow = AddReadable(() =>
        {
            int hiddenViews = typeHiddenViews | (DeclarationRules.IsDeclared(file, member, settings) ? 0 : Rows.CSharpView);

            return Add(
                SymbolClassifier.GetKind(member),
                SymbolClassifier.GetFlags(member),
                parent,
                key,
                _memberAmbience.ConvertSymbol(member),
                WriteDetail(member),
                hiddenViews);
        });

        return memberRow ?? parent;
    }

    // counts and skips a symbol whose metadata or IL the engine can't read, like MethodBodyScanner, so the file's other
    // rows stay listed, and catches every exception because the decompiler throws many types for broken metadata
    private int? AddReadable(Func<int> add)
    {
        try
        {
            return add();
        }
        catch (Exception)
        {
            _skippedCount++;

            return null;
        }
    }

    private int Add(SymbolKind kind, int flags, int parent, int key, string name, string detail, int hiddenViews)
    {
        _values.AddRange([(int)kind, flags, parent, key, hiddenViews]);
        _names.Add(name);
        _details.Add(detail);

        return _names.Count - 1;
    }
}
