// Native window identity shared by window discovery and app grouping.
export const WINDOWS_APP_IDENTITY_SOURCE = String.raw`
public static class NeuraflokWindowsAppIdentity {
  [StructLayout(LayoutKind.Sequential)]
  struct PROPERTYKEY { public Guid Format; public uint Id; }
  [StructLayout(LayoutKind.Explicit, Size = 24)]
  struct PROPVARIANT { [FieldOffset(0)] public ushort Type; [FieldOffset(8)] public IntPtr Pointer; }
  [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IPropertyStore {
    [PreserveSig] int GetCount(out uint count);
    [PreserveSig] int GetAt(uint index, out PROPERTYKEY key);
    [PreserveSig] int GetValue(ref PROPERTYKEY key, out PROPVARIANT value);
    [PreserveSig] int SetValue(ref PROPERTYKEY key, ref PROPVARIANT value);
    [PreserveSig] int Commit();
  }
  [DllImport("shell32.dll")] static extern int SHGetPropertyStoreForWindow(IntPtr window, ref Guid iid, out IPropertyStore store);
  [DllImport("ole32.dll")] static extern int PropVariantClear(ref PROPVARIANT value);
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint process);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool QueryFullProcessImageNameW(IntPtr process, uint flags, StringBuilder path, ref uint length);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern int GetApplicationUserModelId(IntPtr process, ref uint length, StringBuilder value);

  static string Bounded(string value) {
    return !String.IsNullOrWhiteSpace(value) && value.Length <= 2048 && value.IndexOf((char)31) < 0 ? value : "";
  }
  static string WindowAppId(IntPtr window) {
    IPropertyStore store = null;
    var value = new PROPVARIANT();
    try {
      Guid iid = typeof(IPropertyStore).GUID;
      if (SHGetPropertyStoreForWindow(window, ref iid, out store) < 0 || store == null) return "";
      var key = new PROPERTYKEY { Format = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"), Id = 5 };
      if (store.GetValue(ref key, out value) < 0 || value.Type != 31 || value.Pointer == IntPtr.Zero) return "";
      return Bounded(Marshal.PtrToStringUni(value.Pointer));
    } catch { return ""; }
    finally {
      PropVariantClear(ref value);
      if (store != null && Marshal.IsComObject(store)) Marshal.ReleaseComObject(store);
    }
  }
  // app identifier, process image path, native AppUserModelID. No process-name joins.
  public static string[] Read(long handle, uint processId) {
    string appId = WindowAppId(new IntPtr(handle));
    string path = "";
    IntPtr process = OpenProcess(0x1000, false, processId); // PROCESS_QUERY_LIMITED_INFORMATION
    if (process != IntPtr.Zero) {
      try {
        uint size = 32768;
        var buffer = new StringBuilder((int)size);
        if (QueryFullProcessImageNameW(process, 0, buffer, ref size)) path = Bounded(buffer.ToString());
        if (appId.Length == 0) {
          size = 2048;
          buffer = new StringBuilder((int)size);
          if (GetApplicationUserModelId(process, ref size, buffer) == 0) appId = Bounded(buffer.ToString());
        }
      } finally { CloseHandle(process); }
    }
    return new string[] { appId.Length > 0 ? appId : path.ToLowerInvariant(), path, appId };
  }
}
`;

