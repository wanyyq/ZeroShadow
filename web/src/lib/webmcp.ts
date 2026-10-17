import {
  api,
  createEmptyFile,
  createShare,
  deleteShare,
  downloadUrl,
  fetchMyShares,
  shareDownloadUrl,
  type ShareExpiryOption,
} from "@/lib/api"
import type { Entry, Me } from "@/lib/types"

/**
 * lib/webmcp.ts —— WebMCP（Web Model Context Protocol）支持
 *
 * WebMCP 是 W3C Web Machine Learning CG 的草案（Chrome 带 flag 的实验实现），
 * 给网页一个标准入口，把自己的能力以 **tool**（名字 + 描述 + JSON Schema +
 * execute 回调）的形式暴露给浏览器内置的 AI 代理：
 *
 *   navigator.modelContext.provideContext({ tools })
 *   navigator.modelContext.registerTool(tool) / unregisterTool(name) / clearContext()
 *
 * 这里的设计原则：
 *  1. **零依赖、零首屏成本**：只用特性检测，浏览器不支持时整个模块不做事；
 *  2. **不绕过权限**：所有工具最终都调用同一套 `/api/*`（带 CSRF 头、带当前小组
 *     上下文），服务端照常校验权限与可见范围，AI 拿不到比人更多的能力；
 *  3. **不做"格式化"包装**：返回值就是把接口响应裁剪成少量字段，避免大对象
 *     把模型上下文撑爆（列表默认截断到 50 条）；
 *  4. **只在登录后注册**：访客没有任何写能力，注册一堆只会失败的工具有害无益。
 *
 * 注意：`provideContext()` 是**整体替换**语义，所以每次权限/小组成员变化都重建一次；
 * 组件卸载或登出时 `clearContext()`。
 */

interface ModelContextTool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  execute: (args: Record<string, unknown>) => unknown | Promise<unknown>
  annotations?: { readOnlyHint?: boolean }
}

interface ModelContextApi {
  provideContext?: (options?: { tools?: ModelContextTool[] }) => void
  registerTool?: (tool: ModelContextTool) => void
  unregisterTool?: (name: string) => void
  clearContext?: () => void
}

function modelContext(): ModelContextApi | null {
  if (typeof navigator === "undefined") return null
  const mc = (navigator as unknown as { modelContext?: ModelContextApi }).modelContext
  return mc && typeof mc === "object" ? mc : null
}

/** 浏览器是否支持 WebMCP（给诊断/文档用；界面不依赖它） */
export function webMcpSupported(): boolean {
  const mc = modelContext()
  return !!mc && (typeof mc.provideContext === "function" || typeof mc.registerTool === "function")
}

const str = (description: string) => ({ type: "string", description })
const optionalStr = (description: string) => ({ type: "string", description })

/** 把文件条目裁成模型真正需要的字段 */
function compactEntry(entry: Entry) {
  return {
    name: entry.name,
    type: entry.type === "dir" ? "folder" : entry.type === "shortcut" ? "shortcut" : "file",
    size: entry.size,
    modifiedAt: new Date(entry.mtime).toISOString(),
    ...(entry.softReadOnly ? { readOnly: true } : {}),
    ...(entry.hiddenFromGuest ? { hiddenFromGuest: true } : {}),
  }
}

function errorPayload(err: unknown) {
  const message = err instanceof Error ? err.message : String(err)
  return { ok: false, error: message }
}

