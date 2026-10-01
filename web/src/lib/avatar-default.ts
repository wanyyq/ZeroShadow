/**
 * 默认头像（用户没有上传头像时使用）。
 *
 * 规则刻意做得极简：统一的 **#0078d7 底 + 白色前两个字符**。
 * 之前那版是「24 色相 × 4 渐变 × 3 明度 = 288 种配色 + 双字符缩写」，
 * 看起来挺唬人，实际既花哨又不好认——统一底色反而更容易靠文字认人。
 */

/** 默认头像底色（Windows 蓝） */
export const DEFAULT_AVATAR_BG = "#0078d7"

/**
 * 取名字的**前两个字符**。
 * ASCII 小写字母转成大写（`wangyq` → `WA`），中文/日文/韩文原样保留（`张伟` → `张伟`）。
 */
export function avatarInitials(name?: string | null) {
  const raw = (name || "").trim()
  if (!raw) return "?"
  // 用扩展运算符按「码点」切分，避免把 emoji 之类的代理对切成半个
  const chars = [...raw].slice(0, 2)
  return chars.map((c) => (/^[a-z]$/.test(c) ? c.toUpperCase() : c)).join("")
}

/** 字号占头像直径的比例：两个字符要收一点，否则会顶满圆形 */
export function avatarFontRatio(text: string) {
  return text.length > 1 ? 0.36 : 0.46
}
