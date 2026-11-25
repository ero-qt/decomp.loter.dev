using System.Collections.Generic;
using System.Globalization;
using System.Text;
using LibCpp2IL;
using LibCpp2IL.BinaryStructures;
using LibCpp2IL.Metadata;
using LibCpp2IL.Reflection;

namespace Decomp.Il2Cpp;

/// <summary>
///     Represents a part of a global's C# text that names a type definition by its index, or the global's own method
///     or field.
/// </summary>
internal sealed record TextPart(
    int Start,
    int Length,
    int Definition,
    bool IsMember);

/// <summary>
///     Writes the C# text of a metadata global, like <c>typeof(Dictionary&lt;string, int&gt;)</c>, with the parts
///     that name types and the global's member. A type has its own name, without its namespace and declaring types.
/// </summary>
internal sealed class GlobalText(Dictionary<Il2CppTypeDefinition, int> typeIndexes)
{
    private const int MaxDepth = 32;

    private static readonly Dictionary<string, string> _keywords = new()
    {
        ["Void"] = "void",
        ["Boolean"] = "bool",
        ["Char"] = "char",
        ["SByte"] = "sbyte",
        ["Byte"] = "byte",
        ["Int16"] = "short",
        ["UInt16"] = "ushort",
        ["Int32"] = "int",
        ["UInt32"] = "uint",
        ["Int64"] = "long",
        ["UInt64"] = "ulong",
        ["Single"] = "float",
        ["Double"] = "double",
        ["Decimal"] = "decimal",
        ["String"] = "string",
        ["Object"] = "object",
    };

    private readonly StringBuilder _text = new();

    public List<TextPart> Parts { get; } = [];

    public int Length => _text.Length;

    public override string ToString()
    {
        return _text.ToString();
    }

    public void Add(string text)
    {
        _text.Append(text);
    }

    public void AddMember(string name)
    {
        Parts.Add(new(_text.Length, name.Length, -1, true));
        _text.Append(name);
    }

    /// <summary>
    ///     Adds a type definition's name without the count of its generic parameters, or C#'s keyword for a built-in
    ///     type of <c>System</c>.
    /// </summary>
    public void AddDefinition(Il2CppTypeDefinition definition)
    {
        string name = (definition.Name ?? "").Split('`')[0];
        if (definition.Namespace == "System" && definition.DeclaringType is null && _keywords.TryGetValue(name, out string? keyword))
        {
            _text.Append(keyword);

            return;
        }

        if (typeIndexes.TryGetValue(definition, out int index))
        {
            Parts.Add(new(_text.Length, name.Length, index, false));
        }

        _text.Append(name);
    }

    public void AddType(Il2CppType type, int depth = 0)
    {
        if (depth > MaxDepth)
        {
            _text.Append('?');

            return;
        }

        if (TypeNames.TryGetKeyword(type.Type, out string? keyword))
        {
            _text.Append(keyword);

            return;
        }

        switch (type.Type)
        {
            case Il2CppTypeEnum.IL2CPP_TYPE_GENERICINST:
                Il2CppGenericClass generic = type.GetGenericClass();
                AddDefinition(generic.TypeDefinition);
                AddArguments(generic.Context.ClassInst.Types, argument => AddType(argument, depth + 1));
                break;
            case Il2CppTypeEnum.IL2CPP_TYPE_SZARRAY:
                AddType(type.GetEncapsulatedType(), depth + 1);
                _text.Append("[]");
                break;
            case Il2CppTypeEnum.IL2CPP_TYPE_ARRAY:
                AddType(type.GetArrayElementType(), depth + 1);
                _text.Append('[').Append(',', type.GetArrayRank() - 1).Append(']');
                break;
            case Il2CppTypeEnum.IL2CPP_TYPE_PTR:
                AddType(type.GetEncapsulatedType(), depth + 1);
                _text.Append('*');
                break;
            case Il2CppTypeEnum.IL2CPP_TYPE_VAR or Il2CppTypeEnum.IL2CPP_TYPE_MVAR:
                _text.Append(type.GetGenericParamName());
                break;
            case Il2CppTypeEnum.IL2CPP_TYPE_CLASS or Il2CppTypeEnum.IL2CPP_TYPE_VALUETYPE:
                AddDefinition(type.AsClass());
                break;
            default:
                _text.Append(type.Type.ToString());
                break;
        }
    }

    /// <summary>
    ///     Adds a type argument of a generic method's reference, which LibCpp2IL reads into its own shape.
    /// </summary>
    public void AddType(Il2CppTypeReflectionData type, int depth = 0)
    {
        if (depth > MaxDepth)
        {
            _text.Append('?');
        }
        else if (type.isArray && type.arrayType is not null)
        {
            AddType(type.arrayType, depth + 1);
            _text.Append('[').Append(',', type.arrayRank - 1).Append(']');
        }
        else if (type.baseType is null)
        {
            _text.Append(type.variableGenericParamName);
        }
        else
        {
            AddDefinition(type.baseType);
            if (type.isGenericType)
            {
                AddArguments(type.genericParams, argument => AddType(argument, depth + 1));
            }
        }

        if (type.isPointer)
        {
            _text.Append('*');
        }
    }

    public void AddArguments<TArgument>(IReadOnlyList<TArgument> arguments, System.Action<TArgument> add)
    {
        if (arguments.Count == 0)
        {
            return;
        }

        _text.Append('<');
        for (int index = 0; index < arguments.Count; index++)
        {
            if (index > 0)
            {
                _text.Append(", ");
            }

            add(arguments[index]);
        }

        _text.Append('>');
    }

    /// <summary>
    ///     Adds a string as a C# literal, with escapes for quotes, backslashes and control characters.
    /// </summary>
    public void AddLiteral(string value)
    {
        _text.Append('"');
        foreach (char character in value)
        {
            _text.Append(character switch
            {
                '"' => "\\\"",
                '\\' => "\\\\",
                '\n' => "\\n",
                '\r' => "\\r",
                '\t' => "\\t",
                '\0' => "\\0",
                < ' ' or '\u007f' => "\\u" + ((int)character).ToString("x4", CultureInfo.InvariantCulture),
                _ => character.ToString(),
            });
        }

        _text.Append('"');
    }
}
