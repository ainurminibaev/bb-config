// bb Status for Windows: the counterpart of the macOS menu bar item (macos/BBStatus.swift).
//
// It only reads the files the menubar-status plugin keeps next to it (status.json,
// usage.json) and never calls bb. What it shows, chosen by the one-word file "ui":
//   strip (default)  a strip at the left end of the taskbar, laid out like the menu
//                    bar title: "bb", a symbol and a count per agent state, then per
//                    agent its mark and per account two bars filling upwards (thick:
//                    5 hours, thin: week) over the machines' initials, then the time
//                    until the limit that matters resets;
//   tray             a notification-area icon with the most urgent state and a count;
//   both             both.
// Pointing at either opens the panel (panel.html, served by the local helper
// server.py) above the taskbar without taking the keyboard focus; it hides when the
// pointer leaves; a click pins it, a second click hides it; a right click opens the
// menu. Everything is shown only while BB Desktop runs. Built by install.ps1 with
// the C# compiler that ships with Windows (C# 5).
//
// Windows 11 has no place for third-party taskbar content, so the strip is a small
// borderless window kept above the taskbar; it steps aside for full-screen windows.
// The panel is this program's own borderless window around a WebView2 (the Edge
// engine that ships with Windows; its three SDK libraries are fetched by install.ps1).
// Being its own window it is shown without activation, so pointing at the strip never
// moves the keyboard focus; a click inside the panel gives it the keyboard as usual.
// (A separate Edge app window was tried first: Edge puts a new window in front
// whatever it is told, and a program in the background cannot hand the focus back.)
using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Drawing.Text;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Win32;

static class Native
{
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] public static extern bool DestroyIcon(IntPtr handle);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr window, int command);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr window);
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr window);
    [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] public static extern IntPtr GetStyle(IntPtr window, int index);
    [DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW")] public static extern IntPtr SetStyle(IntPtr window, int index, IntPtr value);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr window, out Bounds bounds);
    [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr window, IntPtr after, int x, int y, int width, int height, uint flags);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr FindWindow(string className, string title);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr window, StringBuilder name, int size);
    [DllImport("user32.dll")] public static extern IntPtr GetDC(IntPtr window);
    [DllImport("user32.dll")] public static extern int ReleaseDC(IntPtr window, IntPtr dc);
    [DllImport("gdi32.dll")] public static extern IntPtr CreateCompatibleDC(IntPtr dc);
    [DllImport("gdi32.dll")] public static extern bool DeleteDC(IntPtr dc);
    [DllImport("gdi32.dll")] public static extern IntPtr SelectObject(IntPtr dc, IntPtr item);
    [DllImport("gdi32.dll")] public static extern bool DeleteObject(IntPtr item);
    [DllImport("dwmapi.dll")] public static extern int DwmSetWindowAttribute(IntPtr window, int attribute, ref int value, int size);
    [DllImport("user32.dll")] public static extern bool UpdateLayeredWindow(IntPtr window, IntPtr screen, ref Point position, ref Size size, IntPtr source, ref Point origin, int key, ref Blend blend, int flags);
    [StructLayout(LayoutKind.Sequential)] public struct Bounds { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential, Pack = 1)] public struct Blend { public byte Op, Flags, Alpha, Format; }
    public static readonly IntPtr Topmost = new IntPtr(-1);
}

static class Program
{
    [STAThread]
    static void Main(string[] args)
    {
        Native.SetProcessDPIAware();   // real pixels: everything is placed against the taskbar
        // --render <folder> <file.png> [light]: draw the strip for the data in that folder and exit; for checks.
        if (args.Length >= 3 && args[0] == "--render")
        {
            using (var once = new StatusContext(false, args[1])) once.RenderTo(args[2], args.Length > 3 && args[3] == "light");
            return;
        }
        bool first;
        using (new Mutex(true, "Local\\dev.bb.status", out first))
        {
            if (!first) return;
            Application.EnableVisualStyles();
            // --self-test: show the strip, open and hide the panel, write what happened to self-test.log, exit.
            Application.Run(new StatusContext(args.Length > 0 && (args[0] == "--self-test" || args[0] == "--panel-test")));
        }
    }
}

/** One account's limits as the plugin wrote them. */
sealed class Account
{
    public string Provider = "", Machines = "";
    public int FiveHour = -1, Week = -1, Tariff = -1, Resets;
    public DateTime? FiveHourReset, WeekReset;
}

/** What is shown: agents by state and the accounts. */
sealed class Model
{
    public bool Stale;
    public int Needs, Working, Errors, Unread;
    public List<Account> Accounts = new List<Account>();
}

/** The window on the taskbar: drawn into a bitmap with its own transparency. */
sealed class Strip : Form
{
    public Strip()
    {
        FormBorderStyle = FormBorderStyle.None;
        ShowInTaskbar = false;
        StartPosition = FormStartPosition.Manual;
    }

    protected override bool ShowWithoutActivation { get { return true; } }

    protected override CreateParams CreateParams
    {
        get
        {
            CreateParams p = base.CreateParams;
            p.ExStyle |= 0x80000 | 0x80 | 0x08000000 | 0x8;   // layered, tool window, never activated, topmost
            return p;
        }
    }

    /** Shows the picture at the given screen position; the picture's alpha is the window's shape. */
    public void Present(Bitmap picture, Point at)
    {
        IntPtr screen = Native.GetDC(IntPtr.Zero), memory = Native.CreateCompatibleDC(screen);
        IntPtr bitmap = picture.GetHbitmap(Color.FromArgb(0)), previous = Native.SelectObject(memory, bitmap);
        try
        {
            Size size = picture.Size;
            Point origin = Point.Empty;
            var blend = new Native.Blend { Op = 0, Flags = 0, Alpha = 255, Format = 1 };
            Native.UpdateLayeredWindow(Handle, screen, ref at, ref size, memory, ref origin, 0, ref blend, 2);
        }
        finally
        {
            Native.SelectObject(memory, previous);
            Native.DeleteObject(bitmap);
            Native.DeleteDC(memory);
            Native.ReleaseDC(IntPtr.Zero, screen);
        }
    }
}

/** The panel: a borderless window of this program around the web view that shows panel.html. */
sealed class PanelForm : Form
{
    public readonly Microsoft.Web.WebView2.WinForms.WebView2 View = new Microsoft.Web.WebView2.WinForms.WebView2();

    public PanelForm()
    {
        Text = "bb Status panel";   // not shown (no title bar); names the window for tools and tests
        FormBorderStyle = FormBorderStyle.None;
        ShowInTaskbar = false;
        StartPosition = FormStartPosition.Manual;
        TopMost = true;
        BackColor = Color.FromArgb(241, 243, 248);
        View.Dock = DockStyle.Fill;
        Controls.Add(View);
    }

    /** Shown by pointing, it must not take the keyboard. */
    protected override bool ShowWithoutActivation { get { return true; } }

