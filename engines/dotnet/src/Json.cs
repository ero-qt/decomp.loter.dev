using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.Json.Serialization.Metadata;
using System.Threading.Tasks;

namespace Decomp.Dotnet;

/// <summary>
///     The reply of an export as the worker reads it: the value, or the error text that the page shows.
/// </summary>
internal sealed record Reply<TValue>(
    TValue? Value,
    string? Error);

/// <summary>
///     The rows of a file's tree with the values as bytes, which the JSON has in base64, the note on the file's row and
///     the file's missing assemblies.
/// </summary>
internal sealed record ListingReply(
    byte[] Values,
    List<string> Names,
    List<string> Details,
    string Note,
    List<MissingFile> MissingFiles)
{
    public static ListingReply From(Rows rows, FoundMissingFiles missingFiles, string note)
    {
        return new(MemoryMarshal.AsBytes(rows.Values.AsSpan()).ToArray(), rows.Names, rows.Details, note, missingFiles.Files);
    }
}

/// <summary>
///     A document with the token values as bytes, which the JSON has in base64.
/// </summary>
internal sealed record DocumentReply(
    string Text,
    byte[] Tokens,
    List<string> Targets,
    List<string> Locals)
{
    public static DocumentReply From(Document document)
    {
        return new(document.Text, MemoryMarshal.AsBytes(document.Tokens.AsSpan()).ToArray(), document.Targets, document.Locals);
    }
}

/// <summary>
///     Writes the replies with serializers that the build generates, because the trimmer then keeps them.
/// </summary>
[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase)]
[JsonSerializable(typeof(Reply<bool>))]
[JsonSerializable(typeof(Reply<ListingReply>))]
[JsonSerializable(typeof(Reply<DocumentReply>))]
[JsonSerializable(typeof(Reply<Il2Cpp.StubDocumentReply>))]
[JsonSerializable(typeof(Reply<Description>))]
[JsonSerializable(typeof(Reply<string>))]
[JsonSerializable(typeof(Reply<List<string>>))]
[JsonSerializable(typeof(Reply<List<StringUse>>))]
internal sealed partial class ReplyJson : JsonSerializerContext
{
    /// <summary>
    ///     Runs a call and writes its value, or the text of an exception that refuses the call. Any other exception is
    ///     a bug, which leaves the call.
    /// </summary>
    public static string Write<TValue>(Func<TValue> call, JsonTypeInfo<Reply<TValue>> typeInfo)
    {
        Reply<TValue> reply;

        try
        {
            reply = new(call(), Error: null);
        }
        catch (Exception exception) when (exception is ArgumentException or BadImageFormatException)
        {
            reply = new(Value: default, exception.Message);
        }

        return JsonSerializer.Serialize(reply, typeInfo);
    }

    /// <summary>
    ///     Runs a call that waits and writes its value like <see cref="Write{TValue}"/>. A cancel leaves the call.
    /// </summary>
    public static async Task<string> WriteAsync<TValue>(Func<Task<TValue>> call, JsonTypeInfo<Reply<TValue>> typeInfo)
    {
        Reply<TValue> reply;

        try
        {
            reply = new(await call(), Error: null);
        }
        catch (Exception exception) when (exception is ArgumentException or BadImageFormatException)
        {
            reply = new(Value: default, exception.Message);
        }

        return JsonSerializer.Serialize(reply, typeInfo);
    }

    /// <summary>
    ///     Runs a call without a value and writes <see langword="true"/>, or the text of an exception that refuses the
    ///     call.
    /// </summary>
    public static string Write(Action call)
    {
        return Write(
            () =>
            {
                call();

                return true;
            },
            Default.ReplyBoolean);
    }
}
