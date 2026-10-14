namespace Folia.RouteRunner;
internal static class Program
{
    private static int Main(string[] args)
    {
        if(args.Contains("--internal-worker") || args.Contains("--internal-recover"))
        {
            if(!Supervisor.ValidateWorkerHandshake(args)) return 90;
            return args.Contains("--internal-recover")?Worker.Recover(args):Worker.Run(args);
        }
        return Supervisor.Run(args);
    }
}
