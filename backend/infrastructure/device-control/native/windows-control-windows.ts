export const WINDOWS_CONTROL_WINDOWS_SOURCE = String.raw`
public static partial class NeuraflokWindowsControl {
  public static string Cursor() {
    POINT p; GetCursorPos(out p);
    return p.X + "," + p.Y;
  }

  /** Virtual desktop rect, then the primary monitor's size. */
  public static string Screen() {
    return VX + "," + VY + "," + VW + "," + VH + "," + GetSystemMetrics(0) + "," + GetSystemMetrics(1);
  }

  public static string Rect(long handle) {
    RECT r;
    if (!GetWindowRect(new IntPtr(handle), out r)) throw new Exception("No window with that id is open.");
    return r.Left + "," + r.Top + "," + (r.Right - r.Left) + "," + (r.Bottom - r.Top);
  }

  public static string Window(long handle) {
    IntPtr h = new IntPtr(handle);
    if (!IsWindow(h) || !IsWindowVisible(h)) return "";
    int len = GetWindowTextLengthW(h);
    // An exact handle may name a menu/popup without a title. General listing still filters these; related-window discovery supplies their ownership proof.
    StringBuilder sb = new StringBuilder(len + 1);
    GetWindowTextW(h, sb, sb.Capacity);
    RECT r;
    if (!GetWindowRect(h, out r) || r.Right - r.Left <= 0 || r.Bottom - r.Top <= 0) return "";
    uint pid;
    GetWindowThreadProcessId(h, out pid);
    if (OwnPid != 0 && pid == OwnPid) return ""; // NEURAFLOK's own windows are not listed or targeted.
    string[] identity = NeuraflokWindowsAppIdentity.Read(handle, pid);
    if (identity[0].Length == 0) return ""; // Unknown app identity cannot be targeted by the window API.
    string proc = System.IO.Path.GetFileNameWithoutExtension(identity[1]);
    if (proc.Length == 0) try { using (var process = System.Diagnostics.Process.GetProcessById((int)pid)) proc = process.ProcessName; } catch { }
    uint dpi = GetDpiForWindow(h);
    if (dpi == 0) return "";
    return string.Join(((char)31).ToString(), new string[] {
      h.ToInt64().ToString(), sb.ToString().Replace((char)31, ' '), proc,
      r.Left.ToString(), r.Top.ToString(), (r.Right - r.Left).ToString(), (r.Bottom - r.Top).ToString(),
      IsIconic(h) ? "minimized" : (h == GetForegroundWindow() ? "foreground" : "open"),
      identity[0], pid.ToString(), identity[1], identity[2], dpi.ToString()
    });
  }

  public static List<string> Windows() {
    List<string> found = new List<string>();
    EnumWindows(delegate(IntPtr h, IntPtr lp) {
      if (!IsWindowVisible(h)) return true;
      int len = GetWindowTextLengthW(h);
      if (len == 0) return true;
      // WS_EX_TOOLWINDOW: palettes and other chrome the user never thinks of as a window, which would otherwise bury the real ones.
      if ((GetWindowLong(h, -20) & 0x00000080) != 0) return true;
      string row = Window(h.ToInt64());
      if (row.Length > 0) found.Add(row);
      return true;
    }, IntPtr.Zero);
    return found;
  }

  static bool OwnedBy(IntPtr candidate, IntPtr target) {
    IntPtr root = GetAncestor(candidate, 2); // GA_ROOT: child controls belong to their top-level window.
    if (root != IntPtr.Zero) candidate = root;
    for (int depth = 0; depth < 16 && candidate != IntPtr.Zero; depth++) {
      if (candidate == target) return true;
      candidate = GetWindow(candidate, 4); // GW_OWNER: exact owner chain, never merely same PID.
    }
    return false;
  }

  static bool IsMenu(IntPtr window) {
    StringBuilder name = new StringBuilder(256);
    GetClassNameW(window, name, name.Capacity);
    return name.ToString() == "#32768";
  }

  public static bool IsRelatedWindow(long candidateHandle, long targetHandle) {
    IntPtr candidate = new IntPtr(candidateHandle), target = new IntPtr(targetHandle);
    if (candidate == target || !IsWindow(target) || !IsWindowVisible(candidate) || IsIconic(candidate)) return false;
    if (OwnedBy(candidate, target)) return true;
    if (!IsMenu(candidate)) return false;
    uint targetProcess, candidateProcess;
    uint targetThread = GetWindowThreadProcessId(target, out targetProcess);
    uint candidateThread = GetWindowThreadProcessId(candidate, out candidateProcess);
    GUITHREADINFO gui = new GUITHREADINFO();
    gui.cbSize = (uint)Marshal.SizeOf(typeof(GUITHREADINFO));
    return candidateThread == targetThread && candidateProcess == targetProcess && GetGUIThreadInfo(targetThread, ref gui) &&
      gui.menuOwner != IntPtr.Zero && OwnedBy(gui.menuOwner, target);
  }

  static IntPtr InputRoot(IntPtr window) {
    bool menu = IsMenu(window);
    if ((GetWindowLong(window, -20) & 0x08000000) == 0 && !menu) return window; // WS_EX_NOACTIVATE
    IntPtr owner = GetWindow(window, 4);
    if (owner == IntPtr.Zero && menu) {
      uint process;
      uint thread = GetWindowThreadProcessId(window, out process);
      GUITHREADINFO gui = new GUITHREADINFO();
      gui.cbSize = (uint)Marshal.SizeOf(typeof(GUITHREADINFO));
      if (GetGUIThreadInfo(thread, ref gui)) owner = GetAncestor(gui.menuOwner, 2);
    }
    for (int depth = 0; depth < 16 && owner != IntPtr.Zero; depth++) {
      if ((GetWindowLong(owner, -20) & 0x08000000) == 0 && !IsMenu(owner)) break;
      owner = GetWindow(owner, 4);
    }
    return owner != IntPtr.Zero && IsRelatedWindow(window.ToInt64(), owner.ToInt64()) ? owner : IntPtr.Zero;
  }

  public static bool InputIsFocused(long handle) {
    IntPtr window = new IntPtr(handle);
    if (!IsWindowVisible(window) || IsIconic(window)) return false;
    IntPtr root = InputRoot(window);
    return root != IntPtr.Zero && GetForegroundWindow() == root;
  }

  public static List<string> RelatedWindows(long handle) {
    IntPtr target = new IntPtr(handle);
    List<string> related = new List<string>();
    if (!IsWindow(target)) return related;
    uint targetProcess;
    uint targetThread = GetWindowThreadProcessId(target, out targetProcess);
    GUITHREADINFO gui = new GUITHREADINFO();
    gui.cbSize = (uint)Marshal.SizeOf(typeof(GUITHREADINFO));
    bool menuOwned = GetGUIThreadInfo(targetThread, ref gui) && gui.menuOwner != IntPtr.Zero && OwnedBy(gui.menuOwner, target);
    EnumWindows(delegate(IntPtr candidate, IntPtr lp) {
      if (candidate == target || !IsWindowVisible(candidate) || IsIconic(candidate)) return true;
      bool owned = OwnedBy(candidate, target);
      if (!owned && menuOwned) {
        uint candidateProcess;
        uint candidateThread = GetWindowThreadProcessId(candidate, out candidateProcess);
        StringBuilder className = new StringBuilder(256);
        GetClassNameW(candidate, className, className.Capacity);
        owned = candidateThread == targetThread && candidateProcess == targetProcess && className.ToString() == "#32768";
      }
      if (!owned) return true;
      string row = Window(candidate.ToInt64());
      if (row.Length > 0) related.Add(row);
      return related.Count < 3;
    }, IntPtr.Zero);
    return related;
  }

  // Detach only input threads this operation attached, including when window activation fails.
  public static bool Focus(long handle) {
    IntPtr h = InputRoot(new IntPtr(handle));
    if (h == IntPtr.Zero) return false;
    if (!IsWindow(h)) return false;
    if (GetForegroundWindow() == h) return true;
    if (IsIconic(h)) ShowWindow(h, 9);
    uint dummy;
    uint fore = GetWindowThreadProcessId(GetForegroundWindow(), out dummy);
    uint target = GetWindowThreadProcessId(h, out dummy);
    uint self = GetCurrentThreadId();
    var attached = new List<Tuple<uint, uint>>();
    Action<uint, uint> attach = (from, to) => {
      if (from == 0 || to == 0 || from == to) return;
      foreach (var pair in attached)
        if ((pair.Item1 == from && pair.Item2 == to) || (pair.Item1 == to && pair.Item2 == from)) return;
      if (AttachThreadInput(from, to, true)) attached.Add(Tuple.Create(from, to));
    };
    try {
      attach(self, fore);
      attach(self, target);
      attach(fore, target);
      return SetForegroundWindow(h);
    } finally {
      for (int i = attached.Count - 1; i >= 0; i--)
        AttachThreadInput(attached[i].Item1, attached[i].Item2, false);
    }
  }

  public static long ForegroundId() {
    return GetForegroundWindow().ToInt64();
  }

  // Downscale before encoding to avoid oversized captures and return the dimensions actually written.
}
`;
