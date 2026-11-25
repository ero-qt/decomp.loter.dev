using System;
using System.Collections.Generic;
using AssetRipper.Primitives;
using LibCpp2IL;
using LibCpp2IL.Metadata;

namespace Decomp.Il2Cpp;

/// <summary>
///     Represents the bytes of an open game, the binary's or <see langword="null" /> before the engine has it, with the
///     Unity version that read the game.
/// </summary>
internal sealed record GameSource(
    byte[] Metadata,
    byte[]? Binary,
    UnityVersion Version);

/// <summary>
///     Keeps the open games under the file ids that the page picks, with 1 of them in LibCpp2IL's state, because
///     LibCpp2IL keeps 1 game in static fields.
/// </summary>
internal sealed class OpenGames
{
    private readonly Dictionary<int, GameSource> _sources = [];
    private readonly Dictionary<int, GameStubs> _stubs = [];

    // the game in LibCpp2IL's state with its lookups, or null while LibCpp2IL's state doesn't have an open game
    private (int FileId, GameIndex Index)? _loaded;

    /// <summary>
    ///     Keeps a game that its read left in LibCpp2IL's state, in place of the game with the same id.
    /// </summary>
    public void Keep(int fileId, GameSource source)
    {
        _sources[fileId] = source;
        _stubs[fileId] = new();
        _loaded = (fileId, new(LibCpp2IlMain.TheMetadata!));
    }

    /// <summary>
    ///     Marks LibCpp2IL's state as empty, after a failed read dropped it.
    /// </summary>
    public void ForgetLoaded()
    {
        _loaded = null;
    }

    public void Close(int fileId)
    {
        _sources.Remove(fileId);
        _stubs.Remove(fileId);

        if (_loaded?.FileId == fileId)
        {
            GameReader.DropState();
            _loaded = null;
        }
    }

    public void Reset()
    {
        _sources.Clear();
        _stubs.Clear();
        GameReader.DropState();
        _loaded = null;
    }

    /// <summary>
    ///     Returns the bytes of an open game.
    /// </summary>
    /// <exception cref="ArgumentException">The engine doesn't have an open game with the id.</exception>
    public GameSource GetSource(int fileId)
    {
        if (!_sources.TryGetValue(fileId, out GameSource? source))
        {
            throw new ArgumentException($"The IL2CPP engine doesn't have an open file with the id {fileId}.");
        }

        return source;
    }

    /// <summary>
    ///     Returns the stub modules of an open game, which <see cref="Load" /> checks the id of.
    /// </summary>
    public GameStubs GetStubs(int fileId)
    {
        return _stubs[fileId];
    }

    /// <summary>
    ///     Loads a game into LibCpp2IL's state, unless the state already has it, and returns its lookups.
    /// </summary>
    /// <exception cref="ArgumentException">The engine doesn't have an open game with the id.</exception>
    public GameIndex Load(int fileId)
    {
        GameSource source = GetSource(fileId);
        if (_loaded is var (loadedId, loadedIndex) && loadedId == fileId)
        {
            return loadedIndex;
        }

        GameReader.Load(source.Metadata, source.Binary, source.Version);
        GameIndex index = new(LibCpp2IlMain.TheMetadata!);
        _loaded = (fileId, index);

        return index;
    }
}

/// <summary>
///     Indexes the types of the game in LibCpp2IL's state: each type definition's index, each type's image and the
///     index of each type's first field, method and property among all members of their kind, which the row keys of
///     <c>rows.ts</c> count the same way.
/// </summary>
internal sealed class GameIndex
{
    public GameIndex(Il2CppMetadata metadata)
    {
        Metadata = metadata;
        TypeIndexes = ModelWriter.IndexTypes(metadata);
        HasBinary = LibCpp2IlMain.Binary is not null;

        int typeCount = metadata.typeDefs.Length;
        ImageOfType = new int[typeCount];
        for (int image = 0; image < metadata.imageDefinitions.Length; image++)
        {
            Il2CppImageDefinition definition = metadata.imageDefinitions[image];
            int first = definition.firstTypeIndex.Value;
            for (int type = first; type < first + definition.typeCount && type < typeCount; type++)
            {
                ImageOfType[type] = image;
            }
        }

        FirstFields = new int[typeCount];
        FirstMethods = new int[typeCount];
        FirstProperties = new int[typeCount];
        int fields = 0;
        int methods = 0;
        int properties = 0;
        for (int type = 0; type < typeCount; type++)
        {
            Il2CppTypeDefinition definition = metadata.typeDefs[type];
            FirstFields[type] = fields;
            FirstMethods[type] = methods;
            FirstProperties[type] = properties;
            fields += definition.FieldCount;
            methods += definition.MethodCount;
            properties += definition.PropertyCount;
        }
    }

    public Il2CppMetadata Metadata { get; }

    public Dictionary<Il2CppTypeDefinition, int> TypeIndexes { get; }

    /// <summary>
    ///     Gets whether LibCpp2IL read the game with its binary, which has the members' types.
    /// </summary>
    public bool HasBinary { get; }

    public int[] ImageOfType { get; }

    public int[] FirstFields { get; }

    public int[] FirstMethods { get; }

    public int[] FirstProperties { get; }

    private Dictionary<string, int>? _coreTypes;

    /// <summary>
    ///     Finds the index of a type in the core library's namespace <c>System</c>, like <c>Object</c>, or -1.
    /// </summary>
    public int FindCoreType(string name)
    {
        _coreTypes ??= IndexCoreTypes();

        return _coreTypes.GetValueOrDefault(name, -1);
    }

    // indexes the top types of the core library's namespace `System` by their names once, because each type row of a
    // stub without the binary looks up its base type
    private Dictionary<string, int> IndexCoreTypes()
    {
        Dictionary<string, int> types = [];
        foreach (Il2CppImageDefinition image in Metadata.imageDefinitions)
        {
            if (image.Name != "mscorlib.dll")
            {
                continue;
            }

            int first = image.firstTypeIndex.Value;
            for (int type = first; type < first + image.typeCount; type++)
            {
                Il2CppTypeDefinition definition = Metadata.typeDefs[type];
                if (definition.Namespace == "System" && definition.DeclaringTypeIndex.IsNull)
                {
                    types.TryAdd(definition.Name ?? "", type);
                }
            }
        }

        return types;
    }
}
