import { useAvatar } from "@/lib/avatar-cache"
import { cn } from "@/lib/utils"

interface AvatarProps {
  owner: string | null | undefined
  name?: string | null
  size?: number
  className?: string
}

const PALETTE = [
  "#5b8def",
  "#7c6cf0",
  "#e06c9f",
  "#e0894c",
  "#4bb3a1",
  "#c06060",
  "#6a9e4f",
  "#b58a3a",
]

function initial(name?: string | null) {
  const text = (name || "").trim()
  if (!text) return "?"
  const first = [...text][0]
  return first.toUpperCase()
}

// 颜色只由"稳定的显示名"决定（昵称/用户名唯一），避免同一用户在不同位置
// 因 owner 有无而换色。没有名字时才退回 owner。
function colorSeed(owner?: string | null, name?: string | null) {
  const byName = (name || "").trim()
  if (byName) return byName
  return (owner || "?").trim() || "?"
}

function colorFor(seed: string) {
  let hash = 0
  for (let i = 0; i < seed.length; i += 1) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0
  return PALETTE[hash % PALETTE.length]
}

export function Avatar({ owner, name, size = 32, className }: AvatarProps) {
  const url = useAvatar(owner)
  const style = { width: size, height: size, fontSize: Math.max(10, Math.round(size * 0.42)) }
  const seed = colorSeed(owner, name)
  if (url) {
    return (
      <img
        src={url}
        alt={name || "avatar"}
        width={size}
        height={size}
        loading="lazy"
        className={cn("shrink-0 rounded-full object-cover ring-1 ring-foreground/10", className)}
        style={style}
      />
    )
  }
  return (
    <span
      aria-label={name || "avatar"}
      className={cn(
        "inline-flex shrink-0 select-none items-center justify-center rounded-full font-medium text-white ring-1 ring-foreground/10",
        className
      )}
      style={{ ...style, background: colorFor(seed) }}
    >
      {initial(name)}
    </span>
  )
}
