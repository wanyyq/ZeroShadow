import { useAvatar } from "@/lib/avatar-cache"
import { avatarFontRatio, avatarGradient, avatarInitials, avatarSeed } from "@/lib/avatar-default"
import { cn } from "@/lib/utils"

interface AvatarProps {
  owner: string | null | undefined
  name?: string | null
  size?: number
  className?: string
}

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

  const { from, to } = avatarGradient(avatarSeed(owner, name))

  return (
    <span
      aria-label={name || "avatar"}
      title={name || undefined}
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-full font-semibold tracking-tight text-white ring-1 ring-foreground/10",
        "select-none [text-shadow:0_1px_2px_oklch(0_0_0/30%)]",
        className
      )}
      style={{ ...style, backgroundImage: `linear-gradient(140deg, ${from}, ${to})` }}
    >
      {text}
    </span>
  )
}
