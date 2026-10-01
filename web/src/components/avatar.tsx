import { useAvatar } from "@/lib/avatar-cache"
import { DEFAULT_AVATAR_BG, avatarFontRatio, avatarInitials } from "@/lib/avatar-default"
import { cn } from "@/lib/utils"

interface AvatarProps {
  owner: string | null | undefined
  name?: string | null
  size?: number
  className?: string
}

/**
 * 头像：有上传过头像就用图片，否则统一渲染成 **#0078d7 底 + 白色前两个字符**。
 * 规则见 lib/avatar-default.ts。
 */
export function Avatar({ owner, name, size = 32, className }: AvatarProps) {
  const url = useAvatar(owner)
  const text = avatarInitials(name)
  const style = {
    width: size,
    height: size,
    fontSize: Math.max(9, Math.round(size * avatarFontRatio(text))),
  }

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
      title={name || undefined}
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-full font-medium text-white ring-1 ring-foreground/10",
        "select-none",
        className
      )}
      style={{ ...style, background: DEFAULT_AVATAR_BG }}
    >
      {text}
    </span>
  )
}
