using ICSharpCode.Decompiler;
using ICSharpCode.Decompiler.CSharp;
using ICSharpCode.Decompiler.CSharp.Syntax;
using ICSharpCode.Decompiler.Documentation;
using ICSharpCode.Decompiler.Metadata;
using ICSharpCode.Decompiler.TypeSystem;
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection.Metadata;
using System.Reflection.Metadata.Ecma335;
using System.Reflection.PortableExecutable;
using System.Threading.Tasks;

namespace Decomp.Dotnet;

/// <summary>
///     Keeps the open assemblies between calls, each under the file id that the page picks.
/// </summary>
internal sealed partial class Session
{
    // writes a record's constructor and properties as members because each row then has a declaration
    private readonly DecompilerSettings _settings = new()
    {
        ThrowOnAssemblyResolveErrors = false,
        UsePrimaryConstructorSyntax = false,
        UsePrimaryConstructorSyntaxForNonRecordTypes = false,
    };

    private readonly Dictionary<int, PEFile> _files = [];

    // file id -> the type system of the file with the other open files that it references, built on the first call that
    // needs it
    private readonly Dictionary<int, DecompilerTypeSystem> _typeSystems = [];

    // file id -> the rows of the file, listed on the first call that needs them and dropped with the type systems
    private readonly Dictionary<int, Rows> _rows = [];

    // file id -> the missing files of the file, found on the first call that needs them and dropped with the type
    // systems, because a hover over each symbol outside the open files looks them up
    private readonly Dictionary<int, FoundMissingFiles> _missingFiles = [];

    // file id -> whether the scans of the file's method bodies and strings stop at their limits, which only the file's
    // own bytes decide
    private readonly Dictionary<int, (bool IsScanCut, bool AreStringsCut)> _cuts = [];

    private readonly Cancellation _cancellation = new();

    /// <summary>
    ///     Reads an assembly and keeps it under the file id.
    /// </summary>
    /// <exception cref="ArgumentException">The session already has a file with the id.</exception>
    /// <exception cref="BadImageFormatException">The bytes aren't an assembly that the engine reads.</exception>
    public void Open(int fileId, string name, byte[] bytes)
    {
        if (_files.ContainsKey(fileId))
        {
            throw new ArgumentException($"The .NET engine already has an open file with the id {fileId}.");
        }

        PEFile file = ReadFile(name, bytes);
        _files.Add(fileId, file);

        // drops the type systems of the files that reference the new one because they then read its types from it
        DropUsersState(file);
    }

    /// <exception cref="ArgumentException">The session doesn't have a file with the id.</exception>
    public void Close(int fileId)
    {
        PEFile file = FindFile(fileId);

        // drops the type systems of the files that reference the closed one because they keep it
        DropUsersState(file);
        _cuts.Remove(fileId);
        _files.Remove(fileId);
        file.Dispose();
    }

    /// <summary>
    ///     Stops the running call at its next check.
    /// </summary>
    public void Cancel()
    {
        _cancellation.Cancel();
    }

    /// <summary>
    ///     Closes every file.
    /// </summary>
    public void Reset()
    {
        foreach (PEFile file in _files.Values)
        {
            file.Dispose();
        }

        _files.Clear();
        _typeSystems.Clear();
        _rows.Clear();
        _missingFiles.Clear();
        _cuts.Clear();
    }

    /// <summary>
    ///     Lists the rows of a file's tree, the note on its row and the referenced assemblies that aren't open.
    /// </summary>
    /// <exception cref="ArgumentException">The session doesn't have a file with the id.</exception>
    /// <exception cref="BadImageFormatException">The file has symbols that the engine can't read.</exception>
    /// <exception cref="CanceledCallException">The worker canceled the call.</exception>
    public async Task<ListingReply> ListAsync(int fileId)
    {
        _cancellation.Start();
        PEFile file = FindFile(fileId);
        Rows fileRows = await GetRowsAsync(fileId, file, _cancellation);
        FoundMissingFiles missingFiles = GetMissingFiles(fileId, file);

        if (!_cuts.TryGetValue(fileId, out (bool IsScanCut, bool AreStringsCut) cuts))
        {
            cuts = (MethodBodyScanner.ListBodies(file).IsCut, await Strings.IsCutAsync(file, _cancellation));
            _cuts[fileId] = cuts;
        }

        FileNote note = new(fileRows.SkippedCount, missingFiles.SkippedCount, cuts.IsScanCut, cuts.AreStringsCut);

        return ListingReply.From(fileRows, missingFiles, note.ToString());
    }

