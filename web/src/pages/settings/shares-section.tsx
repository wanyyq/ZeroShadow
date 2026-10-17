import * as React from "react"
import { toast } from "sonner"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Switch } from "@/components/ui/switch"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Icon } from "@/components/icon"
import { useConfirm } from "@/components/confirm-dialog"
import { api, adminDeleteShare, fetchAllShares, type AdminSharesResponse, type AdminShareRow } from "@/lib/api"
import { formatDate } from "@/lib/format"
import { useT } from "@/lib/i18n"

/**
 * 「设置 → 分享」板块（v1.2.1）。
 *
 * 两件事：
 *   1. 分享功能的总开关与"是否允许匿名访问"（后者是需求里"管理员可一键关成仅登录"）；
 *   2. 全站分享记录的总览与强制取消。
 *
 * 移动端注意：这里刻意用「卡片列表」而不是表格 —— 分享记录有 6~7 列，
 * 手机上无论怎么压缩都放不下，横向滚动又极难操作（本项目设置页原先的主要问题）。
 * 表格只在 ≥md 时出现。
 */
export function SharesSection() {
  const t = useT()
  const confirm = useConfirm()

  const [data, setData] = React.useState<AdminSharesResponse | null>(null)
  const [query, setQuery] = React.useState("")
  const [status, setStatus] = React.useState("all")
  const [loading, setLoading] = React.useState(true)

  const load = React.useCallback(
    (silent = false) => {
      if (!silent) setLoading(true)
      fetchAllShares({ q: query.trim() || undefined, status })
        .then(setData)
        .catch((err) => toast.error((err as Error).message))
        .finally(() => setLoading(false))
    },
    [query, status]
  )

  React.useEffect(() => {
    load()
  }, [load])

  const patchConfig = async (body: Record<string, unknown>) => {
    try {
      await api.patch("/admin/config", body)
      toast.success(t("ui.share.updated"))
      load(true)
    } catch (err) {
      toast.error((err as Error).message)
    }
  }

  const revoke = async (row: AdminShareRow) => {
    const ok = await confirm({
      title: t("ui.share.revoke_confirm_title"),
      description: t("ui.share.revoke_confirm_desc"),
      confirmText: t("ui.share.admin_revoke"),
      destructive: true,
    })
    if (!ok) return
    try {
      await adminDeleteShare(row.id)
      toast.success(t("ui.share.revoked"))
      load(true)
    } catch (err) {
      toast.error((err as Error).message)
    }
  }

  const rows = data?.shares ?? []

  return (
    <div className="grid gap-5">
      {/* 开关 */}
      <div className="edge-highlight min-w-0 rounded-xl border border-border bg-card p-4 sm:p-5">
        <h3 className="mb-1 text-sm font-medium">{t("ui.share.admin_title")}</h3>
        <p className="mb-4 text-xs text-muted-foreground">{t("ui.share.admin_desc")}</p>
        <div className="grid gap-2">
          <div className="flex items-center justify-between gap-3 rounded-md bg-muted/50 px-3 py-2">
            <div className="min-w-0">
              <p className="text-sm font-medium">{t("ui.share.enabled_label")}</p>
              <p className="text-xs text-muted-foreground">{t("ui.share.disabled_hint")}</p>
            </div>
            <Switch checked={data?.enabled ?? true} onCheckedChange={(v) => void patchConfig({ shareEnabled: !!v })} />
          </div>
          <div className="flex items-center justify-between gap-3 rounded-md bg-muted/50 px-3 py-2">
            <div className="min-w-0">
              <p className="text-sm font-medium">{t("ui.share.public_access_label")}</p>
              <p className="text-xs text-muted-foreground">{t("ui.share.public_access_on_hint")}</p>
            </div>
            <Switch checked={data?.publicAccess ?? true} onCheckedChange={(v) => void patchConfig({ sharePublicAccess: !!v })} />
          </div>
        </div>
      </div>

      {/* 列表 */}
      <div className="edge-highlight min-w-0 rounded-xl border border-border bg-card p-4 sm:p-5">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <div className="min-w-0 flex-1">
            <h3 className="text-sm font-medium">{t("ui.share.admin_title")}</h3>
            <p className="text-xs text-muted-foreground">
              {t("ui.share.stats", { active: data?.active ?? 0, total: data?.total ?? 0 })}
            </p>
          </div>
          <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("ui.share.search_placeholder")}
              className="h-8 min-w-0 flex-1 sm:w-56 sm:flex-none"
            />
            <Select value={status} onValueChange={(v) => setStatus(String(v))}>
              <SelectTrigger className="h-8 w-28 shrink-0" size="sm">
                <SelectValue>
                  {(value) =>
                    value === "active"
                      ? t("ui.share.filter_active")
                      : value === "expired"
                        ? t("ui.share.filter_expired")
                        : t("ui.share.filter_all")
                  }
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t("ui.share.filter_all")}</SelectItem>
                <SelectItem value="active">{t("ui.share.filter_active")}</SelectItem>
                <SelectItem value="expired">{t("ui.share.filter_expired")}</SelectItem>
              </SelectContent>
            </Select>
            <Button size="icon-sm" variant="outline" onClick={() => load()} title={t("ui.common.refresh")}>
              <Icon name="refresh-cw" />
            </Button>
          </div>
        </div>

        {loading && rows.length === 0 && (
          <p className="py-8 text-center text-sm text-muted-foreground">{t("ui.common.loading")}</p>
        )}
        {!loading && rows.length === 0 && (
          <p className="py-8 text-center text-sm text-muted-foreground">{t("ui.share.empty")}</p>
        )}

        {/* ≥md：表格 */}
        {rows.length > 0 && (
          <div className="hidden md:block">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="min-w-40">{t("ui.share.col_name")}</TableHead>
                  <TableHead className="hidden lg:table-cell">{t("ui.share.col_path")}</TableHead>
                  <TableHead className="w-32">{t("ui.share.col_owner")}</TableHead>
                  <TableHead className="hidden w-40 xl:table-cell">{t("ui.share.col_created")}</TableHead>
                  <TableHead className="w-40">{t("ui.share.col_expires")}</TableHead>
                  <TableHead className="w-24">{t("ui.share.col_status")}</TableHead>
                  <TableHead className="w-20 text-right">{t("ui.share.col_downloads")}</TableHead>
                  <TableHead className="w-20 text-right">{t("ui.common.actions")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell className="max-w-64 truncate font-medium" title={row.path}>
                      <span className="inline-flex items-center gap-1.5">
                        <Icon name={row.isFolder ? "folder" : "file"} className="size-3.5 shrink-0 text-muted-foreground" />
                        {row.name}
                      </span>
                    </TableCell>
                    <TableCell className="hidden max-w-56 truncate font-mono text-xs text-muted-foreground lg:table-cell" title={row.path}>
                      /{row.path}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">{row.owner || "-"}</TableCell>
                    <TableCell className="hidden text-xs text-muted-foreground xl:table-cell">{formatDate(row.createdAt)}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{formatDate(row.expiresAt)}</TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        {row.expired ? (
                          <Badge variant="secondary">{t("ui.share.status_expired")}</Badge>
                        ) : (
                          <Badge variant="default">{t("ui.share.status_active")}</Badge>
                        )}
                        {row.requirePassword && <Badge variant="outline">{t("ui.share.status_password")}</Badge>}
                      </div>
                    </TableCell>
                    <TableCell className="text-right text-xs text-muted-foreground" title={t("ui.share.downloads", { n: row.downloads })}>{row.downloads}</TableCell>
                    <TableCell className="text-right">
                      <Button size="icon-sm" variant="ghost" title={t("ui.share.admin_revoke")} onClick={() => void revoke(row)}>
                        <Icon name="trash-2" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}

        {/* <md：卡片列表（避免手机横向滚动） */}
        {rows.length > 0 && (
          <div className="grid gap-2 md:hidden">
            {rows.map((row) => (
              <div key={row.id} className="min-w-0 rounded-lg border border-border/60 p-3">
                <div className="flex items-start gap-2">
                  <Icon name={row.isFolder ? "folder" : "file"} className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium" title={row.name}>{row.name}</p>
                    <p className="truncate text-[11px] text-muted-foreground" title={row.path}>{row.path}</p>
                  </div>
                  <Button size="icon-sm" variant="ghost" title={t("ui.share.admin_revoke")} onClick={() => void revoke(row)}>
                    <Icon name="trash-2" />
                  </Button>
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
                  {row.expired ? (
                    <Badge variant="secondary">{t("ui.share.status_expired")}</Badge>
                  ) : (
                    <Badge variant="default">{t("ui.share.status_active")}</Badge>
                  )}
                  {row.requirePassword && <Badge variant="outline">{t("ui.share.status_password")}</Badge>}
                  <span className="truncate">{row.owner || "-"}</span>
                  <span>·</span>
                  <span className="tabular-nums">{formatDate(row.expiresAt)}</span>
                  <span>·</span>
                  <span className="tabular-nums">{row.downloads}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
