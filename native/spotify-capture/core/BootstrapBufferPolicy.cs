namespace Folia.Capture;

public static class BootstrapBufferPolicy
{
	public const int BytesPerSecond = 352800;

	public const int LiveCapacityBytes = 705600;

	public const int TimeoutMilliseconds = 75000;

	public const int CapacityBytes = 27165600;

	public const string Capability = "bounded-bootstrap-buffer-v1";
}
