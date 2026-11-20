using ICSharpCode.Decompiler.Metadata;
using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;

namespace Decomp.Dotnet;

/// <summary>
///     Finds a referenced assembly among the other open files by its name, so the decompiler reads the types of the
///     open files that a file uses.
/// </summary>
internal sealed class OpenFileResolver(
    IReadOnlyList<PEFile> files) : IAssemblyResolver
{
    public IDisposable? BeginSnapshot()
    {
        return null;
    }

    public MetadataFile? Resolve(IAssemblyReference reference)
    {
        return files.FirstOrDefault(file => file.Name == reference.Name);
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
}