    protected override CreateParams CreateParams
    {
        get
        {
            CreateParams p = base.CreateParams;
            p.ExStyle |= 0x80 | 0x8 | 0x08000000;   // tool window (no taskbar button, not in Alt+Tab), topmost, not activated
            p.ClassStyle |= 0x00020000;             // a drop shadow, as popups have
            return p;
        }
    }

    /**
     * The window cannot be activated until the user takes it up: Windows hands the keyboard to
     * the first window of a program that has just started, and loading the web view asks for it.
     * A click inside (or on the strip) lifts that, so a reply can be typed; hiding restores it.
     */
    public void AllowActivation(bool allow)
    {
        long style = Native.GetStyle(Handle, -20).ToInt64();
        long wanted = allow ? style & ~0x08000000L : style | 0x08000000L;
        if (wanted != style) Native.SetStyle(Handle, -20, new IntPtr(wanted));
    }

    public bool Activatable { get { return (Native.GetStyle(Handle, -20).ToInt64() & 0x08000000L) == 0; } }

    protected override void WndProc(ref Message m)
    {
        if (m.Msg == 0x0021) AllowActivation(true);   // WM_MOUSEACTIVATE: a click in the window or in the page
        base.WndProc(ref m);
    }

    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        int round = 2;   // Windows 11: rounded corners for a borderless window; ignored on Windows 10
        Native.DwmSetWindowAttribute(Handle, 33, ref round, 4);
    }
}

sealed class StatusContext : ApplicationContext
{
    const int StaleSeconds = 180;
    const int PanelWidth = 860, PanelHeight = 700;
    const int OpenDelayMs = 180;             // a pointer only passing over the taskbar opens nothing
    const int LeaveDelayMs = 450;            // the pointer may cross the gap between strip and panel
        static readonly Color Orange = Color.FromArgb(245, 158, 11), Red = Color.FromArgb(239, 68, 68),
        Blue = Color.FromArgb(96, 165, 250), Green = Color.FromArgb(52, 211, 153), Grey = Color.FromArgb(148, 156, 170);

    readonly string dir = Path.GetDirectoryName(Application.ExecutablePath);
    readonly string port = Environment.GetEnvironmentVariable("BB_MENUBAR_PORT") ?? "47615";
    readonly NotifyIcon tray = new NotifyIcon();
    readonly Strip strip = new Strip();
    readonly ContextMenuStrip menu = new ContextMenuStrip();
    readonly System.Windows.Forms.Timer timer = new System.Windows.Forms.Timer();
    readonly System.Windows.Forms.Timer pointer = new System.Windows.Forms.Timer();
    readonly JavaScriptSerializer json = new JavaScriptSerializer();
    readonly Dictionary<string, Image> marks = new Dictionary<string, Image>();
    readonly List<string> testLog = new List<string>();
    readonly PanelForm panelForm = new PanelForm();
    readonly bool test;
    readonly string readFrom;                // --render: the folder with status.json and usage.json instead of this program's own
    readonly bool useStrip, useTray;
    Model model = new Model { Stale = true };
    Process helper;
    bool awaitLeave;   // hidden by a click on the strip: pointing opens it again only after the pointer has left
    bool wanted, pinned, hovered, stripShown;
    bool viewStarted, viewReady, loaded;     // the web view exists; the page has come
    IntPtr lastOther = IntPtr.Zero;          // the window that had the keyboard last, other than this program's own
    string viewError;
    Rectangle anchor;                        // what the panel hangs over: the strip or the tray icon
    DateTime insideSince = DateTime.MinValue, outsideSince = DateTime.MinValue, hiddenAt = DateTime.MinValue, retryAt = DateTime.MinValue, testStarted, testWait;
    string trayDrawn = "", stripDrawn = "";
    IntPtr iconHandle = IntPtr.Zero;
    int ticks, spin, testStep;

    public StatusContext(bool test, string readFrom = null)
    {
        this.test = test;
        this.readFrom = readFrom;
        testStarted = DateTime.UtcNow;
        if (readFrom != null) return;   // --render: no windows, no timers
        lastOther = Native.GetForegroundWindow();
        string ui = "strip";
        try { ui = File.ReadAllText(Path.Combine(dir, "ui")).Trim().ToLowerInvariant(); } catch (Exception) { }
        useStrip = ui != "tray";
        useTray = ui == "tray" || ui == "both";

        menu.Items.Add("Панель агентов", null, delegate { pinned = true; OpenPanel(true); });
        menu.Items.Add("Открыть bb", null, delegate { OpenBb(); });
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("Скрыть до следующего входа", null, delegate { ExitThread(); });
        tray.ContextMenuStrip = menu;
        tray.MouseMove += delegate { Point p = Cursor.Position; anchor = new Rectangle(p.X - 20, p.Y - 20, 40, 40); if (!wanted) OpenPanel(false); };
        tray.MouseClick += delegate(object sender, MouseEventArgs e) { if (e.Button == MouseButtons.Left) Clicked(); };
        strip.MouseClick += delegate(object sender, MouseEventArgs e)
        {
            if (e.Button == MouseButtons.Left) Clicked();
            else if (e.Button == MouseButtons.Right) menu.Show(Cursor.Position);
        };
        timer.Interval = 2000;
        timer.Tick += delegate { Refresh(); };
        timer.Start();
        pointer.Interval = 100;
        pointer.Tick += delegate { Tick(); };
        pointer.Start();
        Refresh();
    }

    void Clicked()
    {
        // A panel the user has clicked into counts as pinned: the click puts it away. (Activatable says
        // so; the foreground window does not, the click has just made the strip the foreground.)
        if (pinned || (panelForm.Visible && panelForm.Activatable)) { HidePanel(); awaitLeave = true; return; }
        pinned = true;
        OpenPanel(true);
    }

    protected override void ExitThreadCore()
    {
        timer.Stop();
        pointer.Stop();
        tray.Visible = false;
        tray.Dispose();
        strip.Hide();
        strip.Dispose();
        ClosePanel();
        try { panelForm.Dispose(); } catch (Exception) { }
        try { if (helper != null && !helper.HasExited) helper.Kill(); } catch (Exception) { }
        base.ExitThreadCore();
    }

    // --- data -------------------------------------------------------------

    Dictionary<string, object> Read(string name)
    {
        try { return json.Deserialize<Dictionary<string, object>>(File.ReadAllText(Path.Combine(readFrom ?? dir, name))); }
        catch (Exception) { return null; }
    }

    static int Number(IDictionary<string, object> map, string key)
    {
        object value;
        return map != null && map.TryGetValue(key, out value) && value != null ? Convert.ToInt32(Convert.ToDouble(value, CultureInfo.InvariantCulture)) : 0;
    }

    static string Text(IDictionary<string, object> map, string key)
    {
        object value;
        return map != null && map.TryGetValue(key, out value) ? value as string : null;
    }

