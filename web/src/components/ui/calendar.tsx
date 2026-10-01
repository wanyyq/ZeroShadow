"use client"

import * as React from "react"
import { Icon } from "@/components/icon"
import { cn } from "@/lib/utils"

const WEEKDAYS = ["一", "二", "三", "四", "五", "六", "日"]

function startOfDay(d: Date) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate())
}

function sameDay(a: Date, b: Date) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}

export interface CalendarProps {
  value?: Date | null
  onChange?: (date: Date) => void
  className?: string
}

export function Calendar({ value, onChange, className }: CalendarProps) {
  const selected = value ? startOfDay(value) : null
  const [month, setMonth] = React.useState<Date>(() => {
    const base = value || new Date()
    return new Date(base.getFullYear(), base.getMonth(), 1)
  })
  const today = React.useMemo(() => startOfDay(new Date()), [])

  const days = React.useMemo(() => {
    const first = new Date(month.getFullYear(), month.getMonth(), 1)
    const offset = (first.getDay() + 6) % 7 // 周一为一周起点
    const start = new Date(first)
    start.setDate(1 - offset)
    return Array.from({ length: 42 }, (_, i) => {
      const d = new Date(start)
      d.setDate(start.getDate() + i)
      return d
    })
  }, [month])

  const move = (delta: number) => setMonth((m) => new Date(m.getFullYear(), m.getMonth() + delta, 1))

  return (
    <div className={cn("w-64 select-none p-1", className)}>
      <div className="mb-2 flex items-center justify-between">
        <button
          type="button"
          onClick={() => move(-1)}
          className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          aria-label="上个月"
        >
          <Icon name="chevron-left" className="size-4" />
        </button>
        <span className="text-sm font-medium">
          {month.getFullYear()} 年 {month.getMonth() + 1} 月
        </span>
        <button
          type="button"
          onClick={() => move(1)}
          className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          aria-label="下个月"
        >
          <Icon name="chevron-right" className="size-4" />
        </button>
      </div>
      <div className="grid grid-cols-7 gap-0.5">
        {WEEKDAYS.map((w) => (
          <span key={w} className="flex h-7 items-center justify-center text-[11px] text-muted-foreground">
            {w}
          </span>
        ))}
        {days.map((d) => {
          const inMonth = d.getMonth() === month.getMonth()
          const isSelected = !!selected && sameDay(d, selected)
          const isToday = sameDay(d, today)
          return (
            <button
              key={d.toISOString()}
              type="button"
              onClick={() => onChange?.(startOfDay(d))}
              className={cn(
                "flex h-8 items-center justify-center rounded-md text-xs transition-colors",
                inMonth ? "text-foreground" : "text-muted-foreground/40",
                !isSelected && "hover:bg-muted",
                isToday && !isSelected && "ring-1 ring-border",
                isSelected && "bg-primary font-medium text-primary-foreground hover:bg-primary/90"
              )}
            >
              {d.getDate()}
            </button>
          )
        })}
      </div>
      <div className="mt-2 flex items-center justify-between border-t border-border/60 pt-2">
        <button
          type="button"
          onClick={() => { onChange?.(today); setMonth(new Date(today.getFullYear(), today.getMonth(), 1)) }}
          className="rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          今天
        </button>
        {selected && (
          <span className="text-[11px] text-muted-foreground">
            已选 {selected.getFullYear()}-{String(selected.getMonth() + 1).padStart(2, "0")}-{String(selected.getDate()).padStart(2, "0")}
          </span>
        )}
      </div>
    </div>
  )
}
