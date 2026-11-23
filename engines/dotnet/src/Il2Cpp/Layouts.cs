using System.Collections.Generic;
using System.Linq;
using AssetRipper.Primitives;

namespace Decomp.Il2Cpp;

/// <summary>
///     Provides the Unity versions that pick each layout of a metadata version in LibCpp2IL, newest layout first,
///     because the file only has the version's whole number and LibCpp2IL picks a layout like 24.5 by the Unity
///     version.
/// </summary>
internal static class Layouts
{
    private static readonly Dictionary<int, string[]> _unityVersions = new()
    {
        [24] = ["2019.4.21f1", "2019.4.15f1", "2019.3.7f1", "2019.1.0f1", "2018.4.34f1", "2018.3.0f1", "2018.2.0f1"],
        [27] = ["2021.1.0f1", "2020.2.4f1", "2020.2.0f1"],
        [29] = ["2022.1.0b7", "2021.2.0f1"],
        [31] = ["2022.3.33f1", "2022.3.0f1"],
    };

    // gives the versions with a single layout any Unity version, because LibCpp2IL then takes the file's number
    private static readonly string[] _anyUnityVersion = ["6000.0.0f1"];

    /// <summary>
    ///     Returns the Unity versions to try for a metadata version, newest layout first, or the version of
    ///     <paramref name="firstVersion" /> first when it's one of them.
    /// </summary>
    public static IEnumerable<UnityVersion> ListCandidates(int fileVersion, string firstVersion = "")
    {
        string[] versions = _unityVersions.GetValueOrDefault(fileVersion, _anyUnityVersion);
        foreach (string version in versions.OrderBy(version => version != firstVersion))
        {
            yield return UnityVersion.Parse(version);
        }
    }
}
