using System.Collections.Concurrent;
using System.Text.Json;
using Folia.Audio;

// native/windows-audio/Program.cs — one STA owner for COM drivers and serialized commands.
internal static class Program
{
    private static readonly object OutputLock = new();
    internal static void Send(object value)
    {
        lock (OutputLock) Console.WriteLine(JsonSerializer.Serialize(value));
    }

    [STAThread]
    private static void Main()
    {
        using var queue = new BlockingCollection<string>();
        var input = new Thread(() => {
            string? line;
            while ((line = Console.ReadLine()) != null) queue.Add(line);
            queue.CompleteAdding();
        }) { IsBackground = true };
        input.Start();
        using var engine = new AudioEngine(Send);
        while (!queue.IsCompleted)
        {
            if (queue.TryTake(out var line, 40))
            {
                int id = 0;
                try
                {
                    using var document = JsonDocument.Parse(line);
                    var request = document.RootElement;
                    id = request.GetProperty("id").GetInt32();
                    var result = engine.Command(request);
                    Send(new { id, ok = true, result });
                }
                catch (Exception error)
                {
                    // A driver may fail halfway through initialization; release partial resources.
                    // Stale-session validation errors must not stop a newer track.
                    if (!error.Message.StartsWith("Stale playback session")) engine.Dispose();
                    Send(new { id, ok = false, error = error.Message });
                }
            }
            engine.Tick();
        }
    }
}
