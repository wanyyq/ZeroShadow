import * as React from "react"
import { toast } from "sonner"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Badge } from "@/components/ui/badge"
import { Textarea } from "@/components/ui/textarea"
import { Separator } from "@/components/ui/separator"
import { ColorPicker } from "@/components/ui/color-picker"
import { Avatar } from "@/components/avatar"
import { Icon } from "@/components/icon"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog"
import { createGroup, deleteGroup, fetchAdminGroups, updateGroup } from "@/lib/api"
import type { Group, Member } from "@/lib/types"
import { cn } from "@/lib/utils"

const PERM_ITEMS: [string, string][] = [
  ["fileWrite", "文件操作总开关"],
  ["browse", "浏览目录"],
  ["upload", "上传文件"],
  ["uploadFolders", "上传文件夹"],
  ["downloadFile", "下载文件"],
  ["downloadFolder", "下载文件夹"],
  ["preview", "允许预览"],
  ["copy", "复制"],
  ["move", "移动"],
  ["rename", "重命名"],
  ["delete", "删除"],
  ["mkdir", "新建文件夹"],
  ["manageGuestVisibility", "管理访客可见性"],
  ["htmlPreview", "HTML 全屏预览"],
  ["editFiles", "在线编辑"],
  ["compressZip", "压缩 Zip"],
  ["extractZip", "解压 Zip"],
  ["downloadUrl", "多线程下载器"],
  ["changePassword", "修改密码"],
]

const CAP_ITEMS: [string, string][] = [
  ["viewMembers", "查看本组成员名单"],
  ["manageTodo", "创建/编辑本组 Todo"],
  ["editMemberAvatar", "修改本组成员头像"],
  ["manageMembers", "管理本组成员与可见范围"],
]

interface GroupsData {
  groups: Group[]
  members: Member[]
}

