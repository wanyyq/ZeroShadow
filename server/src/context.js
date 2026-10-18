import { permsForContext, resolveGroupContext, visibilityForContext } from "./groups.js"

// ============================================================================
//  context.js - 请求上下文
//
//  在 attachAuth 之后挂载：解析顶栏所选小组（X-ZS-Group 头 / ?group=），校验成员
//  归属，并据此计算本轮请求的有效权限 req.perms 与可见范围 req.visibility。
//
//  关键点（安全审计 H1 / 语义决定 1）：小组上下文是**自选**的，所以"没选"不能
//  等于"不受限"。成员未指定小组（或指定了不属于自己的小组）时：
//    - 权限  取**所属各组权限的交集**（deny 优先）—— 去掉请求头拿不回被收窄的权限；
//    - 可见范围取**所属各组可见范围的并集** —— 既保留"一人参与多个项目"的用法，
//      又不会让他看到任何没被任何组授予的目录。
//  无任何小组的成员仍按全局 memberPerms + defaultVisibility（旧行为）。
// ============================================================================

export function attachContext(req, _res, next) {
  const { group, groupId } = resolveGroupContext(req)
  req.group = group
  req.groupId = groupId
  req.perms = permsForContext(req.auth.role, req.auth.userId, group)
  req.visibility = visibilityForContext(req.auth.role, req.auth.userId, group)
  next()
}
