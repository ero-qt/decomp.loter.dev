using System;
using System.Collections.Generic;
using System.IO;
using System.Reflection.PortableExecutable;
using System.Threading.Tasks;
using Decomp.Dotnet;
using ICSharpCode.Decompiler;
using ICSharpCode.Decompiler.Metadata;
using ICSharpCode.Decompiler.TypeSystem;

namespace Decomp.Il2Cpp;

/// <summary>
///     Represents a stub module that the decompiler reads, with the index of its image's first type, the type whose
///     members it has or -1, and the index of each method row's method among all methods of the game.
/// </summary>
internal sealed record StubFile(
    PEFile File,
    int FirstType,
    int OpenedType,
    int[] MethodIndexes);

/// <summary>
///     Represents the type system of an opened type's stub module, with the stub modules of the other images that it
///     reads the referenced types from.
/// </summary>
internal sealed record OpenedStub(
    StubFile Stub,
    DecompilerTypeSystem TypeSystem);

/// <summary>
///     Keeps the stub modules of an open game. Each image gets a module without an opened type on the first reference
///     to the image. The modules of the last opened types stay too, because a hover after a read needs the same type
///     again.
/// </summary>
internal sealed class GameStubs : IAssemblyResolver
{
    // the opened types whose type systems the stubs keep, which a few hovers over other types' members don't push out
    private const int KeptOpenedCount = 8;

    private readonly Dictionary<int, StubFile> _images = [];
    private readonly Dictionary<MetadataFile, StubFile> _files = new(ReferenceEqualityComparer.Instance);
    private readonly List<OpenedStub> _opened = [];
    private GameIndex? _index;

    /// <summary>
    ///     Gets the stub module that a module of a type system is, or <see langword="null" />.
    /// </summary>
    public StubFile? FindStub(MetadataFile file)
    {
        return _files.GetValueOrDefault(file);
    }

    /// <summary>
    ///     Returns the type system of a type's stub module, built with the stub modules of the images that it refers to.
    /// </summary>
    public OpenedStub Open(GameIndex index, int typeIndex, DecompilerSettings settings)
    {
        _index = index;
        OpenedStub? kept = _opened.Find(opened => opened.Stub.OpenedType == typeIndex);
        if (kept is not null)
        {
            _opened.Remove(kept);
            _opened.Add(kept);

            return kept;
        }

        StubFile stub = Build(index, index.ImageOfType[typeIndex], typeIndex);

        // builds the type system with CreateAsync because the synchronous constructor blocks on a task, which throws on
        // browser-wasm, and takes the result at once because the resolver's tasks are finished
        DecompilerTypeSystem typeSystem = DecompilerTypeSystem.CreateAsync(stub.File, this, settings).GetAwaiter().GetResult();
        OpenedStub opened = new(stub, typeSystem);

        if (_opened.Count == KeptOpenedCount)
        {
            _files.Remove(_opened[0].Stub.File);
            _opened.RemoveAt(0);
        }

        _opened.Add(opened);

        return opened;
    }

    public IDisposable? BeginSnapshot()
    {
        return null;
    }

    /// <summary>
    ///     Finds the stub module of an image by its assembly's name, which leaves out the image of the opened type,
    ///     because the opened type's module has every type of its image.
    /// </summary>
    public MetadataFile? Resolve(IAssemblyReference reference)
    {
        if (_index is null)
        {
            return null;
        }

        for (int image = 0; image < _index.Metadata.imageDefinitions.Length; image++)
        {
            if (StubModule.NameAssembly(_index.Metadata.imageDefinitions[image]) == reference.Name)
            {
                if (!_images.TryGetValue(image, out StubFile? stub))
                {
                    stub = Build(_index, image, openedType: -1);
                    _images.Add(image, stub);
                }

                return stub.File;
            }
        }

        return null;
    }

    public MetadataFile? ResolveModule(MetadataFile mainModule, string moduleName)
    {
        return null;
    }

    public Task<MetadataFile?> ResolveAsync(IAssemblyReference reference)
    {
        return Task.FromResult(Resolve(reference));
    }

    public Task<MetadataFile?> ResolveModuleAsync(MetadataFile mainModule, string moduleName)
    {
        return Task.FromResult<MetadataFile?>(null);
    }

    private StubFile Build(GameIndex index, int image, int openedType)
    {
        (byte[] bytes, int[] methodIndexes) = StubModule.Write(index, image, openedType);
        string name = index.Metadata.imageDefinitions[image].Name ?? "";
        PEFile file = new(name, new MemoryStream(bytes), PEStreamOptions.PrefetchEntireImage);
        StubFile stub = new(file, index.Metadata.imageDefinitions[image].firstTypeIndex.Value, openedType, methodIndexes);
        _files.Add(file, stub);

        return stub;
    }
}
