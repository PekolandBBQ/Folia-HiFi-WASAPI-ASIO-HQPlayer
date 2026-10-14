using System.Collections.Concurrent;
using System.Text;
using System.Text.Json;

namespace Folia.Capture;

internal static class Program
{
    private static readonly JsonSerializerOptions JsonOptions = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };

    private static void Send(object response) => Console.WriteLine(JsonSerializer.Serialize(response, JsonOptions));

    [STAThread]
    private static int Main()
    {
        // The Windows binary is not used for cloud tests; tests target the pure net8.0 core.
        if (!OperatingSystem.IsWindows() || !Environment.Is64BitProcess) return 2;
        Console.OutputEncoding = new UTF8Encoding(false);
        using var commands = new BlockingCollection<string>(16);
        var input = new Thread(() =>
        {
            try
            {
                var line = new StringBuilder();
                var oversized = false;
                while (Console.Read() is var next && next >= 0)
                {
                    if (next == '\n')
                    {
                        commands.Add(oversized ? "{}" : line.ToString());
                        line.Clear(); oversized = false;
                    }
                    else if (!oversized)
                    {
                        if (line.Length >= 32768) { oversized = true; line.Clear(); }
                        else line.Append((char)next);
                    }
                }
            }
            catch { /* EOF/pipe loss closes the process-owned capture lease below. */ }
            finally { commands.CompleteAdding(); }
        }) { IsBackground = true, Name = "Folia capture controls" };
        input.Start();
        using var engine = new CaptureEngine(Send);
        while (!commands.IsCompleted)
        {
            if (commands.TryTake(out var line, 40))
            {
                long id = 0;
                try
                {
                    using var document = JsonDocument.Parse(line, new JsonDocumentOptions { MaxDepth = 12 });
                    var request = document.RootElement;
                    if (!request.TryGetProperty("id", out var field) || !field.TryGetInt64(out id)
                        || id is <= 0 or > 9007199254740991) throw new CaptureFailure("INVALID_REQUEST");
                    var result = engine.Command(request);
                    Send(new { id, ok = true, result });
                }
                catch (Exception error)
                {
                    var code = error is CaptureFailure failure ? failure.Code
                        : error is JsonException or InvalidOperationException or KeyNotFoundException or FormatException or OverflowException
                            ? "INVALID_REQUEST" : "CAPTURE_REQUEST_FAILED";
                    // Neither PCM, process paths, tokens nor arbitrary exception text enter stderr.
                    Console.Error.WriteLine($"捕获命令失败 / Capture command failed [{code}]");
                    var hresult = EndpointInventoryReader.NativeHresult(error);
                    Send(new { id, ok = false, errorCode = code, hresult });
                }
            }
            engine.Tick();
        }
        return 0;
    }
}