    Model Load()
    {
        var result = new Model();
        var feed = Read("status.json");
        object raw;
        var counts = feed != null && feed.TryGetValue("counts", out raw) ? raw as Dictionary<string, object> : null;
        double generated = feed != null && feed.ContainsKey("generatedAt") ? Convert.ToDouble(feed["generatedAt"], CultureInfo.InvariantCulture) : 0;
        result.Stale = feed == null || (DateTime.UtcNow - new DateTime(1970, 1, 1)).TotalMilliseconds - generated > StaleSeconds * 1000;
        result.Needs = Number(counts, "needs"); result.Working = Number(counts, "running");
        result.Errors = Number(counts, "error"); result.Unread = Number(counts, "unread");

        var usage = Read("usage.json");
        object accounts;
        if (usage == null || !usage.TryGetValue("accounts", out accounts) || !(accounts is IEnumerable)) return result;
        // Limits older than a quarter of an hour are not shown as if they were current, as in the menu bar item.
        double written = usage.ContainsKey("at") && usage["at"] != null ? Convert.ToDouble(usage["at"], CultureInfo.InvariantCulture) : 0;
        if ((DateTime.UtcNow - new DateTime(1970, 1, 1)).TotalMilliseconds - written > 15 * 60 * 1000) return result;
        foreach (object item in (IEnumerable)accounts)
        {
            var row = item as Dictionary<string, object>;
            object windows, hosts;
            if (row == null || !row.TryGetValue("windows", out windows) || !(windows is IEnumerable)) continue;
            var account = new Account { Provider = Text(row, "provider") ?? "", Resets = Number(row, "resets") };
            // A machine's initial, one per machine, as in the menu bar: "server" -> S.
            if (row.TryGetValue("hosts", out hosts) && hosts is IEnumerable)
                foreach (object host in (IEnumerable)hosts)
                {
                    string name = (host as string ?? "").Trim();
                    if (name.Length > 0 && account.Machines.IndexOf(char.ToUpperInvariant(name[0])) < 0) account.Machines += char.ToUpperInvariant(name[0]);
                }
            foreach (object window in (IEnumerable)windows)
            {
                var entry = window as Dictionary<string, object>;
                string kind = Text(entry, "kind");
                DateTime parsed;
                DateTime? reset = DateTime.TryParse(Text(entry, "resetsAt"), CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind, out parsed) ? parsed.ToUniversalTime() : (DateTime?)null;
                int used = Math.Max(0, Number(entry, "usedPercent"));
                if (kind == "five-hour") { account.FiveHour = used; account.FiveHourReset = reset; }
                if (kind == "weekly") { account.Week = used; account.WeekReset = reset; }
                if ((account.Provider == "vclaude" || account.Provider == "acp-gemini-antig") && kind == "other") { account.Tariff = used; account.Machines = account.Provider == "vclaude" ? "V" : "A"; }
            }
            if (account.FiveHour >= 0 || account.Week >= 0 || account.Tariff >= 0) result.Accounts.Add(account);
        }
        result.Accounts.Sort(delegate(Account a, Account b)
        {
            int byAgent = Order(a.Provider).CompareTo(Order(b.Provider));
            return byAgent != 0 ? byAgent : string.CompareOrdinal(a.Machines, b.Machines);
        });
        return result;
    }

    static int Order(string provider) { return (provider.StartsWith("claude") || provider == "vclaude") ? 0 : provider.StartsWith("codex") ? 1 : 9; }

    void Refresh()
    {
        // Like the menu bar item: present only while the desktop app runs.
        bool running = Process.GetProcessesByName("bb").Length > 0;
        if (!running && !test) { tray.Visible = false; HideStrip(); ClosePanel(); return; }
        KeepHelper();
        model = Load();
        bool taskbar = useStrip && DrawStrip();
        if (useTray || !taskbar) DrawTray(); else tray.Visible = false;   // no taskbar to sit on: fall back to the icon
        // Have the page loaded before the strip is pointed at.
        StartView();
    }

    // --- notification-area icon --------------------------------------------

    void DrawTray()
    {
        Color badge; string digit = "";
        if (model.Stale) badge = Grey;
        else if (model.Needs > 0) { badge = Orange; digit = Short(model.Needs); }
        else if (model.Errors > 0) { badge = Red; digit = Short(model.Errors); }
        else if (model.Working > 0) { badge = Blue; digit = Short(model.Working); }
        else if (model.Unread > 0) badge = Green;
        else badge = Color.Empty;

        string text = model.Stale ? "bb: нет свежих данных" : "bb · ждут " + model.Needs + " · работают " + model.Working +
            (model.Errors > 0 ? " · ошибок " + model.Errors : "") + (model.Unread > 0 ? " · новых " + model.Unread : "");
        int five = -1, week = -1;
        foreach (Account account in model.Accounts) { five = Math.Max(five, account.FiveHour); week = Math.Max(week, account.Week); }
        string limits = (five >= 0 ? " · 5ч " + five + "%" : "") + (week >= 0 ? " · нед " + week + "%" : "");
        if ((text + limits).Length <= 63) text += limits;   // NotifyIcon.Text takes at most 63 characters
        if (text.Length > 63) text = text.Substring(0, 63);

        string signature = badge.ToArgb() + "|" + digit;
        if (signature != trayDrawn)
        {
            using (var bitmap = new Bitmap(32, 32))
            {
                using (var g = Graphics.FromImage(bitmap))
                {
                    g.SmoothingMode = SmoothingMode.AntiAlias;
                    g.TextRenderingHint = TextRenderingHint.AntiAliasGridFit;
                    using (var back = new SolidBrush(Color.FromArgb(31, 41, 55))) FillRound(g, back, new RectangleF(1, 1, 30, 30), 7);
                    using (var font = new Font("Segoe UI", 15f, FontStyle.Bold, GraphicsUnit.Pixel))
                        g.DrawString("bb", font, Brushes.White, new RectangleF(0, badge.IsEmpty ? 5 : 1, 32, 22), Centered());
                    if (!badge.IsEmpty)
                    {
                        var spot = digit.Length > 0 ? new Rectangle(14, 14, 18, 18) : new Rectangle(20, 20, 11, 11);
                        using (var brush = new SolidBrush(badge)) g.FillEllipse(brush, spot);
                        if (digit.Length > 0)
                            using (var font = new Font("Segoe UI", digit.Length > 1 ? 10f : 13f, FontStyle.Bold, GraphicsUnit.Pixel))
                                g.DrawString(digit, font, Brushes.White, new RectangleF(13, 13, 20, 20), Centered());
                    }
                }
                IntPtr handle = bitmap.GetHicon();
                tray.Icon = Icon.FromHandle(handle);
                if (iconHandle != IntPtr.Zero) Native.DestroyIcon(iconHandle);
                iconHandle = handle;
            }
            trayDrawn = signature;
        }
        tray.Text = text;
        tray.Visible = true;
    }

