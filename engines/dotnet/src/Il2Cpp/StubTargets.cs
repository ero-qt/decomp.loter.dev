using System.Reflection.Metadata;
using System.Reflection.Metadata.Ecma335;
using Decomp.Dotnet;
using ICSharpCode.Decompiler.TypeSystem;

namespace Decomp.Il2Cpp;

/// <summary>
///     Provides the first key of each kind of row, like <c>firstKeys</c> in <c>rows.ts</c>. A type's key is its index. A
///     member's key is its kind's first key plus the member's index among all members of that kind in the metadata.
/// </summary>
internal static class RowKeys
{
    public const int Field = 0x10000000;
    public const int Method = 0x20000000;
    public const int Property = 0x30000000;
}

/// <summary>
///     Finds the row targets of the symbols in the stub modules of an open game, so a name in a stub opens the row of
///     its type or member in any image of the game.
/// </summary>
internal sealed class StubTargets(
    int fileId,
    GameStubs stubs,
    GameIndex index) : ISymbolTargets
{
    public string? FindTypeTarget(IType type)
    {
        return type.GetDefinition() is { } definition ? FindTarget(definition) : null;
    }

    public string? FindTarget(IEntity entity)
    {
        IEntity definition = entity is IMember member ? member.MemberDefinition : entity;

        return FindKey(definition) is int key ? Targets.FormatRowTarget(fileId, key) : null;
    }

    public bool IsHiddenIn(string target, int view)
    {
        return false;
    }

    /// <summary>
    ///     Finds the row key of a type or a member of a stub module. The type <c>&lt;Module&gt;</c> and an enum's value
    ///     field don't have rows, like a member of a type that the module only has the name of.
    /// </summary>
    public int? FindKey(IEntity definition)
    {
        if (definition.ParentModule?.MetadataFile is not { } file || stubs.FindStub(file) is not { } stub || definition.MetadataToken.IsNil)
        {
            return null;
        }

        int row = MetadataTokens.GetRowNumber(definition.MetadataToken);
        bool isOpened = stub.OpenedType >= 0;

        return definition.MetadataToken.Kind switch
        {
            HandleKind.TypeDefinition when definition is not ITypeDefinition { Name: "<Module>", Namespace: "" } => stub.FirstType + row - 1,
            HandleKind.FieldDefinition when isOpened && definition is not IField { DeclaringTypeDefinition.Kind: TypeKind.Enum, IsConst: false }
                => RowKeys.Field + index.FirstFields[stub.OpenedType] + row - 1,
            HandleKind.MethodDefinition when row <= stub.MethodIndexes.Length => RowKeys.Method + stub.MethodIndexes[row - 1],
            HandleKind.PropertyDefinition when isOpened => RowKeys.Property + index.FirstProperties[stub.OpenedType] + row - 1,
            _ => null,
        };
    }
}
