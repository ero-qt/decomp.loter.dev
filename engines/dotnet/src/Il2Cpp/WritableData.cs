using System;
using System.Buffers.Binary;
using System.Collections.Generic;
using System.IO;
using System.Reflection.PortableExecutable;

namespace Decomp.Il2Cpp;

/// <summary>
///     A run of a binary's file that the loader maps as writable data, by its start and end in the file.
/// </summary>
internal readonly record struct DataRange(
    int Start,
    int End);

/// <summary>
///     Finds the writable data of a PE or ELF binary, where IL2CPP keeps the metadata globals of version 27 and later.
/// </summary>
internal static class WritableData
{
    // SHT_PROGBITS, SHF_WRITE, PT_LOAD and PF_W of the ELF specification
    private const uint ElfProgramBits = 1;
    private const ulong ElfWriteFlag = 1;
    private const uint ElfLoadSegment = 1;
    private const uint ElfWritableSegment = 2;

    /// <summary>
    ///     Lists the file ranges of a binary's writable sections with bytes in the file, with the size of a pointer
    ///     in the binary, or none for a binary that isn't PE or ELF.
    /// </summary>
    public static (List<DataRange> Ranges, int PointerSize) List(byte[] binary)
    {
        if (binary.Length > 4 && binary[0] == 0x7f && binary[1] == 'E' && binary[2] == 'L' && binary[3] == 'F')
        {
            return ListElf(binary);
        }

        if (binary.Length > 2 && binary[0] == 'M' && binary[1] == 'Z')
        {
            return ListPe(binary);
        }

        return ([], 0);
    }

    private static (List<DataRange> Ranges, int PointerSize) ListPe(byte[] binary)
    {
        using PEReader reader = new(new MemoryStream(binary, writable: false));
        PEHeaders headers = reader.PEHeaders;
        int pointerSize = headers.PEHeader?.Magic == PEMagic.PE32Plus ? 8 : 4;
        List<DataRange> ranges = [];
        foreach (SectionHeader section in headers.SectionHeaders)
        {
            bool isData = section.SectionCharacteristics.HasFlag(SectionCharacteristics.ContainsInitializedData);
            if (isData && section.SectionCharacteristics.HasFlag(SectionCharacteristics.MemWrite))
            {
                ranges.Add(Clip(binary, section.PointerToRawData, section.SizeOfRawData));
            }
        }

        return (ranges, pointerSize);
    }

    // reads the section headers of a little-endian ELF file, which every Android and Linux build of IL2CPP is, or the
    // program headers of a file without sections, like an Android build whose section table went away
    private static (List<DataRange> Ranges, int PointerSize) ListElf(byte[] binary)
    {
        bool is64 = binary[4] == 2;
        List<DataRange> ranges = ListElfSections(binary, is64);

        return (ranges.Count > 0 ? ranges : ListElfSegments(binary, is64), is64 ? 8 : 4);
    }

    private static List<DataRange> ListElfSections(byte[] binary, bool is64)
    {
        ReadOnlySpan<byte> bytes = binary;
        long tableStart = (long)ReadWord(bytes[(is64 ? 0x28 : 0x20)..], is64);
        int entrySize = BinaryPrimitives.ReadUInt16LittleEndian(bytes[(is64 ? 0x3a : 0x2e)..]);
        int count = BinaryPrimitives.ReadUInt16LittleEndian(bytes[(is64 ? 0x3c : 0x30)..]);
        List<DataRange> ranges = [];

        for (int index = 0; index < count; index++)
        {
            long entryStart = tableStart + ((long)index * entrySize);
            if (entryStart + entrySize > binary.Length)
            {
                break;
            }

            ReadOnlySpan<byte> entry = bytes.Slice((int)entryStart, entrySize);
            uint type = BinaryPrimitives.ReadUInt32LittleEndian(entry[4..]);
            ulong flags = ReadWord(entry[8..], is64);
            long offset = (long)ReadWord(entry[(is64 ? 0x18 : 0x10)..], is64);
            long size = (long)ReadWord(entry[(is64 ? 0x20 : 0x14)..], is64);
            if (type == ElfProgramBits && (flags & ElfWriteFlag) != 0)
            {
                ranges.Add(Clip(binary, offset, size));
            }
        }

        return ranges;
    }

    // lists the bytes in the file of each writable segment that the loader maps
    private static List<DataRange> ListElfSegments(byte[] binary, bool is64)
    {
        ReadOnlySpan<byte> bytes = binary;
        long tableStart = (long)ReadWord(bytes[(is64 ? 0x20 : 0x1c)..], is64);
        int entrySize = BinaryPrimitives.ReadUInt16LittleEndian(bytes[(is64 ? 0x36 : 0x2a)..]);
        int count = BinaryPrimitives.ReadUInt16LittleEndian(bytes[(is64 ? 0x38 : 0x2c)..]);
        List<DataRange> ranges = [];

        for (int index = 0; index < count; index++)
        {
            long entryStart = tableStart + ((long)index * entrySize);
            if (entryStart + entrySize > binary.Length)
            {
                break;
            }

            ReadOnlySpan<byte> entry = bytes.Slice((int)entryStart, entrySize);
            uint type = BinaryPrimitives.ReadUInt32LittleEndian(entry);
            uint flags = BinaryPrimitives.ReadUInt32LittleEndian(entry[(is64 ? 4 : 0x18)..]);
            long offset = (long)ReadWord(entry[(is64 ? 8 : 4)..], is64);
            long size = (long)ReadWord(entry[(is64 ? 0x20 : 0x10)..], is64);
            if (type == ElfLoadSegment && (flags & ElfWritableSegment) != 0)
            {
                ranges.Add(Clip(binary, offset, size));
            }
        }

        return ranges;
    }

    // reads an ELF word, which takes 8 bytes in a 64-bit file and 4 in a 32-bit file
    private static ulong ReadWord(ReadOnlySpan<byte> bytes, bool is64)
    {
        return is64 ? BinaryPrimitives.ReadUInt64LittleEndian(bytes) : BinaryPrimitives.ReadUInt32LittleEndian(bytes);
    }

    // keeps a range inside the file, because a damaged header can point past its end
    private static DataRange Clip(byte[] binary, long start, long size)
    {
        int clippedStart = (int)Math.Clamp(start, 0, binary.Length);
        int clippedEnd = (int)Math.Clamp(start + size, clippedStart, binary.Length);

        return new(clippedStart, clippedEnd);
    }
}
