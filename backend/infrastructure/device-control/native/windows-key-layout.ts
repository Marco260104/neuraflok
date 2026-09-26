export const WINDOWS_KEY_LAYOUT_SOURCE = String.raw`
public static partial class NeuraflokWindowsKeys {
  [System.Runtime.InteropServices.DllImport("user32.dll")]
  static extern IntPtr GetKeyboardLayout(uint thread);
  [System.Runtime.InteropServices.DllImport("user32.dll")]
  static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
  [System.Runtime.InteropServices.DllImport("user32.dll")]
  static extern IntPtr GetForegroundWindow();
  [System.Runtime.InteropServices.DllImport("user32.dll", CharSet = System.Runtime.InteropServices.CharSet.Unicode)]
  static extern short VkKeyScanExW(char character, IntPtr layout);

  public static int[] Resolve(string[] names, long targetWindow) {
    IntPtr window = targetWindow == 0 ? GetForegroundWindow() : new IntPtr(targetWindow);
    uint process;
    uint thread = GetWindowThreadProcessId(window, out process);
    if (thread == 0) throw new InvalidOperationException("BAD_KEY: target window has no keyboard layout");
    IntPtr layout = GetKeyboardLayout(thread);
    if (layout == IntPtr.Zero) throw new InvalidOperationException("BAD_KEY: target keyboard layout is unavailable");
    return ResolveForLayout(names, layout, VkKeyScanExW);
  }

  static int ModifierGroup(int key) {
    switch (key & 0xFFFF) {
      case 0x10: case 0xA0: case 0xA1: return 1;
      case 0x11: case 0xA2: case 0xA3: return 2;
      case 0x12: case 0xA4: case 0xA5: return 4;
      case 0x5B: case 0x5C: return 8;
      default: return 0;
    }
  }

  static bool TryGeneratedKey(string name, out int code) {
    int number;
    code = 0;
    if (name.Length >= 2 && name.Length <= 3 && name.StartsWith("F", StringComparison.OrdinalIgnoreCase) &&
        int.TryParse(name.Substring(1), out number) && number >= 1 && number <= 24) {
      code = 0x6F + number;
      return true;
    }
    if (name.Length == 4 && name.StartsWith("KP_", StringComparison.OrdinalIgnoreCase) && name[3] >= '0' && name[3] <= '9') {
      code = 0x60 + name[3] - '0';
      return true;
    }
    if (name.Length == 1 && IsAsciiLetterOrDigit(name[0])) {
      code = char.ToUpperInvariant(name[0]);
      return true;
    }
    return false;
  }

  static bool IsAsciiLetterOrDigit(char value) {
    return (value >= 'a' && value <= 'z') || (value >= 'A' && value <= 'Z') || (value >= '0' && value <= '9');
  }

  static char ResolveCharacter(string name) {
    char value;
    if (TryCharacterKey(name, out value)) return value;
    if (name.Length != 1 || char.IsControl(name[0]) || char.IsSurrogate(name[0])) {
      throw new ArgumentException("BAD_KEY: unsupported key " + name);
    }
    return name[0];
  }

  public static int[] ResolveForLayout(string[] names, IntPtr layout, Func<char, IntPtr, short> translate) {
    if (names == null || names.Length == 0 || names.Length > 16) {
      throw new ArgumentException("BAD_KEY: a chord needs between 1 and 16 keys");
    }
    if (translate == null) throw new ArgumentNullException("translate");

    var modifiers = new System.Collections.Generic.List<int>();
    var keys = new System.Collections.Generic.List<int>();
    int requiredModifiers = 0;
    foreach (string raw in names) {
      string name = (raw ?? "").Trim();
      if (name.Length == 0) throw new ArgumentException("BAD_KEY: key name is empty");
      if (name.StartsWith("NUMPAD_", StringComparison.OrdinalIgnoreCase)) name = "KP_" + name.Substring(7);

      int code;
      if (!TryNamedKey(name, out code) && !TryGeneratedKey(name, out code)) {
        short translation = translate(ResolveCharacter(name), layout);
        int layoutModifiers = (translation >> 8) & 0xFF;
        if (translation == -1 || layoutModifiers > 7) {
          throw new ArgumentException("BAD_KEY: key is unavailable in the target keyboard layout: " + name);
        }
        code = translation & 0xFF;
        requiredModifiers |= layoutModifiers;
      }

      if (ModifierGroup(code) != 0) {
        if (!modifiers.Contains(code)) modifiers.Add(code);
      } else {
        if (keys.Contains(code)) throw new ArgumentException("BAD_KEY: chord repeats a key");
        keys.Add(code);
      }
    }

    int suppliedModifiers = 0;
    foreach (int code in modifiers) suppliedModifiers |= ModifierGroup(code);
    if ((requiredModifiers & 1) != 0 && (suppliedModifiers & 1) == 0) modifiers.Add(0x10);
    if ((requiredModifiers & 2) != 0 && (suppliedModifiers & 2) == 0) modifiers.Add(0x11);
    if ((requiredModifiers & 4) != 0 && (suppliedModifiers & 4) == 0) modifiers.Add(0x12);
    modifiers.AddRange(keys);
    return modifiers.ToArray();
  }
}
`;
