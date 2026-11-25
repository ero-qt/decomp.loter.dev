using ICSharpCode.Decompiler.TypeSystem;
using System;

namespace Decomp.Dotnet;

/// <summary>
///     The kinds of symbols, with the numbers of <c>kinds</c> in <c>contract/symbols.ts</c>.
/// </summary>
internal enum SymbolKind
{
    Namespace = 0,
    Class = 1,
    Struct = 2,
    Interface = 3,
    Enum = 4,
    Delegate = 5,
    Method = 6,
    Constructor = 7,
    Operator = 8,
    Property = 9,
    Indexer = 10,
    Field = 11,
    EnumMember = 12,
    Event = 13,
    Parameter = 14,
    Local = 15,
    TypeParameter = 16,
    Label = 17,
    Opcode = 18,
    Record = 19,
    Section = 21,
    Reference = 22,
    Resource = 23,
    Keyword = 26,
}

/// <summary>
///     The modifiers of symbols, with the bits of <c>modifiers</c> in <c>contract/symbols.ts</c> above the 4 bits of
///     the accessibility.
/// </summary>
[Flags]
internal enum SymbolModifiers
{
    None = 0,
    Declaration = 1 << 4,
    Document = 1 << 5,
    Static = 1 << 6,
    Abstract = 1 << 7,
    Sealed = 1 << 8,
    Virtual = 1 << 9,
    Override = 1 << 10,
    ReadOnly = 1 << 11,
    Const = 1 << 12,
    Extern = 1 << 13,
    Extension = 1 << 14,
    Volatile = 1 << 19,
}

/// <summary>
///     Finds the kind and the flags of types and members as C# writes them.
/// </summary>
internal static class SymbolClassifier
{
    public static SymbolKind GetKind(ITypeDefinition type)
    {
        return type switch
        {
            { Kind: TypeKind.Class, IsRecord: true } => SymbolKind.Record,
            { Kind: TypeKind.Struct } => SymbolKind.Struct,
            { Kind: TypeKind.Interface } => SymbolKind.Interface,
            { Kind: TypeKind.Enum } => SymbolKind.Enum,
            { Kind: TypeKind.Delegate } => SymbolKind.Delegate,
            _ => SymbolKind.Class,
        };
    }

    /// <summary>
    ///     Finds the kind of a type that a document uses, which is a class for a type of an assembly that isn't open
    ///     because the decompiler doesn't have its definition.
    /// </summary>
    public static SymbolKind GetKind(IType type)
    {
        return type switch
        {
            { Kind: TypeKind.TypeParameter } => SymbolKind.TypeParameter,
            _ when type.GetDefinition() is { } definition => GetKind(definition),
            _ => SymbolKind.Class,
        };
    }

    public static SymbolKind GetKind(IMember member)
    {
        return member switch
        {
            IMethod { IsConstructor: true } => SymbolKind.Constructor,
            IMethod { IsOperator: true } => SymbolKind.Operator,
            IMethod => SymbolKind.Method,
            IProperty { IsIndexer: true } => SymbolKind.Indexer,
            IProperty => SymbolKind.Property,
            IField { DeclaringTypeDefinition.Kind: TypeKind.Enum } => SymbolKind.EnumMember,
            IField => SymbolKind.Field,
            _ => SymbolKind.Event,
        };
    }

    /// <summary>
    ///     Finds the flags of a type or a member, which are its accessibility and the modifiers that C# writes. The
    ///     accessibility's numbers match <c>accessibilities</c> in <c>contract/symbols.ts</c>.
    /// </summary>
    public static int GetFlags(IEntity entity)
    {
        SymbolModifiers modifiers = entity switch
        {
            ITypeDefinition type => GetModifiers(type),
            IField field => GetModifiers(field),
            IMember member => GetModifiers(member),
            _ => SymbolModifiers.None,
        };

        return (int)GetAccessibility(entity) | (int)modifiers;
    }

