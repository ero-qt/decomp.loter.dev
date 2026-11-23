using System;
using System.Runtime.InteropServices.JavaScript;
using System.Runtime.Versioning;
using AssetRipper.Primitives;
using Decomp.Dotnet;

namespace Decomp.Il2Cpp;

/// <summary>
///     Exports the methods that the engine's worker calls. Each read returns its reply as the bytes that
///     <see cref="GameWriter" /> writes.
/// </summary>
[SupportedOSPlatform("browser")]
public static partial class Exports
{
    private static readonly OpenGames _games = new();

    /// <summary>
    ///     Closes every open game, because a new set of handlers in the same runtime starts empty.
    /// </summary>
    [JSExport]
    public static void Reset()
    {
        _games.Reset();
    }

    /// <summary>
    ///     Reads a game's metadata and keeps it under the file id, in place of a game with the same id.
    /// </summary>
    [JSExport]
    public static byte[] ReadMetadata(int fileId, string name, byte[] metadata)
    {
        return GameWriter.WriteReply(() => Keep(fileId, metadata, binary: null, () =>
        {
            GameModel model = GameReader.ReadMetadata(name, metadata, out UnityVersion version);

            return (model, version);
        }));
    }

    /// <summary>
    ///     Reads the metadata that the engine keeps under the file id with its binary and keeps the game in place of
    ///     the game that only had the metadata. Tries the layout of the Unity version that read the metadata first.
    /// </summary>
    [JSExport]
    public static byte[] ReadGame(int fileId, string name, string binaryName, byte[] binary)
    {
        GameSource source = _games.GetSource(fileId);

        return GameWriter.WriteReply(() => Keep(fileId, source.Metadata, binary, () =>
        {
            string firstVersion = source.Version.ToString();
            GameModel model = GameReader.ReadGame(name, binaryName, source.Metadata, binary, firstVersion, out UnityVersion version);

            return (model, version);
        }));
    }

    [JSExport]
    public static void Close(int fileId)
    {
        _games.Close(fileId);
    }

    /// <summary>
    ///     Writes the C# of a type that has its own document, like the .NET engine's export, with the type's index as
    ///     its key and the places of the methods' empty bodies.
    /// </summary>
    [JSExport]
    public static string ReadCSharp(int fileId, int typeIndex, bool expandsAccessors)
    {
        return ReplyJson.Write(
            () =>
            {
                GameIndex index = _games.Load(fileId);

                return StubReader.ReadCSharp(fileId, index, _games.GetStubs(fileId), typeIndex, expandsAccessors);
            },
            ReplyJson.Default.ReplyStubDocumentReply);
    }

    /// <summary>
    ///     Describes the type or member of a row key, or returns <see langword="null" /> for a key without one.
    /// </summary>
    [JSExport]
    public static string Describe(int fileId, int key)
    {
        return ReplyJson.Write(
            () =>
            {
                GameIndex index = _games.Load(fileId);

                return StubReader.Describe(index, _games.GetStubs(fileId), key);
            },
            ReplyJson.Default.ReplyDescription);
    }

    // marks LibCpp2IL's state as empty after a read that failed, because a failed read drops the state
    private static GameModel Keep(int fileId, byte[] metadata, byte[]? binary, Func<(GameModel Model, UnityVersion Version)> read)
    {
        try
        {
            (GameModel model, UnityVersion version) = read();
            _games.Keep(fileId, new(metadata, binary, version));

            return model;
        }
        catch (GameException)
        {
            _games.ForgetLoaded();

            throw;
        }
    }
}
