using ICSharpCode.Decompiler;
using ICSharpCode.Decompiler.CSharp;
using ICSharpCode.Decompiler.Metadata;
using ICSharpCode.Decompiler.TypeSystem;
using System;
using System.Linq;
using System.Reflection;
using System.Reflection.Metadata;
using System.Reflection.Metadata.Ecma335;

namespace Decomp.Dotnet;

/// <summary>
///     Picks out the types and members that the decompiler's C# declares, so each row that the C# view shows has its
///     declaration.
/// </summary>
internal static class DeclarationRules
{
    // ldarg.0, call with a 4-byte token, the nops of a debug build and ret
    private const byte Nop = 0x00;
    private const byte LoadThis = 0x02;
    private const byte Call = 0x28;
    private const byte Return = 0x2a;
    private const int BaseCallSize = 6;

    /// <summary>
    ///     Checks whether C# declares a type, which it doesn't for the types that the decompiler hides, like the class
    ///     of a lambda or an iterator, whose code shows in the member that uses it.
    /// </summary>
    public static bool IsDeclared(MetadataFile file, ITypeDefinition type, DecompilerSettings settings)
    {
        return !CSharpDecompiler.MemberIsHidden(file, type.MetadataToken, settings);
    }

    /// <summary>
    ///     Checks whether C# declares a member of a declared type.
    /// </summary>
    public static bool IsDeclared(MetadataFile file, IMember member, DecompilerSettings settings)
    {
        return !member.MetadataToken.IsNil
            && !IsWrittenElsewhere(member)
            && !member.HasAttribute(KnownAttribute.CompilerGenerated)
            && !CSharpDecompiler.MemberIsHidden(file, member.MetadataToken, settings)
            && !IsFieldInitializer(file, member)
            && !IsDefaultConstructor(file, member);
    }

    // leaves out the accessors because their property or event shows, an enum's value field because C# only shows the
    // constants, and a delegate's members because C# declares a delegate without a body
    private static bool IsWrittenElsewhere(IMember member)
    {
        return member is IMethod { IsAccessor: true }
            or IField { DeclaringTypeDefinition.Kind: TypeKind.Enum, IsConst: false }
            or { DeclaringTypeDefinition.Kind: TypeKind.Delegate };
    }

    // leaves out the static constructor of a `beforefieldinit` type because C# then only made it for field
    // initializers, which the decompiler moves to the fields
    private static bool IsFieldInitializer(MetadataFile file, IMember member)
    {
        if (member is not IMethod { IsConstructor: true, IsStatic: true } || member.DeclaringTypeDefinition is not { } type)
        {
            return false;
        }

        TypeDefinition definition = file.Metadata.GetTypeDefinition((TypeDefinitionHandle)type.MetadataToken);

        return definition.Attributes.HasFlag(TypeAttributes.BeforeFieldInit);
    }

    // leaves out a type's only instance constructor when it takes nothing, has the accessibility of a default
    // constructor, no attributes and a body that ends with the call of the base constructor and nops, because the
    // decompiler moves the field initializers before that call to the fields, drops the nops and then the empty
    // constructor
    private static bool IsDefaultConstructor(MetadataFile file, IMember member)
    {
        if (member is not IMethod { IsConstructor: true, IsStatic: false, Parameters.Count: 0 } constructor
            || constructor.DeclaringTypeDefinition is not { } type
            || type.Methods.Count(method => method.IsConstructor && !method.IsStatic) != 1
            || constructor.Accessibility != (type.IsAbstract ? Accessibility.Protected : Accessibility.Public)
            || constructor.GetAttributes().Any())
        {
            return false;
        }

        MethodDefinition definition = file.Metadata.GetMethodDefinition((MethodDefinitionHandle)constructor.MetadataToken);
        if (definition.RelativeVirtualAddress == 0 || !MethodBodyScanner.HasIl(definition))
        {
            return false;
        }

        byte[]? il = file.GetMethodBody(definition.RelativeVirtualAddress).GetILBytes();
        if (il is null || il.Length == 0 || il[^1] != Return)
        {
            return false;
        }

        // skips the nops before ret, which can't end the call because a method token's last byte is its table
        int callEnd = il.Length - 1;
        while (callEnd > 0 && il[callEnd - 1] == Nop)
        {
            callEnd--;
        }

        if (callEnd < BaseCallSize || il[callEnd - BaseCallSize] != LoadThis || il[callEnd - BaseCallSize + 1] != Call)
        {
            return false;
        }

        // checks that the call isn't `this()` because a constructor that calls another one isn't empty
        MetadataModule module = (MetadataModule)type.ParentModule!;
        int token = BitConverter.ToInt32(il, callEnd - 4);
        IMethod called = module.ResolveMethod(MetadataTokens.EntityHandle(token), default);

        return called is { IsConstructor: true, Parameters.Count: 0 } && !type.Equals(called.DeclaringTypeDefinition);
    }
}
