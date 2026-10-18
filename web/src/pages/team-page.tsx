import * as React from "react"
import { toast } from "sonner"
import { AppShell } from "@/components/layout/app-shell"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from "@/components/ui/context-menu"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { DatePicker } from "@/components/ui/date-picker"
import { Avatar } from "@/components/avatar"
import { Icon } from "@/components/icon"
import { PathPicker } from "@/components/browser/path-picker"
import { useConfirm } from "@/components/confirm-dialog"
import { animateListIn } from "@/lib/lucide"
import { useAuth } from "@/state/auth"
import { SUPER_OWNER } from "@/lib/avatar-cache"
import { createTodo, deleteTodo, fetchTodos, patchTodo, setTodoDone, fetchLeaderGroups, addGroupMembers, patchLeaderGroup } from "@/lib/api"
import type { LeaderGroup, Member, Todo, TodosResponse } from "@/lib/types"
import { cn } from "@/lib/utils"
import { translate, useT } from "@/lib/i18n"
import { useNavigate } from "react-router-dom"

/** 复制纯文本并给出反馈 */
function copyText(text: string, okMsg: string) {
  void navigator.clipboard?.writeText(text).then(
    () => toast.success(okMsg),
    () => toast.error(translate("ui.common.copy_failed"))
  )
}

/**
 * 表单里的「左标签 + 右控件」行，配合父容器的 divide-y 使用。
 * 抽到模块级而不是写在组件里——写在组件内部会每次渲染都生成新的组件类型，
 * 导致子树整体重挂载（eslint 的 react-hooks/static-components 也会报错）。
 */
