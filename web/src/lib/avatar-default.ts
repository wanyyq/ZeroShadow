/**
 * 默认头像的纯计算部分（不依赖 React，方便单独测试）。
 *
 * 旧实现是「8 色调色板 + 一个首字母」，问题很直接：
 *   - 8 种颜色在十几个人的团队里必然撞色（生日悖论，几个人就有较大概率重复）；
 *   - 只取首字母时 wangyq / wanglei 都是「W」，中文名更是大量同姓；
 *   于是两个不同的人长得一模一样，扫一眼根本分不出来。
 *
 * 现在改成三个维度一起做区分：
 *   1. 色相 24 档（每档 15°，任意两人色相至少差 15°）；
 *   2. 渐变副色相 4 档（+25° / −25° / +65° / −65°）；
 *   3. 明度 3 档；
 *   组合共 24 × 4 × 3 = 288 种外观，再叠加两个字符的缩写，撞脸概率极低。
 *
 * 颜色用 oklch：明度固定在 0.50~0.62，保证白色文字始终有足够对比度。
 */

const HUE_STEPS = 24
const SECOND_HUE_OFFSETS = [25, -25, 65, -65]
const LIGHTNESS = [0.5, 0.56, 0.62]

/** 稳定的 32 位哈希（FNV-1a）：同一个显示名在任何位置都得到同样的头像 */
export function hashSeed(seed: string) {
  let h = 2166136261
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

export interface AvatarGradient {
  from: string
  to: string
  /** 便于测试与调试：三个维度各自的档位 */
  hue: number
  lightness: number
}

export function avatarGradient(seed: string): AvatarGradient {
  const h = hashSeed(seed)
  const hue = (h % HUE_STEPS) * (360 / HUE_STEPS)
  const offset = SECOND_HUE_OFFSETS[Math.floor(h / HUE_STEPS) % SECOND_HUE_OFFSETS.length]
  const l = LIGHTNESS[Math.floor(h / (HUE_STEPS * SECOND_HUE_OFFSETS.length)) % LIGHTNESS.length]
  const hue2 = (hue + offset + 360) % 360
  const chroma = offset > 0 ? 0.16 : 0.14
  return {
    from: `oklch(${l} ${chroma} ${hue})`,
    to: `oklch(${Math.max(0.42, l - 0.06)} ${chroma} ${hue2})`,
    hue,
    lightness: l,
  }
}

const CJK = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u3040-\u30FF\uAC00-\uD7AF]/

/**
 * 取两个字符做缩写：
 *   - 中文/日文/韩文名字取**后两字**（同姓极多，姓氏几乎没有区分度）；
 *   - 拉丁文名字有多个词时取两个词的首字母（Wang Yuqian → WY）；
 *   - 单个词时取首字母 + 末字母（wangyq → WQ），比只取 W 好认得多。
 */
export function avatarInitials(name?: string | null) {
  const raw = (name || "").trim()
  if (!raw) return "?"

  if (CJK.test(raw)) {
    const chars = [...raw].filter((c) => CJK.test(c))
    if (!chars.length) return "?"
    return (chars.length >= 3 ? chars.slice(-2) : chars.slice(0, 2)).join("")
  }

  const words = raw.split(/[\s._\-@]+/).filter(Boolean)
  if (words.length >= 2) {
    return (words[0][0] + words[1][0]).toUpperCase()
  }
  const letters = [...raw.replace(/[^\p{L}\p{N}]/gu, "")]
  if (!letters.length) return "?"
  if (letters.length === 1) return letters[0].toUpperCase()
  return (letters[0] + letters[letters.length - 1]).toUpperCase()
}

/**
 * 颜色种子：只由「稳定的显示名」决定（昵称/用户名唯一），
 * 避免同一用户在不同位置因 owner 有无而换色。没有名字时才退回 owner。
 */
export function avatarSeed(owner?: string | null, name?: string | null) {
  const byName = (name || "").trim()
  if (byName) return byName
  return (owner || "?").trim() || "?"
}

/** 字号占头像直径的比例：两个字符要收一点，否则顶满圆形 */
export function avatarFontRatio(text: string) {
  return text.length > 1 ? 0.34 : 0.44
}
