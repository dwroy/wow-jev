// Pure/offline Windows acceptance; never opens a game window or calls SendInput.
using System;
using System.Collections.Generic;
using System.Threading;
using WowJev.Input;

static class NativeRecoverySafetyFixture
{
    static int checks;
    static void Check(bool value, string name)
    { if (!value) throw new InvalidOperationException(name); checks++; }
    static RecoveryRect Rect(int l, int t, int r, int b) { return new RecoveryRect(l, t, r, b); }
    static List<RecoveryRect> Monitors(params RecoveryRect[] values) { return new List<RecoveryRect>(values); }
    static int Main()
    {
        try
        {
            RecoveryRect client = Rect(10, 10, 90, 90);
            Check(RecoverySafety.WindowVisible(true, false), "visible unminimized target eligible");
            Check(!RecoverySafety.WindowVisible(true, true), "minimized target refused");
            Check(!RecoverySafety.WindowVisible(false, false), "hidden target refused");
            Check(RecoverySafety.CoveredByMonitors(client, Monitors(Rect(0, 0, 100, 100))), "contained monitor");
            Check(!RecoverySafety.CoveredByMonitors(Rect(-1, 0, 90, 90), Monitors(Rect(0, 0, 100, 100))), "one-pixel offscreen refused");
            Check(RecoverySafety.CoveredByMonitors(client, Monitors(Rect(0, 0, 50, 100), Rect(50, 0, 100, 100))), "adjacent displays union");
            Check(!RecoverySafety.CoveredByMonitors(client, Monitors(Rect(0, 0, 49, 100), Rect(50, 0, 100, 100))), "display gap refused");
            Check(!RecoverySafety.CoveredByMonitors(client, Monitors(Rect(0, 0, 100, 50))), "partially visible client refused");
            Check(!RecoverySafety.CoveredByMonitors(Rect(0, 0, 0, 90), Monitors(Rect(0, 0, 100, 100))), "empty client refused");
            Check(!RecoverySafety.CoveredByMonitors(client, Monitors()), "unknown monitors refused");
            Check(client.Intersects(Rect(30, 30, 31, 31)), "single-pixel occluder detected");
            Check(client.Intersects(Rect(89, 89, 100, 100)), "edge occluder detected");
            Check(!client.Intersects(Rect(90, 10, 100, 90)), "touching edge without overlap");
            Check(RecoverySafety.OccluderGeometry(true, true, Rect(20, 20, 20, 60)) == "empty", "successful zero-width system window is not an occluder");
            Check(RecoverySafety.OccluderGeometry(true, true, Rect(20, 20, 60, 20)) == "empty", "successful zero-height system window is not an occluder");
            Check(RecoverySafety.OccluderGeometry(true, true, Rect(0, 0, 0, 0)) == "empty", "successful zero-area system window is not unknown");
            Check(RecoverySafety.OccluderGeometry(true, true, Rect(60, 20, 20, 60)) == "unknown", "reversed coordinates remain refused");
            Check(RecoverySafety.OccluderGeometry(false, true, Rect(0, 0, 0, 0)) == "unknown", "existing window API failure remains refused");
            Check(RecoverySafety.OccluderGeometry(false, false, Rect(0, 0, 0, 0)) == "changed", "destroyed window API failure requests re-enumeration");
            Check(RecoverySafety.OccluderGeometry(true, true, Rect(20, 20, 60, 60)) == "valid", "positive-area rectangle still requires intersection check");
            Check(!RecoverySafety.IdleAllowed(6000, 1000), "strict five-second boundary refused");
            Check(RecoverySafety.IdleAllowed(6001, 1000), "over-five-second idle accepted");
            Check(!RecoverySafety.IdleAllowed(100, 100), "recent input refused");
            Check(RecoverySafety.IdleAllowed(6000, UInt32.MaxValue - 100), "DWORD wrap handled");
            Check(!RecoverySafety.IdleAllowed(100, 200), "future timestamp refused");
            uint idle;
            Check(!RecoverySafety.TryIdle(Int32.MaxValue + 1U, 0, out idle), "ambiguous half-cycle refused");
            Check(!(bool)Native.GetRecoverySafety(IntPtr.Zero)["allowed"], "invalid HWND fails closed");
            Native.InputPacket absolute = new Native.InputPacket(); absolute.Type = 0;
            absolute.Data.Mouse.Flags = 1U | 0x8000U | 0x4000U;
            absolute.Data.Mouse.Dx = 100; absolute.Data.Mouse.Dy = 200;
            foreach (int bit in new[] { 1, 2, 4 })
            {
                Native.InputPacket[] batch = Native.ClickBatch(absolute, bit);
                Check(batch.Length == 2 && batch[0].Type == 0 && batch[0].Data.Mouse.Flags == absolute.Data.Mouse.Flags &&
                    batch[0].Data.Mouse.Dx == 100 && batch[0].Data.Mouse.Dy == 200, "contiguous move-first click batch");
                Check(batch[1].Type == 0 && batch[1].Data.Mouse.Flags == (bit == 1 ? 2U : bit == 2 ? 8U : 32U), "contiguous down-second click batch");
                Check(Native.MouseButton(bit, true).Data.Mouse.Flags == (bit == 1 ? 4U : bit == 2 ? 16U : 64U), "single owned UP preserves three total events");
            }
            bool rejected = false;
            try { Native.ClickBatch(absolute, 8); } catch (ArgumentException) { rejected = true; }
            Check(rejected, "unsupported button cannot construct a click");
            Native.InputPacket relative = absolute; relative.Data.Mouse.Flags = 1; rejected = false;
            try { Native.ClickBatch(relative, 1); } catch (ArgumentException) { rejected = true; }
            Check(rejected, "relative move cannot construct an absolute click");
            Native.InputPacket keyboard = absolute; keyboard.Type = 1; rejected = false;
            try { Native.ClickBatch(keyboard, 1); } catch (ArgumentException) { rejected = true; }
            Check(rejected, "keyboard packet cannot masquerade as click move");
            // Exercise a real shared ownership ledger and cancellation latch with
            // no physical inputs registered. The normal release path must remain
            // empty, idempotent, and cannot claim an effect.
            using (ManualResetEvent cancel = new ManualResetEvent(false))
            using (LeaseStore store = new LeaseStore(Guid.NewGuid().ToString("D"), true))
            {
                store.Write(new LeaseSnapshot()); cancel.Set();
                Check(cancel.WaitOne(0), "cancellation observable");
                ReleaseResult release = store.ReleaseOwned("offline_fixture_cancel");
                Check(release.Released && release.Requested == 0 && release.Inserted == 0, "empty ownership release sends zero events");
                Check(store.ReleaseOwned("offline_fixture_repeat").Released, "empty release idempotent");
            }
            Console.WriteLine("{\"status\":\"passed\",\"checks\":" + checks + ",\"game_inputs\":0,\"model_calls\":0,\"effect\":\"unverified\"}");
            return 0;
        }
        catch (Exception error) { Console.Error.WriteLine(error); return 1; }
    }
}