    static string Short(int count) { return count > 9 ? "9+" : count.ToString(); }

    static StringFormat Centered()
    {
        return new StringFormat { Alignment = StringAlignment.Center, LineAlignment = StringAlignment.Center };
    }

    static void FillRound(Graphics g, Brush brush, RectangleF r, float radius)
    {
        using (GraphicsPath path = Round(r, radius)) g.FillPath(brush, path);
    }

    static GraphicsPath Round(RectangleF r, float radius)
    {
        var path = new GraphicsPath();
        float d = Math.Min(radius * 2, Math.Min(r.Width, r.Height));
        path.AddArc(r.X, r.Y, d, d, 180, 90);
        path.AddArc(r.Right - d, r.Y, d, d, 270, 90);
        path.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
        path.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
        path.CloseFigure();
        return path;
    }

    // --- taskbar strip ------------------------------------------------------

    static bool Taskbar(out Rectangle bounds)
    {
        bounds = Rectangle.Empty;
        IntPtr bar = Native.FindWindow("Shell_TrayWnd", null);
        Native.Bounds b;
        if (bar == IntPtr.Zero || !Native.IsWindowVisible(bar) || !Native.GetWindowRect(bar, out b)) return false;
        bounds = Rectangle.FromLTRB(b.Left, b.Top, b.Right, b.Bottom);
        // A hidden (auto-hide) or vertical taskbar has no room for a strip.
        return bounds.Width > bounds.Height * 4 && bounds.Top < Screen.PrimaryScreen.Bounds.Bottom - 8;
    }

    /** A window covering the whole screen (a game, a video) is in front: the taskbar is not in view. */
    static bool FullScreenInFront()
    {
        IntPtr front = Native.GetForegroundWindow();
        Native.Bounds b;
        if (front == IntPtr.Zero || !Native.GetWindowRect(front, out b)) return false;
        var name = new StringBuilder(64);
        Native.GetClassName(front, name, name.Capacity);
        string kind = name.ToString();
        if (kind == "Progman" || kind == "WorkerW" || kind == "Shell_TrayWnd") return false;
        Rectangle screen = Screen.FromHandle(front).Bounds;
        return b.Left <= screen.Left && b.Top <= screen.Top && b.Right >= screen.Right && b.Bottom >= screen.Bottom;
    }

    static bool LightTaskbar()
    {
        try { return Convert.ToInt32(Registry.GetValue("HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize", "SystemUsesLightTheme", 0)) == 1; }
        catch (Exception) { return false; }
    }

    static string Until(DateTime? moment)
    {
        if (moment == null) return "";
        TimeSpan left = moment.Value - DateTime.UtcNow;
        if (left.TotalSeconds <= 0) return "";
        if (left.TotalMinutes < 1) return "<1м";
        if (left.TotalHours >= 24) return (int)left.TotalDays + "д " + left.Hours + "ч";
        return left.TotalHours >= 1 ? (int)left.TotalHours + "ч " + left.Minutes + "м" : left.Minutes + "м";
    }

    static Color Level(int percent, Color normal) { return percent >= 100 ? Red : percent >= 90 ? Orange : normal; }

    /** The agent's own mark (icons\claude-dark.png and the like), or null when the file is missing. */
    Image Mark(string provider, bool light)
    {
        string name = ((provider.StartsWith("claude") || provider == "vclaude") ? "claude" : provider.StartsWith("codex") ? "codex" : provider) + (light ? "-light" : "-dark");
        Image image;
        if (marks.TryGetValue(name, out image)) return image;
        try { using (var file = Image.FromFile(Path.Combine(dir, "icons", name + ".png"))) image = new Bitmap(file); }
        catch (Exception) { image = null; }
        marks[name] = image;
        return image;
    }

    void HideStrip() { if (stripShown) { strip.Hide(); stripShown = false; stripDrawn = ""; } }

    void KeepStripOnTop()
    {
        if (!useStrip || !stripShown) return;
        if (FullScreenInFront()) { HideStrip(); return; }
        // The taskbar is topmost too and comes forward when it is used.
        Native.SetWindowPos(strip.Handle, Native.Topmost, 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0010);
    }

    // The symbols of the menu bar item, drawn here: Windows has no SF Symbols.

    static void SymbolNeeds(Graphics g, RectangleF r)   // exclamationmark.bubble.fill
    {
        using (var brush = new SolidBrush(Orange))
        {
            var body = new RectangleF(r.X, r.Y + r.Height * 0.06f, r.Width, r.Height * 0.72f);
            FillRound(g, brush, body, r.Width * 0.24f);
            g.FillPolygon(brush, new[] { new PointF(r.X + r.Width * 0.22f, body.Bottom - 1), new PointF(r.X + r.Width * 0.52f, body.Bottom - 1), new PointF(r.X + r.Width * 0.24f, r.Bottom) });
        }
        using (var ink = new SolidBrush(Color.FromArgb(40, 26, 0)))
        {
            g.FillRectangle(ink, r.X + r.Width * 0.44f, r.Y + r.Height * 0.20f, r.Width * 0.13f, r.Height * 0.30f);
            g.FillEllipse(ink, r.X + r.Width * 0.43f, r.Y + r.Height * 0.56f, r.Width * 0.15f, r.Width * 0.15f);
        }
    }

    static void SymbolError(Graphics g, RectangleF r)   // xmark.octagon.fill
    {
        float c = r.Width * 0.29f;
        using (var brush = new SolidBrush(Red))
            g.FillPolygon(brush, new[] { new PointF(r.X + c, r.Y), new PointF(r.Right - c, r.Y), new PointF(r.Right, r.Y + c), new PointF(r.Right, r.Bottom - c),
                new PointF(r.Right - c, r.Bottom), new PointF(r.X + c, r.Bottom), new PointF(r.X, r.Bottom - c), new PointF(r.X, r.Y + c) });
        using (var pen = new Pen(Color.White, r.Width * 0.13f) { StartCap = LineCap.Round, EndCap = LineCap.Round })
        {
            float m = r.Width * 0.31f;
            g.DrawLine(pen, r.X + m, r.Y + m, r.Right - m, r.Bottom - m);
            g.DrawLine(pen, r.Right - m, r.Y + m, r.X + m, r.Bottom - m);
        }
    }

    static void SymbolRunning(Graphics g, RectangleF r, int turn)   // arrow.triangle.2.circlepath, turning
    {
        GraphicsState saved = g.Save();
        g.TranslateTransform(r.X + r.Width / 2, r.Y + r.Height / 2);
        g.RotateTransform(turn);
        float radius = r.Width * 0.37f;
        // Two arcs chasing each other, each ending in an arrow head that follows the curve.
        using (var head = new AdjustableArrowCap(2.4f, 2.2f, true))
        using (var pen = new Pen(Blue, r.Width * 0.115f) { StartCap = LineCap.Round, CustomEndCap = head })
            for (int half = 0; half < 2; half++)
            {
                g.DrawArc(pen, -radius, -radius, radius * 2, radius * 2, -70, 118);
                g.RotateTransform(180);
            }
        g.Restore(saved);
    }

