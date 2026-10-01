import * as React from "react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { ColorPicker } from "@/components/ui/color-picker"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from "@/components/ui/context-menu"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Field, FieldDescription, FieldGroup, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Separator } from "@/components/ui/separator"
import { Switch } from "@/components/ui/switch"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import { Avatar } from "@/components/avatar"
import { Icon } from "@/components/icon"
import { createGroup, deleteGroup, fetchAdminGroups, updateGroup } from "@/lib/api"
import { useGroups } from "@/state/groups"
import type { Group, Member } from "@/lib/types"
import { cn } from "@/lib/utils"

// 权限按语义分组；键名与顺序对齐 server/src/config.js 的 MEMBER_PERM_KEYS。
// fileWrite 是写操作总开关（服务端 effectivePerms 用 `fw && p.x` 合成），
// 所以它关闭时下列写类子开关在界面上同步置灰，避免「看着开着其实不生效」。
const WRITE_PERM_KEYS = ["upload", "uploadFolders", "mkdir", "copy", "move", "rename", "delete"]

const PERM_GROUPS: { title: string; hint?: string; items: [string, string][] }[] = [
  {
    title: "文件操作",
    hint: "「文件操作总开关」关闭时，本组写类权限全部失效。",
    items: [
      ["fileWrite", "文件操作总开关"],
      ["upload", "上传文件"],
      ["uploadFolders", "上传文件夹"],
      ["mkdir", "新建文件夹"],
      ["copy", "复制"],
      ["move", "移动"],
      ["rename", "重命名"],
      ["delete", "删除"],
    ],
  },
  {
    title: "浏览、下载与预览",
    items: [
      ["browse", "浏览目录"],
      ["downloadFile", "下载文件"],
      ["downloadFolder", "下载文件夹（打包）"],
      ["preview", "允许预览"],
    ],
  },
  {
    title: "高级功能",
    items: [
      ["compressZip", "压缩 Zip"],
      ["extractZip", "解压 Zip"],
      ["downloadUrl", "多线程下载器"],
      ["htmlPreview", "HTML 全屏预览"],
      ["editFiles", "在线编辑"],
    ],
  },
  {
    title: "管理与账户",
    items: [
      ["manageGuestVisibility", "管理访客可见性"],
      ["changePassword", "修改密码"],
    ],
  },
]

const CAP_ITEMS: [string, string][] = [
  ["viewMembers", "查看本组成员名单"],
  ["manageTodo", "创建 / 编辑本组待办"],
  ["editMemberAvatar", "修改本组成员头像"],
  ["manageMembers", "管理本组成员与可见范围"],
]

interface GroupsData {
  groups: Group[]
  members: Member[]
}

/** 复制纯文本并给出反馈 */
function copyText(text: string, okMsg: string) {
  void navigator.clipboard?.writeText(text).then(
    () => toast.success(okMsg),
    () => toast.error("复制失败，请手动选择文本")
  )
}