    // only shows a static class as static because C# writes it without `abstract` and `sealed`
    private static SymbolModifiers GetModifiers(ITypeDefinition type)
    {
        if (type.Kind == TypeKind.Class)
        {
            return type switch
            {
                { IsStatic: true } => SymbolModifiers.Static,
                { IsAbstract: true } => SymbolModifiers.Abstract,
                { IsSealed: true } => SymbolModifiers.Sealed,
                _ => SymbolModifiers.None,
            };
        }

        return type is { Kind: TypeKind.Struct, IsReadOnly: true } ? SymbolModifiers.ReadOnly : SymbolModifiers.None;
    }

    // only shows a constant as const and an enum member without modifiers because C# writes them that way
    private static SymbolModifiers GetModifiers(IField field)
    {
        if (field.DeclaringTypeDefinition?.Kind == TypeKind.Enum)
        {
            return SymbolModifiers.None;
        }

        if (field.IsConst)
        {
            return SymbolModifiers.Const;
        }

        return (field.IsStatic ? SymbolModifiers.Static : SymbolModifiers.None)
            | (field.IsReadOnly ? SymbolModifiers.ReadOnly : SymbolModifiers.None)
            | (field.IsVolatile ? SymbolModifiers.Volatile : SymbolModifiers.None);
    }

    // shows a finalizer without `override` because C# writes a finalizer without modifiers
    private static SymbolModifiers GetModifiers(IMember member)
    {
        if (member is IMethod { IsDestructor: true })
        {
            return SymbolModifiers.None;
        }

        return (member.DeclaringTypeDefinition?.Kind == TypeKind.Interface ? GetInterfaceModifiers(member) : GetClassModifiers(member))
            | (IsExtern(member) ? SymbolModifiers.Extern : SymbolModifiers.None)
            | (member is IMethod { IsExtensionMethod: true } ? SymbolModifiers.Extension : SymbolModifiers.None);
    }

    // shows `abstract` and `virtual` only on a static interface member and `sealed` only on an instance interface
    // member that isn't virtual, because C# writes the other interface members without them
    private static SymbolModifiers GetInterfaceModifiers(IMember member)
    {
        if (member.IsStatic)
        {
            return SymbolModifiers.Static
                | (member.IsAbstract ? SymbolModifiers.Abstract : SymbolModifiers.None)
                | (member.IsVirtual ? SymbolModifiers.Virtual : SymbolModifiers.None);
        }

        bool isSealed = !member.IsAbstract && !member.IsVirtual && member.Accessibility != Accessibility.Private;

        return isSealed ? SymbolModifiers.Sealed : SymbolModifiers.None;
    }

    private static SymbolModifiers GetClassModifiers(IMember member)
    {
        return (member.IsStatic ? SymbolModifiers.Static : SymbolModifiers.None)
            | (member.IsAbstract ? SymbolModifiers.Abstract : SymbolModifiers.None)
            | (member.IsVirtual ? SymbolModifiers.Virtual : SymbolModifiers.None)
            | (member.IsOverride ? SymbolModifiers.Override : SymbolModifiers.None)
            | (member.IsSealed ? SymbolModifiers.Sealed : SymbolModifiers.None);
    }

    // marks a method without a body that isn't abstract as extern, like a method with `DllImport`, and a property or an
    // event by its first accessor, because C# writes `extern` on the property or the event
    private static bool IsExtern(IMember member)
    {
        IMethod? method = member switch
        {
            IMethod self => self,
            IProperty property => property.Getter ?? property.Setter,
            IEvent @event => @event.AddAccessor ?? @event.RemoveAccessor,
            _ => null,
        };

        return method is { HasBody: false, IsAbstract: false };
    }

    // leaves out the accessibility of a finalizer, a static constructor and an explicit interface implementation
    // because C# writes them without one
    private static Accessibility GetAccessibility(IEntity entity)
    {
        bool isWrittenWithoutAccessibility = entity is IMethod { IsDestructor: true }
            or IMethod { IsConstructor: true, IsStatic: true }
            or IMember { IsExplicitInterfaceImplementation: true };

        return isWrittenWithoutAccessibility ? Accessibility.None : entity.Accessibility;
    }
}