export function GroupsSection() {
  const [data, setData] = React.useState<GroupsData | null>(null)
  const [editing, setEditing] = React.useState<Group | null>(null)
  const [creating, setCreating] = React.useState(false)
  const [confirmDelete, setConfirmDelete] = React.useState<Group | null>(null)

  const load = React.useCallback(() => {
    fetchAdminGroups()
      .then((d) => setData({ groups: d.groups, members: d.members }))
      .catch((e) => toast.error((e as Error).message))
  }, [])
  React.useEffect(load, [load])

  const doDelete = async () => {
    if (!confirmDelete) return
    try {
      await deleteGroup(confirmDelete.id)
      toast.success("小组已删除")
      setConfirmDelete(null)
      load()
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  if (!data) return <p className="py-8 text-center text-sm text-muted-foreground">加载中…</p>

  return (
    <Card className="edge-highlight">
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div className="space-y-1">
            <CardTitle>小组管理</CardTitle>
            <CardDescription>成员可属于多个小组；顶栏切换小组后，文件可见范围、权限与待办随之收窄</CardDescription>
          </div>
          <Button size="sm" onClick={() => setCreating(true)}><Icon name="plus" /> 新建小组</Button>
        </div>
      </CardHeader>
      <CardContent>
        {data.groups.length === 0 ? (
          <p className="py-10 text-center text-sm text-muted-foreground">还没有小组，点击右上角「新建小组」开始</p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {data.groups.map((g) => (
              <div key={g.id} className="flex flex-col gap-2 rounded-xl border border-border bg-card p-3 shadow-xs">
                <div className="flex items-center gap-2">
                  <span className="size-3 shrink-0 rounded-full" style={{ background: g.color }} />
                  <span className="truncate text-sm font-medium">{g.name}</span>
                  <div className="ml-auto flex shrink-0 gap-1">
                    <Button size="icon-xs" variant="ghost" onClick={() => setEditing(g)} title="编辑"><Icon name="pencil-line" className="size-3.5" /></Button>
                    <Button size="icon-xs" variant="ghost" className="text-destructive" onClick={() => setConfirmDelete(g)} title="删除"><Icon name="trash-2" className="size-3.5" /></Button>
                  </div>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  <Badge variant="secondary" className="text-[10px]">{g.members.length} 成员</Badge>
                  <Badge variant="outline" className="text-[10px]">{g.leaders.length} 组长</Badge>
                  <Badge variant="outline" className="text-[10px]">
                    {g.whitelist.length ? `白名单 ${g.whitelist.length}` : "可见不限"}
                  </Badge>
                  {g.blacklist.length > 0 && <Badge variant="outline" className="text-[10px]">黑名单 {g.blacklist.length}</Badge>}
                </div>
                <p className="line-clamp-1 text-xs text-muted-foreground">
                  {g.members.length
                    ? data.members.filter((m) => g.members.includes(m.id)).map((m) => m.username).join("、")
                    : "暂无成员"}
                </p>
              </div>
            ))}
          </div>
        )}
      </CardContent>

      {(creating || editing) && (
        <GroupEditor
          group={editing}
          members={data.members}
          onClose={() => { setCreating(false); setEditing(null) }}
          onSaved={() => { setCreating(false); setEditing(null); load() }}
        />
      )}

      <AlertDialog open={confirmDelete !== null} onOpenChange={(o) => !o && setConfirmDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除小组「{confirmDelete?.name}」？</AlertDialogTitle>
            <AlertDialogDescription>小组成员关系与可见范围将一并删除，该小组的待办会转为全体可见。</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction className="bg-destructive/10 text-destructive hover:bg-destructive/20" onClick={(e) => { e.preventDefault(); doDelete() }}>删除</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  )
}

function SectionTitle({ children, hint }: { children: React.ReactNode; hint?: string }) {
  return (
    <div className="space-y-0.5">
      <h4 className="text-sm font-medium">{children}</h4>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  )
}

function linesToList(text: string): string[] {
  return text.split("\n").map((l) => l.trim()).filter(Boolean)
}

function GroupEditor({ group, members, onClose, onSaved }: {
  group: Group | null
  members: Member[]
  onClose: () => void
  onSaved: () => void
}) {
  const isNew = !group
  const [name, setName] = React.useState(group?.name || "")
  const [color, setColor] = React.useState(group?.color || "#5b8def")
  const [memberIds, setMemberIds] = React.useState<Set<string>>(new Set(group?.members || []))
  const [leaderIds, setLeaderIds] = React.useState<Set<string>>(new Set(group?.leaders || []))
  const [perms, setPerms] = React.useState<Record<string, boolean>>(group?.perms || Object.fromEntries(PERM_ITEMS.map(([k]) => [k, true])))
  const [leaderCaps, setLeaderCaps] = React.useState(group?.leaderCaps || { viewMembers: true, manageTodo: true, editMemberAvatar: false, manageMembers: false })
  const [whitelist, setWhitelist] = React.useState((group?.whitelist || []).join("\n"))
  const [blacklist, setBlacklist] = React.useState((group?.blacklist || []).join("\n"))
  const [memberQuery, setMemberQuery] = React.useState("")
  const [showPerms, setShowPerms] = React.useState(false)
  const [busy, setBusy] = React.useState(false)

  const toggleMember = (id: string) => {
    setMemberIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
        setLeaderIds((l) => { const n = new Set(l); n.delete(id); return n })
      } else next.add(id)
      return next
    })
  }

  const toggleLeader = (id: string) => {
    if (!memberIds.has(id)) return
    setLeaderIds((prev) => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next })
  }

  const save = async () => {
    if (!name.trim()) { toast.error("请输入小组名称"); return }
    setBusy(true)
    try {
      const payload = {
        name: name.trim(),
        color,
        members: [...memberIds],
        leaders: [...leaderIds],
        perms,
        leaderCaps,
        whitelist: linesToList(whitelist),
        blacklist: linesToList(blacklist),
      }
      if (isNew) await createGroup(payload)
      else await updateGroup(group.id, payload)
      toast.success(isNew ? "小组已创建" : "小组已保存")
      onSaved()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const filtered = members.filter((m) => m.username.toLowerCase().includes(memberQuery.toLowerCase()))

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader><DialogTitle>{isNew ? "新建小组" : `编辑小组 · ${group.name}`}</DialogTitle></DialogHeader>

        {/* 内容区：固定最大高度并自身滚动，保证底部按钮始终可见 */}
        <div className="-mr-2 max-h-[56vh] space-y-6 overflow-y-auto pr-2">
          {/* 基本信息 */}
          <section className="space-y-2">
            <SectionTitle>基本信息</SectionTitle>
            <div className="grid grid-cols-[1fr_auto] items-end gap-3">
              <div className="grid gap-1.5">
                <Label htmlFor="g-name">小组名称</Label>
                <Input id="g-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="如：设计组" />
              </div>
              <div className="grid gap-1.5">
                <Label>颜色</Label>
                <ColorPicker value={color} onChange={setColor} />
              </div>
            </div>
          </section>

          <Separator />

          {/* 成员与组长 */}
          <section className="space-y-2">
            <div className="flex items-end justify-between gap-3">
              <SectionTitle hint={`已选 ${memberIds.size} 名成员、${leaderIds.size} 名组长`}>成员与组长</SectionTitle>
              <Input className="h-8 w-40 text-xs" placeholder="搜索成员…" value={memberQuery} onChange={(e) => setMemberQuery(e.target.value)} />
            </div>
            <div className="max-h-52 overflow-y-auto rounded-lg border border-border p-1">
              {filtered.length === 0 && <p className="p-3 text-center text-xs text-muted-foreground">没有成员</p>}
              {filtered.map((m) => {
                const isMem = memberIds.has(m.id)
                const isLead = leaderIds.has(m.id)
                return (
                  <div key={m.id} className={cn("flex items-center gap-2 rounded-md px-2 py-1", isMem ? "bg-accent/60" : "hover:bg-muted/50")}>
                    <button type="button" className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={() => toggleMember(m.id)}>
                      <span className={cn("flex size-4 shrink-0 items-center justify-center rounded border transition-colors", isMem ? "border-primary bg-primary text-primary-foreground" : "border-input")}>
                        {isMem && <Icon name="check" className="size-3" />}
                      </span>
                      <Avatar owner={`u-${m.id}`} name={m.username} size={20} />
                      <span className="truncate text-sm">{m.username}</span>
                      {m.disabled && <Badge variant="secondary" className="text-[10px]">禁用</Badge>}
                    </button>
                    {isMem && (
                      <button
                        type="button"
                        onClick={() => toggleLeader(m.id)}
                        className={cn(
                          "shrink-0 rounded-full px-2 py-0.5 text-[11px] transition-colors",
                          isLead ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:text-foreground"
                        )}
                      >
                        组长
                      </button>
                    )}
                  </div>
                )
              })}
            </div>
          </section>

          <Separator />

          {/* 可见范围 */}
          <section className="space-y-2">
            <SectionTitle hint="白名单留空表示不限制；黑名单优先级更高">可见范围</SectionTitle>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="grid gap-1.5">
                <span className="text-xs text-muted-foreground">白名单（每行一个目录）</span>
                <Textarea className="h-24 resize-none font-mono text-xs" placeholder={"项目A\n公共资料"} value={whitelist} onChange={(e) => setWhitelist(e.target.value)} />
              </div>
              <div className="grid gap-1.5">
                <span className="text-xs text-muted-foreground">黑名单（每行一个目录）</span>
                <Textarea className="h-24 resize-none font-mono text-xs" placeholder={"机密"} value={blacklist} onChange={(e) => setBlacklist(e.target.value)} />
              </div>
            </div>
          </section>

          <Separator />

          {/* 组长权限 */}
          <section className="space-y-2">
            <SectionTitle hint="控制组长在该小组内可以做什么">组长权限</SectionTitle>
            <div className="grid gap-1.5">
              {CAP_ITEMS.map(([key, label]) => (
                <div key={key} className="flex items-center justify-between rounded-lg bg-muted/40 px-3 py-2">
                  <span className="text-sm">{label}</span>
                  <Switch
                    checked={!!leaderCaps[key as keyof typeof leaderCaps]}
                    onCheckedChange={(v) => setLeaderCaps((prev) => ({ ...prev, [key]: !!v }))}
                  />
                </div>
              ))}
            </div>
          </section>

          <Separator />

          {/* 高级：权限收窄 */}
          <section className="space-y-2">
            <button type="button" className="flex w-full items-center justify-between gap-3" onClick={() => setShowPerms((s) => !s)}>
              <SectionTitle hint="仅能在全局成员权限基础上收窄，不可放宽">高级 · 小组权限</SectionTitle>
              <Icon name={showPerms ? "chevron-up" : "chevron-down"} className="size-4 shrink-0 text-muted-foreground" />
            </button>
            {showPerms && (
              <div className="grid gap-0.5 sm:grid-cols-2">
                {PERM_ITEMS.map(([key, label]) => (
                  <div key={key} className="flex items-center justify-between gap-3 rounded-md px-3 py-1.5 hover:bg-muted/40">
                    <span className="truncate text-sm">{label}</span>
                    <Switch checked={perms[key] !== false} onCheckedChange={(v) => setPerms((prev) => ({ ...prev, [key]: !!v }))} />
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>取消</Button>
          <Button onClick={save} disabled={busy}>{busy && <Icon name="loader-2" className="animate-spin" />} 保存</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
