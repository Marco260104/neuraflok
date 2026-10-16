export const WINDOWS_CAPTURE_PIXELS_SOURCE = String.raw`
public static partial class NeuraflokWindowsCapture {
  static void ValidateContentSize(int poolWidth, int poolHeight, int width, int height, int contentWidth, int contentHeight) {
    if (poolWidth <= 0 || poolHeight <= 0 || (long)poolWidth * poolHeight > MaxPixels)
      throw new InvalidOperationException("CAPTURE_FAILED: capture dimensions exceed the pixel limit");
    if (width <= 0 || height <= 0 || width > poolWidth || height > poolHeight || contentWidth != width || contentHeight != height)
      throw new InvalidOperationException("STALE_FRAME: frame content and DWM bounds disagree");
  }

  static Bitmap ContentBitmap(byte[] pixels, int poolWidth, int poolHeight, int width, int height) {
    ValidateContentSize(poolWidth, poolHeight, width, height, width, height);
    if (pixels == null || pixels.Length != checked(poolWidth * poolHeight * 4))
      throw new InvalidOperationException("STALE_FRAME: copied surface byte count changed");
    var bitmap = new Bitmap(width, height, PixelFormat.Format32bppArgb);
    try {
      var locked = bitmap.LockBits(new Rectangle(0, 0, width, height), ImageLockMode.WriteOnly, PixelFormat.Format32bppArgb);
      try {
        // Copy only the valid top-left rectangle while retaining the larger surface's source stride.
        for (int row = 0; row < height; row++)
          Marshal.Copy(pixels, checked(row * poolWidth * 4), IntPtr.Add(locked.Scan0, row * locked.Stride), checked(width * 4));
      } finally { bitmap.UnlockBits(locked); }
      return bitmap;
    } catch { bitmap.Dispose(); throw; }
  }
}
`;
