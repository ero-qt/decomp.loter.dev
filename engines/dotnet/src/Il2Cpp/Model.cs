using System.Collections.Generic;

namespace Decomp.Il2Cpp;

/// <summary>
///     Represents the metadata's layout, images, types and string literals that the engine read from a game, with the
///     binary's metadata globals. Without the binary, the members' types and addresses are <see langword="null" />,
///     the pointer size is 0 and the globals are empty. The Unity version is the version that picked the layout among
///     the candidates. The classes are those that the globals reach, see <see cref="ClassModel" />.
/// </summary>
internal sealed record GameModel(
    int FileVersion,
    string Layout,
    bool IsLayoutGuessed,
    string UnityVersion,
    int PointerSize,
    List<ImageModel> Images,
    List<TypeModel> Types,
    List<string> Strings,
    List<GlobalModel> Globals,
    List<ClassModel> Classes);

/// <summary>
///     Represents an assembly's image, whose types are the run of <see cref="TypeCount" /> types from
///     <see cref="FirstType" />.
/// </summary>
internal sealed record ImageModel(
    string Name,
    int FirstType,
    int TypeCount);

/// <summary>
///     Represents a type definition, with the index of its declaring type or -1 at the top.
/// </summary>
internal sealed record TypeModel(
    string Namespace,
    string Name,
    int DeclaringType,
    uint Flags,
    bool IsValueType,
    bool IsEnum,
    List<string> GenericParameters,
    TypeReference? BaseType,
    List<FieldModel> Fields,
    List<MethodModel> Methods,
    List<PropertyModel> Properties);

/// <summary>
///     Represents a field with its flags, which IL2CPP keeps in the binary, its offset and a constant's value.
/// </summary>
internal sealed record FieldModel(
    string Name,
    TypeReference? Type,
    uint? Flags,
    int? Offset,
    string? Value);

/// <summary>
///     Represents a method with its code's address relative to the image, or <see langword="null" /> for a method
///     without code.
/// </summary>
internal sealed record MethodModel(
    string Name,
    uint Flags,
    TypeReference? ReturnType,
    List<ParameterModel> Parameters,
    List<string> GenericParameters,
    ulong? Rva);

internal sealed record ParameterModel(
    string Name,
    TypeReference? Type);

/// <summary>
///     Represents a property with the indexes of its accessors among its type's methods, or -1 without one.
/// </summary>
internal sealed record PropertyModel(
    string Name,
    int Getter,
    int Setter);
