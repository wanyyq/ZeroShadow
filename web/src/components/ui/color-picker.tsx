"use client"

import * as React from "react"
import { Input } from "@/components/ui/input"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { cn } from "@/lib/utils"

const SWATCHES = [
  "#5b8def", "#7c6cf0", "#a855f7", "#e06c9f", "#e0894c", "#eab308",
  "#6a9e4f", "#4bb3a1", "#14b8a6", "#0ea5e9", "#64748b", "#c06060",
  "#b58a3a", "#84cc16", "#f97316", "#ef4444", "#ec4899", "#6366f1",
]

const HEX_RE = /^#[0-9a-fA-F]{6}$/

interface ColorPickerProps {
  value: string
  onChange: (value: string) => void
  className?: string
  id?: string
}

export function ColorPicker({ value, onChange, className, id }: ColorPickerProps) {
  const [open, setOpen] = React.useState(false)
  const [text, setText] = React.useState(value)
  React.useEffect(() => setText(value), [value])

  const commit = (v: string) => {
    const trimmed = v.trim()
    if (!trimmed.startsWith("#")) return commit(`#${trimmed}`)
    if (HEX_RE.test(trimmed)) onChange(trimmed.toLowerCase())
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        id={id}
        render={
          <button
            type="button"
            aria-label="选择颜色"
            className={cn("size-9 shrink-0 rounded-md border border-border ring-offset-background transition-shadow focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none", className)}
            style={{ background: HEX_RE.test(value) ? value : "#6b7280" }}
          />
        }
      />
      <PopoverContent className="w-60" align="start">
        <div className="grid grid-cols-6 gap-1.5">
          {SWATCHES.map((c) => (
            <button
              key={c}
              type="button"
              title={c}
              onClick={() => { onChange(c); setOpen(false) }}
              className={cn(
                "size-6 rounded-full ring-1 ring-foreground/10 transition-transform hover:scale-110",
                value.toLowerCase() === c && "ring-2 ring-ring ring-offset-1 ring-offset-popover"
              )}
              style={{ background: c }}
            />
          ))}
        </div>
        <div className="mt-3 flex items-center gap-2 border-t border-border/60 pt-3">
          <span className="size-7 shrink-0 rounded-md border border-border" style={{ background: HEX_RE.test(value) ? value : "#6b7280" }} />
          <Input
            value={text}
            onChange={(e) => setText(e.target.value)}
            onBlur={() => commit(text)}
            onKeyDown={(e) => { if (e.key === "Enter") { commit(text); setOpen(false) } }}
            placeholder="#5b8def"
            className="h-8 font-mono text-xs"
          />
        </div>
      </PopoverContent>
    </Popover>
  )
}