export function GroupsSection() {
  const [data, setData] = React.useState<GroupsData | null>(null)
  const [editing, setEditing] = React.useState<Group | null>(null)
  const [creating, setCreating] = React.useState(false)
  const [confirmDelete, setConfirmDelete] = React.useState<Group | null>(null)
  // 顶栏的「身份切换」列表由 GroupsProvider 持有；这里增删改之后必须让它重拉，
  // 否则新小组要刷新整页才会出现在顶栏下拉里。
  const { refresh: refreshGroupContext } = useGroups()

  const load = React.useCallback(() => {
    fetchAdminGroups()
      .then((d) => setData({ groups: d.groups, members: d.members }))
      .catch((e) => toast.error((e as Error).message))
    void refreshGroupContext()
  }, [refreshGroupContext])
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
          <div className="flex flex-col gap-1">
            <CardTitle>小组管理</CardTitle>
            <CardDescription>成员可属于多个小组；顶栏切换小组后，文件可见范围、权限与待办随之收窄</CardDescription>
          </div>
          <Button size="sm" onClick={() => setCreating(true)}>
            <Icon name="plus" data-icon="inline-start" /> 新建小组
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {data.groups.length === 0 ? (
          <Empty className="border">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <Icon name="layers" />
              </EmptyMedia>
              <EmptyTitle>还没有小组</EmptyTitle>
              <EmptyDescription>点击右上角「新建小组」，为不同团队划分可见范围与权限</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {data.groups.map((g) => (
              <GroupCard
                key={g.id}
                group={g}
                members={data.members}
                onEdit={() => setEditing(g)}
                onDelete={() => setConfirmDelete(g)}
              />
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

/** 列表里的单个小组：一行标题 + 一行统计 + 溢出菜单，尽量减少视觉噪音 */
function GroupCard({ group, members, onEdit, onDelete }: {
  group: Group
  members: Member[]
  onEdit: () => void
  onDelete: () => void
}) {
  const names = members.filter((m) => group.members.includes(m.id)).map((m) => m.username)

  return (
    <ContextMenu>
      <ContextMenuTrigger render={<div />}>
        <div className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4">
      <div className="flex items-center gap-2.5">
        <span className="size-2.5 shrink-0 rounded-full" style={{ background: group.color }} aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate font-medium">{group.name}</span>
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button size="icon-xs" variant="ghost" aria-label={`${group.name} 的操作`} />}>
            <Icon name="ellipsis-vertical" className="size-3.5" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={onEdit}>
              <Icon name="pencil-line" /> 编辑小组
            </DropdownMenuItem>
            <DropdownMenuItem variant="destructive" onClick={onDelete}>
              <Icon name="trash-2" /> 删除
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span className="flex items-center gap-1"><Icon name="users" className="size-3.5" />{group.members.length} 成员</span>
        <span className="flex items-center gap-1"><Icon name="crown" className="size-3.5" />{group.leaders.length} 组长</span>
        <span className="flex items-center gap-1">
          <Icon name={group.whitelist.length ? "filter" : "infinity"} className="size-3.5" />
          {group.whitelist.length ? `白名单 ${group.whitelist.length}` : "可见不限"}
          {group.blacklist.length > 0 ? ` · 隐藏 ${group.blacklist.length}` : ""}
        </span>
      </div>

      <p className="line-clamp-1 text-xs text-muted-foreground">
        {names.length ? names.join("、") : "暂无成员"}
      </p>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-52">
        <ContextMenuItem onClick={onEdit}>
          <Icon name="pencil-line" /> 编辑小组
        </ContextMenuItem>
        <ContextMenuItem onClick={() => copyText(group.name, "已复制小组名")}>
          <Icon name="clipboard-copy" /> 复制小组名
        </ContextMenuItem>
        {group.members.length > 0 && (
          <ContextMenuItem onClick={() => copyText(names.join("、"), "已复制成员名单")}>
            <Icon name="users" /> 复制成员名单
          </ContextMenuItem>
        )}
        <ContextMenuSeparator />
        <ContextMenuItem variant="destructive" onClick={onDelete}>
          <Icon name="trash-2" /> 删除
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
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
  const [tab, setTab] = React.useState("basic")
  const [name, setName] = React.useState(group?.name || "")
  const [color, setColor] = React.useState(group?.color || "#5b8def")
  const [memberIds, setMemberIds] = React.useState<Set<string>>(new Set(group?.members || []))
  const [leaderIds, setLeaderIds] = React.useState<Set<string>>(new Set(group?.leaders || []))
  const [perms, setPerms] = React.useState<Record<string, boolean>>(
    group?.perms || Object.fromEntries(PERM_GROUPS.flatMap((g) => g.items).map(([k]) => [k, true]))
  )
  const [leaderCaps, setLeaderCaps] = React.useState(
    group?.leaderCaps || { viewMembers: true, manageTodo: true, editMemberAvatar: false, manageMembers: false }
  )
  const [whitelist, setWhitelist] = React.useState((group?.whitelist || []).join("\n"))
  const [blacklist, setBlacklist] = React.useState((group?.blacklist || []).join("\n"))
  const [memberQuery, setMemberQuery] = React.useState("")
  const [nameError, setNameError] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState(false)

  const fileWriteOn = perms.fileWrite !== false

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
    if (!name.trim()) {
      setNameError("请输入小组名称")
      setTab("basic")
      return
    }
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

  const filtered = members.filter((m) => m.username.toLowerCase().includes(memberQuery.trim().toLowerCase()))
  const whiteCount = linesToList(whitelist).length
  const blackCount = linesToList(blacklist).length

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{isNew ? "新建小组" : `编辑小组 · ${group.name}`}</DialogTitle>
          <DialogDescription>
            小组只做「收窄」：可见范围与权限都只能在超管设定的全局范围内收紧，不会放宽。
          </DialogDescription>
        </DialogHeader>

        <Tabs value={tab} onValueChange={setTab}>
          <TabsList className="w-full">
            <TabsTrigger value="basic">基本</TabsTrigger>
            <TabsTrigger value="members">
              成员
              {memberIds.size > 0 && <Badge variant="secondary" className="px-1 text-[10px]">{memberIds.size}</Badge>}
            </TabsTrigger>
            <TabsTrigger value="scope">
              可见范围
              {(whiteCount > 0 || blackCount > 0) && (
                <Badge variant="secondary" className="px-1 text-[10px]">{whiteCount + blackCount}</Badge>
              )}
            </TabsTrigger>
            <TabsTrigger value="perms">权限</TabsTrigger>
          </TabsList>

          {/* 基本信息 */}
          <TabsContent value="basic">
            <ScrollArea className="h-[46vh] pr-3">
              <FieldGroup className="gap-6 py-1">
                <Field data-invalid={nameError ? true : undefined}>
                  <FieldLabel htmlFor="g-name">小组名称</FieldLabel>
                  <Input
                    id="g-name"
                    value={name}
                    aria-invalid={nameError ? true : undefined}
                    placeholder="如：设计组"
                    onChange={(e) => { setName(e.target.value); if (nameError) setNameError(null) }}
                  />
                  {nameError ? (
                    <p role="alert" className="text-sm font-normal text-destructive">{nameError}</p>
                  ) : (
                    <FieldDescription>最多 40 个字符，支持中英文、数字、空格与 _ . -</FieldDescription>
                  )}
                </Field>

                <Field orientation="horizontal">
                  <FieldLabel>小组颜色</FieldLabel>
                  <ColorPicker value={color} onChange={setColor} />
                </Field>

                <Separator />

                <FieldSet>
                  <FieldLegend variant="label">组长权限</FieldLegend>
                  <FieldDescription className="mb-3">
                    超管可下放给组长；未勾选的能力，组长在该小组内无法使用。
                  </FieldDescription>
                  <div className="grid gap-1">
                    {CAP_ITEMS.map(([key, label]) => (
                      <Field key={key} orientation="horizontal" className="rounded-lg bg-muted/40 px-3 py-2">
                        <FieldLabel htmlFor={`cap-${key}`} className="flex-auto font-normal">{label}</FieldLabel>
                        <Switch
                          id={`cap-${key}`}
                          checked={!!leaderCaps[key as keyof typeof leaderCaps]}
                          onCheckedChange={(v) => setLeaderCaps((prev) => ({ ...prev, [key]: !!v }))}
                        />
                      </Field>
                    ))}
                  </div>
                </FieldSet>
              </FieldGroup>
            </ScrollArea>
          </TabsContent>

          {/* 成员与组长 */}
          <TabsContent value="members">
            <div className="flex h-[46vh] flex-col gap-3 py-1">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                <InputGroup className="sm:max-w-xs">
                  <InputGroupAddon>
                    <Icon name="search" />
                  </InputGroupAddon>
                  <InputGroupInput
                    placeholder="搜索成员…"
                    value={memberQuery}
                    onChange={(e) => setMemberQuery(e.target.value)}
                  />
                </InputGroup>
                <p className="text-xs text-muted-foreground sm:ml-auto">
                  已选 <span className="font-medium text-foreground">{memberIds.size}</span> 名成员、
                  <span className="font-medium text-foreground">{leaderIds.size}</span> 名组长
                </p>
              </div>

              <ScrollArea className="min-h-0 flex-1 rounded-lg border border-border">
                {filtered.length === 0 ? (
                  <p className="p-6 text-center text-sm text-muted-foreground">
                    {members.length === 0 ? "还没有成员，请先到「成员」页添加" : "没有匹配的成员"}
                  </p>
                ) : (
                  <div className="flex flex-col p-1">
                    {filtered.map((m) => {
                      const isMem = memberIds.has(m.id)
                      const isLead = leaderIds.has(m.id)
                      return (
                        <div
                          key={m.id}
                          className={cn(
                            "flex items-center gap-2.5 rounded-md px-2 py-1.5 transition-colors",
                            isMem ? "bg-accent/40" : "hover:bg-muted/60"
                          )}
                        >
                          <Checkbox id={`m-${m.id}`} checked={isMem} onCheckedChange={() => toggleMember(m.id)} />
                          <label htmlFor={`m-${m.id}`} className="flex min-w-0 flex-1 cursor-pointer items-center gap-2">
                            <Avatar owner={`u-${m.id}`} name={m.username} size={20} />
                            <span className="truncate text-sm">{m.username}</span>
                            {m.disabled && <Badge variant="secondary" className="text-[10px]">已禁用</Badge>}
                          </label>
                          <Button
                            type="button"
                            size="xs"
                            variant={isLead ? "secondary" : "ghost"}
                            aria-pressed={isLead}
                            disabled={!isMem}
                            className={cn("shrink-0", !isMem && "opacity-40")}
                            onClick={() => toggleLeader(m.id)}
                          >
                            {isLead && <Icon name="crown" data-icon="inline-start" />}
                            组长
                          </Button>
                        </div>
                      )
                    })}
                  </div>
                )}
              </ScrollArea>
              <p className="text-xs text-muted-foreground">取消成员资格会同时取消其组长身份。</p>
            </div>
          </TabsContent>

          {/* 可见范围 */}
          <TabsContent value="scope">
            <ScrollArea className="h-[46vh] pr-3">
              <FieldGroup className="gap-6 py-1">
                <Field>
                  <FieldLabel htmlFor="g-white">
                    白名单
                    {whiteCount > 0
                      ? <Badge variant="secondary" className="px-1 text-[10px]">{whiteCount}</Badge>
                      : <Badge variant="outline" className="px-1 text-[10px]">不限</Badge>}
                  </FieldLabel>
                  <Textarea
                    id="g-white"
                    className="h-32 resize-none font-mono text-xs"
                    placeholder={"每行一个目录，相对网盘根目录：\n项目A\n公共资料"}
                    value={whitelist}
                    onChange={(e) => setWhitelist(e.target.value)}
                  />
                  <FieldDescription>留空表示不限制；填了则成员只能看到这些目录及其子目录。</FieldDescription>
                </Field>

                <Field>
                  <FieldLabel htmlFor="g-black">
                    黑名单
                    {blackCount > 0 && <Badge variant="secondary" className="px-1 text-[10px]">{blackCount}</Badge>}
                  </FieldLabel>
                  <Textarea
                    id="g-black"
                    className="h-32 resize-none font-mono text-xs"
                    placeholder={"每行一个目录：\n机密\n财务报表"}
                    value={blacklist}
                    onChange={(e) => setBlacklist(e.target.value)}
                  />
                  <FieldDescription>
                    优先级高于白名单：同时命中时一律隐藏。不可见的目录对成员表现为「不存在」。
                  </FieldDescription>
                </Field>
              </FieldGroup>
            </ScrollArea>
          </TabsContent>

          {/* 权限收窄 */}
          <TabsContent value="perms">
            <ScrollArea className="h-[46vh] pr-3">
              <FieldGroup className="gap-6 py-1">
                <p className="text-sm text-muted-foreground">
                  这里的开关只能在「权限」页设定的全局成员权限基础上继续关闭，无法放开全局已关闭的项。
                </p>
                {PERM_GROUPS.map((permGroup) => (
                  <FieldSet key={permGroup.title}>
                    <FieldLegend variant="label">{permGroup.title}</FieldLegend>
                    {permGroup.hint && <FieldDescription className="mb-3">{permGroup.hint}</FieldDescription>}
                    <div className="grid gap-1 sm:grid-cols-2">
                      {permGroup.items.map(([key, label]) => {
                        // 写类子权限受总开关支配：总开关关闭时它们实际不生效，界面上同步置灰
                        const gated = key !== "fileWrite" && WRITE_PERM_KEYS.includes(key) && !fileWriteOn
                        return (
                          <Field
                            key={key}
                            orientation="horizontal"
                            data-disabled={gated ? true : undefined}
                            className="rounded-md px-3 py-1.5 hover:bg-muted/40"
                          >
                            <FieldLabel htmlFor={`perm-${key}`} className="flex-auto font-normal">{label}</FieldLabel>
                            <Switch
                              id={`perm-${key}`}
                              checked={perms[key] !== false}
                              disabled={gated}
                              onCheckedChange={(v) => setPerms((prev) => ({ ...prev, [key]: !!v }))}
                            />
                          </Field>
                        )
                      })}
                    </div>
                  </FieldSet>
                ))}
              </FieldGroup>
            </ScrollArea>
          </TabsContent>
        </Tabs>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>取消</Button>
          <Button onClick={save} disabled={busy}>
            {busy && <Icon name="loader-2" className="animate-spin" data-icon="inline-start" />} 保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