    static void SymbolQuiet(Graphics g, RectangleF r, Color color, bool check)   // checkmark.circle, or a plain dot for "new"
    {
        if (!check) { using (var brush = new SolidBrush(color)) g.FillEllipse(brush, r.X + r.Width * 0.2f, r.Y + r.Height * 0.2f, r.Width * 0.6f, r.Height * 0.6f); return; }
        using (var pen = new Pen(color, r.Width * 0.1f) { StartCap = LineCap.Round, EndCap = LineCap.Round, LineJoin = LineJoin.Round })
        {
            g.DrawEllipse(pen, r.X + r.Width * 0.08f, r.Y + r.Height * 0.08f, r.Width * 0.84f, r.Height * 0.84f);
            g.DrawLines(pen, new[] { new PointF(r.X + r.Width * 0.30f, r.Y + r.Height * 0.52f), new PointF(r.X + r.Width * 0.45f, r.Y + r.Height * 0.67f), new PointF(r.X + r.Width * 0.71f, r.Y + r.Height * 0.36f) });
        }
    }

    static void SymbolOffline(Graphics g, RectangleF r)   // wifi.slash
    {
        using (var pen = new Pen(Grey, r.Width * 0.11f) { StartCap = LineCap.Round, EndCap = LineCap.Round })
        {
            float cx = r.X + r.Width / 2, by = r.Bottom - r.Height * 0.16f;
            for (int ring = 1; ring <= 3; ring++) { float q = r.Width * 0.2f * ring; g.DrawArc(pen, cx - q, by - q, q * 2, q * 2, 225, 90); }
            g.DrawLine(pen, r.X + r.Width * 0.12f, r.Y + r.Height * 0.10f, r.Right - r.Width * 0.12f, r.Bottom - r.Height * 0.06f);
        }
        using (var brush = new SolidBrush(Grey)) g.FillEllipse(brush, r.X + r.Width * 0.43f, r.Bottom - r.Height * 0.24f, r.Width * 0.14f, r.Width * 0.14f);
    }

    /** One limit as a bar that fills from the bottom as it is used, like the menu bar item. */
    static void Bar(Graphics g, float x, float top, float width, float height, int used, Color ink)
    {
        var track = new RectangleF(x, top, width, height);
        using (var brush = new SolidBrush(Color.FromArgb(72, ink))) FillRound(g, brush, track, width / 2);
        if (used <= 0) return;
        float filled = Math.Max(width, height * Math.Min(100, used) / 100f);
        GraphicsState saved = g.Save();
        using (GraphicsPath shape = Round(track, width / 2)) g.SetClip(shape, CombineMode.Intersect);
        using (var brush = new SolidBrush(Level(used, ink))) g.FillRectangle(brush, x, top + height - filled, width, filled);
        g.Restore(saved);
    }

    /** Draws the strip when what it shows has changed; false when there is no taskbar to put it on. */
    bool DrawStrip()
    {
        Rectangle bar;
        if (!useStrip || !Taskbar(out bar)) { HideStrip(); return false; }
        if (FullScreenInFront() && !test) { HideStrip(); return true; }
        float s;
        using (var probe = Graphics.FromHwnd(IntPtr.Zero)) s = probe.DpiX / 96f;
        bool light = LightTaskbar();

        var signature = new StringBuilder();
        signature.Append(bar).Append(light).Append(hovered).Append(pinned).Append(model.Stale).Append(model.Needs).Append('/').Append(model.Working)
            .Append('/').Append(model.Errors).Append('/').Append(model.Unread).Append(model.Working > 0 && !model.Stale ? spin : 0);
        foreach (Account a in model.Accounts) signature.Append('|').Append(a.Provider).Append(a.Machines).Append(a.Resets).Append(a.FiveHour).Append('/').Append(a.Week).Append('/').Append(a.Tariff).Append(Until(a.FiveHourReset)).Append(Until(a.WeekReset));
        string wantedPicture = signature.ToString();
        if (wantedPicture == stripDrawn && stripShown) return true;

        using (Bitmap picture = Picture(Math.Max(64, bar.Width / 2), bar.Height, s, light, hovered || pinned))
        {
            var at = new Point(bar.Left + (int)(4 * s), bar.Top);
            strip.Bounds = new Rectangle(at, picture.Size);
            if (!stripShown) { strip.Show(); stripShown = true; }
            strip.Present(picture, at);
        }
        stripDrawn = wantedPicture;
        return true;
    }

