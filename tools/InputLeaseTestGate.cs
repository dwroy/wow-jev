// Acceptance-only gate: delays cleanup of this test's own existing lease.
// It sends no input and has a finite lifetime, including if WSL is interrupted.
using System;
using System.Threading;
using System.Text.RegularExpressions;

class InputLeaseTestGate
{
    static int Main(string[] args)
    {
        if (args.Length != 1 || !Regex.IsMatch(args[0], "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")) return 2;
        try
        {
            using (Mutex gate = Mutex.OpenExisting("Local\\WowJevInput.LeaseMutex." + args[0]))
            {
                if (!gate.WaitOne(1000)) return 3;
                try
                {
                    Console.WriteLine("{\"type\":\"gate_locked\"}");
                    Console.Out.Flush();
                    Thread.Sleep(1500);
                }
                finally { gate.ReleaseMutex(); }
            }
            return 0;
        }
        catch (Exception error)
        {
            Console.Error.WriteLine(error.GetType().Name);
            return 4;
        }
    }
}
