// Pure production scheduler fixture. No window, capture, or SendInput call.
using System;
using System.Collections.Generic;
static class ClickTimelineTimingFixture
{
    static int checks;
    static void Need(bool value, string label) { if (!value) throw new Exception(label); checks++; }
    static ClickTimelineStep[] Single(int hold)
    { return new[] { new ClickTimelineStep("absolute_mouse_move", 0, 0), new ClickTimelineStep("button_down", 150, 2), new ClickTimelineStep("button_up", 150 + hold, 2) }; }
    static ClickTimelineStep[] DoubleClick()
    { return new[] { new ClickTimelineStep("absolute_mouse_move", 0, 0), new ClickTimelineStep("button_down", 150, 1), new ClickTimelineStep("button_up", 230, 1), new ClickTimelineStep("absolute_mouse_move", 310, 0), new ClickTimelineStep("button_down", 460, 1), new ClickTimelineStep("button_up", 540, 1) }; }
    sealed class Result
    {
        public readonly List<double> Starts = new List<double>(), Ends = new List<double>();
        public readonly List<string> Sent = new List<string>();
        public bool Owned, Released;
        public string Failure;
        public int Guards;
    }
    // The same WaitBefore/CheckDispatch/Record methods are called by RunTimeline.
    static Result Run(ClickTimelineStep[] plan, int duration, double moveDelay, double downDelay, double cancelAt, double loseFocusAt)
    {
        var timing = ClickTimelineTiming.TryCreate(plan, duration, 0); Need(timing != null, "production click shape detected");
        var result = new Result(); double clock = 0;
        Action guard = delegate { result.Guards++; if (clock >= cancelAt) throw new Exception("cancelled"); if (clock >= loseFocusAt) throw new Exception("window_unfocused"); };
        try {
            for (int i = 0; i < plan.Length; i++) {
                timing.WaitBefore(i, delegate { return clock; }, delegate(int ms) { clock += ms; }, guard);
                guard(); timing.CheckDispatch(i, clock);
                result.Starts.Add(clock); result.Sent.Add(plan[i].Kind);
                if (plan[i].Kind == "button_down") result.Owned = true;
                clock += plan[i].Kind == "absolute_mouse_move" ? moveDelay : plan[i].Kind == "button_down" ? downDelay : 2;
                result.Ends.Add(clock);
                if (plan[i].Kind == "button_up") result.Owned = false;
                timing.Record(i, result.Starts[i], result.Ends[i]);
            }
            timing.WaitCompletion(delegate { return clock; }, delegate(int ms) { clock += ms; }, guard);
        } catch (Exception error) { result.Failure = error.Message; }
        finally {
            // A fake ledger models the caller's finally release without issuing UP.
            if (result.Owned) { result.Sent.Add("emergency_owned_up"); result.Owned = false; }
            result.Released = !result.Owned;
        }
        return result;
    }
    static int Main()
    {
        try {
            var single = Run(Single(80), 230, 40, 7, Double.MaxValue, Double.MaxValue);
            Need(single.Failure == null && single.Sent.Count == 3, "delayed MOVE/DOWN finish normally");
            Need(single.Starts[1] - single.Ends[0] >= 150, "actual successful MOVE finish to DOWN start >=150");
            Need(single.Starts[2] - single.Ends[1] >= 80, "actual successful DOWN finish to UP start >=80");
            Need(single.Starts[1] > 150 && single.Starts[2] > 230, "absolute original deadlines cannot shorten actual waits");
            Need(single.Guards > 40 && single.Released, "continuous safety checks and no held fake ownership");
            var longer = Run(Single(150), 300, 3, 9, Double.MaxValue, Double.MaxValue);
            Need(longer.Starts[2] - longer.Ends[1] >= 150, "explicit longer hold is preserved");
            var twice = Run(DoubleClick(), 540, 13, 11, Double.MaxValue, Double.MaxValue);
            Need(twice.Failure == null && twice.Sent.Count == 6, "two complete independent click phases");
            Need(twice.Starts[4] - twice.Ends[3] >= 150 && twice.Starts[5] - twice.Ends[4] >= 80, "second click actual lower bounds");
            Need(twice.Starts[3] - twice.Ends[2] >= 80, "approved interclick gap survives delayed first UP");
            Need(ClickTimelineTiming.TryCreate(DoubleClick(), 540, 0).FirstHoldMs == 80, "receipt hold is80 not whole540");
            foreach (bool loss in new[] { false, true }) {
                var stopped = Run(Single(80), 230, 5, 5, loss ? Double.MaxValue : 100, loss ? 100 : Double.MaxValue);
                Need(stopped.Sent.Count == 1 && stopped.Sent[0] == "absolute_mouse_move", "cancel/focus loss after MOVE prevents DOWN");
                Need(stopped.Released && !stopped.Owned, "pre DOWN stop leaves fake ledger empty");
            }
            var heldCancel = Run(Single(80), 230, 5, 5, 200, Double.MaxValue);
            Need(heldCancel.Sent.Count == 3 && heldCancel.Sent[2] == "emergency_owned_up", "cancel after DOWN invokes owned release");
            Need(heldCancel.Released && !heldCancel.Owned, "post DOWN cancel has empty fake ledger");
            var late = Run(Single(80), 230, 300, 5, Double.MaxValue, Double.MaxValue);
            Need(late.Failure == "click_schedule_grace_exceeded" && late.Sent.Count == 1, "beyond250ms scheduling grace prevents DOWN");
            Need(ClickTimelineTiming.TryCreate(new[] { new ClickTimelineStep("absolute_mouse_move", 0, 0), new ClickTimelineStep("button_down", 0, 1), new ClickTimelineStep("button_up", 500, 1) }, 500, 0) == null, "drag no settle is not reinterpreted as click");
            Need(ClickTimelineTiming.TryCreate(new[] { new ClickTimelineStep("button_down", 0, 2), new ClickTimelineStep("relative_mouse_move", 100, 0), new ClickTimelineStep("button_up", 400, 2) }, 400, 0) == null, "steering remains original timeline");
            Need(ClickTimelineTiming.TryCreate(new[] { new ClickTimelineStep("key_down", 0, 0), new ClickTimelineStep("key_up", 80, 0) }, 80, 0) == null, "keys remain original timeline");
            var immutable = Single(80); var scheduler = ClickTimelineTiming.TryCreate(immutable, 230, 0);
            immutable[1] = new ClickTimelineStep("button_down", 1, 2);
            scheduler.Record(0, 0, 0); Need(scheduler.Earliest(1) == 150, "scheduler copies approved plan and cannot alter caller payload");
            bool refused = false; try { scheduler.CheckDispatch(1, 149.9); } catch (ClickTimelineTiming.Failure) { refused = true; }
            Need(refused, "last native dispatch check refuses early DOWN");
            Console.WriteLine("{\"status\":\"passed\",\"checks\":" + checks + ",\"real_inputs\":0,\"desktop_windows\":0,\"game_effect\":\"unverified\",\"scheduler\":\"production_ClickTimelineTiming\"}"); return 0;
        } catch (Exception error) { Console.Error.WriteLine(error); return 1; }
    }
}
