using ICSharpCode.Decompiler.Disassembler;
using ICSharpCode.Decompiler.Metadata;
using System;
using System.Collections.Generic;
using System.Reflection;
using System.Reflection.Metadata;
using System.Threading.Tasks;

namespace Decomp.Dotnet;

/// <summary>
///     An instruction with a metadata token as its operand, like a call or the load of a string.
/// </summary>
internal readonly record struct TokenInstruction(
    MethodDefinitionHandle Method,
    ILOpCode OpCode,
    int Token);

/// <summary>
///     The method bodies of a file that a scan reads, the count of their IL bytes and whether the scan leaves out the
///     bodies past <see cref="Limits.MaxIlBytes"/>.
/// </summary>
internal sealed record ScannedBodies(
    List<(MethodDefinitionHandle Method, MethodBodyBlock Body)> Bodies,
    long IlBytes,
    bool IsCut);

/// <summary>
///     Reads the instructions of a file's method bodies that have a metadata token as their operand.
/// </summary>
internal static class MethodBodyScanner
{
    /// <summary>
    ///     Checks whether a method's body is IL, which a native method of a mixed-mode assembly's body isn't.
    /// </summary>
    public static bool HasIl(MethodDefinition definition)
    {
        return (definition.ImplAttributes & MethodImplAttributes.CodeTypeMask) == MethodImplAttributes.IL;
    }

    /// <summary>
    ///     Lists the bodies that a scan reads in the order of the methods, until their IL passes
    ///     <see cref="Limits.MaxIlBytes"/>. Lists a body that several methods share once, for the first of them, and
    ///     skips a body that isn't readable IL.
    /// </summary>
    public static ScannedBodies ListBodies(PEFile file)
    {
        MetadataReader metadata = file.Metadata;
        List<(MethodDefinitionHandle Method, MethodBodyBlock Body)> bodies = [];
        HashSet<int> readAddresses = [];
        long ilBytes = 0;

        foreach (MethodDefinitionHandle handle in metadata.MethodDefinitions)
        {
            MethodDefinition definition = metadata.GetMethodDefinition(handle);
            int address = definition.RelativeVirtualAddress;
            if (address == 0 || !HasIl(definition) || !readAddresses.Add(address) || ReadBody(file, address) is not { } body)
            {
                continue;
            }

            int size = body.GetILReader().Length;
            if (ilBytes + size > Limits.MaxIlBytes)
            {
                return new(bodies, ilBytes, IsCut: true);
            }

            ilBytes += size;
            bodies.Add((handle, body));
        }

        return new(bodies, ilBytes, IsCut: false);
    }

    /// <summary>
    ///     Reads the instructions with a token operand of the bodies that <see cref="ListBodies"/> lists, in their
    ///     order and the order of their IL, with a check of the cancellation before each body.
    /// </summary>
    /// <exception cref="CanceledCallException">The worker canceled the call.</exception>
    public static async Task<List<TokenInstruction>> ReadTokenInstructionsAsync(PEFile file, Cancellation? cancellation)
    {
        List<TokenInstruction> instructions = [];

        foreach ((MethodDefinitionHandle method, MethodBodyBlock body) in ListBodies(file).Bodies)
        {
            if (cancellation is not null)
            {
                await cancellation.CheckAsync();
            }

            ReadMethodBody(method, body, instructions);
        }

        return instructions;
    }

    private static MethodBodyBlock? ReadBody(PEFile file, int address)
    {
        try
        {
            return file.GetMethodBody(address);
        }
        catch (BadImageFormatException)
        {
            return null;
        }
    }

    // leaves out the instructions of a body that isn't readable IL, so the file's other methods stay readable
    private static void ReadMethodBody(MethodDefinitionHandle method, MethodBodyBlock body, List<TokenInstruction> instructions)
    {
        int start = instructions.Count;

        try
        {
            BlobReader reader = body.GetILReader();
            while (reader.RemainingBytes > 0)
            {
                ILOpCode opCode = ILParser.DecodeOpCode(ref reader);
                if (opCode.GetOperandType() is OperandType.String or OperandType.Method or OperandType.Field or OperandType.Type or OperandType.Tok)
                {
                    instructions.Add(new(method, opCode, reader.ReadInt32()));
                }
                else
                {
                    ILParser.SkipOperand(ref reader, opCode);
                }
            }
        }
        catch (BadImageFormatException)
        {
            instructions.RemoveRange(start, instructions.Count - start);
        }
    }
}
