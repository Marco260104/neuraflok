export const WINDOWS_KEY_CATALOG_SOURCE = String.raw`
public static partial class NeuraflokWindowsKeys {
  const int Extended = 0x10000;
  static readonly System.Collections.Generic.Dictionary<string, int> VirtualKeys = CreateVirtualKeys();
  static readonly System.Collections.Generic.Dictionary<string, char> CharacterKeys = CreateCharacterKeys();

  static System.Collections.Generic.Dictionary<string, int> CreateVirtualKeys() {
    var keys = new System.Collections.Generic.Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
    AddKey(keys, 0x11, "CTRL", "CONTROL");
    AddKey(keys, 0x10, "SHIFT");
    AddKey(keys, 0x12, "ALT", "OPTION");
    AddKey(keys, 0xA2, "CONTROL_L", "CTRL_L");
    AddKey(keys, Extended | 0xA3, "CONTROL_R", "CTRL_R");
    AddKey(keys, 0xA0, "SHIFT_L");
    AddKey(keys, 0xA1, "SHIFT_R");
    AddKey(keys, 0xA4, "ALT_L");
    AddKey(keys, Extended | 0xA5, "ALT_R");
    AddKey(keys, Extended | 0x5B, "WIN", "WINDOWS", "SUPER", "META", "CMD", "COMMAND", "SUPER_L", "META_L");
    AddKey(keys, Extended | 0x5C, "SUPER_R", "META_R");
    AddKey(keys, 0x0D, "ENTER", "RETURN");
    AddKey(keys, 0x09, "TAB");
    AddKey(keys, 0x1B, "ESC", "ESCAPE");
    AddKey(keys, 0x20, "SPACE");
    AddKey(keys, 0x08, "BACKSPACE", "BACK_SPACE", "BKSP");
    AddKey(keys, Extended | 0x2E, "DELETE", "DEL");
    AddKey(keys, Extended | 0x2D, "INSERT", "INS");
    AddKey(keys, Extended | 0x24, "HOME");
    AddKey(keys, Extended | 0x23, "END");
    AddKey(keys, Extended | 0x21, "PAGEUP", "PAGE_UP", "PGUP", "PRIOR");
    AddKey(keys, Extended | 0x22, "PAGEDOWN", "PAGE_DOWN", "PGDN", "NEXT");
    AddKey(keys, Extended | 0x26, "UP", "ARROWUP");
    AddKey(keys, Extended | 0x28, "DOWN", "ARROWDOWN");
    AddKey(keys, Extended | 0x25, "LEFT", "ARROWLEFT");
    AddKey(keys, Extended | 0x27, "RIGHT", "ARROWRIGHT");
    AddKey(keys, Extended | 0x2C, "PRINTSCREEN", "PRINT");
    AddKey(keys, 0x14, "CAPSLOCK", "CAPS_LOCK");
    AddKey(keys, Extended | 0x90, "NUMLOCK", "NUM_LOCK");
    AddKey(keys, 0x91, "SCROLLLOCK", "SCROLL_LOCK");
    AddKey(keys, 0x13, "PAUSE");
    AddKey(keys, Extended | 0x5D, "MENU", "APPS");
    AddKey(keys, Extended | 0x0D, "KP_ENTER");
    AddKey(keys, 0x6B, "KP_ADD");
    AddKey(keys, 0x6D, "KP_SUBTRACT");
    AddKey(keys, 0x6A, "KP_MULTIPLY");
    AddKey(keys, Extended | 0x6F, "KP_DIVIDE");
    AddKey(keys, 0x6E, "KP_DECIMAL");
    AddKey(keys, 0x6C, "KP_SEPARATOR");
    AddKey(keys, 0x24, "KP_HOME");
    AddKey(keys, 0x23, "KP_END");
    AddKey(keys, 0x26, "KP_UP");
    AddKey(keys, 0x28, "KP_DOWN");
    AddKey(keys, 0x25, "KP_LEFT");
    AddKey(keys, 0x27, "KP_RIGHT");
    AddKey(keys, 0x21, "KP_PRIOR");
    AddKey(keys, 0x22, "KP_NEXT");
    AddKey(keys, 0x2D, "KP_INSERT");
    AddKey(keys, 0x2E, "KP_DELETE");
    return keys;
  }

  static void AddKey(System.Collections.Generic.Dictionary<string, int> keys, int code, params string[] names) {
    foreach (string name in names) keys.Add(name, code);
  }

  static System.Collections.Generic.Dictionary<string, char> CreateCharacterKeys() {
    return new System.Collections.Generic.Dictionary<string, char>(StringComparer.OrdinalIgnoreCase) {
      {"MINUS",'-'}, {"EQUALS",'='}, {"EQUAL",'='}, {"PLUS",'+'},
      {"LBRACKET",'['}, {"BRACKETLEFT",'['}, {"RBRACKET",']'}, {"BRACKETRIGHT",']'},
      {"BACKSLASH",'\\'}, {"SEMICOLON",';'}, {"COLON",':'}, {"QUOTE",'\''}, {"APOSTROPHE",'\''},
      {"QUOTEDBL",'"'}, {"COMMA",','}, {"PERIOD",'.'}, {"SLASH",'/'}, {"QUESTION",'?'},
      {"GREATER",'>'}, {"LESS",'<'}, {"BACKQUOTE",(char)96}, {"GRAVE",(char)96},
      {"TILDE",'~'}, {"ASCIITILDE",'~'}, {"EXCLAM",'!'}, {"AT",'@'}, {"NUMBERSIGN",'#'},
      {"DOLLAR",'$'}, {"PERCENT",'%'}, {"ASCIICIRCUM",'^'}, {"AMPERSAND",'&'}, {"ASTERISK",'*'},
      {"PARENLEFT",'('}, {"PARENRIGHT",')'}, {"UNDERSCORE",'_'}, {"BRACELEFT",'{'},
      {"BRACERIGHT",'}'}, {"BAR",'|'}
    };
  }

  static bool TryNamedKey(string name, out int code) {
    return VirtualKeys.TryGetValue(name, out code);
  }

  static bool TryCharacterKey(string name, out char value) {
    return CharacterKeys.TryGetValue(name, out value);
  }
}
`;
