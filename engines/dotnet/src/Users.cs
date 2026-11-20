using ICSharpCode.Decompiler.CSharp;
using ICSharpCode.Decompiler.Metadata;
using ICSharpCode.Decompiler.TypeSystem;
using ICSharpCode.Decompiler.TypeSystem.Implementation;
using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection.Metadata;
using System.Reflection.Metadata.Ecma335;
using System.Threading.Tasks;

namespace Decomp.Dotnet;

/// <summary>
///     An open file that a search for users reads, with its rows and the targets of the symbols that it uses.
/// </summary>
internal sealed record SearchedFile(
    int FileId,
    PEFile File,
    MetadataModule Module,
    Rows Rows,
    Targets Targets);

/// <summary>
///     Finds the rows whose code uses a symbol, as row targets.
/// </summary>
/// <param name="target">The target of the used symbol, a row target or an outside target.</param>
/// <param name="isType">Whether the used symbol is a type.</param>
internal sealed class Users(
    string target,
    bool isType)
{
    private readonly List<string> _users = [];
    private readonly HashSet<string> _foundUsers = [];

    /// <summary>
    ///     Finds the users of a symbol in the method bodies of the files and, for a type, in the signatures that name
    ///     it. A call of an accessor counts as a use of its property or event and, for a type, a use of a member counts
    ///     as a use of the type.
    /// </summary>
    public static async Task<List<string>> FindAsync(string target, bool isType, IEnumerable<SearchedFile> files, Cancellation cancellation)
    {
        Users search = new(target, isType);

        // leaves out the rest of a file whose metadata the decompiler can't read, but not a cancel, so a broken file
        // doesn't hide the uses in the other files, and catches every exception because the decompiler throws many
        // types for broken metadata
        foreach (SearchedFile file in files)
        {
            try
            {
                await search.SearchFileAsync(file, cancellation);
            }
            catch (Exception exception) when (exception is not CanceledCallException)
            {
            }
        }

        return search._users;
    }

    // finds the definition of the type or the member that an instruction's token operand points at, with the generic
    // definition of a generic instance, or null for an operand that the type system can't resolve
    private static object? ResolveOperand(MetadataModule module, int token)
    {
        try
        {
            EntityHandle handle = MetadataTokens.EntityHandle(token);

            return handle.Kind switch
            {
                HandleKind.TypeDefinition or HandleKind.TypeReference or HandleKind.TypeSpecification => module.ResolveType(handle, default),
                HandleKind.MethodDefinition or HandleKind.MethodSpecification or HandleKind.MemberReference or HandleKind.FieldDefinition
                    => (module.ResolveEntity(handle, default) as IMember)?.MemberDefinition,
                _ => null,
            };
        }
        catch (Exception exception) when (exception is BadImageFormatException or ArgumentException or InvalidOperationException)
        {
            return null;
        }
    }

    private async Task SearchFileAsync(SearchedFile file, Cancellation cancellation)
    {
        UserRows userRows = new(file);

        foreach (TokenInstruction instruction in await MethodBodyScanner.ReadTokenInstructionsAsync(file.File, cancellation))
        {
            await cancellation.CheckAsync();
            if (instruction.OpCode != ILOpCode.Ldstr && Uses(file.Targets, ResolveOperand(file.Module, instruction.Token)))
            {
                Add(userRows.FindMethodUser(instruction.Method));
            }
        }

        if (!isType)
        {
            return;
        }

        foreach (ITypeDefinition? type in file.Module.TypeDefinitions)
        {
            await cancellation.CheckAsync();
            if (type.DirectBaseTypes.Any(baseType => Names(file.Targets, baseType)))
            {
                Add(userRows.FindTypeUser((TypeDefinitionHandle)type.MetadataToken));
            }

            foreach (IMember? member in type.Members.Where(member => NamesInSignature(file.Targets, member)))
            {
                Add(userRows.FindMemberUser(member));
            }
        }
    }

    private bool Uses(Targets targets, object? used)
    {
        return used switch
        {
            IType type => targets.FindTypeTarget(type) == target,
            IMember member => targets.FindTarget(member) == target
                || member is IMethod { AccessorOwner: { } owner } && targets.FindTarget(owner) == target
                || isType && targets.FindTypeTarget(member.DeclaringType) == target,
            _ => false,
        };
    }

    private bool NamesInSignature(Targets targets, IMember member)
    {
        return Names(targets, member.ReturnType)
            || member is IParameterizedMember { Parameters: var parameters } && parameters.Any(parameter => Names(targets, parameter.Type));
    }

    private bool Names(Targets targets, IType type)
    {
        return type switch
        {
            TypeWithElementType element => Names(targets, element.ElementType),
            ParameterizedType generic => Names(targets, generic.GenericType) || generic.TypeArguments.Any(argument => Names(targets, argument)),
            _ => targets.FindTypeTarget(type) == target,
        };
    }

    private void Add(string? user)
    {
        if (user is not null && _foundUsers.Add(user))
        {
            _users.Add(user);
        }
    }
}

