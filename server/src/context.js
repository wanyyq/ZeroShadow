import { effectivePerms } from "./config.js"
import { resolveGroupContext } from "./groups.js"

// ============================================================================
//  context.js - 请求上下文
//
//  在 attachAuth 之后挂载：解析顶栏所选小组（X-ZS-Group 头），校验成员归属，
//  并据此计算本轮请求的有效权限 req.perms。所有 requirePerm 都读取 req.perms，
//  因此小组切换（收窄权限）对所有接口立即生效。
// ============================================================================

export function attachContext(req, _res, next) {
  const { group, groupId } = resolveGroupContext(req)
  req.group = group
  req.groupId = groupId
  req.perms = effectivePerms(req.auth.role, group)
  next()
}
