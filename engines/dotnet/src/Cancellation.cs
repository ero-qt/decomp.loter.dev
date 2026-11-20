using System;
using System.Diagnostics;
using System.Threading.Tasks;

namespace Decomp.Dotnet;

/// <summary>
///     Stops the session's running call once the worker cancels it, at the steps where the call checks.
/// </summary>
internal sealed class Cancellation
{
    // waits every 50 ms because the worker gets the cancel message only while the call waits
    private static readonly TimeSpan _waitInterval = TimeSpan.FromMilliseconds(50);

    private bool _isCanceled;
    private long _lastWait;

    public void Cancel()
    {
        _isCanceled = true;
    }

    /// <summary>
    ///     Starts a call, which drops the cancel of the call before it.
    /// </summary>
    public void Start()
    {
        _isCanceled = false;
        _lastWait = Stopwatch.GetTimestamp();
    }

    /// <summary>
    ///     Waits for the worker's messages when 50 ms passed since the last wait, then stops a canceled call.
    /// </summary>
    /// <exception cref="CanceledCallException">The worker canceled the call.</exception>
    public async ValueTask CheckAsync()
    {
        // waits for a timer because the runtime can run a continuation of Task.Yield before the worker's messages
        if (Stopwatch.GetElapsedTime(_lastWait) >= _waitInterval)
        {
            await Task.Delay(1);
            _lastWait = Stopwatch.GetTimestamp();
        }

        if (_isCanceled)
        {
            throw new CanceledCallException();
        }
    }
}

/// <summary>
///     Stops a call that the worker canceled. It isn't an <see cref="OperationCanceledException"/> because the JS
///     interop never settles the promise of a canceled task, which a faulted task rejects.
/// </summary>
internal sealed class CanceledCallException() : Exception("The call was canceled.");
