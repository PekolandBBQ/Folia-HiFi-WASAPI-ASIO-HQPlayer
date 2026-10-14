namespace Folia.Capture;

// If a native owner does not exit, only OS process termination can prove its handles released.
public sealed class HelperLifetime
{
    private bool restartRequired;
    public bool RestartRequired => restartRequired;
    public void RequireReusable() { if (restartRequired) throw new CaptureFailure("HELPER_RESTART_REQUIRED"); }
    public void ObserveStop(bool confirmedExited)
    {
        if (!confirmedExited) { restartRequired = true; throw new CaptureFailure("HELPER_RESTART_REQUIRED"); }
    }
    public void Poison() => restartRequired = true;
}
