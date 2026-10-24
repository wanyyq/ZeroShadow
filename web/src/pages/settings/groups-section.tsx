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
import { PathPicker } from "@/components/browser/path-picker"
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
import { translate, useT } from "@/lib/i18n"

// 权限按语义分组；键名与顺序对齐 server/src/config.js 的 MEMBER_PERM_KEYS。
// fileWrite 是写操作总开关（服务端 effectivePerms 用 `fw && p.x` 合成），
// 所以它关闭时下列写类子开关在界面上同步置灰，避免「看着开着其实不生效」。
const WRITE_PERM_KEYS = ["upload", "uploadFolders", "mkdir", "copy", "move", "rename", "delete", "compressZip", "extractZip", "convertFiles"]

const PERM_GROUPS: { titleKey: string; hintKey?: string; items: [string, string][] }[] = [
  {
    titleKey: "ui.settings.groups.perm_group_file_ops",
    hintKey: "ui.settings.groups.perm_group_file_ops_hint",
    items: [
      ["fileWrite", "ui.settings.groups.perm_file_write"],
      ["upload", "ui.settings.groups.perm_upload"],
      ["uploadFolders", "ui.settings.groups.perm_upload_folders"],
      ["mkdir", "ui.settings.groups.perm_mkdir"],
      ["copy", "ui.common.copy"],
      ["move", "ui.settings.groups.perm_move"],
      ["rename", "ui.common.rename"],
      ["delete", "ui.common.delete"],
    ],
  },
  {
    titleKey: "ui.settings.groups.perm_group_browse_download",
    items: [
      ["browse", "ui.settings.groups.perm_browse"],
      ["downloadFile", "ui.settings.groups.perm_download_file"],
      ["downloadFolder", "ui.settings.groups.perm_download_folder"],
      ["preview", "ui.settings.groups.perm_preview"],
    ],
  },
  {
    titleKey: "ui.settings.groups.perm_group_advanced",
    items: [
      ["compressZip", "ui.settings.groups.perm_compress_zip"],
      ["extractZip", "ui.settings.groups.perm_extract_zip"],
      ["convertFiles", "ui.settings.groups.perm_convert_files"],
      ["downloadUrl", "ui.settings.groups.perm_download_url"],
      ["htmlPreview", "ui.settings.groups.perm_html_preview"],
      ["editFiles", "ui.settings.groups.perm_edit_files"],
    ],
  },
  {
    titleKey: "ui.settings.groups.perm_group_admin_account",
    items: [
      ["manageGuestVisibility", "ui.settings.groups.perm_manage_guest_visibility"],
      ["changePassword", "ui.settings.groups.perm_change_password"],
    ],
  },
]

const CAP_ITEMS: [string, string][] = [
  ["viewMembers", "ui.settings.groups.leader_caps_view_members"],
  ["manageTodo", "ui.settings.groups.leader_caps_manage_todo"],
  ["editMemberAvatar", "ui.settings.groups.leader_caps_edit_member_avatar"],
  ["manageMembers", "ui.settings.groups.leader_caps_manage_members"],
  ["manageVisibility", "ui.settings.groups.leader_caps_manage_visibility"],
]

interface GroupsData {
  groups: Group[]
  members: Member[]
}

/** 复制纯文本并给出反馈 */
function copyText(text: string, okMsg: string) {
  void navigator.clipboard?.writeText(text).then(
    () => toast.success(okMsg),
    () => toast.error(translate("ui.common.copy_failed"))
  )
}

