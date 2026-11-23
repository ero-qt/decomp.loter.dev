using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using AssetRipper.Primitives;
using LibCpp2IL;
using LibCpp2IL.Logging;
using LibCpp2IL.Metadata;

namespace Decomp.Il2Cpp;

/// <summary>
///     Reads a game's metadata and binary with LibCpp2IL into a model. LibCpp2IL keeps 1 game in static fields, which
///     <see cref="OpenGames" /> loads again for another open game.
/// </summary>
internal static class GameReader
{
    // the name of the first code gen module, which LibCpp2IL's search for the registration structs starts from
    private static readonly byte[] _corlibModuleName = Encoding.ASCII.GetBytes("mscorlib.dll\0");

    /// <summary>
    ///     Reads the metadata without the binary, which only gives each symbol's name and flags, and leaves the metadata
    ///     in LibCpp2IL's state for the stubs.
    /// </summary>
    public static GameModel ReadMetadata(string name, byte[] metadata, out UnityVersion readVersion)
    {
        LibLogger.Writer = new SilentLogWriter();
        int fileVersion = BitConverter.ToInt32(metadata, 4);
        List<UnityVersion> candidates = Layouts.ListCandidates(fileVersion).ToList();

        foreach (UnityVersion unityVersion in candidates)
        {
            GameModel? model = TryReadMetadata(metadata, unityVersion, fileVersion, candidates.Count > 1);
            if (model is not null)
            {
                readVersion = unityVersion;

                return model;
            }
        }

        DropState();

        // puts the version in the text because the worker's header check already refused scrambled metadata
        throw new GameException($"{name} has version {fileVersion}, but the engine can't read its layout.");
    }

    /// <summary>
    ///     Reads the metadata with the binary, trying each layout of the metadata's version from the newest, and marks
    ///     the layout as guessed when the version has more than 1 layout. Tries the layout of
    ///     <paramref name="firstVersion" /> first, the Unity version that read the metadata, because each failed try
    ///     reads the whole binary. Leaves the game in LibCpp2IL's state for the stubs.
    /// </summary>
    public static GameModel ReadGame(
        string name,
        string binaryName,
        byte[] metadata,
        byte[] binary,
        string firstVersion,
        out UnityVersion readVersion)
    {
        LibLogger.Writer = new SilentLogWriter();
        int fileVersion = BitConverter.ToInt32(metadata, 4);
        List<UnityVersion> candidates = Layouts.ListCandidates(fileVersion, firstVersion).ToList();

        foreach (UnityVersion unityVersion in candidates)
        {
            GameModel? model = TryReadGame(metadata, binary, unityVersion, fileVersion, candidates.Count > 1);
            if (model is not null)
            {
                readVersion = unityVersion;

                return model;
            }
        }

        DropState();

        if (binary.AsSpan().IndexOf(_corlibModuleName) < 0)
        {
            throw new GameException($"The engine can't find the IL2CPP tables in {binaryName}. The file may be packed or protected.");
        }

        throw new GameException($"{binaryName} doesn't match {name}.");
    }

    /// <summary>
    ///     Reads a game again into LibCpp2IL's state with the Unity version that read it before, with the binary or
    ///     without it.
    /// </summary>
    public static void Load(byte[] metadata, byte[]? binary, UnityVersion unityVersion)
    {
        LibLogger.Writer = new SilentLogWriter();
        DropState();

        if (binary is null)
        {
            LibCpp2IlMain.TheMetadata = Il2CppMetadata.ReadFrom(metadata, unityVersion);
        }
        else
        {
            LibCpp2IlMain.Initialize(binary, metadata, unityVersion);
        }
    }

    /// <summary>
    ///     Drops each static field of LibCpp2IL's that keeps a game, because <c>LibCpp2IlMain.Reset</c> only clears the
    ///     global mapper and the methods by their pointers, and the binary and the metadata stay in memory otherwise.
    /// </summary>
    public static void DropState()
    {
        LibCpp2IlMain.Reset();
        LibCpp2IlMain.Binary = null;
        LibCpp2IlMain.TheMetadata = null;
    }

    // returns null for a layout that doesn't fit, because LibCpp2IL throws plain exceptions for any misread
    private static GameModel? TryReadMetadata(byte[] metadata, UnityVersion unityVersion, int fileVersion, bool isLayoutGuessed)
    {
        try
        {
            DropState();
            Il2CppMetadata read = Il2CppMetadata.ReadFrom(metadata, unityVersion);
            LibCpp2IlMain.TheMetadata = read;

            return new ModelWriter(read, names: null).Write(fileVersion, isLayoutGuessed, unityVersion);
        }
        catch (Exception exception) when (exception is not OutOfMemoryException)
        {
            return null;
        }
    }

    private static GameModel? TryReadGame(
        byte[] metadata,
        byte[] binary,
        UnityVersion unityVersion,
        int fileVersion,
        bool isLayoutGuessed)
    {
        try
        {
            DropState();
            LibCpp2IlMain.Initialize(binary, metadata, unityVersion);
            Il2CppMetadata read = LibCpp2IlMain.TheMetadata!;

            return new ModelWriter(read, new(ModelWriter.IndexTypes(read))).Write(fileVersion, isLayoutGuessed, unityVersion);
        }
        catch (Exception exception) when (exception is not OutOfMemoryException)
        {
            return null;
        }
    }
}

/// <summary>
///     Drops LibCpp2IL's log, because the worker doesn't have a console to show it.
/// </summary>
internal sealed class SilentLogWriter : LogWriter
{
    public override void Info(string message)
    {
    }

    public override void Warn(string message)
    {
    }

    public override void Error(string message)
    {
    }

    public override void Verbose(string message)
    {
    }
}
