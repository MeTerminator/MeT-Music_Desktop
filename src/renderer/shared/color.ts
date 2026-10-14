/** 渲染进程(歌词窗 / 设置窗)共用的颜色工具。 */

/** #rrggbb → [r, g, b](允许省略 #) */
export function hexToRgb(hex: string): [number, number, number] {
  const clean = hex.replace("#", "");
  return [
    parseInt(clean.substring(0, 2), 16),
    parseInt(clean.substring(2, 4), 16),
    parseInt(clean.substring(4, 6), 16),
  ];
}

/** rgba() 字符串组装(alpha 固定两位小数,与旧实现输出格式一致) */
export function rgba(r: number, g: number, b: number, alpha: number): string {
  return `rgba(${r}, ${g}, ${b}, ${alpha.toFixed(2)})`;
}

/** hex + 不透明度百分比 → rgba() 字符串 */
export function hexToRgba(hex: string, opacityPercent: number): string {
  if (!hex) return "rgba(255, 255, 255, 1)";
  const [r, g, b] = hexToRgb(hex);
  return rgba(r, g, b, opacityPercent / 100);
}

/** rgb 分量 → #rrggbb */
export function rgbToHex(r: number, g: number, b: number): string {
  const channel = (value: number) => value.toString(16).padStart(2, "0");
  return `#${channel(r)}${channel(g)}${channel(b)}`;
}

/** 封面 shadeTwo 为逗号分隔的 RGB。去掉亮色的粉白感，保持色相和原有透明度。 */
export function coverThemeLyricColor(shadeTwo: string | undefined): string | null {
  if (!shadeTwo?.trim()) return null;
  const channels = shadeTwo.split(",").map((channel) => channel.trim());
  if (channels.length !== 3 || channels.some((channel) =>
    !/^\d+(?:\.\d+)?$/.test(channel) || Number(channel) > 255
  )) return null;

  const rgb = channels.map(Number);
  const max = Math.max(...rgb);
  const min = Math.min(...rgb);
  const chroma = max - min;
  const saturation = max === 0 ? 0 : chroma / max;

  // 以 HSV 的饱和度和明度控制“鲜艳”：让主色通道接近满亮度，并去掉
  // 混入的白色。相同 HSV 明度下黄绿自然比蓝紫更亮，无需统一压低亮度。
  // 在低饱和度区平滑淡入，避免灰白封面微小的 RGB 偏差被放大成艳色。
  const t = Math.min(1, Math.max(0, (saturation - 0.02) / 0.10));
  const strength = t * t * (3 - 2 * t);
  if (strength === 0 || chroma === 0) return rgba(rgb[0], rgb[1], rgb[2], 0.95);

  const targetSaturation = saturation + (Math.max(0.88, saturation) - saturation) * strength;
  const targetValue = max + (Math.max(250, max) - max) * strength;
  const targetChroma = targetValue * targetSaturation;
  // 对三个通道使用相同的线性映射，精确保留 RGB 色相，并直接落在 sRGB
  // 色域内；避免浏览器压缩超色域的彩度后，实际显示依然发淡。
  const result = rgb.map((channel) => Math.round(
    targetValue - targetChroma + ((channel - min) / chroma) * targetChroma
  ));
  return rgba(result[0], result[1], result[2], 0.95);
}