export function GroupsSection() {
  const t = useT()
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
      toast.success(t("ui.settings.groups.deleted"))
      setConfirmDelete(null)
      load()
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  if (!data) return <p className="py-8 text-center text-sm text-muted-foreground">{t("ui.common.loading")}</p>

  return (
    <Card className="edge-highlight">
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div className="flex flex-col gap-1">
            <CardTitle>{t("ui.settings.groups.title")}</CardTitle>
            <CardDescription>{t("ui.settings.groups.description")}</CardDescription>
          </div>
          <Button size="sm" onClick={() => setCreating(true)}>
            <Icon name="plus" data-icon="inline-start" /> {t("ui.settings.groups.create")}
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
              <EmptyTitle>{t("ui.settings.groups.empty_title")}</EmptyTitle>
              <EmptyDescription>{t("ui.settings.groups.empty_description")}</EmptyDescription>
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
            <AlertDialogTitle>{t("ui.settings.groups.delete_confirm_title", { name: confirmDelete?.name ?? "" })}</AlertDialogTitle>
            <AlertDialogDescription>{t("ui.settings.groups.delete_confirm_description")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("ui.common.cancel")}</AlertDialogCancel>
            <AlertDialogAction className="bg-destructive/10 text-destructive hover:bg-destructive/20" onClick={(e) => { e.preventDefault(); doDelete() }}>{t("ui.common.delete")}</AlertDialogAction>
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
  const t = useT()
  const names = members.filter((m) => group.members.includes(m.id)).map((m) => m.username)

  return (
    <ContextMenu>
      <ContextMenuTrigger render={<div />}>
        <div className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4">
      <div className="flex items-center gap-2.5">
        <span className="size-2.5 shrink-0 rounded-full" style={{ background: group.color }} aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate font-medium">{group.name}</span>
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button size="icon-xs" variant="ghost" aria-label={t("ui.settings.groups.actions_for", { name: group.name })} />}>
            <Icon name="ellipsis-vertical" className="size-3.5" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={onEdit}>
              <Icon name="pencil-line" /> {t("ui.settings.groups.edit")}
            </DropdownMenuItem>
            <DropdownMenuItem variant="destructive" onClick={onDelete}>
              <Icon name="trash-2" /> {t("ui.common.delete")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span className="flex items-center gap-1"><Icon name="users" className="size-3.5" />{t("ui.settings.groups.member_count", { n: group.members.length })}</span>
        <span className="flex items-center gap-1"><Icon name="crown" className="size-3.5" />{t("ui.settings.groups.leader_count", { n: group.leaders.length })}</span>
        <span className="flex items-center gap-1">
          <Icon name={group.whitelist.length ? "filter" : "infinity"} className="size-3.5" />
          {group.whitelist.length ? t("ui.settings.groups.whitelist_count", { n: group.whitelist.length }) : t("ui.settings.groups.visibility_unlimited")}
          {group.blacklist.length > 0 ? t("ui.settings.groups.hidden_count", { n: group.blacklist.length }) : ""}
        </span>
      </div>

      <p className="line-clamp-1 text-xs text-muted-foreground">
        {names.length ? names.join(t("ui.settings.groups.name_separator")) : t("ui.settings.groups.no_members")}
      </p>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-52">
        <ContextMenuItem onClick={onEdit}>
          <Icon name="pencil-line" /> {t("ui.settings.groups.edit")}
        </ContextMenuItem>
        <ContextMenuItem onClick={() => copyText(group.name, t("ui.settings.groups.copied_name"))}>
          <Icon name="clipboard-copy" /> {t("ui.settings.groups.copy_name")}
        </ContextMenuItem>
        {group.members.length > 0 && (
          <ContextMenuItem onClick={() => copyText(names.join(t("ui.settings.groups.name_separator")), t("ui.settings.groups.copied_members"))}>
            <Icon name="users" /> {t("ui.settings.groups.copy_members")}
          </ContextMenuItem>
        )}
        <ContextMenuSeparator />
        <ContextMenuItem variant="destructive" onClick={onDelete}>
          <Icon name="trash-2" /> {t("ui.common.delete")}
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
  const t = useT()
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
    group?.leaderCaps || {
      viewMembers: true,
      manageTodo: true,
      editMemberAvatar: false,
      manageMembers: false,
      manageVisibility: false,
    }
  )
  const [whitelist, setWhitelist] = React.useState((group?.whitelist || []).join("\n"))
  const [blacklist, setBlacklist] = React.useState((group?.blacklist || []).join("\n"))
  // 「从目录选择」当前要往哪个列表里插
  const [picking, setPicking] = React.useState<null | "white" | "black">(null)
  const insertPicked = (picked: string) => {
    const isWhite = picking === "white"
    const current = isWhite ? whitelist : blacklist
    const lines = current.split("\n").map((l) => l.trim()).filter(Boolean)
    if (picked && !lines.includes(picked)) lines.push(picked)
    if (isWhite) setWhitelist(lines.join("\n"))
    else setBlacklist(lines.join("\n"))
    setPicking(null)
  }
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
      setNameError(t("ui.settings.groups.name_required"))
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
      toast.success(isNew ? t("ui.settings.groups.created") : t("ui.settings.groups.saved"))
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
          <DialogTitle>{isNew ? t("ui.settings.groups.create") : t("ui.settings.groups.edit_title", { name: group.name })}</DialogTitle>
          <DialogDescription>
            {t("ui.settings.groups.editor_description")}
          </DialogDescription>
        </DialogHeader>

        <Tabs value={tab} onValueChange={setTab}>
          <TabsList className="w-full">
            <TabsTrigger value="basic">{t("ui.settings.groups.tab_basic")}</TabsTrigger>
            <TabsTrigger value="members">
              {t("ui.settings.groups.tab_members")}
              {memberIds.size > 0 && <Badge variant="secondary" className="px-1 text-[10px]">{memberIds.size}</Badge>}
            </TabsTrigger>
            <TabsTrigger value="scope">
              {t("ui.settings.groups.tab_scope")}
              {(whiteCount > 0 || blackCount > 0) && (
                <Badge variant="secondary" className="px-1 text-[10px]">{whiteCount + blackCount}</Badge>
              )}
            </TabsTrigger>
            <TabsTrigger value="perms">{t("ui.settings.groups.tab_perms")}</TabsTrigger>
          </TabsList>

          {/* 基本信息 */}
          <TabsContent value="basic">
            <ScrollArea className="h-[46vh] pr-3">
              <FieldGroup className="gap-6 py-1">
                <Field data-invalid={nameError ? true : undefined}>
                  <FieldLabel htmlFor="g-name">{t("ui.settings.groups.name_label")}</FieldLabel>
                  <Input
                    id="g-name"
                    value={name}
                    aria-invalid={nameError ? true : undefined}
                    placeholder={t("ui.settings.groups.name_placeholder")}
                    onChange={(e) => { setName(e.target.value); if (nameError) setNameError(null) }}
                  />
                  {nameError ? (
                    <p role="alert" className="text-sm font-normal text-destructive">{nameError}</p>
                  ) : (
                    <FieldDescription>{t("ui.settings.groups.name_hint")}</FieldDescription>
                  )}
                </Field>

                <Field orientation="horizontal">
                  <FieldLabel>{t("ui.settings.groups.color_label")}</FieldLabel>
                  <ColorPicker value={color} onChange={setColor} />
                </Field>

                <Separator />

                <FieldSet>
                  <FieldLegend variant="label">{t("ui.settings.groups.leader_caps")}</FieldLegend>
                  <FieldDescription className="mb-3">
                    {t("ui.settings.groups.leader_caps_hint")}
                  </FieldDescription>
                  <div className="grid gap-1">
                    {CAP_ITEMS.map(([key, label]) => (
                      <Field key={key} orientation="horizontal" className="rounded-lg bg-muted/40 px-3 py-2">
                        <FieldLabel htmlFor={`cap-${key}`} className="flex-auto font-normal">{t(label)}</FieldLabel>
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
                    placeholder={t("ui.settings.groups.search_members_placeholder")}
                    value={memberQuery}
                    onChange={(e) => setMemberQuery(e.target.value)}
                  />
                </InputGroup>
                <p className="text-xs text-muted-foreground sm:ml-auto">
                  {t("ui.settings.groups.selected_summary", { members: memberIds.size, leaders: leaderIds.size })}
                </p>
              </div>

              <ScrollArea className="min-h-0 flex-1 rounded-lg border border-border">
                {filtered.length === 0 ? (
                  <p className="p-6 text-center text-sm text-muted-foreground">
                    {members.length === 0 ? t("ui.settings.groups.no_members_hint") : t("ui.settings.groups.no_matching_members")}
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
                            {m.disabled && <Badge variant="secondary" className="text-[10px]">{t("ui.common.disabled")}</Badge>}
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
                            {t("ui.settings.groups.leader_label")}
                          </Button>
                        </div>
                      )
                    })}
                  </div>
                )}
              </ScrollArea>
              <p className="text-xs text-muted-foreground">{t("ui.settings.groups.member_hint")}</p>
            </div>
          </TabsContent>

          {/* 可见范围 */}
          <TabsContent value="scope">
            <ScrollArea className="h-[46vh] pr-3">
              <FieldGroup className="gap-6 py-1">
                <Field>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <FieldLabel htmlFor="g-white" className="flex items-center gap-2">
                      {t("ui.settings.groups.whitelist_label")}
                      {whiteCount > 0
                        ? <Badge variant="secondary" className="px-1 text-[10px]">{whiteCount}</Badge>
                        : <Badge variant="outline" className="px-1 text-[10px]">{t("ui.settings.groups.unlimited")}</Badge>}
                    </FieldLabel>
                    <Button size="xs" variant="outline" onClick={() => setPicking("white")}>
                      <Icon name="folder-tree" data-icon="inline-start" /> {t("ui.settings.groups.pick_from_dir")}
                    </Button>
                  </div>
                  <Textarea
                    id="g-white"
                    className="h-32 resize-none font-mono text-xs"
                    placeholder={t("ui.settings.groups.whitelist_placeholder")}
                    value={whitelist}
                    onChange={(e) => setWhitelist(e.target.value)}
                  />
                  <FieldDescription>{t("ui.settings.groups.whitelist_hint")}</FieldDescription>
                </Field>

                <Field>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <FieldLabel htmlFor="g-black" className="flex items-center gap-2">
                      {t("ui.settings.groups.blacklist_label")}
                      {blackCount > 0 && <Badge variant="secondary" className="px-1 text-[10px]">{blackCount}</Badge>}
                    </FieldLabel>
                    <Button size="xs" variant="outline" onClick={() => setPicking("black")}>
                      <Icon name="folder-tree" data-icon="inline-start" /> {t("ui.settings.groups.pick_from_dir")}
                    </Button>
                  </div>
                  <Textarea
                    id="g-black"
                    className="h-32 resize-none font-mono text-xs"
                    placeholder={t("ui.settings.groups.blacklist_placeholder")}
                    value={blacklist}
                    onChange={(e) => setBlacklist(e.target.value)}
                  />
                  <FieldDescription>
                    {t("ui.settings.groups.blacklist_hint")}
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
                  {t("ui.settings.groups.perms_hint")}
                </p>
                {PERM_GROUPS.map((permGroup) => (
                  <FieldSet key={permGroup.titleKey}>
                    <FieldLegend variant="label">{t(permGroup.titleKey)}</FieldLegend>
                    {permGroup.hintKey && <FieldDescription className="mb-3">{t(permGroup.hintKey)}</FieldDescription>}
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
                            <FieldLabel htmlFor={`perm-${key}`} className="flex-auto font-normal">{t(label)}</FieldLabel>
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
          <Button variant="outline" onClick={onClose}>{t("ui.common.cancel")}</Button>
          <Button onClick={save} disabled={busy}>
            {busy && <Icon name="loader-2" className="animate-spin" data-icon="inline-start" />} {t("ui.common.save")}
          </Button>
        </DialogFooter>
      </DialogContent>

      <PathPicker open={picking !== null} onOpenChange={(o) => { if (!o) setPicking(null) }} onPick={insertPicked} />
    </Dialog>
  )
}
