using ICSharpCode.Decompiler.Documentation;
using ICSharpCode.Decompiler.Metadata;
using ICSharpCode.Decompiler.TypeSystem;
using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection.Metadata;
using System.Reflection.Metadata.Ecma335;
using System.Threading.Tasks;

namespace Decomp.Dotnet;

/// <summary>
///     Describes, resolves and searches the symbols of the open assemblies.
/// </summary>
internal sealed partial class Session
{
    /// <summary>
    ///     Describes the symbol of a row target, or of an outside target from the open file that has it, or else from
    ///     its ID string.
    /// </summary>
    /// <returns>
    ///     The description, or <see langword="null"/> for a local, a target without a row and a target that isn't one.
    /// </returns>
    /// <exception cref="BadImageFormatException">The symbol has metadata that the engine can't read.</exception>
    public Description? Describe(string target, View view)
    {
        if (Targets.ParseRowTarget(target) is var (fileId, key))
        {
            return DescribeRow(fileId, key, view);
        }

        if (Targets.ParseOutsideTarget(target) is not var (assemblyName, idString))
        {
            return null;
        }

        return FindOutsideRow(assemblyName, idString) is var (rowFileId, rowKey)
            ? DescribeRow(rowFileId, rowKey, view)
            : Signatures.DescribeOutside(idString, FindMissingFile(assemblyName));
    }

    /// <summary>
    ///     Finds the row target of an outside target among the open files, those with the target's assembly name first
    ///     because another file only has the symbol through a forwarder. A row target resolves to itself.
    /// </summary>
    /// <returns>The row target, or <see langword="null"/> while no open file has a row for the symbol.</returns>
    public string? Resolve(string target)
    {
        if (Targets.ParseRowTarget(target) is var (fileId, key))
        {
            return _files.TryGetValue(fileId, out PEFile? file) && GetRows(fileId, file).FindIndex(key) is not null ? target : null;
        }

        return Targets.ParseOutsideTarget(target) is var (assemblyName, idString) && FindOutsideRow(assemblyName, idString) is var (rowFileId, rowKey)
            ? Targets.FormatRowTarget(rowFileId, rowKey)
            : null;
    }

    /// <summary>
    ///     Finds the rows of the open files whose code uses the symbol of a row target or an outside target. Leaves out
    ///     a file that the engine can't read, so a broken file doesn't hide the uses in the other files.
    /// </summary>
    /// <returns>The users' row targets, or none for a target without a row and a target that isn't one.</returns>
    /// <exception cref="CanceledCallException">The worker canceled the call.</exception>
    public async Task<List<string>> FindUsersAsync(string target)
    {
        _cancellation.Start();

        bool isType;
        if (Targets.ParseRowTarget(target) is var (fileId, key))
        {
            if (!_files.TryGetValue(fileId, out PEFile? file)
                || SymbolRows.IsNamespaceKey(key)
                || FileSections.IsSectionKey(key)
                || GetRows(fileId, file).FindIndex(key) is null)
            {
                return [];
            }

            isType = MetadataTokens.EntityHandle(key).Kind == HandleKind.TypeDefinition;
        }
        else if (Targets.ParseOutsideTarget(target) is var (assemblyName, idString))
        {
            if (FindOutsideRow(assemblyName, idString) is var (rowFileId, rowKey))
            {
                return await FindUsersAsync(Targets.FormatRowTarget(rowFileId, rowKey));
            }

            isType = idString.StartsWith("T:", StringComparison.Ordinal);
        }
        else
        {
            return [];
        }

        return await Users.FindAsync(target, isType, await ListSearchedFilesAsync(), _cancellation);
    }

    /// <summary>
    ///     Lists the strings that a file's methods load, with the rows of their users.
    /// </summary>
    /// <exception cref="ArgumentException">The session doesn't have a file with the id.</exception>
    /// <exception cref="BadImageFormatException">The file has symbols that the engine can't read.</exception>
    /// <exception cref="CanceledCallException">The worker canceled the call.</exception>
    public async Task<List<StringUse>> ListStringsAsync(int fileId)
    {
        _cancellation.Start();
        SearchedFile file = await OpenSearchedFileAsync(fileId, FindFile(fileId));

        return await Strings.ListAsync(file, _cancellation);
    }

    // skips a file whose rows or type system the engine can't read, but not a cancel, and catches every exception
    // because the decompiler throws many types for broken metadata
    private async Task<List<SearchedFile>> ListSearchedFilesAsync()
    {
        List<SearchedFile> searched = [];

        foreach ((int fileId, PEFile? file) in _files)
        {
            try
            {
                searched.Add(await OpenSearchedFileAsync(fileId, file));
            }
            catch (Exception exception) when (exception is not CanceledCallException)
            {
            }
        }

        return searched;
    }

    private async Task<SearchedFile> OpenSearchedFileAsync(int fileId, PEFile file)
    {
        Rows fileRows = await GetRowsAsync(fileId, file, _cancellation);

        return new(fileId, file, GetTypeSystem(fileId, file).MainModule, fileRows, new Targets(file, FindFileId, HasRow, FindHiddenViews));
    }

    private Description? DescribeRow(int fileId, int key, View view)
    {
        if (!_files.TryGetValue(fileId, out PEFile? file) || GetRows(fileId, file).FindIndex(key) is not { } index)
        {
            return null;
        }

        if (SymbolRows.IsNamespaceKey(key))
        {
            return new($"namespace {GetRows(fileId, file).Names[index]}", Container: null, [], MissingFile: null);
        }

        if (FileSections.IsSectionKey(key))
        {
            return FileSections.Describe(file, key, GetRows(fileId, file).Names[index], FindMissingFile);
        }

        // wraps the decompiler's exception because it throws many types for metadata that it can't read
        try
        {
            IEntity entity = GetTypeSystem(fileId, file).MainModule.ResolveEntity(MetadataTokens.EntityHandle(key), default);

            return Signatures.Describe(entity, view, _settings.CSharpFormattingOptions);
        }
        catch (Exception exception)
        {
            throw new BadImageFormatException($"The engine can't read the symbol {GetRows(fileId, file).Names[index]}.", exception);
        }
    }

    // doesn't find a row for an ID string that the decompiler can't parse, like `T:{`, because the page sends any target
    private (int FileId, int Key)? FindOutsideRow(string assemblyName, string idString)
    {
        foreach ((int fileId, PEFile? file) in _files.OrderBy(pair => pair.Value.Name != assemblyName))
        {
            EntityHandle handle;
            try
            {
                (MetadataFile _, handle) = IdStringProvider.FindEntity(idString, [file]);
            }
            catch (ReflectionNameParseException)
            {
                return null;
            }

            int key = MetadataTokens.GetToken(handle);
            if (!handle.IsNil && HasRow(fileId, key))
            {
                return (fileId, key);
            }
        }

        return null;
    }

    // returns the assembly's file name while an open file lists it as missing, because the page offers to open that
    // file
    private string? FindMissingFile(string assemblyName)
    {
        string name = $"{assemblyName}.dll";

        bool isMissing = _files.Any(pair => GetMissingFiles(pair.Key, pair.Value).Files.Any(missingFile => missingFile.Name == name));

        return isMissing ? name : null;
    }
}
