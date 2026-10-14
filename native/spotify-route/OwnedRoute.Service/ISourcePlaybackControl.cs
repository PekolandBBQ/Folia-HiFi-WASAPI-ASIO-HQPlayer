using System;

namespace Folia.ProductRoute;

public interface ISourcePlaybackControl
{
	PlaybackStatus ReadFresh(TimeSpan budget);

	void PauseExactDevice(string deviceId, TimeSpan budget);
}
