export const WINDOWS_CONTROL_INPUT_SOURCE = String.raw`
public static partial class NeuraflokWindowsControl {
  static void Send(INPUT[] inputs) {
    uint sent = SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT)));
    if (sent != inputs.Length) throw new Exception("SendInput was blocked (sent " + sent + " of " + inputs.Length + "). A window running as administrator can refuse synthetic input.");
  }

  static INPUT Mouse(uint flags, int dx, int dy, uint data) {
    INPUT i = new INPUT();
    i.type = INPUT_MOUSE;
    i.u.mi.dx = dx; i.u.mi.dy = dy; i.u.mi.mouseData = data;
    i.u.mi.dwFlags = flags;
    return i;
  }

  // SendInput takes absolute coordinates normalised to 0..65535 across the whole virtual desktop, not pixels, so every monitor layout works with one formula.
  public static void Move(int x, int y) {
    int nx = (int)(((double)(x - VX) * 65535.0) / Math.Max(1, VW - 1));
    int ny = (int)(((double)(y - VY) * 65535.0) / Math.Max(1, VH - 1));
    Send(new INPUT[] { Mouse(MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK, nx, ny, 0) });
  }

  // Resolve Windows left-handed mouse swapping per call so settings changes cannot invert the requested primary button.
  static void ButtonFlags(string button, out uint down, out uint up) {
    bool swapped = GetSystemMetrics(SM_SWAPBUTTON) != 0;
    switch (button) {
      case "right":
        down = swapped ? MOUSEEVENTF_LEFTDOWN : MOUSEEVENTF_RIGHTDOWN;
        up = swapped ? MOUSEEVENTF_LEFTUP : MOUSEEVENTF_RIGHTUP;
        break;
      case "middle": case "wheel": down = MOUSEEVENTF_MIDDLEDOWN; up = MOUSEEVENTF_MIDDLEUP; break;
      default:
        down = swapped ? MOUSEEVENTF_RIGHTDOWN : MOUSEEVENTF_LEFTDOWN;
        up = swapped ? MOUSEEVENTF_RIGHTUP : MOUSEEVENTF_LEFTUP;
        break;
    }
  }

  public static void Click(int x, int y, string button, int times) {
    if (times < 1 || times > 3) throw new ArgumentException("BAD_ACTION: click count must be between 1 and 3");
    Move(x, y);
    uint down, up;
    ButtonFlags(button, out down, out up);
    List<INPUT> batch = new List<INPUT>();
    for (int n = 0; n < times; n++) {
      batch.Add(Mouse(down, 0, 0, 0));
      batch.Add(Mouse(up, 0, 0, 0));
    }
    try { Send(batch.ToArray()); }
    catch {
      // A short SendInput may have accepted a button-down without its matching up.
      try { Send(new INPUT[] { Mouse(up, 0, 0, 0) }); } catch { }
      throw;
    }
  }

  public static void Scroll(int x, int y, int dx, int dy) {
    Scroll(x, y, dx, dy, false);
  }

  public static void Scroll(int x, int y, int dx, int dy, bool rawWheel) {
    Move(x, y);
    List<INPUT> batch = new List<INPUT>();
    // Positive scroll_y means "scroll down" for the caller; the wheel API is the other way round, hence the negation.
    int unit = rawWheel ? 1 : 120;
    if (dy != 0) batch.Add(Mouse(MOUSEEVENTF_WHEEL, 0, 0, unchecked((uint)(-dy * unit))));
    if (dx != 0) batch.Add(Mouse(MOUSEEVENTF_HWHEEL, 0, 0, unchecked((uint)(dx * unit))));
    if (batch.Count > 0) Send(batch.ToArray());
  }

  public static void Drag(int[] xs, int[] ys, string button) {
    Drag(xs, ys, button, 350);
  }

  public static void Drag(int[] xs, int[] ys, string button, int durationMs) {
    if (xs == null || ys == null || xs.Length != ys.Length || xs.Length < 2 || xs.Length > 64 || durationMs < 50 || durationMs > 2000)
      throw new ArgumentException("BAD_ACTION: drag requires 2-64 points and a 50-2000 ms duration");
    double[] distance = new double[xs.Length];
    for (int i = 1; i < xs.Length; i++) {
      double dx = (double)xs[i] - xs[i - 1], dy = (double)ys[i] - ys[i - 1];
      distance[i] = distance[i - 1] + Math.Sqrt(dx * dx + dy * dy);
    }
    uint down, up;
    ButtonFlags(button, out down, out up);
    Move(xs[0], ys[0]);
    try {
      Send(new INPUT[] { Mouse(down, 0, 0, 0) });
      int steps = Math.Min(256, Math.Max(2, (int)Math.Ceiling(durationMs / 10.0)));
      int segment = 1;
      var clock = System.Diagnostics.Stopwatch.StartNew();
      for (int step = 1; step <= steps; step++) {
        double at = distance[distance.Length - 1] * step / steps;
        while (segment < distance.Length - 1 && distance[segment] < at) segment++;
        double length = distance[segment] - distance[segment - 1];
        double fraction = length <= 0 ? 1 : (at - distance[segment - 1]) / length;
        int x = (int)Math.Round(xs[segment - 1] + (xs[segment] - (double)xs[segment - 1]) * fraction);
        int y = (int)Math.Round(ys[segment - 1] + (ys[segment] - (double)ys[segment - 1]) * fraction);
        Move(x, y);
        int remaining = (int)Math.Ceiling((double)durationMs * step / steps - clock.ElapsedMilliseconds);
        if (remaining > 0) System.Threading.Thread.Sleep(Math.Min(10, remaining));
      }
    } finally {
      Send(new INPUT[] { Mouse(up, 0, 0, 0) });
    }
  }

  static INPUT Key(int encoded, bool up) {
    INPUT i = new INPUT();
    i.type = INPUT_KEYBOARD;
    i.u.ki.wVk = (ushort)(encoded & 0xFFFF);
    bool extended = (encoded & 0x10000) != 0;
    i.u.ki.dwFlags = (up ? KEYEVENTF_KEYUP : 0) | (extended ? KEYEVENTF_EXTENDEDKEY : 0);
    return i;
  }

  static INPUT Unicode(char c, bool up) {
    INPUT i = new INPUT();
    i.type = INPUT_KEYBOARD;
    i.u.ki.wVk = 0;
    i.u.ki.wScan = c;
    i.u.ki.dwFlags = KEYEVENTF_UNICODE | (up ? KEYEVENTF_KEYUP : 0);
    return i;
  }

  /** Types literal text, layout-independently. */
  public static void Type(string text) {
    if (text.IndexOf('\r') >= 0 || text.IndexOf('\n') >= 0)
      throw new InvalidOperationException("MULTILINE_REQUIRES_PASTE: literal multiline text requires the clipboard paste action");
    List<INPUT> batch = new List<INPUT>();
    foreach (char c in text) {
      batch.Add(Unicode(c, false));
      batch.Add(Unicode(c, true));
      // SendInput caps out on very long batches; flush in chunks.
      if (batch.Count >= 200) { SendText(batch); batch.Clear(); }
    }
    if (batch.Count > 0) SendText(batch);
  }

  static void SendText(List<INPUT> batch) {
    try { Send(batch.ToArray()); }
    catch {
      // A short injection can split a Unicode packet's down/up pair too.
      List<INPUT> release = new List<INPUT>();
      foreach (INPUT input in batch) {
        if ((input.u.ki.dwFlags & KEYEVENTF_KEYUP) == 0) release.Add(Unicode((char)input.u.ki.wScan, true));
      }
      try { Send(release.ToArray()); } catch { }
      throw;
    }
  }

  // Hold modifier keys briefly before releasing the chord so Windows applications recognize system shortcuts reliably.
  public static void Press(int[] vks) {
    List<INPUT> down = new List<INPUT>();
    List<INPUT> up = new List<INPUT>();
    for (int i = 0; i < vks.Length; i++) down.Add(Key(vks[i], false));
    for (int i = vks.Length - 1; i >= 0; i--) up.Add(Key(vks[i], true));
    try {
      Send(down.ToArray());
      System.Threading.Thread.Sleep(35);
    } finally {
      Send(up.ToArray());
    }
  }
}
`;