/// <summary>
///     Finds the row that the tree shows for code of a file: a member's own row, the property or the event of an
///     accessor, the method that a lambda, a local function or a state machine is part of, or else the nearest type
///     row.
/// </summary>
internal sealed class UserRows(
    SearchedFile file)
{
    // top-level type -> the methods that the decompiler writes into the methods of the type
    private readonly Dictionary<TypeDefinitionHandle, CodeMappingInfo> _mappings = [];

    public string? FindMethodUser(MethodDefinitionHandle handle)
    {
        if (FindOwnRow(file.Module.GetDefinition(handle)) is { } user)
        {
            return user;
        }

        MethodDefinitionHandle parent = GetMapping(handle).GetParentMethod(handle);
        if (!parent.IsNil && parent != handle && FindOwnRow(file.Module.GetDefinition(parent)) is { } parentUser)
        {
            return parentUser;
        }

        return FindTypeUser(file.File.Metadata.GetMethodDefinition(handle).GetDeclaringType());
    }

    public string? FindMemberUser(IMember member)
    {
        return FindOwnRow(member) ?? (member.DeclaringTypeDefinition is { } type ? FindTypeUser((TypeDefinitionHandle)type.MetadataToken) : null);
    }

    public string? FindTypeUser(TypeDefinitionHandle type)
    {
        MetadataReader metadata = file.File.Metadata;

        for (int depth = 0; depth <= Limits.MaxNestingDepth && !type.IsNil; depth++)
        {
            if (FindRowTarget(MetadataTokens.GetToken(type)) is { } user)
            {
                return user;
            }

            type = metadata.GetTypeDefinition(type).GetDeclaringType();
        }

        return null;
    }

    private string? FindOwnRow(IMember member)
    {
        IMember shown = member is IMethod { AccessorOwner: { } owner } ? owner : member;

        return FindRowTarget(MetadataTokens.GetToken(shown.MetadataToken));
    }

    // skips a row that the view csharp hides because the tree leaves it out
    private string? FindRowTarget(int key)
    {
        return file.Rows.FindIndex(key) is int index && (file.Rows.GetHiddenViews(index) & Rows.CSharpView) == 0
            ? Targets.FormatRowTarget(file.FileId, key)
            : null;
    }

    // reads the mapping of the nearest type that the compiler didn't make, like the class of a lambda, because the
    // methods of that type use the made types
    private CodeMappingInfo GetMapping(MethodDefinitionHandle method)
    {
        MetadataReader metadata = file.File.Metadata;
        TypeDefinitionHandle type = metadata.GetMethodDefinition(method).GetDeclaringType();
        for (int depth = 0; depth < Limits.MaxNestingDepth && IsMadeByCompiler(type) && !GetDeclaringType(type).IsNil; depth++)
        {
            type = GetDeclaringType(type);
        }

        if (!_mappings.TryGetValue(type, out CodeMappingInfo? mapping))
        {
            mapping = CSharpDecompiler.GetCodeMappingInfo(file.File, type);
            _mappings.Add(type, mapping);
        }

        return mapping;
    }

    private bool IsMadeByCompiler(TypeDefinitionHandle type)
    {
        MetadataReader metadata = file.File.Metadata;

        return metadata.GetString(metadata.GetTypeDefinition(type).Name).StartsWith('<');
    }

    private TypeDefinitionHandle GetDeclaringType(TypeDefinitionHandle type)
    {
        return file.File.Metadata.GetTypeDefinition(type).GetDeclaringType();
    }
}