    /** The strip as a picture with its own transparency, at most `room` wide: what DrawStrip shows and --render saves. */
    Bitmap Picture(int room, int height, float s, bool light, bool plate)
    {
        Color ink = light ? Color.FromArgb(236, 0, 0, 0) : Color.White;
        Color soft = Color.FromArgb(light ? 170 : 190, ink);
        float middle = height / 2f;
        using (var logo = new Font("Segoe UI", 16f * s, FontStyle.Bold, GraphicsUnit.Pixel))
        using (var digits = new Font("Segoe UI", 13.5f * s, FontStyle.Bold, GraphicsUnit.Pixel))
        using (var small = new Font("Segoe UI", 12f * s, FontStyle.Regular, GraphicsUnit.Pixel))
        using (var tiny = new Font("Segoe UI", 10f * s, FontStyle.Bold, GraphicsUnit.Pixel))
        using (var canvas = new Bitmap(room, height, PixelFormat.Format32bppArgb))
        {
            float x;
            using (var g = Graphics.FromImage(canvas))
            using (var inkBrush = new SolidBrush(ink))
            using (var softBrush = new SolidBrush(soft))
            {
                g.SmoothingMode = SmoothingMode.AntiAlias;
                g.InterpolationMode = InterpolationMode.HighQualityBicubic;
                g.PixelOffsetMode = PixelOffsetMode.HighQuality;
                g.TextRenderingHint = TextRenderingHint.AntiAliasGridFit;   // grey antialiasing: ClearType needs an opaque background
                var left = new StringFormat(StringFormat.GenericTypographic) { LineAlignment = StringAlignment.Center, FormatFlags = StringFormatFlags.NoWrap | StringFormatFlags.MeasureTrailingSpaces };
                Func<string, Font, float> wide = delegate(string text, Font font) { return g.MeasureString(text, font, 1000, left).Width; };
                Action<string, Font, Brush, float> write = delegate(string text, Font font, Brush brush, float at) { g.DrawString(text, font, brush, new RectangleF(at, 0, 1000, height - 1 * s), left); };

                x = 11 * s;
                write("bb", logo, inkBrush, x);
                x += wide("bb", logo) + 3 * s;

                // A symbol and a count per state that has agents; one quiet symbol otherwise.
                float side = 17 * s;
                var states = new List<KeyValuePair<int, int>>();   // kind, count
                if (model.Stale) states.Add(new KeyValuePair<int, int>(5, 0));
                else
                {
                    if (model.Needs > 0) states.Add(new KeyValuePair<int, int>(0, model.Needs));
                    if (model.Errors > 0) states.Add(new KeyValuePair<int, int>(1, model.Errors));
                    if (model.Working > 0) states.Add(new KeyValuePair<int, int>(2, model.Working));
                    if (states.Count == 0) states.Add(model.Unread > 0 ? new KeyValuePair<int, int>(3, model.Unread) : new KeyValuePair<int, int>(4, 0));
                }
                foreach (var state in states)
                {
                    x += 6 * s;
                    var box = new RectangleF(x, middle - side / 2, side, side);
                    if (state.Key == 0) SymbolNeeds(g, box);
                    else if (state.Key == 1) SymbolError(g, box);
                    else if (state.Key == 2) SymbolRunning(g, box, spin);
                    else if (state.Key == 3) SymbolQuiet(g, box, Green, false);
                    else if (state.Key == 4) SymbolQuiet(g, box, Grey, true);
                    else SymbolOffline(g, box);
                    x += side;
                    if (state.Value > 0) { x += 3 * s; string count = state.Value.ToString(); write(count, digits, inkBrush, x); x += wide(count, digits); }
                }

                // Limits, the usage block of the menu bar item at taskbar scale: per agent its mark, per
                // account a thick bar (5 hours) and a thin one (week), both filling upwards, with the
                // machines' initials underneath and "+N" for limit resets on hand; a line between agents.
                // A limit bb has no figure for gets no bar: nothing is drawn in its place.
                float barHeight = 21 * s, barTop = middle - 15 * s, thick = 6 * s, thin = 3 * s, between = 3 * s, labelTop = barTop + barHeight + 1 * s;
                string previous = "";
                Account tightest = null;
                if (model.Accounts.Count > 0) x += 12 * s;
                foreach (Account account in model.Accounts)
                {
                    if (account.Provider != previous)
                    {
                        if (previous.Length > 0)
                        {
                            x += 7 * s;
                            using (var line = new Pen(Color.FromArgb(light ? 70 : 90, ink), 1)) g.DrawLine(line, x, height * 0.24f, x, height * 0.76f);
                            x += 8 * s;
                        }
                        Image mark = Mark(account.Provider, light);
                        float markSide = 18 * s;
                        if (mark != null) { g.DrawImage(mark, new RectangleF(x, middle - markSide / 2, markSide, markSide)); x += markSide + 6 * s; }
                        previous = account.Provider;
                    }
                    else x += 7 * s;

                    string plus = account.Resets > 0 ? "+" + account.Resets : "";
                    float lettersWidth = wide(account.Machines, tiny), labelWidth = lettersWidth + (plus.Length > 0 ? wide(plus, tiny) : 0);
                    float barsWidth = (account.FiveHour >= 0 || account.Tariff >= 0 ? thick + between : 0) + thin;
                    float column = Math.Max(barsWidth, labelWidth), bx = x + (column - barsWidth) / 2;
                    if (account.FiveHour >= 0 || account.Tariff >= 0) { Bar(g, bx, barTop, thick, barHeight, Math.Max(account.FiveHour, account.Tariff), ink); bx += thick + between; }
                    if (account.Week >= 0) Bar(g, bx, barTop, thin, barHeight, account.Week, ink);
                    float lx = x + (column - labelWidth) / 2;
                    g.DrawString(account.Machines, tiny, softBrush, lx, labelTop, StringFormat.GenericTypographic);
                    if (plus.Length > 0) using (var green = new SolidBrush(light ? Color.FromArgb(4, 120, 87) : Green)) g.DrawString(plus, tiny, green, lx + lettersWidth, labelTop, StringFormat.GenericTypographic);
                    x += column;
                    // The reset that matters, as in the menu bar: the most used 5-hour limit, or the
                    // week of that account when it is used up too; without 5-hour limits the most used week.
                    if (account.FiveHour >= 0 && (tightest == null || tightest.FiveHour < account.FiveHour)) tightest = account;
                }
                if (tightest == null) foreach (Account account in model.Accounts) if (tightest == null || tightest.Week < account.Week) tightest = account;
                if (tightest != null)
                {
                    bool byWeek = tightest.FiveHour < 0 || tightest.Week >= 100;
                    int used = byWeek ? tightest.Week : tightest.FiveHour;
                    string time = Until(byWeek ? tightest.WeekReset : tightest.FiveHourReset);
                    if (time.Length > 0)
                    {
                        x += 10 * s;
                        float width = wide(time, small);
                        if (used >= 90)
                        {
                            // An alert is white text on a coloured pill: coloured text on the taskbar reads badly.
                            var pill = new RectangleF(x, middle - 10 * s, width + 12 * s, 20 * s);
                            using (var brush = new SolidBrush(used >= 100 ? Red : Orange)) FillRound(g, brush, pill, 10 * s);
                            write(time, small, Brushes.White, x + 6 * s);
                            x = pill.Right;
                        }
                        else { write(time, small, softBrush, x); x += width; }
                    }
                }
                x += 12 * s;
            }

            int widthPixels = Math.Min(canvas.Width, (int)Math.Ceiling(x));
            var picture = new Bitmap(widthPixels, height, PixelFormat.Format32bppArgb);
            using (var g = Graphics.FromImage(picture))
            {
                g.SmoothingMode = SmoothingMode.AntiAlias;
                // Almost invisible everywhere, so the whole strip takes the pointer; a soft plate when pointed at or pinned.
                using (var ground = new SolidBrush(Color.FromArgb(plate ? (light ? 28 : 38) : 1, ink))) FillRound(g, ground, new RectangleF(2 * s, 4 * s, widthPixels - 4 * s, height - 8 * s), 6 * s);
                g.DrawImageUnscaled(canvas, 0, 0);
            }
            return picture;
        }
    }

    /** --render: the strip for the status.json and usage.json of the given folder, on a taskbar-coloured ground. */
    public void RenderTo(string output, bool light)
    {
        model = Load();
        float s;
        using (var probe = Graphics.FromHwnd(IntPtr.Zero)) s = probe.DpiX / 96f;
        using (Bitmap picture = Picture(1200, (int)(48 * s), s, light, false))
        using (var ground = new Bitmap(picture.Width + (int)(8 * s), picture.Height, PixelFormat.Format32bppArgb))
        {
            using (var g = Graphics.FromImage(ground))
            {
                g.Clear(light ? Color.FromArgb(238, 241, 246) : Color.FromArgb(28, 36, 45));
                g.DrawImageUnscaled(picture, (int)(4 * s), 0);
            }
            ground.Save(output, ImageFormat.Png);
        }
    }

    // --- helper -----------------------------------------------------------

