using System;
using System.Collections.Generic;
using System.IO;
using System.Text;

namespace Decomp.Il2Cpp;

/// <summary>
///     Writes a reply of an export as bytes, because the worker then reads a game of 100,000 methods without the JSON
///     text that it would decode and parse. A reply starts with 0 and the game, or with 1 and the error text. The game
///     starts with its strings, which the rest refers to by their index, and writes each number as an unsigned LEB128.
///     A number that can be -1 or missing gets 1 added for each, so 0 stands for null.
/// </summary>
internal sealed class GameWriter
{
    private readonly MemoryStream _stream = new();
    private readonly Dictionary<string, int> _stringIndexes = [];
    private readonly List<string> _strings = [];

    /// <summary>
    ///     Runs a call and writes its game, or the text of a <see cref="GameException" /> that refuses the call. Any
    ///     other exception is a bug, which leaves the call.
    /// </summary>
    public static byte[] WriteReply(Func<GameModel> call)
    {
        GameModel game;

        try
        {
            game = call();
        }
        catch (GameException exception)
        {
            byte[] text = Encoding.UTF8.GetBytes(exception.Message);
            byte[] refusal = new byte[text.Length + 1];
            refusal[0] = 1;
            text.CopyTo(refusal, 1);

            return refusal;
        }

        GameWriter writer = new();
        writer.WriteGame(game);

        return writer.Finish();
    }

    private void WriteGame(GameModel game)
    {
        WriteNumber((ulong)game.FileVersion);
        WriteString(game.Layout);
        WriteNumber(game.IsLayoutGuessed ? 1UL : 0UL);
        WriteString(game.UnityVersion);
        WriteNumber((ulong)game.PointerSize);

        WriteNumber((ulong)game.Images.Count);
        foreach (ImageModel image in game.Images)
        {
            WriteString(image.Name);
            WriteNumber((ulong)image.FirstType);
            WriteNumber((ulong)image.TypeCount);
        }

        WriteNumber((ulong)game.Types.Count);
        foreach (TypeModel type in game.Types)
        {
            WriteType(type);
        }

        WriteNumber((ulong)game.Strings.Count);
        foreach (string text in game.Strings)
        {
            WriteString(text);
        }

        WriteNumber((ulong)game.Globals.Count);
        foreach (GlobalModel global in game.Globals)
        {
            WriteNumber(global.Rva);
            WriteNumber((ulong)global.Kind);
            WriteString(global.Name);
            WriteNumber((ulong)(global.Definition + 1));
            WriteNumber((ulong)(global.Member + 1));
            WriteString(global.Text);
            WriteNumber((ulong)global.TypeStart);
            WriteNumber((ulong)global.TypeLength);
            WriteNumber((ulong)global.Parts.Count);
            foreach (TextPart part in global.Parts)
            {
                WriteNumber((ulong)part.Start);
                WriteNumber((ulong)part.Length);
                WriteNumber((ulong)(part.Definition + 1));
                WriteNumber(part.IsMember ? 1UL : 0UL);
            }
        }
    }

    private void WriteType(TypeModel type)
    {
        WriteString(type.Namespace);
        WriteString(type.Name);
        WriteNumber((ulong)(type.DeclaringType + 1));
        WriteNumber(type.Flags);
        WriteNumber((type.IsValueType ? 1UL : 0UL) | (type.IsEnum ? 2UL : 0UL));
        WriteStrings(type.GenericParameters);
        WriteReference(type.BaseType);

        WriteNumber((ulong)type.Fields.Count);
        foreach (FieldModel field in type.Fields)
        {
            WriteString(field.Name);
            WriteReference(field.Type);
            WriteNumber(field.Flags is null ? 0 : (ulong)field.Flags + 1);
            // keeps a thread static field's offset of -1 apart from null, which is 0
            WriteNumber(field.Offset is null ? 0 : (ulong)((long)field.Offset + 2));
            WriteOptionalString(field.Value);
        }

        WriteNumber((ulong)type.Methods.Count);
        foreach (MethodModel method in type.Methods)
        {
            WriteMethod(method);
        }

        WriteNumber((ulong)type.Properties.Count);
        foreach (PropertyModel property in type.Properties)
        {
            WriteString(property.Name);
            WriteNumber((ulong)(property.Getter + 1));
            WriteNumber((ulong)(property.Setter + 1));
        }
    }

    private void WriteMethod(MethodModel method)
    {
        WriteString(method.Name);
        WriteNumber(method.Flags);
        WriteReference(method.ReturnType);
        WriteNumber((ulong)method.Parameters.Count);
        foreach (ParameterModel parameter in method.Parameters)
        {
            WriteString(parameter.Name);
            WriteReference(parameter.Type);
        }

        WriteStrings(method.GenericParameters);
        WriteNumber(method.Rva is null ? 0 : (ulong)method.Rva + 1);
    }

    private void WriteReference(TypeReference? reference)
    {
        if (reference is null)
        {
            WriteNumber(0);
            return;
        }

        WriteNumber((ulong)IndexString(reference.Name) + 1);
        WriteNumber((ulong)(reference.Definition + 1));
    }

    private void WriteStrings(List<string> texts)
    {
        WriteNumber((ulong)texts.Count);
        foreach (string text in texts)
        {
            WriteString(text);
        }
    }

    private void WriteString(string text)
    {
        WriteNumber((ulong)IndexString(text));
    }

    private void WriteOptionalString(string? text)
    {
        WriteNumber(text is null ? 0 : (ulong)IndexString(text) + 1);
    }

    private int IndexString(string text)
    {
        if (!_stringIndexes.TryGetValue(text, out int index))
        {
            index = _strings.Count;
            _stringIndexes[text] = index;
            _strings.Add(text);
        }

        return index;
    }

    private void WriteNumber(ulong value)
    {
        while (value >= 0x80)
        {
            _stream.WriteByte((byte)(value | 0x80));
            value >>= 7;
        }

        _stream.WriteByte((byte)value);
    }

    // puts the strings before the game, because the reader then has each string before the game refers to it
    private byte[] Finish()
    {
        byte[] game = _stream.ToArray();
        _stream.SetLength(0);
        _stream.WriteByte(0);
        WriteNumber((ulong)_strings.Count);
        foreach (string text in _strings)
        {
            byte[] bytes = Encoding.UTF8.GetBytes(text);
            WriteNumber((ulong)bytes.Length);
            _stream.Write(bytes);
        }

        _stream.Write(game);

        return _stream.ToArray();
    }
}

/// <summary>
///     Represents a refusal with the text that the page shows, like a game whose files the engine can't read.
/// </summary>
internal sealed class GameException(string message) : Exception(message);
