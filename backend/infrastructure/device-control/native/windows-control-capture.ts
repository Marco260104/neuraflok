export const WINDOWS_CONTROL_CAPTURE_SOURCE = String.raw`
public static partial class NeuraflokWindowsControl {
  static string SavePng(Bitmap shot, int maxW, string file) {
    int w = shot.Width, h = shot.Height;
    int outW = w, outH = h;
    if (maxW > 0 && w > maxW) {
      outW = maxW;
      outH = (int)Math.Round((double)h * maxW / w);
      if (outH < 1) outH = 1;
    }
    if (outW == w && outH == h) {
      shot.Save(file, System.Drawing.Imaging.ImageFormat.Png);
    } else {
      using (Bitmap small = new Bitmap(outW, outH))
      using (Graphics gs = Graphics.FromImage(small)) {
        gs.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.HighQualityBicubic;
        gs.PixelOffsetMode = System.Drawing.Drawing2D.PixelOffsetMode.HighQuality;
        gs.DrawImage(shot, new Rectangle(0, 0, outW, outH));
        small.Save(file, System.Drawing.Imaging.ImageFormat.Png);
      }
    }
    return outW + "," + outH;
  }

  public static string Capture(int x, int y, int w, int h, int maxW, string file) {
    using (Bitmap shot = new Bitmap(w, h))
    using (Graphics g = Graphics.FromImage(shot)) {
      g.CopyFromScreen(x, y, 0, 0, new Size(w, h), CopyPixelOperation.SourceCopy);
      return SavePng(shot, maxW, file);
    }
  }
}
`;
