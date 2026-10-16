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

/** UI 已完成桌面歌词取色；宿主只应用 RGB 和本地透明度。 */
export function coverThemeLyricColor(color: string | undefined, opacity = 0.95): string | null {
  if (!color?.trim()) return null;
  const channels = color.split(",").map((channel) => channel.trim());
  if (channels.length !== 3 || channels.some((channel) =>
    !/^\d+(?:\.\d+)?$/.test(channel) || Number(channel) > 255
  )) return null;
  const [r, g, b] = channels.map(Number);
  return rgba(r, g, b, opacity);
}

/** 保留底色配置中的透明度，主题色开关只替换 RGB。 */
export function colorOpacity(color: string): number {
  const alpha = color.match(/^rgba\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+\s*,\s*([\d.]+)\s*\)$/i)?.[1];
  if (alpha !== undefined) return Math.max(0, Math.min(1, Number(alpha)));
  if (/^#[\da-f]{8}$/i.test(color)) return parseInt(color.slice(7), 16) / 255;
  return 1;
}