function buildTools(me: Me, expiry: ShareExpiryOption[]): ModelContextTool[] {
  const perms = me.perms
  const tools: ModelContextTool[] = []

  // ---------------------------------------------------------------- 只读 --
  tools.push({
    name: "zeroshadow_list_files",
    description:
      "List the files and folders inside a directory of this cloud drive (ZeroShadow). " +
      "Returns at most 50 entries with name, type, size and modified time. " +
      "Use an empty path for the drive root.",
    inputSchema: {
      type: "object",
      properties: { path: optionalStr("Directory path relative to the drive root, e.g. '项目/2026'. Empty = root.") },
      required: [],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
    execute: async (args) => {
      try {
        const data = await api.get<{ path: string; entries: Entry[] }>("/fs/list", {
          path: String(args.path ?? ""),
        })
        const entries = data.entries.slice(0, 50).map(compactEntry)
        return { ok: true, path: data.path, count: entries.length, truncated: data.entries.length > 50, entries }
      } catch (err) {
        return errorPayload(err)
      }
    },
  })

  tools.push({
    name: "zeroshadow_search_files",
    description:
      "Search the whole drive (or a subtree) for files and folders whose name contains the given text. " +
      "Returns at most 30 results.",
    inputSchema: {
      type: "object",
      properties: {
        query: str("Text to look for in names (case-insensitive)."),
        path: optionalStr("Subtree to search in; empty = whole drive."),
      },
      required: ["query"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
    execute: async (args) => {
      try {
        const data = await api.get<{ results: (Entry & { path: string })[] }>("/fs/search", {
          q: String(args.query ?? ""),
          path: String(args.path ?? ""),
        })
        const results = data.results.slice(0, 30).map((r) => ({ ...compactEntry(r), path: r.path }))
        return { ok: true, count: results.length, truncated: data.results.length > 30, results }
      } catch (err) {
        return errorPayload(err)
      }
    },
  })

  if (perms.details) {
    tools.push({
      name: "zeroshadow_file_details",
      description:
        "Get metadata of one file: detected real format, size, timestamps, checksums (MD5/SHA-256) when small enough, " +
        "and image/document/media specifics.",
      inputSchema: {
        type: "object",
        properties: { path: str("File path relative to the drive root.") },
        required: ["path"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true },
      execute: async (args) => {
        try {
          const path = String(args.path ?? "")
          const data = await api.get<Record<string, unknown>>("/fs/details", { path })
          return { ok: true, path, details: data }
        } catch (err) {
          return errorPayload(err)
        }
      },
    })
  }

  tools.push({
    name: "zeroshadow_get_download_url",
    description:
      "Return a same-origin URL that downloads the given file (or a ZIP of the given folder). " +
      "The URL only works for a signed-in browser session.",
    inputSchema: {
      type: "object",
      properties: { path: str("File or folder path relative to the drive root.") },
      required: ["path"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
    execute: (args) => {
      const path = String(args.path ?? "")
      if (!path) return { ok: false, error: "path is required" }
      return { ok: true, url: new URL(downloadUrl(path), window.location.origin).href }
    },
  })

  // ---------------------------------------------------------------- 写入 --
  if (perms.mkdir) {
    tools.push({
      name: "zeroshadow_create_folder",
      description: "Create a new folder inside an existing directory.",
      inputSchema: {
        type: "object",
        properties: {
          path: str("Parent directory (empty = drive root)."),
          name: str("New folder name."),
        },
        required: ["path", "name"],
        additionalProperties: false,
      },
      execute: async (args) => {
        try {
          const data = await api.post<{ name: string }>("/fs/mkdir", {
            path: String(args.path ?? ""),
            name: String(args.name ?? ""),
          })
          return { ok: true, created: data.name }
        } catch (err) {
          return errorPayload(err)
        }
      },
    })
  }

  if (perms.upload) {
    tools.push({
      name: "zeroshadow_create_text_file",
      description:
        "Create a new UTF-8 text file with optional initial content. " +
        "Use `unique: true` to auto-rename when the name is taken.",
      inputSchema: {
        type: "object",
        properties: {
          path: str("Parent directory (empty = drive root)."),
          name: str("File name including extension, e.g. 'notes.md'."),
          content: optionalStr("Initial UTF-8 content; omit for an empty file."),
          unique: { type: "boolean", description: "Auto-rename instead of failing when the name exists." },
        },
        required: ["path", "name"],
        additionalProperties: false,
      },
      execute: async (args) => {
        try {
          const data = await createEmptyFile(
            String(args.path ?? ""),
            String(args.name ?? ""),
            String(args.content ?? ""),
            args.unique === true
          )
          return { ok: true, created: data.name, path: data.path }
        } catch (err) {
          return errorPayload(err)
        }
      },
    })
  }

  // ---------------------------------------------------------------- 分享 --
  if (me.role !== "guest") {
    tools.push({
      name: "zeroshadow_share_create",
      description:
        "Create a share link for one file or folder. Pick one of the allowed expiry presets " +
        "(listed in the description of `expireKey`). Paths that are hidden from guests REQUIRE a 6-10 character password. " +
        "The password and expiry cannot be changed later — revoke and recreate instead.",
      inputSchema: {
        type: "object",
        properties: {
          path: str("File or folder path relative to the drive root."),
          expireKey: {
            type: "string",
            description: `Expiry preset. One of: ${expiry.map((o) => o.key).join(", ")}.`,
          },
          password: optionalStr("6-10 characters, no spaces. Required when the path is hidden from guests."),
        },
        required: ["path", "expireKey"],
        additionalProperties: false,
      },
      execute: async (args) => {
        try {
          const path = String(args.path ?? "")
          const key = String(args.expireKey ?? "")
          const preset = expiry.find((o) => o.key === key)
          if (!preset) {
            return {
              ok: false,
              error: `expireKey must be one of: ${expiry.map((o) => o.key).join(", ")}`,
            }
          }
          const row = await createShare({
            path,
            expireSeconds: preset.seconds,
            password: typeof args.password === "string" && args.password ? args.password : undefined,
          })
          return {
            ok: true,
            name: row.name,
            expiresAt: new Date(row.expiresAt).toISOString(),
            requirePassword: row.requirePassword,
            url: new URL(row.url, window.location.origin).href,
          }
        } catch (err) {
          return errorPayload(err)
        }
      },
    })

    tools.push({
      name: "zeroshadow_share_list",
      description: "List the share links created by the current user, with expiry and download counters.",
      inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
      annotations: { readOnlyHint: true },
      execute: async () => {
        try {
          const data = await fetchMyShares()
          return {
            ok: true,
            count: data.shares.length,
            shares: data.shares.slice(0, 50).map((s) => ({
              id: s.id,
              name: s.name,
              path: s.path,
              folder: s.isFolder,
              expiresAt: new Date(s.expiresAt).toISOString(),
              expired: s.expired,
              requirePassword: s.requirePassword,
              downloads: s.downloads,
              url: new URL(s.url, window.location.origin).href,
            })),
          }
        } catch (err) {
          return errorPayload(err)
        }
      },
    })

    tools.push({
      name: "zeroshadow_share_revoke",
      description: "Revoke one of the current user's own share links by id (get ids from zeroshadow_share_list).",
      inputSchema: {
        type: "object",
        properties: { id: str("Share id, e.g. 'shr_xxx'.") },
        required: ["id"],
        additionalProperties: false,
      },
      execute: async (args) => {
        try {
          await deleteShare(String(args.id ?? ""))
          return { ok: true, revoked: String(args.id ?? "") }
        } catch (err) {
          return errorPayload(err)
        }
      },
    })
  }

  // ------------------------------------------------------------- 我的身份 --
  tools.push({
    name: "zeroshadow_whoami",
    description: "Report the current user's role, upload limit and granted permissions in this cloud drive.",
    inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
    annotations: { readOnlyHint: true },
    execute: () => ({
      ok: true,
      role: me.role,
      username: me.username,
      group: me.group?.name ?? null,
      uploadLimitMB: me.uploadLimitMB,
      permissions: Object.entries(perms)
        .filter(([, v]) => v === true)
        .map(([k]) => k),
    }),
  })

  // 供 share 下载用的辅助：把"相对路径"转成分享页地址（只读，无副作用）
  if (me.role !== "guest") {
    tools.push({
      name: "zeroshadow_shared_download_url",
      description:
        "Given a share token (and optionally a file path inside a shared folder), return the direct download URL. " +
        "Password-protected shares additionally need the ticket returned by the share page.",
      inputSchema: {
        type: "object",
        properties: {
          token: str("Share token from the share URL /s/<token>."),
          path: optionalStr("File path inside the share; empty for a single-file share."),
          ticket: optionalStr("Ticket obtained from the share page after entering the password."),
        },
        required: ["token"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true },
      execute: (args) => {
        const token = String(args.token ?? "")
        if (!token) return { ok: false, error: "token is required" }
        const url = shareDownloadUrl(token, String(args.path ?? ""), String(args.ticket ?? ""))
        return { ok: true, url: new URL(url, window.location.origin).href }
      },
    })
  }

  return tools
}

/**
 * 把当前会话的能力注册成 WebMCP 工具，返回一个"注销"函数。
 *
 * 调用方是 `state/webmcp.tsx` 里的 `<WebMcpBridge />`：它在登录态 / 权限 /
 * 小组上下文变化时重新调用本函数（`provideContext` 是整体替换语义，
 * 所以每次变化都重建一次最省心），卸载或登出时执行返回的清理函数。
 */
export function installWebMcpTools(me: Me, expiry: ShareExpiryOption[]): () => void {
  const mc = modelContext()
  if (!mc) return () => {}
  if (me.role === "guest") {
    try {
      mc.clearContext?.()
    } catch {
      /* 浏览器实现差异，忽略 */
    }
    return () => {}
  }

  const tools = buildTools(me, expiry)
  try {
    if (typeof mc.provideContext === "function") mc.provideContext({ tools })
    else if (typeof mc.registerTool === "function") for (const tool of tools) mc.registerTool(tool)
  } catch (err) {
    // 注册失败不能影响网盘本身：只在控制台留一条线索
    console.warn("[webmcp] 工具注册失败", err)
  }

  return () => {
    try {
      mc.clearContext?.()
    } catch {
      /* ignore */
    }
  }
}
