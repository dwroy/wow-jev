// Offline image tests only: no desktop capture, process launch, or input API.
using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Web.Script.Serialization;

static class RecoveryCalibrationFixture
{
    static readonly List<object> Rows = new List<object>();
    static void Need(bool condition, string name)
    { Rows.Add(new Dictionary<string, object> { { "check", name }, { "passed", condition } }); if (!condition) throw new InvalidOperationException(name); }
    static bool Selected(Bitmap image, string root) { return (bool)RecoveryCalibration.Match(image, root)["verified"]; }
    static bool Tutorial(Bitmap image, string root) { return (bool)RecoveryTutorialCv.Match(image, root)["verified"]; }
    static Bitmap Changed(Bitmap image, Rectangle rectangle, Color color)
    { var copy = new Bitmap(image); using (var graphics = Graphics.FromImage(copy)) using (var brush = new SolidBrush(color)) graphics.FillRectangle(brush, rectangle); return copy; }
    static int Main(string[] args)
    {
        try
        {
            if (args.Length != 3) throw new InvalidOperationException("three_offline_paths_required");
            using (var selection = new Bitmap(args[0])) using (var tutorial = new Bitmap(args[1]))
            {
                string root = args[2];
                Need(Selected(selection, root), "reviewed_selected_alliance_warrior");
                using (var image = Changed(selection, new Rectangle(2037, 614, 110, 45), Color.Magenta)) Need(!Selected(image, root), "wrong_name_rejected");
                using (var image = Changed(selection, new Rectangle(2052, 638, 6, 5), Color.Magenta)) Need(!Selected(image, root), "thirty_changed_name_pixels_not_hidden_by_background");
                using (var image = Changed(selection, new Rectangle(2119, 657, 66, 43), Color.Magenta)) Need(!Selected(image, root), "wrong_class_rejected");
                using (var image = Changed(selection, new Rectangle(2390, 625, 101, 112), Color.Black)) Need(!Selected(image, root), "wrong_or_missing_alliance_glyph_rejected");
                using (var image = Changed(selection, new Rectangle(2014, 598, 483, 148), Color.Gray)) Need(!Selected(image, root), "unselected_row_rejected");
                using (var image = new Bitmap(1280, 720)) Need(!Selected(image, root), "selection_wrong_dimensions_rejected");
                Need(!Selected(tutorial, root), "world_not_selection");
                Need(Tutorial(tutorial, root), "reviewed_named_npc_and_same_tutorial_hint");
                using (var image = Changed(tutorial, new Rectangle(1194, 332, 309, 44), Color.Black)) Need(!Tutorial(image, root), "missing_or_wrong_npc_name_rejected");
                using (var image = Changed(tutorial, new Rectangle(1114, 921, 446, 65), Color.Black)) Need(!Tutorial(image, root), "different_or_missing_task_hint_rejected");
                using (var image = new Bitmap(2560, 1440))
                {
                    using (var graphics = Graphics.FromImage(image)) graphics.DrawImageUnscaled(tutorial, 50, 0);
                    Need(!Tutorial(image, root), "uncalibrated_camera_shift_rejected");
                }
                Need(!Tutorial(selection, root), "selection_not_world_conversation");
                using (var image = new Bitmap(1280, 720)) Need(!Tutorial(image, root), "tutorial_wrong_dimensions_rejected");
            }
            Console.WriteLine(new JavaScriptSerializer().Serialize(new { status = "passed", checks = Rows.Count, results = Rows, game_inputs = 0, desktop_capture = 0, model_calls = 0 }));
            return 0;
        }
        catch (Exception error)
        { Console.WriteLine(new JavaScriptSerializer().Serialize(new { status = "failed", reason = error.Message, results = Rows, game_inputs = 0 })); return 1; }
    }
}