function FormRow({ label, htmlFor, hint, children }: {
  label: string
  htmlFor?: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-3.5">
      <div className="flex min-w-0 flex-col gap-0.5">
        <FieldLabel htmlFor={htmlFor} className="text-sm">{label}</FieldLabel>
        {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  )
}

function formatDue(due: string | null) {
  if (!due) return ""
  const d = new Date(due)
  if (Number.isNaN(d.getTime())) return due
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
}

function dueState(todo: Todo): "overdue" | "today" | "future" | "none" {
  if (!todo.dueAt || todo.done) return "none"
  const d = new Date(todo.dueAt)
  if (Number.isNaN(d.getTime())) return "none"
  const today = new Date()
  const d0 = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const t0 = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()
  if (d0 < t0) return "overdue"
  if (d0 === t0) return "today"
  return "future"
}

export function TeamPage() {
  const { me, ready } = useAuth()
  const t = useT()
  const navigate = useNavigate()
  const [data, setData] = React.useState<TodosResponse | null>(null)
  const [status, setStatus] = React.useState("open")
  const [scope, setScope] = React.useState("all")
  const [q, setQ] = React.useState("")
  const [editorOpen, setEditorOpen] = React.useState(false)
  const [editing, setEditing] = React.useState<Todo | null>(null)
  const [confirmDelete, setConfirmDelete] = React.useState<Todo | null>(null)
  const [ledGroups, setLedGroups] = React.useState<LeaderGroup[]>([])
  const [allMembers, setAllMembers] = React.useState<Member[]>([])
  const listRef = React.useRef<HTMLDivElement>(null)

  const loadGroups = React.useCallback(() => {
    fetchLeaderGroups().then((d) => { setLedGroups(d.groups); setAllMembers(d.allMembers) }).catch(() => {})
  }, [])
  React.useEffect(() => {
    if (ready && me.role !== "guest") loadGroups()
  }, [ready, me.role, loadGroups])

  const load = React.useCallback(() => {
    fetchTodos({ status, scope, q })
      // 服务端在「团队待办已关闭」等情况下可能少给字段；这里统一补默认值，
      // 保证 data.leaderGroups / data.members 永远是可读数组，页面不会白屏。
      .then((d) => setData({
        ...d,
        todos: d.todos ?? [],
        canCreateAll: !!d.canCreateAll,
        leaderGroups: d.leaderGroups ?? [],
        members: d.members ?? [],
      }))
      .catch((e) => toast.error((e as Error).message))
  }, [status, scope, q])
  React.useEffect(() => {
    if (ready && me.role !== "guest") load()
  }, [ready, me.role, load])

  // 列表入场动画：只在筛选条件变化时播放一次。
  // 之前依赖 data，导致每次勾选完成 / 删除 / 刷新都重放一遍，既闪又费。
  // 必须放在下面那些提前 return 之前 —— 否则会变成条件调用 Hook。
  const animatedKeyRef = React.useRef<string | null>(null)
  React.useEffect(() => {
    const key = `${status}|${scope}|${q}`
    if (animatedKeyRef.current === key) return
    animatedKeyRef.current = key
    requestAnimationFrame(() => animateListIn(listRef.current))
  }, [status, scope, q])

  if (!ready) return <AppShell><div className="p-8 text-center text-sm text-muted-foreground">{t("ui.common.loading")}</div></AppShell>
  if (me.role === "guest") {
    return (
      <AppShell>
        <div className="flex flex-1 items-center justify-center p-8">
          <Empty className="max-w-sm border">
            <EmptyHeader>
              <EmptyMedia variant="icon"><Icon name="clipboard-list" /></EmptyMedia>
              <EmptyTitle>{t("ui.team.guest_title")}</EmptyTitle>
              <EmptyDescription>{t("ui.team.guest_desc")}</EmptyDescription>
            </EmptyHeader>
            <Button onClick={() => navigate("/login")}>
              <Icon name="log-in" data-icon="inline-start" /> {t("ui.team.go_login")}
            </Button>
          </Empty>
        </div>
      </AppShell>
    )
  }

  // 超管关掉团队待办后给出明确说明，而不是一个看起来坏掉的空页面
  if (data && data.enabled === false) {
    return (
      <AppShell>
        <div className="flex flex-1 items-center justify-center p-8">
          <Empty className="max-w-sm border">
            <EmptyHeader>
              <EmptyMedia variant="icon"><Icon name="clipboard-list" /></EmptyMedia>
              <EmptyTitle>{t("ui.team.disabled_title")}</EmptyTitle>
              <EmptyDescription>
                {t("ui.team.disabled_desc")}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        </div>
      </AppShell>
    )
  }

  const canCreate = !!data && (data.canCreateAll || data.leaderGroups.length > 0)
  const todos = data?.todos || []
  const openCount = todos.filter((x) => !x.done).length

  const toggleDone = async (todo: Todo) => {
    try {
      await setTodoDone(todo.id, !todo.done)
      load()
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  const doDelete = async () => {
    if (!confirmDelete) return
    try {
      await deleteTodo(confirmDelete.id)
      toast.success(t("ui.team.deleted"))
      setConfirmDelete(null)
      load()
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  return (
    <AppShell>
      <div className="flex flex-1 flex-col overflow-hidden">
        {/* 整页统一滚动，不再套「列表自己滚 + 外面不滚」的双层滚动区 */}
        <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-4 overflow-y-auto px-4 py-6 sm:px-6">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex flex-col gap-1">
              <h1 className="font-heading text-2xl font-semibold tracking-tight">{t("ui.team.page_title")}</h1>
              <p className="text-sm text-muted-foreground">{t("ui.team.page_subtitle")}</p>
            </div>
            {canCreate && (
              <Button size="sm" onClick={() => { setEditing(null); setEditorOpen(true) }}>
                <Icon name="plus" data-icon="inline-start" /> {t("ui.team.new_todo")}
              </Button>
            )}
          </div>

          {/* 筛选工具条：两组分段控件 + 搜索，收进同一块里，不再各占一行 */}
          <div className="edge-highlight flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-border bg-card px-3 py-2.5">
            <ToggleGroup
              size="sm"
              value={[status]}
              onValueChange={(v) => { const next = v[v.length - 1]; if (next) setStatus(next) }}
            >
              <ToggleGroupItem value="open">{t("ui.team.status_open")}</ToggleGroupItem>
              <ToggleGroupItem value="done">{t("ui.team.status_done")}</ToggleGroupItem>
              <ToggleGroupItem value="all">{t("ui.common.all")}</ToggleGroupItem>
            </ToggleGroup>

            <span className="hidden h-5 w-px shrink-0 bg-border sm:block" aria-hidden="true" />

            <ToggleGroup
              size="sm"
              value={[scope]}
              onValueChange={(v) => { const next = v[v.length - 1]; if (next) setScope(next) }}
            >
              <ToggleGroupItem value="all">{t("ui.team.filter_all_scopes")}</ToggleGroupItem>
              <ToggleGroupItem value="group">{t("ui.team.scope_group")}</ToggleGroupItem>
              <ToggleGroupItem value="member">{t("ui.team.scope_member")}</ToggleGroupItem>
            </ToggleGroup>

            <InputGroup className="h-8 w-full sm:ml-auto sm:w-48">
              <InputGroupAddon><Icon name="search" /></InputGroupAddon>
              <InputGroupInput placeholder={t("ui.team.search_todos_placeholder")} value={q} onChange={(e) => setQ(e.target.value)} />
            </InputGroup>
          </div>

          {/* 任务列表：页面的主体，放在最显眼的位置 */}
          <div className="edge-highlight flex flex-col overflow-hidden rounded-xl border border-border bg-card">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-border/60 bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
              <Icon name="list-checks" className="size-3.5" />
              <span>{t("ui.team.total_count", { n: todos.length })}</span>
              {status !== "done" && <span>{t("ui.team.open_count", { n: openCount })}</span>}
            </div>

            {todos.length === 0 ? (
              <Empty className="border-0">
                <EmptyHeader>
                  <EmptyMedia variant="icon"><Icon name="clipboard-check" /></EmptyMedia>
                  <EmptyTitle>{t("ui.team.empty_title")}</EmptyTitle>
                  <EmptyDescription>
                    {canCreate ? t("ui.team.empty_can_create_desc") : t("ui.team.empty_filtered_desc")}
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              <div ref={listRef} className="divide-y divide-border/50">
                {todos.map((todo) => (
                  <TodoRow
                    key={todo.id}
                    todo={todo}
                    onToggle={() => toggleDone(todo)}
                    onEdit={() => { setEditing(todo); setEditorOpen(true) }}
                    onDelete={() => setConfirmDelete(todo)}
                  />
                ))}
              </div>
            )}
          </div>

          {/* 小组管理是次要动作，放到列表下面，避免一进页面先看到一大块管理面板 */}
          {ledGroups.length > 0 && (
            <LeaderPanel groups={ledGroups} allMembers={allMembers} onChanged={loadGroups} />
          )}
        </div>
      </div>

      {editorOpen && data && (
        <TodoEditor
          todo={editing}
          data={data}
          onClose={() => setEditorOpen(false)}
          onSaved={() => { setEditorOpen(false); load() }}
        />
      )}

      <AlertDialog open={confirmDelete !== null} onOpenChange={(o) => !o && setConfirmDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("ui.team.delete_confirm_title")}</AlertDialogTitle>
            <AlertDialogDescription>{t("ui.team.delete_confirm_desc")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("ui.common.cancel")}</AlertDialogCancel>
            <AlertDialogAction className="bg-destructive/10 text-destructive hover:bg-destructive/20" onClick={(e) => { e.preventDefault(); doDelete() }}>{t("ui.common.delete")}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </AppShell>
  )
}

/** 单条待办：标题行（标题 + 优先级 + 操作），下面是备注与元信息 */
function TodoRow({ todo, onToggle, onEdit, onDelete }: {
  todo: Todo
  onToggle: () => void
  onEdit: () => void
  onDelete: () => void
}) {
  const t = useT()
  // scope / priority 的取值本身是发回服务端的数据，这里只做「值 → 文案」的映射
  const scopeLabels: Record<Todo["scope"], string> = {
    all: t("ui.team.scope_all"),
    group: t("ui.team.scope_group"),
    member: t("ui.team.scope_member"),
  }
  const priorityLabels: Record<Todo["priority"], string> = {
    high: t("ui.team.priority_high"),
    normal: t("ui.team.priority_normal"),
    low: t("ui.team.priority_low"),
  }
  const ds = dueState(todo)
  const canOperate = todo.canEdit || todo.canComplete || todo.canManage
  const toggleLabel = todo.done ? t("ui.team.action_mark_undone") : t("ui.team.action_mark_done")
  return (
    <ContextMenu>
      <ContextMenuTrigger render={<div />}>
        <div className={cn("dense-row flex items-start gap-3 px-3 transition-colors hover:bg-muted/30", todo.done && "opacity-60")} data-animate-item>
      <Checkbox
        className="mt-0.5"
        checked={todo.done}
        onCheckedChange={onToggle}
        aria-label={todo.done ? t("ui.team.mark_undone") : t("ui.team.mark_done")}
      />
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="flex items-start gap-2">
          <span className={cn("min-w-0 flex-1 text-sm font-medium break-words", todo.done && "line-through")}>
            {todo.title}
          </span>
          <Badge
            variant={todo.priority === "high" ? "default" : todo.priority === "low" ? "outline" : "secondary"}
            className="shrink-0 text-[10px]"
          >
            {priorityLabels[todo.priority]}
          </Badge>
          {canOperate && (
            <DropdownMenu>
              <DropdownMenuTrigger render={<Button size="icon-xs" variant="ghost" aria-label={t("ui.team.todo_actions")} />}>
                <Icon name="ellipsis-vertical" className="size-3.5" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {todo.canEdit && (
                  <DropdownMenuItem onClick={onEdit}>
                    <Icon name="pencil-line" /> {t("ui.common.edit")}
                  </DropdownMenuItem>
                )}
                {todo.canComplete && (
                  <DropdownMenuItem onClick={onToggle}>
                    <Icon name={todo.done ? "undo-2" : "check"} /> {toggleLabel}
                  </DropdownMenuItem>
                )}
                {todo.canManage && (
                  <DropdownMenuItem variant="destructive" onClick={onDelete}>
                    <Icon name="trash-2" /> {t("ui.common.delete")}
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>

        {todo.note && <p className="line-clamp-2 text-xs text-muted-foreground">{todo.note}</p>}

        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
          <span className="flex items-center gap-1">
            <Icon name="layers" className="size-3" />
            {scopeLabels[todo.scope]}
            {todo.groupName ? `·${todo.groupName}` : ""}
            {todo.memberName ? `·${todo.memberName}` : ""}
          </span>
          {todo.dueAt && (
            <span
              className={cn(
                "flex items-center gap-1",
                ds === "overdue" && "font-medium text-destructive",
                // 没有「警告」语义令牌，这里有意用琥珀色把「今天到期」区分出来
                ds === "today" && "font-medium text-amber-600 dark:text-amber-400"
              )}
            >
              <Icon name="clock" className="size-3" />
              {formatDue(todo.dueAt)}
              {ds === "overdue" ? t("ui.team.due_overdue") : ds === "today" ? t("ui.team.due_today") : ""}
            </span>
          )}
          <span className="flex items-center gap-1">
            <Avatar
              owner={todo.createdById ? `u-${todo.createdById}` : todo.createdByRole === "superadmin" ? SUPER_OWNER : null}
              name={todo.createdBy}
              size={16}
            />
            {todo.createdBy || t("ui.common.unknown")}
          </span>
          {todo.done && todo.doneBy && <span>{t("ui.team.done_by", { name: todo.doneBy })}</span>}
        </div>
      </div>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-52">
        {todo.canEdit && (
          <ContextMenuItem onClick={onEdit}>
            <Icon name="pencil-line" /> {t("ui.common.edit")}
          </ContextMenuItem>
        )}
        {todo.canComplete && (
          <ContextMenuItem onClick={onToggle}>
            <Icon name={todo.done ? "undo-2" : "check"} /> {toggleLabel}
          </ContextMenuItem>
        )}
        <ContextMenuSeparator />
        <ContextMenuItem onClick={() => copyText(todo.title, t("ui.team.copied_title"))}>
          <Icon name="clipboard-copy" /> {t("ui.team.copy_title")}
        </ContextMenuItem>
        {todo.note && (
          <ContextMenuItem onClick={() => copyText(todo.note, t("ui.team.copied_note"))}>
            <Icon name="clipboard-list" /> {t("ui.team.copy_note")}
          </ContextMenuItem>
        )}
        {todo.canManage && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem variant="destructive" onClick={onDelete}>
              <Icon name="trash-2" /> {t("ui.common.delete")}
            </ContextMenuItem>
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  )
}

/** 「我管理的小组」：一行一个小组，成员与可见范围的管理收进对话框，列表本身保持清爽 */
function LeaderPanel({ groups, allMembers, onChanged }: { groups: LeaderGroup[]; allMembers: Member[]; onChanged: () => void }) {
  const t = useT()
  const [managingId, setManagingId] = React.useState<string | null>(null)
  // 存 id 而不是对象：onChanged() 重拉之后这里自动拿到最新的成员与可见范围
  const managing = managingId ? groups.find((g) => g.id === managingId) ?? null : null

  return (
    <Card className="gap-0 py-0 edge-highlight">
      <CardHeader className="gap-1 border-b border-border/60 py-4">
        <div className="flex items-center gap-2">
          <CardTitle className="text-sm">{t("ui.team.leader_panel_title")}</CardTitle>
          <Badge variant="secondary" className="text-[10px]">{groups.length}</Badge>
        </div>
        <CardDescription>{t("ui.team.leader_panel_desc")}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col divide-y divide-border/50 p-0">
        {groups.map((g) => (
          <div key={g.id} className="flex items-center gap-3 px-4 py-3">
            <span className="size-2.5 shrink-0 rounded-full" style={{ background: g.color }} aria-hidden="true" />
            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="truncate text-sm font-medium">{g.name}</span>
                <Badge variant="secondary" className="text-[10px]">{t("ui.team.member_count", { n: g.memberCount })}</Badge>
                <Badge variant="outline" className="text-[10px]">
                  {g.whitelist.length ? t("ui.team.whitelist_count", { n: g.whitelist.length }) : t("ui.team.visibility_unrestricted")}
                  {g.blacklist.length ? t("ui.team.blacklist_hidden_count", { n: g.blacklist.length }) : ""}
                </Badge>
              </div>
              {g.canViewMembers && g.members.length > 0 && (
                <div className="flex flex-wrap items-center gap-1 text-[11px] text-muted-foreground">
                  {g.members.slice(0, 6).map((m) => (
                    <span key={m.id} className="flex items-center gap-1 rounded-full bg-muted/60 py-0.5 pr-1.5 pl-0.5">
                      <Avatar owner={`u-${m.id}`} name={m.username} size={16} />
                      {m.username}
                    </span>
                  ))}
                  {g.members.length > 6 && <span>{t("ui.team.more_members", { n: g.members.length })}</span>}
                </div>
              )}
            </div>
            <Button size="sm" variant="outline" className="shrink-0" onClick={() => setManagingId(g.id)}>
              <Icon name="sliders-horizontal" data-icon="inline-start" /> {t("ui.team.manage")}
            </Button>
          </div>
        ))}
      </CardContent>

      {managing && (
        <LeaderGroupDialog
          key={managing.id}
          group={managing}
          allMembers={allMembers}
          onClose={() => setManagingId(null)}
          onChanged={onChanged}
        />
      )}
    </Card>
  )
}

/** 组长管理单个小组：成员与可见范围分两个标签，替代原来一屏塞满的表单 */
function LeaderGroupDialog({ group, allMembers, onClose, onChanged }: {
  group: LeaderGroup
  allMembers: Member[]
  onClose: () => void
  onChanged: () => void
}) {
  const t = useT()
  const [tab, setTab] = React.useState("members")
  const confirm = useConfirm()
  const [query, setQuery] = React.useState("")
  const [white, setWhite] = React.useState(group.whitelist.join("\n"))
  const [black, setBlack] = React.useState(group.blacklist.join("\n"))
  const [picking, setPicking] = React.useState<null | "white" | "black">(null)
  const [busyId, setBusyId] = React.useState<string | null>(null)
  const [saving, setSaving] = React.useState(false)

  const memberIds = new Set(group.members.map((m) => m.id))
  const filtered = allMembers.filter((m) => m.username.toLowerCase().includes(query.trim().toLowerCase()))
  const whiteCount = white.split("\n").map((l) => l.trim()).filter(Boolean).length
  const blackCount = black.split("\n").map((l) => l.trim()).filter(Boolean).length
  const canManage = group.canManageMembers
  // 「调整本组可见范围」是独立能力（manageVisibility，默认关）：只有它能改白/黑名单，
  // 而且服务端只接受"收窄"，放宽会被 403。
  const canVisibility = group.canManageVisibility

  const add = async (id: string) => {
    setBusyId(id)
    try {
      await addGroupMembers(group.id, [id], "add")
      onChanged()
    } catch (e) { toast.error((e as Error).message) } finally { setBusyId(null) }
  }
  const remove = async (m: Member) => {
    // 移出会连带取消组长身份，属于容易误点且不好恢复的操作，必须二次确认。
    // 动作交给确认框执行：请求失败时框会保持打开并显示原因，不会"看起来成功"。
    await confirm({
      title: t("ui.team.remove_member_title", { name: m.username, group: group.name }),
      description: t("ui.team.remove_member_desc"),
      confirmText: t("ui.team.remove_from_group"),
      onConfirm: async () => {
        await addGroupMembers(group.id, [m.id], "remove")
        onChanged()
      },
    })
  }
  const saveVisibility = async () => {
    setSaving(true)
    try {
      await patchLeaderGroup(group.id, {
        whitelist: white.split("\n").map((l) => l.trim()).filter(Boolean),
        blacklist: black.split("\n").map((l) => l.trim()).filter(Boolean),
      })
      toast.success(t("ui.team.visibility_saved"))
      onChanged()
    } catch (e) { toast.error((e as Error).message) } finally { setSaving(false) }
  }
  const insertPicked = (picked: string) => {
    const isWhite = picking === "white"
    const current = isWhite ? white : black
    const lines = current.split("\n").map((l) => l.trim()).filter(Boolean)
    if (picked && !lines.includes(picked)) lines.push(picked)
    if (isWhite) setWhite(lines.join("\n"))
    else setBlack(lines.join("\n"))
    setPicking(null)
  }

  return (
    <>
      <Dialog open onOpenChange={(o) => !o && onClose()}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <span className="size-2.5 shrink-0 rounded-full" style={{ background: group.color }} aria-hidden="true" />
              {group.name}
            </DialogTitle>
            <DialogDescription>
              {canManage ? t("ui.team.dialog_leader_desc") : t("ui.team.dialog_viewer_desc")}
            </DialogDescription>
          </DialogHeader>

          <Tabs value={tab} onValueChange={setTab}>
            <TabsList className="w-full">
              <TabsTrigger value="members">
                {t("ui.team.tab_members")}
                <Badge variant="secondary" className="px-1 text-[10px]">{group.memberCount}</Badge>
              </TabsTrigger>
              <TabsTrigger value="scope">{t("ui.team.tab_visibility")}</TabsTrigger>
            </TabsList>

            <TabsContent value="members">
              {!group.canViewMembers ? (
                <p className="py-12 text-center text-sm text-muted-foreground">
                  {t("ui.team.no_view_members")}
                </p>
              ) : (
                <div className="flex h-[46vh] flex-col gap-3">
                  <InputGroup>
                    <InputGroupAddon><Icon name="search" /></InputGroupAddon>
                    <InputGroupInput placeholder={t("ui.team.search_members_placeholder")} value={query} onChange={(e) => setQuery(e.target.value)} />
                  </InputGroup>
                  <ScrollArea className="min-h-0 flex-1 rounded-lg border border-border">
                    {filtered.length === 0 ? (
                      <p className="p-6 text-center text-sm text-muted-foreground">
                        {allMembers.length === 0 ? t("ui.team.no_members") : t("ui.team.no_matching_members")}
                      </p>
                    ) : (
                      <div className="flex flex-col p-1">
                        {filtered.map((m) => {
                          const joined = memberIds.has(m.id)
                          return (
                            <div key={m.id} className={cn("flex items-center gap-2.5 rounded-md px-2 py-1.5", joined && "bg-accent/40")}>
                              <Avatar owner={`u-${m.id}`} name={m.username} size={22} />
                              <span className="min-w-0 flex-1 truncate text-sm">{m.username}</span>
                              {m.disabled && <Badge variant="secondary" className="text-[10px]">{t("ui.common.disabled")}</Badge>}
                              {joined ? (
                                <span className="flex shrink-0 items-center gap-1.5">
                                  <Badge variant="outline" className="text-[10px]">{t("ui.team.badge_in_group")}</Badge>
                                  {canManage && (
                                    <Button size="xs" variant="ghost" className="text-destructive" disabled={busyId === m.id} onClick={() => remove(m)}>
                                      {t("ui.team.action_remove_member")}
                                    </Button>
                                  )}
                                </span>
                              ) : canManage ? (
                                <Button size="xs" variant="outline" className="shrink-0" disabled={busyId === m.id} onClick={() => add(m.id)}>
                                  <Icon name="plus" data-icon="inline-start" /> {t("ui.team.action_add_member")}
                                </Button>
                              ) : null}
                            </div>
                          )
                        })}
                      </div>
                    )}
                  </ScrollArea>
                  <p className="text-xs text-muted-foreground">{t("ui.team.remove_hint")}</p>
                </div>
              )}
            </TabsContent>

            <TabsContent value="scope">
              <div className="flex h-[46vh] flex-col gap-4">
                <FieldGroup className="gap-5">
                  <Field>
                    <div className="flex items-center justify-between gap-2">
                      <FieldLabel htmlFor="lg-white" className="flex items-center gap-2">
                        {t("ui.team.whitelist_label")}
                        <Badge variant={whiteCount ? "secondary" : "outline"} className="px-1 text-[10px]">
                          {whiteCount ? whiteCount : t("ui.team.unlimited")}
                        </Badge>
                      </FieldLabel>
                      {canVisibility && (
                        <Button size="xs" variant="ghost" onClick={() => setPicking("white")}>
                          <Icon name="folder-tree" data-icon="inline-start" /> {t("ui.team.pick_from_browser")}
                        </Button>
                      )}
                    </div>
                    <Textarea
                      id="lg-white"
                      rows={5}
                      disabled={!canVisibility}
                      className="resize-none font-mono text-xs"
                      placeholder={t("ui.team.whitelist_placeholder")}
                      value={white}
                      onChange={(e) => setWhite(e.target.value)}
                    />
                    <FieldDescription>{t("ui.team.whitelist_hint")}</FieldDescription>
                  </Field>

                  <Field>
                    <div className="flex items-center justify-between gap-2">
                      <FieldLabel htmlFor="lg-black" className="flex items-center gap-2">
                        {t("ui.team.blacklist_label")}
                        <Badge variant={blackCount ? "secondary" : "outline"} className="px-1 text-[10px]">
                          {blackCount ? blackCount : t("ui.common.none")}
                        </Badge>
                      </FieldLabel>
                      {canVisibility && (
                        <Button size="xs" variant="ghost" onClick={() => setPicking("black")}>
                          <Icon name="folder-tree" data-icon="inline-start" /> {t("ui.team.pick_from_browser")}
                        </Button>
                      )}
                    </div>
                    <Textarea
                      id="lg-black"
                      rows={5}
                      disabled={!canVisibility}
                      className="resize-none font-mono text-xs"
                      placeholder={t("ui.team.blacklist_placeholder")}
                      value={black}
                      onChange={(e) => setBlack(e.target.value)}
                    />
                    <FieldDescription>{t("ui.team.blacklist_hint")}</FieldDescription>
                  </Field>
                </FieldGroup>

                <div className="mt-auto flex justify-end">
                  <Button size="sm" disabled={saving || !canVisibility} onClick={saveVisibility}>
                    {saving && <Icon name="loader-2" className="animate-spin" data-icon="inline-start" />} {t("ui.team.save_visibility")}
                  </Button>
                </div>
              </div>
            </TabsContent>
          </Tabs>

          <DialogFooter>
            <Button variant="outline" onClick={onClose}>{t("ui.common.close")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <PathPicker open={picking !== null} onOpenChange={(o) => { if (!o) setPicking(null) }} onPick={insertPicked} />
    </>
  )
}

function TodoEditor({ todo, data, onClose, onSaved }: {
  todo: Todo | null
  data: TodosResponse
  onClose: () => void
  onSaved: () => void
}) {
  const t = useT()
  const [title, setTitle] = React.useState(todo?.title || "")
  const [note, setNote] = React.useState(todo?.note || "")
  const [priority, setPriority] = React.useState<Todo["priority"]>(todo?.priority || "normal")
  const [dueAt, setDueAt] = React.useState(todo?.dueAt ? todo.dueAt.slice(0, 10) : "")
  const [allowAssigneeEdit, setAllowAssigneeEdit] = React.useState(todo?.allowAssigneeEdit || false)
  const [titleError, setTitleError] = React.useState(false)
  const [busy, setBusy] = React.useState(false)

  // 仅新建时可选择作用域/目标
  const scopeOptions: Todo["scope"][] = []
  if (data.canCreateAll) scopeOptions.push("all")
  if (data.leaderGroups.length) scopeOptions.push("group", "member")
  const [scope, setScope] = React.useState<Todo["scope"]>(todo?.scope || scopeOptions[0] || "all")
  const [groupId, setGroupId] = React.useState(todo?.groupId || data.leaderGroups[0]?.id || "")
  const [memberId, setMemberId] = React.useState(todo?.memberId || "")

  const isNew = !todo
  const scopeLabels: Record<Todo["scope"], string> = {
    all: t("ui.team.scope_option_all"),
    group: t("ui.team.scope_option_group"),
    member: t("ui.team.scope_option_member"),
  }
  const canToggleAllowEdit = isNew || !!todo?.canManage

  const save = async () => {
    if (!title.trim()) { setTitleError(true); return }
    if (isNew && scope === "group" && !groupId) { toast.error(t("ui.team.group_required")); return }
    if (isNew && scope === "member" && !memberId) { toast.error(t("ui.team.member_required")); return }
    setBusy(true)
    try {
      if (isNew) {
        await createTodo({
          title: title.trim(),
          note,
          priority,
          dueAt: dueAt || null,
          allowAssigneeEdit,
          scope,
          groupId: scope === "group" ? groupId : undefined,
          memberId: scope === "member" ? memberId : undefined,
        })
        toast.success(t("ui.team.created"))
      } else {
        await patchTodo(todo.id, {
          title: title.trim(),
          note,
          priority,
          dueAt: dueAt || null,
          ...(todo.canManage ? { allowAssigneeEdit } : {}),
        })
        toast.success(t("ui.common.saved"))
      }
      onSaved()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{isNew ? t("ui.team.new_todo") : t("ui.team.edit_todo")}</DialogTitle>
          <DialogDescription>
            {isNew
              ? t("ui.team.editor_new_desc")
              : t("ui.team.editor_edit_desc")}
          </DialogDescription>
        </DialogHeader>

        {/* 用原生滚动而不是嵌套 ScrollArea：对话框里再塞一个滚动容器
            会和外层抢滚动、在小屏上表现为内容被裁掉 */}
        <div className="-mx-1 max-h-[62dvh] overflow-y-auto px-1">
          <div className="flex flex-col gap-3.5 pb-1">
            {/* 内容：标题 + 备注 */}
            <div className="edge-highlight flex flex-col divide-y divide-border/60 rounded-xl border border-border bg-card px-4">
              <div className="flex flex-col gap-2 py-3.5">
                <FieldLabel htmlFor="todo-title" className="text-sm">{t("ui.team.field_title")}</FieldLabel>
                <Input
                  id="todo-title"
                  value={title}
                  autoFocus
                  aria-invalid={titleError ? true : undefined}
                  placeholder={t("ui.team.title_placeholder")}
                  onChange={(e) => { setTitle(e.target.value); if (titleError) setTitleError(false) }}
                />
                {titleError
                  ? <p role="alert" className="text-xs text-destructive">{t("ui.team.title_required")}</p>
                  : <p className="text-xs text-muted-foreground">{t("ui.team.title_hint")}</p>}
              </div>

              <div className="flex flex-col gap-2 py-3.5">
                <FieldLabel htmlFor="todo-note" className="text-sm">{t("ui.team.field_note")}</FieldLabel>
                <Textarea
                  id="todo-note"
                  rows={3}
                  className="resize-y"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder={t("ui.team.note_placeholder")}
                />
              </div>
            </div>

            {/* 安排 */}
            <div className="edge-highlight flex flex-col divide-y divide-border/60 rounded-xl border border-border bg-card px-4">
              <FormRow label={t("ui.team.field_priority")} hint={t("ui.team.priority_hint")}>
                <ToggleGroup
                  size="sm"
                  className="w-fit"
                  value={[priority]}
                  onValueChange={(v) => { const next = v[v.length - 1] as Todo["priority"] | undefined; if (next) setPriority(next) }}
                >
                  <ToggleGroupItem value="high">{t("ui.team.priority_high")}</ToggleGroupItem>
                  <ToggleGroupItem value="normal">{t("ui.team.priority_normal")}</ToggleGroupItem>
                  <ToggleGroupItem value="low">{t("ui.team.priority_low")}</ToggleGroupItem>
                </ToggleGroup>
              </FormRow>

              <FormRow label={t("ui.team.field_due")} htmlFor="todo-due" hint={t("ui.team.due_hint")}>
                {/* DatePicker 内部的按钮是 w-full，放进横向行里必须改回自适应宽度 */}
                <DatePicker
                  id="todo-due"
                  className="w-auto min-w-44"
                  value={dueAt || null}
                  onChange={(v) => setDueAt(v || "")}
                />
              </FormRow>
            </div>

            {/* 下发范围：仅新建时可选 */}
            {isNew && scopeOptions.length > 0 && (
              <div className="edge-highlight flex flex-col divide-y divide-border/60 rounded-xl border border-border bg-card px-4">
                <FormRow label={t("ui.team.field_scope")} hint={t("ui.team.scope_hint")}>
                  <ToggleGroup
                    size="sm"
                    className="w-fit flex-wrap"
                    value={[scope]}
                    onValueChange={(v) => { const next = v[v.length - 1] as Todo["scope"] | undefined; if (next) setScope(next) }}
                  >
                    {scopeOptions.includes("all") && <ToggleGroupItem value="all">{scopeLabels.all}</ToggleGroupItem>}
                    {scopeOptions.includes("group") && <ToggleGroupItem value="group">{scopeLabels.group}</ToggleGroupItem>}
                    {scopeOptions.includes("member") && <ToggleGroupItem value="member">{scopeLabels.member}</ToggleGroupItem>}
                  </ToggleGroup>
                </FormRow>

                {scope === "group" && (
                  <div className="flex flex-col gap-2 py-3.5">
                    <FieldLabel htmlFor="todo-group" className="text-sm">{t("ui.team.select_group")}</FieldLabel>
                    <Select value={groupId} onValueChange={(v) => setGroupId(v || "")}>
                      <SelectTrigger id="todo-group">
                        <SelectValue render={(_p, s) => <>{data.leaderGroups.find((g) => g.id === s.value)?.name || t("ui.team.select_group")}</>}>
                          {t("ui.team.select_group")}
                        </SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        {data.leaderGroups.map((g) => <SelectItem key={g.id} value={g.id}>{g.name}</SelectItem>)}
                      </SelectContent>
                    </Select>
                    <p className="text-xs text-muted-foreground">{t("ui.team.group_scope_hint")}</p>
                  </div>
                )}

                {scope === "member" && (
                  <div className="flex flex-col gap-2 py-3.5">
                    <FieldLabel htmlFor="todo-member" className="text-sm">{t("ui.team.select_member")}</FieldLabel>
                    <Select value={memberId} onValueChange={(v) => setMemberId(v || "")}>
                      <SelectTrigger id="todo-member">
                        <SelectValue render={(_p, s) => <>{data.members.find((m) => m.id === s.value)?.username || t("ui.team.select_member")}</>}>
                          {t("ui.team.select_member")}
                        </SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        {data.members.map((m) => <SelectItem key={m.id} value={m.id}>{m.username}</SelectItem>)}
                      </SelectContent>
                    </Select>
                    <p className="text-xs text-muted-foreground">{t("ui.team.member_scope_hint")}</p>
                  </div>
                )}
              </div>
            )}

            {/* 编辑权限 */}
            <div className="edge-highlight flex items-start gap-3 rounded-xl border border-border bg-card px-4 py-3.5">
              <Checkbox
                id="todo-allow-edit"
                className="mt-0.5"
                checked={allowAssigneeEdit}
                disabled={!canToggleAllowEdit}
                onCheckedChange={(v) => setAllowAssigneeEdit(!!v)}
              />
              <div className="flex min-w-0 flex-col gap-0.5">
                <FieldLabel htmlFor="todo-allow-edit" className={cn("text-sm", !canToggleAllowEdit && "opacity-60")}>
                  {t("ui.team.allow_assignee_edit")}
                </FieldLabel>
                <span className="text-xs text-muted-foreground">
                  {canToggleAllowEdit ? t("ui.team.allow_assignee_edit_on_hint") : t("ui.team.allow_assignee_edit_off_hint")}
                </span>
              </div>
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{t("ui.common.cancel")}</Button>
          <Button onClick={save} disabled={busy}>
            {busy && <Icon name="loader-2" className="animate-spin" data-icon="inline-start" />}
            {isNew ? t("ui.team.create_todo") : t("ui.team.save_changes")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