    /**
     * The helper serves the panel on loopback; it is started here and restarted if it stops.
     * It is told this program's process ID and leaves when the program is gone, also when the
     * program was stopped rather than closed: otherwise every restart would leave one behind.
     */
    void KeepHelper()
    {
        try
        {
            if (helper != null && !helper.HasExited) return;
            string python = "python";
            string named = Path.Combine(dir, "python");
            if (File.Exists(named)) python = File.ReadAllText(named).Trim();
            var start = new ProcessStartInfo(python, "-X utf8 \"" + Path.Combine(dir, "server.py") + "\" " + port + " " + Process.GetCurrentProcess().Id);
            start.UseShellExecute = false;
            start.CreateNoWindow = true;
            start.WorkingDirectory = dir;
            helper = Process.Start(start);
        }
        catch (Exception) { helper = null; }
    }

    // --- panel ------------------------------------------------------------

    /** Loads the WebView2 that shows panel.html, once; the window stays hidden until it is pointed at. */
    void StartView()
    {
        if (viewStarted) return;
        viewStarted = true;
        try
        {
            IntPtr created = panelForm.Handle;   // the control needs its window before the web view can be put in it
            created = panelForm.View.Handle;
            KeepKeyboardWithTheUser(Cursor.Position);
            var ui = TaskScheduler.FromCurrentSynchronizationContext();
            // Its own data folder: nothing is shared with the user's browser.
            CoreWebView2Environment.CreateAsync(null, Path.Combine(dir, "webview"), null).ContinueWith(delegate(Task<CoreWebView2Environment> environment)
            {
                if (environment.IsFaulted) { viewError = Reason(environment.Exception); Trace("web view environment: " + viewError); return; }
                panelForm.View.EnsureCoreWebView2Async(environment.Result).ContinueWith(delegate(Task ready)
                {
                    if (ready.IsFaulted) { viewError = Reason(ready.Exception); Trace("web view: " + viewError); return; }
                    CoreWebView2 core = panelForm.View.CoreWebView2;
                    core.Settings.AreDefaultContextMenusEnabled = false;
                    core.Settings.AreDevToolsEnabled = false;
                    core.Settings.IsStatusBarEnabled = false;
                    core.Settings.IsZoomControlEnabled = false;
                    core.NavigationCompleted += delegate(object sender, CoreWebView2NavigationCompletedEventArgs e) { loaded = e.IsSuccess; retryAt = DateTime.UtcNow.AddSeconds(2); };
                    // A link in a reply opens in the user's browser, not inside the panel.
                    core.NewWindowRequested += delegate(object sender, CoreWebView2NewWindowRequestedEventArgs e) { e.Handled = true; try { Uri link; if (Uri.TryCreate(e.Uri, UriKind.Absolute, out link) && (link.Scheme == Uri.UriSchemeHttps || link.Scheme == Uri.UriSchemeHttp)) Process.Start(link.AbsoluteUri); } catch (Exception) { } };
                    // The page reports a click or a key press in it ("pin") and Esc or its close button ("close"),
                    // as it does to the macOS app.
                    core.WebMessageReceived += delegate(object sender, CoreWebView2WebMessageReceivedEventArgs e)
                    {
                        string message = e.WebMessageAsJson ?? "";
                        if (message.Contains("\"close\"")) HidePanel();
                        else if (message.Contains("\"pin\"") && panelForm.Visible) TakeUp();
                    };
                    viewReady = true;
                    KeepKeyboardWithTheUser(Cursor.Position);
                    Navigate();
                }, ui);
            }, ui);
        }
        catch (Exception error) { viewError = error.Message; Trace("web view start: " + viewError); }
    }

    static string Reason(AggregateException error) { return error == null ? "unknown" : error.GetBaseException().Message; }

    void Navigate()
    {
        try
        {
            retryAt = DateTime.UtcNow.AddSeconds(4);
            panelForm.View.CoreWebView2.Navigate("http://127.0.0.1:" + port + "/?ui=windows&t=" + File.ReadAllText(Path.Combine(dir, "token")).Trim());
        }
        catch (Exception error) { Trace("navigate: " + error.Message); }
    }

    /** Where the panel goes: above the taskbar, over what was pointed at, inside the screen. */
    Rectangle Place()
    {
        Rectangle over = anchor.IsEmpty ? (stripShown ? strip.Bounds : new Rectangle(Screen.PrimaryScreen.WorkingArea.Left, Screen.PrimaryScreen.WorkingArea.Bottom, 40, 40)) : anchor;
        Rectangle area = Screen.FromRectangle(over).WorkingArea;
        float scale;
        using (var g = Graphics.FromHwnd(IntPtr.Zero)) scale = g.DpiX / 96f;
        int width = Math.Min((int)(PanelWidth * scale), area.Width - 16), height = Math.Min((int)(PanelHeight * scale), area.Height - 16);
        int x = Math.Max(area.Left + 8, Math.Min(over.Left, area.Right - width - 8));
        return new Rectangle(x, area.Bottom - height - 8, width, height);
    }

    /** Shows the panel in place. Pointing never gives it the keyboard; a click on the strip or the icon does. */
    void OpenPanel(bool activate)
    {
        wanted = true;
        outsideSince = DateTime.MinValue;
        StartView();
        Rectangle at = Place();
        if (viewReady) { try { panelForm.View.CoreWebView2.Resume(); } catch (Exception) { } }
        // Shown without activation (ShowWithoutActivation) and raised; the window is this program's own.
        panelForm.Bounds = at;
        if (!panelForm.Visible) panelForm.Show();
        Native.SetWindowPos(panelForm.Handle, Native.Topmost, 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0010);
        if (activate) { panelForm.AllowActivation(true); panelForm.Activate(); panelForm.View.Focus(); }
        Tell("bbShown");
        stripDrawn = "";
        DrawStrip();
    }

    /** Calls one of the page's hooks (bbShown: load fresh data now; bbHidden: stop polling, drop the focus), as the macOS app does. */
    void Tell(string hook)
    {
        if (!viewReady || !loaded) return;
        try { panelForm.View.CoreWebView2.ExecuteScriptAsync("window." + hook + " && window." + hook + "()"); } catch (Exception) { }
    }

    /** The user clicked or typed in the panel: now it may have the keyboard, so a reply can be written. */
    void TakeUp()
    {
        if (panelForm.Activatable && Native.GetForegroundWindow() == panelForm.Handle) return;
        panelForm.AllowActivation(true);
        panelForm.Activate();
        panelForm.View.Focus();
        Tell("bbTaken");
        Trace("panel taken up by a click in it; has the keyboard=" + (Native.GetForegroundWindow() == panelForm.Handle));
    }

    void HidePanel()
    {
        wanted = false;
        pinned = false;
        insideSince = DateTime.MinValue;
        hiddenAt = DateTime.UtcNow;
        Tell("bbHidden");
        if (panelForm.Visible) panelForm.Hide();
        panelForm.AllowActivation(false);
        stripDrawn = "";
        DrawStrip();
    }