    /// <summary>
    ///     Writes the C# of a type that has its own document, with the types nested in it.
    /// </summary>
    /// <exception cref="ArgumentException">
    ///     The session doesn't have a file with the id, or the file doesn't have a row with the key and its own
    ///     document that the view csharp shows.
    /// </exception>
    /// <exception cref="BadImageFormatException">The type has metadata or IL that the engine can't read.</exception>
    /// <exception cref="CanceledCallException">The worker canceled the call.</exception>
    public async Task<Document> ReadCSharpAsync(int fileId, int key)
    {
        (PEFile file, string name) = await FindDocumentRowAsync(fileId, key, Rows.CSharpView, "csharp");

        // wraps the decompiler's exception because it throws many types for metadata and IL that it can't read
        try
        {
            CSharpDecompiler decompiler = new(GetTypeSystem(fileId, file), _settings);
            SyntaxTree syntaxTree = decompiler.DecompileTypes([(TypeDefinitionHandle)MetadataTokens.EntityHandle(key)]);

            return CSharpOutput.Write(syntaxTree, _settings, new Targets(file, FindFileId, HasRow, FindHiddenViews));
        }
        catch (Exception exception)
        {
            throw new BadImageFormatException($"The engine can't write the C# of {name}.", exception);
        }
    }

    /// <summary>
    ///     Writes the IL of a type that has its own document, with the types nested in it.
    /// </summary>
    /// <exception cref="ArgumentException">
    ///     The session doesn't have a file with the id, or the file doesn't have a row with the key and its own
    ///     document that the view il shows.
    /// </exception>
    /// <exception cref="BadImageFormatException">The type has metadata or IL that the engine can't read.</exception>
    /// <exception cref="CanceledCallException">The worker canceled the call.</exception>
    public async Task<Document> ReadIlAsync(int fileId, int key)
    {
        (PEFile file, string name) = await FindDocumentRowAsync(fileId, key, Rows.IlView, "il");

        // wraps the disassembler's exception because it throws many types for metadata and IL that it can't read
        try
        {
            MetadataModule module = GetTypeSystem(fileId, file).MainModule;
            Targets targets = new(file, FindFileId, HasRow, FindHiddenViews);

            return IlOutput.Write((TypeDefinitionHandle)MetadataTokens.EntityHandle(key), module, targets);
        }
        catch (Exception exception)
        {
            throw new BadImageFormatException($"The engine can't write the IL of {name}.", exception);
        }
    }

    // finds the file and the name of a row with its own document that the view shows, with a check of the cancellation
    // once the rows are listed
    private async Task<(PEFile File, string Name)> FindDocumentRowAsync(int fileId, int key, int view, string viewName)
    {
        _cancellation.Start();
        PEFile file = FindFile(fileId);
        Rows fileRows = await GetRowsAsync(fileId, file, _cancellation);
        if (fileRows.FindIndex(key) is not int index)
        {
            throw new ArgumentException($"{file.FileName} doesn't have a symbol with the key {key}.");
        }

        if ((fileRows.GetFlags(index) & (int)SymbolModifiers.Document) == 0)
        {
            throw new ArgumentException($"{fileRows.Names[index]} doesn't have its own document.");
        }

        if ((fileRows.GetHiddenViews(index) & view) != 0)
        {
            throw new ArgumentException($"{fileRows.Names[index]} is hidden in the view {viewName}.");
        }

        await _cancellation.CheckAsync();

        return (file, fileRows.Names[index]);
    }

