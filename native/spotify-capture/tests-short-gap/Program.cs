using Folia.Capture;

// Exercise actual packet policy and PCM gate; no Windows device or Spotify is simulated as live playback.
var passed = 0;
void Check(bool value) { if (!value) throw new Exception("Assertion failed"); passed++; }
void Reject(Action action, string code = "CAPTURE_DISCONTINUITY")
{
    try { action(); throw new Exception("Expected failure"); }
    catch (CaptureFailure error) { Check(error.Code == code); }
}
byte[] Samples(int frames, byte value) => Enumerable.Repeat(value, frames * 8).ToArray();
var gate = new PcmDeliveryGate(100000);
var writer = new ShortGapPcmWriter(gate);
writer.Accept(Samples(100, 1), 100, 0, 1, true);
writer.Accept(Samples(100, 2), 100, 100, 2, true);
writer.Accept(Samples(100, 3), 100, 210, 3, true);
var output = new byte[310 * 8];
Check(await gate.ReadAsync(output, CancellationToken.None) == output.Length);
Check(output.Take(800).All(x => x == 1));
Check(output.Skip(800).Take(800).All(x => x == 2));
Check(output.Skip(1600).Take(80).All(x => x == 0));
Check(output.Skip(1680).All(x => x == 3));
Check(writer.ReceivedFrames == 300 && writer.ConcealedFrames == 10 && writer.Discontinuities == 2);
Check(writer.InitialDiscontinuity && gate.State == "live");
writer.Accept(Samples(1, 4), 1, 310 + 4410, 4, true);
Check(writer.ConcealedFrames == 4420);
Reject(() => writer.Accept(Samples(1, 5), 1, 9132, 5, true)); // 100 ms + one frame
Reject(() => writer.Accept(Samples(1, 5), 1, 4720, 5, true)); // overlap
Reject(() => writer.Accept(Samples(1, 5), 1, 4721, 4, true)); // invalid timestamp progression
Reject(() => writer.Accept(Samples(1, 5), 1, -1, 5, true), "CAPTURE_PACKET_INVALID");
Reject(() => writer.Accept(Samples(2, 5), 1, 4721, 5, true), "CAPTURE_PACKET_INVALID");
var bootstrap = new PcmDeliveryGate(100000, "buffer", holdForStartValidation: true);
var pending = new ShortGapPcmWriter(bootstrap);
pending.Accept(Samples(1, 1), 1, 0, 1, true);
Reject(() => pending.Accept(Samples(1, 2), 1, 2, 2, true));
bootstrap.ConfirmStartValidation(); bootstrap.Promote();
pending.Accept(Samples(1, 2), 1, 2, 2, true);
Check(pending.ConcealedFrames == 1);
var discard = new PcmDeliveryGate(104, "discard");
var discarded = new ShortGapPcmWriter(discard);
discarded.Accept(ReadOnlySpan<byte>.Empty, 1, 0, 1, true);
Reject(() => discarded.Accept(ReadOnlySpan<byte>.Empty, 1, 2, 2, true));
Check(discarded.ReceivedFrames == 1 && discarded.ConcealedFrames == 0);
var epochGate = new PcmDeliveryGate(104, "buffer", holdForStartValidation: true);
var epoch = new ShortGapPcmWriter(epochGate);
epoch.Accept(Samples(1, 1), 1, 900, 10, false);
epochGate.ConfirmStartValidation(); epochGate.CutUnpublishedBootstrap(); epoch.Reset();
epoch.Accept(Samples(1, 2), 1, 0, 1, true);
Check(epoch.ReceivedFrames == 1 && epoch.Discontinuities == 0 && epoch.ConcealedFrames == 0);
var tiny = new PcmDeliveryGate(8);
var overflow = new ShortGapPcmWriter(tiny);
overflow.Accept(Samples(1, 1), 1, 0, 1, false);
Reject(() => overflow.Accept(Samples(1, 2), 1, 2, 2, true), "CAPTURE_OVERFLOW");
Check(tiny.State == "closed");
Console.WriteLine($"Short-gap PCM tests: {passed} passed (device-free)");

