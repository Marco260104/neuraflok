export const WINDOWS_CAPTURE_SESSION_SOURCE = String.raw`
public static partial class NeuraflokWindowsCapture {
  public static string Capture(long handle, int maxWidth, string file) {
    if (!GraphicsCaptureSession.IsSupported()) throw new NotSupportedException("CAPTURE_FAILED: Windows.Graphics.Capture is unavailable");
    IntPtr window = new IntPtr(handle);
    RECT bounds = Bounds(window);
    var clock = Stopwatch.StartNew();
    var item = CreateItem(window);
    var poolSize = item.Size;
    int poolWidth = poolSize.Width, poolHeight = poolSize.Height;
    int width = bounds.Right - bounds.Left, height = bounds.Bottom - bounds.Top;
    if (poolWidth <= 0 || poolHeight <= 0 || (long)poolWidth * poolHeight > MaxPixels)
      throw new InvalidOperationException("CAPTURE_FAILED: capture dimensions exceed the pixel limit");
    using (var device = CreateDevice())
    using (var pool = Direct3D11CaptureFramePool.CreateFreeThreaded(device, DirectXPixelFormat.B8G8R8A8UIntNormalized, 1, poolSize))
    using (var session = pool.CreateCaptureSession(item)) {
      // Disable the system capture border when the optional runtime interface is available.
      var border = (object)session as IGraphicsCaptureSession3;
      if (border != null) border.IsBorderRequired = false;
      session.StartCapture();
      Direct3D11CaptureFrame frame = null;
      while (frame == null) {
        if (clock.ElapsedMilliseconds >= TimeoutMs) throw new TimeoutException("CAPTURE_FAILED: no Windows.Graphics.Capture frame arrived");
        frame = pool.TryGetNextFrame();
        if (frame == null) Thread.Sleep(5);
      }
      using (frame) {
        RECT after = Bounds(window);
        // Reject a frame when the window moved or changed size during capture.
        if (after.Left != bounds.Left || after.Top != bounds.Top || after.Right != bounds.Right || after.Bottom != bounds.Bottom)
          throw new InvalidOperationException("STALE_FRAME: window geometry changed during capture");
        ValidateContentSize(poolWidth, poolHeight, width, height, frame.ContentSize.Width, frame.ContentSize.Height);
        using (var surface = frame.Surface)
        using (var software = CopySurface(surface, clock)) {
          if (software.PixelWidth != poolWidth || software.PixelHeight != poolHeight) throw new InvalidOperationException("STALE_FRAME: copied surface dimensions changed");
          byte[] pixels = new byte[checked(poolWidth * poolHeight * 4)];
          var pixelBuffer = new Windows.Storage.Streams.Buffer((uint)pixels.Length);
          software.CopyToBuffer(pixelBuffer);
          using (var reader = Windows.Storage.Streams.DataReader.FromBuffer(pixelBuffer)) reader.ReadBytes(pixels);
          using (var bitmap = ContentBitmap(pixels, poolWidth, poolHeight, width, height)) {
            int outputWidth = maxWidth > 0 ? Math.Min(maxWidth, width) : width;
            int outputHeight = Math.Max(1, (int)Math.Round((double)height * outputWidth / width));
            if (outputWidth == width) bitmap.Save(file, ImageFormat.Png);
            else using (var scaled = new Bitmap(outputWidth, outputHeight))
            using (var graphics = Graphics.FromImage(scaled)) {
              graphics.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.HighQualityBicubic;
              graphics.DrawImage(bitmap, new Rectangle(0, 0, outputWidth, outputHeight));
              scaled.Save(file, ImageFormat.Png);
            }
            return bounds.Left + "," + bounds.Top + "," + width + "," + height + "," + outputWidth + "," + outputHeight;
          }
        }
      }
    }
  }
}
`;