    void ClosePanel()
    {
        wanted = false;
        pinned = false;
        if (panelForm.Visible) panelForm.Hide();
    }

    /**
     * The panel may have the keyboard only once the user has clicked it. Should Windows give it
     * the keyboard anyway (it does to a program that has just started), it goes straight back
     * to the window that had it: this program holds the foreground then, so it may pass it on.
     */
    void KeepKeyboardWithTheUser(Point p)
    {
        IntPtr front = Native.GetForegroundWindow();
        bool mine = front == panelForm.Handle || front == strip.Handle;
        if (!mine) { if (front != IntPtr.Zero) lastOther = front; return; }
        if (panelForm.Visible && panelForm.Activatable) return;
        bool back = lastOther != IntPtr.Zero && Native.IsWindow(lastOther) && Native.SetForegroundWindow(lastOther);
        Trace("the keyboard came to a panel nobody clicked; handed back=" + back);
    }

    /** Diagnostics, only while a file named "debug" lies next to the program: window handles and outcomes, never page content. */
    void Trace(string line)
    {
        try { if (File.Exists(Path.Combine(dir, "debug"))) File.AppendAllText(Path.Combine(dir, "debug.log"), DateTime.Now.ToString("HH:mm:ss.fff ") + line + "\r\n"); }
        catch (Exception) { }
    }

    /** Every 100 ms: where the pointer is decides, whoever has the keyboard focus. */
    void Tick()
    {
        ticks++;
        if (ticks % 10 == 0) KeepStripOnTop();
        int turn = (Environment.TickCount & 0x7FFFFFFF) / 100 * 12 % 360;
        if (model.Working > 0 && !model.Stale && stripShown && turn != spin) { spin = turn; DrawStrip(); }
        KeepKeyboardWithTheUser(Cursor.Position);
        if (test) { TestStep(); return; }

        // The helper may start after the web view: load the page again until it has come.
        if (viewReady && !loaded && DateTime.UtcNow > retryAt) Navigate();
        // A page nobody looks at does not need to run: its timers stop until it is shown again.
        if (viewReady && loaded && !wanted && hiddenAt != DateTime.MinValue && (DateTime.UtcNow - hiddenAt).TotalSeconds > 30)
        {
            hiddenAt = DateTime.MinValue;
            try { panelForm.View.CoreWebView2.TrySuspendAsync(); } catch (Exception) { }
        }

        Point p = Cursor.Position;
        bool onStrip = stripShown && strip.Bounds.Contains(p);
        if (onStrip != hovered) { hovered = onStrip; stripDrawn = ""; DrawStrip(); }
        if (onStrip)
        {
            anchor = strip.Bounds;
            outsideSince = DateTime.MinValue;
            if (insideSince == DateTime.MinValue) insideSince = DateTime.UtcNow;
            if (!wanted && !awaitLeave && (DateTime.UtcNow - insideSince).TotalMilliseconds >= OpenDelayMs) OpenPanel(false);
        }
        else { insideSince = DateTime.MinValue; awaitLeave = false; }

        if (!wanted || !panelForm.Visible) return;
        if (pinned || onStrip) return;
        // Clicked into, the panel has the keyboard: typing a reply keeps it, as in the menu bar item.
        if (panelForm.Activatable && Native.GetForegroundWindow() == panelForm.Handle) { outsideSince = DateTime.MinValue; return; }
        Rectangle b = panelForm.Bounds;
        var over = Rectangle.Inflate(b, 8, 8);
        var near = Rectangle.Inflate(anchor, 8, 8);
        // The way between the panel's lower edge and what was pointed at counts as inside.
        var bridge = Rectangle.FromLTRB(Math.Min(b.Left, near.Left), b.Bottom - 8, Math.Max(b.Right, near.Right), Math.Max(b.Bottom, near.Bottom));
        if (over.Contains(p) || near.Contains(p) || bridge.Contains(p)) { outsideSince = DateTime.MinValue; return; }
        if (outsideSince == DateTime.MinValue) { outsideSince = DateTime.UtcNow; return; }
        if ((DateTime.UtcNow - outsideSince).TotalMilliseconds > LeaveDelayMs) HidePanel();
    }

    // --- self-test ----------------------------------------------------------

    /** Opens and hides the panel three times without the pointer and records what the window did. */
    void TestStep()
    {
        double seconds = (DateTime.UtcNow - testStarted).TotalSeconds;
        if (viewReady && !loaded && DateTime.UtcNow > retryAt) Navigate();
        if (testStep == 0)
        {
            testLog.Add("focusBefore=" + Native.GetForegroundWindow());
            StartView();
            if (!loaded && viewError == null && seconds < 45) return;   // the page first
            testLog.Add("webView ready=" + viewReady + " pageLoaded=" + loaded + (viewError != null ? " error=" + viewError : "") + " after=" + seconds.ToString("0.0", CultureInfo.InvariantCulture) + "s");
            anchor = stripShown ? strip.Bounds : anchor;
            OpenPanel(false);
            testStep = 1;
            testWait = DateTime.UtcNow;
            return;
        }
        if ((DateTime.UtcNow - testWait).TotalMilliseconds < 700) return;   // let each state settle
        testWait = DateTime.UtcNow;
        if (testStep % 2 == 1)
        {
            Rectangle at = Place(), b = panelForm.Bounds;
            testLog.Add("cycle" + (testStep + 1) / 2 + ": shown=" + panelForm.Visible + " rect=" + b.Left + "," + b.Top + "," + b.Right + "," + b.Bottom +
                " expected=" + at.Left + "," + at.Top + "," + at.Right + "," + at.Bottom + " hasKeyboard=" + (Native.GetForegroundWindow() == panelForm.Handle));
            HidePanel();
            testStep++;
            return;
        }
        testLog[testLog.Count - 1] += " hidden=" + !panelForm.Visible;
        if (testStep >= 6 || seconds > 70)
        {
            Rectangle bar;
            bool taskbar = Taskbar(out bar);
            testLog.Add("ui=" + (useStrip ? "strip" : "") + (useTray ? "+tray" : "") + " taskbar=" + taskbar + " strip=" + stripShown + " stripRect=" + strip.Left + "," + strip.Top + "," + strip.Right + "," + strip.Bottom +
                " accounts=" + model.Accounts.Count + " stale=" + model.Stale + " helper=" + (helper != null && !helper.HasExited) + " focusAfter=" + Native.GetForegroundWindow());
            File.WriteAllLines(Path.Combine(dir, "self-test.log"), testLog.ToArray());
            ExitThread();
            return;
        }
        OpenPanel(false);
        testStep++;
    }

    static void OpenBb()
    {
        try
        {
            string app = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs\\bb\\bb.exe");
            if (File.Exists(app)) Process.Start(app);
        }
        catch (Exception) { }
    }
}