    private static PEFile ReadFile(string name, byte[] bytes)
    {
        PEFile? file = null;
        string? nestingError;

        // wraps the decompiler's exception because it throws many types for a file that isn't an assembly
        try
        {
            file = new(name, new MemoryStream(bytes), PEStreamOptions.PrefetchEntireImage);
            nestingError = Limits.FindNestingError(file.Metadata);
        }
        catch (Exception exception)
        {
            file?.Dispose();

            throw new BadImageFormatException($"{name} isn't a readable .NET assembly.", exception);
        }

        if (nestingError is not null)
        {
            file.Dispose();

            throw new BadImageFormatException($"{name} {nestingError}");
        }

        return file;
    }

    // drops the type system, the rows and the missing files of a file and of each open file that reaches its assembly
    // through the references of the open files, because only those files read its types
    private void DropUsersState(PEFile changed)
    {
        foreach ((int fileId, PEFile file) in _files)
        {
            if (file == changed || OpenFileGraph.Reaches(file, changed.Name, _files.Values))
            {
                _typeSystems.Remove(fileId);
                _rows.Remove(fileId);
                _missingFiles.Remove(fileId);
            }
        }
    }

    private FoundMissingFiles GetMissingFiles(int fileId, PEFile file)
    {
        if (!_missingFiles.TryGetValue(fileId, out FoundMissingFiles? missingFiles))
        {
            missingFiles = MissingFiles.Find(file, FindOtherFiles(file));
            _missingFiles.Add(fileId, missingFiles);
        }

        return missingFiles;
    }

    // takes the result at once because a listing without a cancellation doesn't wait
    private Rows GetRows(int fileId, PEFile file)
    {
        return GetRowsAsync(fileId, file, listingCancellation: null).GetAwaiter().GetResult();
    }

    // wraps the decompiler's exception, but not a cancel, because the decompiler throws many types for metadata that it
    // can't read
    private async ValueTask<Rows> GetRowsAsync(int fileId, PEFile file, Cancellation? listingCancellation)
    {
        if (_rows.TryGetValue(fileId, out Rows? fileRows))
        {
            return fileRows;
        }

        try
        {
            fileRows = await SymbolRows.ListAsync(file, GetTypeSystem(fileId, file).MainModule, _settings, listingCancellation);
        }
        catch (Exception exception) when (exception is not CanceledCallException)
        {
            throw new BadImageFormatException($"The engine can't read the symbols of {file.FileName}.", exception);
        }

        _rows.Add(fileId, fileRows);

        return fileRows;
    }

    private int? FindFileId(MetadataFile file)
    {
        foreach ((int fileId, PEFile? openFile) in _files)
        {
            if (openFile == file)
            {
                return fileId;
            }
        }

        return null;
    }

    private bool HasRow(int fileId, int key)
    {
        return GetRows(fileId, _files[fileId]).FindIndex(key) is not null;
    }

    private int FindHiddenViews(int fileId, int key)
    {
        Rows fileRows = GetRows(fileId, _files[fileId]);

        return fileRows.FindIndex(key) is int index ? fileRows.GetHiddenViews(index) : 0;
    }

    private PEFile FindFile(int fileId)
    {
        if (!_files.TryGetValue(fileId, out PEFile? file))
        {
            throw new ArgumentException($"The .NET engine doesn't have an open file with the id {fileId}.");
        }

        return file;
    }

    private List<PEFile> FindOtherFiles(PEFile file)
    {
        return [.. _files.Values.Where(other => other != file)];
    }

    // builds the type system with CreateAsync because the synchronous constructor blocks on a task, which throws on
    // browser-wasm, and takes the result at once because the resolver's tasks are finished
    private DecompilerTypeSystem GetTypeSystem(int fileId, PEFile file)
    {
        if (!_typeSystems.TryGetValue(fileId, out DecompilerTypeSystem? typeSystem))
        {
            OpenFileResolver resolver = new(FindOtherFiles(file));
            typeSystem = DecompilerTypeSystem.CreateAsync(file, resolver, _settings).GetAwaiter().GetResult();
            _typeSystems.Add(fileId, typeSystem);
        }

        return typeSystem;
    }
}
