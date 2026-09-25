export const WINDOWS_CAPTURE_PLATFORM_SOURCE = String.raw`
using System;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.WindowsRuntime;
using System.Threading;
using Windows.Graphics.Capture;
using Windows.Graphics.DirectX;
using Windows.Graphics.DirectX.Direct3D11;
using Windows.Graphics.Imaging;

public static partial class NeuraflokWindowsCapture {
  [StructLayout(LayoutKind.Sequential)]
  struct RECT { public int Left, Top, Right, Bottom; }
  [ComImport, Guid("3628E81B-3CAC-4C60-B7F4-23CE0E0C3356"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IGraphicsCaptureItemInterop {
    [PreserveSig] int CreateForWindow(IntPtr window, ref Guid iid, out IntPtr item);
    [PreserveSig] int CreateForMonitor(IntPtr monitor, ref Guid iid, out IntPtr item);
  }
  // Query this optional interface so supported Windows hosts can run even when their WinMetadata omits the newer session property.
  [ComImport, Guid("F2CDD966-22AE-5EA1-9596-3A289344C3BE"), InterfaceType(ComInterfaceType.InterfaceIsIInspectable)]
  interface IGraphicsCaptureSession3 {
    bool IsBorderRequired {
      [return: MarshalAs(UnmanagedType.U1)] get;
      [param: MarshalAs(UnmanagedType.U1)] set;
    }
  }
  [DllImport("combase.dll")] static extern int WindowsCreateString([MarshalAs(UnmanagedType.LPWStr)] string value, int length, out IntPtr result);
  [DllImport("combase.dll")] static extern int WindowsDeleteString(IntPtr value);
  [DllImport("combase.dll")] static extern int RoGetActivationFactory(IntPtr name, ref Guid iid, out IntPtr factory);
  [DllImport("d3d11.dll")] static extern int D3D11CreateDevice(IntPtr adapter, int driverType, IntPtr software, uint flags, IntPtr levels, uint levelCount, uint version, out IntPtr device, out int level, out IntPtr context);
  [DllImport("d3d11.dll")] static extern int CreateDirect3D11DeviceFromDXGIDevice(IntPtr dxgiDevice, out IntPtr graphicsDevice);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr window, int attribute, out RECT value, int size);
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr window);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr window);

  const int TimeoutMs = 3000;
  const long MaxPixels = 32000000;

  static void Check(int result) { Marshal.ThrowExceptionForHR(result); }
  static void Release(ref IntPtr value) { if (value != IntPtr.Zero) { Marshal.Release(value); value = IntPtr.Zero; } }

  static RECT Bounds(IntPtr window) {
    RECT rect;
    if (!IsWindow(window) || IsIconic(window)) throw new InvalidOperationException("CAPTURE_FAILED: target window is closed or minimized");
    Check(DwmGetWindowAttribute(window, 9, out rect, Marshal.SizeOf(typeof(RECT))));
    int width = rect.Right - rect.Left, height = rect.Bottom - rect.Top;
    if (width <= 0 || height <= 0 || (long)width * height > MaxPixels) throw new InvalidOperationException("CAPTURE_FAILED: window pixel dimensions are outside the capture limit");
    return rect;
  }

  static GraphicsCaptureItem CreateItem(IntPtr window) {
    IntPtr name = IntPtr.Zero, factory = IntPtr.Zero, item = IntPtr.Zero;
    object interopObject = null;
    try {
      string className = "Windows.Graphics.Capture.GraphicsCaptureItem";
      Check(WindowsCreateString(className, className.Length, out name));
      Guid interopId = typeof(IGraphicsCaptureItemInterop).GUID;
      Check(RoGetActivationFactory(name, ref interopId, out factory));
      interopObject = Marshal.GetObjectForIUnknown(factory);
      Guid itemId = new Guid("79C3F95B-31F7-4EC2-A464-632EF5D30760");
      Check(((IGraphicsCaptureItemInterop)interopObject).CreateForWindow(window, ref itemId, out item));
      return (GraphicsCaptureItem)Marshal.GetObjectForIUnknown(item);
    } finally {
      Release(ref item);
      if (interopObject != null && Marshal.IsComObject(interopObject)) Marshal.ReleaseComObject(interopObject);
      Release(ref factory);
      if (name != IntPtr.Zero) WindowsDeleteString(name);
    }
  }

  static IDirect3DDevice CreateDevice() {
    IntPtr device = IntPtr.Zero, context = IntPtr.Zero, dxgi = IntPtr.Zero, projected = IntPtr.Zero;
    try {
      int level;
      // Direct3D's BGRA support is required for Windows.Graphics.Capture readback.
      Check(D3D11CreateDevice(IntPtr.Zero, 1, IntPtr.Zero, 0x20, IntPtr.Zero, 0, 7, out device, out level, out context));
      Guid dxgiId = new Guid("54EC77FA-1377-44E6-8C32-88FD5F44C84C");
      Check(Marshal.QueryInterface(device, ref dxgiId, out dxgi));
      Check(CreateDirect3D11DeviceFromDXGIDevice(dxgi, out projected));
      return (IDirect3DDevice)Marshal.GetObjectForIUnknown(projected);
    } finally { Release(ref projected); Release(ref dxgi); Release(ref context); Release(ref device); }
  }

  static SoftwareBitmap CopySurface(IDirect3DSurface surface, Stopwatch clock) {
    var operation = SoftwareBitmap.CreateCopyFromSurfaceAsync(surface, BitmapAlphaMode.Ignore);
    try {
      // Poll the WinRT operation directly so the persistent STA helper needs no UI dispatcher.
      while (operation.Status == Windows.Foundation.AsyncStatus.Started) {
        if (clock.ElapsedMilliseconds >= TimeoutMs) {
          operation.Cancel();
          throw new TimeoutException("CAPTURE_FAILED: GPU readback timed out");
        }
        Thread.Sleep(5);
      }
      return operation.GetResults();
    } finally { operation.Close(); }
  }
}
`;
