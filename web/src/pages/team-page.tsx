import * as React from "react"
import { toast } from "sonner"
import { AppShell } from "@/components/layout/app-shell"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Checkbox } from "@/components/ui/checkbox"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Separator } from "@/components/ui/separator"
import { Avatar } from "@/components/avatar"
import { Icon } from "@/components/icon"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { DatePicker } from "@/components/ui/date-picker"
import { useAuth } from "@/state/auth"
import { SUPER_OWNER } from "@/lib/avatar-cache"
import { createTodo, deleteTodo, fetchTodos, patchTodo, setTodoDone, fetchLeaderGroups, addGroupMembers, patchLeaderGroup } from "@/lib/api"
import type { LeaderGroup, Member, Todo, TodosResponse } from "@/lib/types"
import { cn } from "@/lib/utils"
import { useNavigate } from "react-router-dom"

const SCOPE_LABEL: Record<Todo["scope"], string> = { all: "全体", group: "小组", member: "成员" }
const PRIORITY_LABEL: Record<Todo["priority"], string> = { high: "高", normal: "中", low: "低" }
const STATUS_FILTER_LABEL: Record<string, string> = { open: "进行中", done: "已完成", all: "全部" }
const SCOPE_FILTER_LABEL: Record<string, string> = { all: "全部范围", group: "小组", member: "成员" }

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

  const loadGroups = React.useCallback(() => {
    fetchLeaderGroups().then((d) => { setLedGroups(d.groups); setAllMembers(d.allMembers) }).catch(() => {})
  }, [])
  React.useEffect(() => {
    if (ready && me.role !== "guest") loadGroups()
  }, [ready, me.role, loadGroups])

  const load = React.useCallback(() => {
    fetchTodos({ status, scope, q }).then(setData).catch((e) => toast.error((e as Error).message))
  }, [status, scope, q])
  React.useEffect(() => {
    if (ready && me.role !== "guest") load()
  }, [ready, me.role, load])

  if (!ready) return <AppShell><div className="p-8 text-center text-sm text-muted-foreground">加载中…</div></AppShell>
  if (me.role === "guest") {
    return (
      <AppShell>
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
          <Icon name="clipboard-list" className="size-8 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">登录后可查看团队待办</p>
          <Button onClick={() => navigate("/login")}>去登录</Button>
        </div>
      </AppShell>
    )
  }

  const canCreate = !!data && (data.canCreateAll || data.leaderGroups.length > 0)
  const todos = data?.todos || []

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
      toast.success("已删除")
      setConfirmDelete(null)
      load()
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  return (
    <AppShell>
      <div className="flex flex-1 flex-col overflow-hidden">
        <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col overflow-hidden px-4 py-6 sm:px-6">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <div>
              <h1 className="font-heading text-2xl font-semibold tracking-tight">团队待办</h1>
              <p className="text-sm text-muted-foreground">超管与组长可下发任务，成员按指派推进</p>
            </div>
            {canCreate && (
              <Button size="sm" onClick={() => { setEditing(null); setEditorOpen(true) }}>
                <Icon name="plus" /> 新建待办
              </Button>
            )}
          </div>

          {ledGroups.length > 0 && (
            <LeaderPanel groups={ledGroups} allMembers={allMembers} onChanged={loadGroups} />
          )}

          <div className="mb-4 flex flex-wrap items-center gap-2">
            <Select value={status} onValueChange={(v) => setStatus(v || "open")}>
              <SelectTrigger className="w-28" size="sm"><SelectValue>{(v) => STATUS_FILTER_LABEL[v as string] || "进行中"}</SelectValue></SelectTrigger>
              <SelectContent>
                <SelectItem value="open">进行中</SelectItem>
                <SelectItem value="done">已完成</SelectItem>
                <SelectItem value="all">全部</SelectItem>
              </SelectContent>
            </Select>
            <Select value={scope} onValueChange={(v) => setScope(v || "all")}>
              <SelectTrigger className="w-28" size="sm"><SelectValue>{(v) => SCOPE_FILTER_LABEL[v as string] || "全部范围"}</SelectValue></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部范围</SelectItem>
                <SelectItem value="group">小组</SelectItem>
                <SelectItem value="member">成员</SelectItem>
              </SelectContent>
            </Select>
            <Input className="h-8 w-48 text-sm" placeholder="搜索待办…" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>

          <ScrollArea className="flex-1 rounded-xl border border-border bg-card">
            {todos.length === 0 ? (
              <div className="flex flex-col items-center justify-center gap-2 py-20 text-center text-sm text-muted-foreground">
                <Icon name="clipboard-check" className="size-6" />
                暂无待办
              </div>
            ) : (
              <div className="divide-y divide-border/50">
                {todos.map((todo) => {
                  const ds = dueState(todo)
                  return (
                    <div key={todo.id} className={cn("flex items-start gap-3 p-3 transition-colors hover:bg-muted/30", todo.done && "opacity-60")}>
                      <Checkbox className="mt-1" checked={todo.done} onCheckedChange={() => toggleDone(todo)} />
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className={cn("text-sm font-medium", todo.done && "line-through")}>{todo.title}</span>
                          <Badge variant={todo.priority === "high" ? "destructive" : "secondary"} className="text-[10px]">
                            {PRIORITY_LABEL[todo.priority]}
                          </Badge>
                          <Badge variant="outline" className="text-[10px]">
                            {SCOPE_LABEL[todo.scope]}{todo.groupName ? `·${todo.groupName}` : ""}{todo.memberName ? `·${todo.memberName}` : ""}
                          </Badge>
                          {todo.dueAt && (
                            <span className={cn("text-[11px]", ds === "overdue" ? "text-destructive" : ds === "today" ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground")}>
                              <Icon name="clock" className="mr-0.5 inline size-3" />
                              {formatDue(todo.dueAt)}
                            </span>
                          )}
                        </div>
                        {todo.note && <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{todo.note}</p>}
                        <div className="mt-1.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                          <Avatar owner={todo.createdById ? `u-${todo.createdById}` : todo.createdByRole === "superadmin" ? SUPER_OWNER : null} name={todo.createdBy} size={16} />
                          <span>{todo.createdBy || "未知"}</span>
                          {todo.done && todo.doneBy && <span>· 由 {todo.doneBy} 完成</span>}
                        </div>
                      </div>
                      {(todo.canEdit || todo.canComplete || todo.canManage) && (
                        <DropdownMenu>
                          <DropdownMenuTrigger render={<Button size="icon-xs" variant="ghost" />}>
                            <Icon name="ellipsis-vertical" className="size-3.5" />
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            {todo.canEdit && (
                              <DropdownMenuItem onClick={() => { setEditing(todo); setEditorOpen(true) }}>
                                <Icon name="pencil-line" /> 编辑
                              </DropdownMenuItem>
                            )}
                            <DropdownMenuItem onClick={() => toggleDone(todo)}>
                              <Icon name={todo.done ? "undo-2" : "check"} /> {todo.done ? "标记未完成" : "标记完成"}
                            </DropdownMenuItem>
                            {todo.canManage && (
                              <DropdownMenuItem variant="destructive" onClick={() => setConfirmDelete(todo)}>
                                <Icon name="trash-2" /> 删除
                              </DropdownMenuItem>
                            )}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </ScrollArea>
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
            <AlertDialogTitle>删除这条待办？</AlertDialogTitle>
            <AlertDialogDescription>删除后不可恢复。</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction className="bg-destructive/10 text-destructive hover:bg-destructive/20" onClick={(e) => { e.preventDefault(); doDelete() }}>删除</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </AppShell>
  )
}

function LeaderPanel({ groups, allMembers, onChanged }: { groups: LeaderGroup[]; allMembers: Member[]; onChanged: () => void }) {
  const [open, setOpen] = React.useState(false)
  return (
    <div className="mb-4 rounded-xl border border-border bg-card">
      <button className="flex w-full items-center justify-between p-3" onClick={() => setOpen(!open)}>
        <span className="flex items-center gap-2 text-sm font-medium"><Icon name="layers" className="size-4" /> 我管理的小组（{groups.length}）</span>
        <Icon name={open ? "chevron-up" : "chevron-down"} className="size-4 text-muted-foreground" />
      </button>
      {open && (
        <div className="grid gap-3 border-t border-border p-3">
          {groups.map((g) => <LeaderGroupCard key={g.id} group={g} allMembers={allMembers} onChanged={onChanged} />)}
        </div>
      )}
    </div>
  )
}

function LeaderGroupCard({ group, allMembers, onChanged }: { group: LeaderGroup; allMembers: Member[]; onChanged: () => void }) {
  const [white, setWhite] = React.useState(group.whitelist.join("\n"))
  const [black, setBlack] = React.useState(group.blacklist.join("\n"))
  const [adding, setAdding] = React.useState("")
  const [busy, setBusy] = React.useState(false)

  const memberIds = new Set(group.members.map((m) => m.id))
  const candidates = allMembers.filter((m) => !m.disabled && !memberIds.has(m.id))

  const add = async (id: string) => {
    if (!id) return
    setBusy(true)
    try {
      await addGroupMembers(group.id, [id], "add")
      setAdding("")
      onChanged()
    } catch (e) { toast.error((e as Error).message) } finally { setBusy(false) }
  }
  const remove = async (id: string) => {
    setBusy(true)
    try {
      await addGroupMembers(group.id, [id], "remove")
      onChanged()
    } catch (e) { toast.error((e as Error).message) } finally { setBusy(false) }
  }
  const saveVisibility = async () => {
    setBusy(true)
    try {
      await patchLeaderGroup(group.id, {
        whitelist: white.split("\n").map((l) => l.trim()).filter(Boolean),
        blacklist: black.split("\n").map((l) => l.trim()).filter(Boolean),
      })
      toast.success("可见范围已保存")
      onChanged()
    } catch (e) { toast.error((e as Error).message) } finally { setBusy(false) }
  }

  return (
    <div className="rounded-lg border border-border p-3">
      <div className="mb-2 flex items-center gap-2">
        <span className="inline-block size-2.5 rounded-full" style={{ background: group.color }} />
        <span className="text-sm font-medium">{group.name}</span>
        <Badge variant="secondary" className="text-[10px]">{group.memberCount} 成员</Badge>
      </div>
      {group.canViewMembers && (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {group.members.map((m) => (
            <span key={m.id} className="flex items-center gap-1 rounded-full border border-border py-0.5 pr-1 pl-0.5 text-xs">
              <Avatar owner={`u-${m.id}`} name={m.username} size={18} />
              {m.username}
              {group.canManageMembers && (
                <button className="rounded-full p-0.5 text-muted-foreground hover:text-destructive" disabled={busy} onClick={() => remove(m.id)}>
                  <Icon name="x" className="size-3" />
                </button>
              )}
            </span>
          ))}
          {group.members.length === 0 && <span className="text-xs text-muted-foreground">暂无成员</span>}
        </div>
      )}
      {group.canManageMembers && (
        <>
          <Select value={adding || null} onValueChange={(v) => add(v || "")}>
            <SelectTrigger className="mb-2 h-8 w-full text-xs"><SelectValue placeholder="添加成员…" /></SelectTrigger>
            <SelectContent>
              {candidates.map((m) => <SelectItem key={m.id} value={m.id}>{m.username}</SelectItem>)}
            </SelectContent>
          </Select>
          <div className="grid gap-2 sm:grid-cols-2">
            <div className="grid gap-1">
              <Label className="text-[11px] text-muted-foreground">可见白名单（留空不限）</Label>
              <Textarea rows={3} className="font-mono text-xs" value={white} onChange={(e) => setWhite(e.target.value)} />
            </div>
            <div className="grid gap-1">
              <Label className="text-[11px] text-muted-foreground">隐藏黑名单（优先）</Label>
              <Textarea rows={3} className="font-mono text-xs" value={black} onChange={(e) => setBlack(e.target.value)} />
            </div>
          </div>
          <Button size="sm" className="mt-2" disabled={busy} onClick={saveVisibility}>保存可见范围</Button>
        </>
      )}
    </div>
  )
}

function TodoEditor({ todo, data, onClose, onSaved }: {
  todo: Todo | null
  data: TodosResponse
  onClose: () => void
  onSaved: () => void
}) {
  const [title, setTitle] = React.useState(todo?.title || "")
  const [note, setNote] = React.useState(todo?.note || "")
  const [priority, setPriority] = React.useState(todo?.priority || "normal")
  const [dueAt, setDueAt] = React.useState(todo?.dueAt ? todo.dueAt.slice(0, 10) : "")
  const [allowAssigneeEdit, setAllowAssigneeEdit] = React.useState(todo?.allowAssigneeEdit || false)
  const [busy, setBusy] = React.useState(false)

  // 仅新建时可选择作用域/目标
  const scopeOptions: Todo["scope"][] = []
  if (data.canCreateAll) scopeOptions.push("all")
  if (data.leaderGroups.length) scopeOptions.push("group", "member")
  const [scope, setScope] = React.useState<Todo["scope"]>(todo?.scope || scopeOptions[0] || "all")
  const [groupId, setGroupId] = React.useState(todo?.groupId || data.leaderGroups[0]?.id || "")
  const [memberId, setMemberId] = React.useState(todo?.memberId || "")

  const isNew = !todo

  const save = async () => {
    if (!title.trim()) { toast.error("请输入标题"); return }
    if (isNew && scope === "group" && !groupId) { toast.error("请选择小组"); return }
    if (isNew && scope === "member" && !memberId) { toast.error("请选择成员"); return }
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
        toast.success("已创建")
      } else {
        await patchTodo(todo.id, {
          title: title.trim(),
          note,
          priority,
          dueAt: dueAt || null,
          ...(todo.canManage ? { allowAssigneeEdit } : {}),
        })
        toast.success("已保存")
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
      <DialogContent>
        <DialogHeader><DialogTitle>{isNew ? "新建待办" : "编辑待办"}</DialogTitle></DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="todo-title">标题</Label>
            <Input id="todo-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="要做什么？" />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="todo-note">备注</Label>
            <Textarea id="todo-note" rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder="补充说明（可选）" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label>优先级</Label>
              <Select value={priority} onValueChange={(v) => setPriority((v as Todo["priority"]) || "normal")}>
                <SelectTrigger><SelectValue render={(_p, s) => <>{PRIORITY_LABEL[s.value as Todo["priority"]] || "中"}</>}>中</SelectValue></SelectTrigger>
                <SelectContent>
                  <SelectItem value="high">高</SelectItem>
                  <SelectItem value="normal">中</SelectItem>
                  <SelectItem value="low">低</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="todo-due">截止日期</Label>
              <DatePicker id="todo-due" value={dueAt || null} onChange={(v) => setDueAt(v || "")} />
            </div>
          </div>

          {isNew && scopeOptions.length > 0 && (
            <>
              <Separator />
              <div className="grid gap-1.5">
                <Label>下发范围</Label>
                <Select value={scope} onValueChange={(v) => setScope((v as Todo["scope"]) || "all")}>
                  <SelectTrigger><SelectValue render={(_p, s) => <>{SCOPE_LABEL[s.value as Todo["scope"]]}</>} /></SelectTrigger>
                  <SelectContent>
                    {scopeOptions.includes("all") && <SelectItem value="all">全体成员</SelectItem>}
                    {scopeOptions.includes("group") && <SelectItem value="group">指定小组</SelectItem>}
                    {scopeOptions.includes("member") && <SelectItem value="member">指定成员</SelectItem>}
                  </SelectContent>
                </Select>
              </div>
              {scope === "group" && (
                <Select value={groupId} onValueChange={(v) => setGroupId(v || "")}>
                  <SelectTrigger><SelectValue render={(_p, s) => <>{data.leaderGroups.find((g) => g.id === s.value)?.name || "选择小组"}</>}>选择小组</SelectValue></SelectTrigger>
                  <SelectContent>
                    {data.leaderGroups.map((g) => <SelectItem key={g.id} value={g.id}>{g.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              )}
              {scope === "member" && (
                <Select value={memberId} onValueChange={(v) => setMemberId(v || "")}>
                  <SelectTrigger><SelectValue render={(_p, s) => <>{data.members.find((m) => m.id === s.value)?.username || "选择成员"}</>}>选择成员</SelectValue></SelectTrigger>
                  <SelectContent>
                    {data.members.map((m) => <SelectItem key={m.id} value={m.id}>{m.username}</SelectItem>)}
                  </SelectContent>
                </Select>
              )}
            </>
          )}

          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={allowAssigneeEdit} onCheckedChange={(v) => setAllowAssigneeEdit(!!v)} />
            允许被指派成员编辑内容
          </label>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>取消</Button>
          <Button onClick={save} disabled={busy}>{busy && <Icon name="loader-2" className="animate-spin" />} 保存</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
