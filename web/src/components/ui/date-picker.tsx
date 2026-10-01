"use client"

import * as React from "react"
import { Button } from "@/components/ui/button"
import { Calendar } from "@/components/ui/calendar"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Icon } from "@/components/icon"
import { cn } from "@/lib/utils"

export function parseDate(value?: string | null): Date | null {
  if (!value) return null
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value)
  if (!m) return null
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  return Number.isNaN(d.getTime()) ? null : d
}

export function formatDateValue(d: Date | null): string {
  if (!d) return ""
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

interface DatePickerProps {
  value: string | null
  onChange: (value: string | null) => void
  placeholder?: string
  className?: string
  id?: string
}

export function DatePicker({ value, onChange, placeholder = "选择日期", className, id }: DatePickerProps) {
  const [open, setOpen] = React.useState(false)
  const selected = parseDate(value)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        id={id}
        render={
          <Button
            variant="outline"
            className={cn(
              "w-full justify-start gap-2 font-normal",
              !selected && "text-muted-foreground",
              className
            )}
          />
        }
      >
        <Icon name="calendar" className="size-4" />
        <span className="flex-1 truncate text-left">{selected ? formatDateValue(selected) : placeholder}</span>
        {selected && (
          <span
            role="button"
            tabIndex={0}
            aria-label="清除日期"
            className="rounded-sm text-muted-foreground transition-colors hover:text-foreground"
            onClick={(e) => { e.stopPropagation(); onChange(null) }}
            onKeyDown={(e) => { if (e.key === "Enter") { e.stopPropagation(); onChange(null) } }}
          >
            <Icon name="x" className="size-3.5" />
          </span>
        )}
      </PopoverTrigger>
      <PopoverContent className="w-auto p-2" align="start">
        <Calendar
          value={selected}
          onChange={(d) => { onChange(formatDateValue(d)); setOpen(false) }}
        />
      </PopoverContent>
    </Popover>
  )
}
