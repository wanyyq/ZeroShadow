"use client"

import * as React from "react"
import { Icon } from "@/components/icon"
import { useT } from "@/lib/i18n"
import { cn } from "@/lib/utils"

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
  const t = useT()
  const selected = value ? startOfDay(value) : null
  // 星期表头必须在组件内取文案：放在模块顶层会被"加载时翻译一次"冻结住，切换语言不更新
  const weekdays = [
    t("ui.calendar.weekday_mon"),
    t("ui.calendar.weekday_tue"),
    t("ui.calendar.weekday_wed"),
    t("ui.calendar.weekday_thu"),
    t("ui.calendar.weekday_fri"),
    t("ui.calendar.weekday_sat"),
    t("ui.calendar.weekday_sun"),
  ]
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
          aria-label={t("ui.calendar.prev_month")}
        >
          <Icon name="chevron-left" className="size-4" />
        </button>
        <span className="text-sm font-medium">
          {t("ui.calendar.month_year", { year: month.getFullYear(), month: month.getMonth() + 1 })}
        </span>
        <button
          type="button"
          onClick={() => move(1)}
          className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          aria-label={t("ui.calendar.next_month")}
        >
          <Icon name="chevron-right" className="size-4" />
        </button>
      </div>
      <div className="grid grid-cols-7 gap-0.5">
        {weekdays.map((w) => (
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
          {t("ui.calendar.today")}
        </button>
        {selected && (
          <span className="text-[11px] text-muted-foreground">
            {t("ui.calendar.selected", {
              date: `${selected.getFullYear()}-${String(selected.getMonth() + 1).padStart(2, "0")}-${String(selected.getDate()).padStart(2, "0")}`,
            })}
          </span>
        )}
      </div>
    </div>
  )
}
