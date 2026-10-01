import path from "node:path"
import crypto from "node:crypto"
import { DATA_DIR } from "./env.js"
import { readJsonTyped, withLock, writeJsonAtomic } from "./store.js"

// ============================================================================
//  todos.js - 团队 Todo
//
//  作用域 scope：
//    - "all"    全体成员可见
//    - "group"  指定小组成员可见（groupId）
//    - "member" 指定成员可见（memberId）
//  可见范围另加：创建者、超管、以及相关小组的组长。
// ============================================================================

const TODOS_FILE = path.join(DATA_DIR, "todos.json")
const MAX_TODOS = 5000
const PRIORITIES = new Set(["low", "normal", "high"])
const SCOPES = new Set(["all", "group", "member"])

let todos = readJsonTyped(TODOS_FILE, [], "array")
  .filter((t) => t && typeof t === "object" && t.id)
  .map(sanitizeTodo)

function sanitizeTodo(raw) {
  const scope = SCOPES.has(raw.scope) ? raw.scope : "all"
  return {
    id: String(raw.id),
    title: String(raw.title || "").slice(0, 200),
    note: String(raw.note || "").slice(0, 2000),
    priority: PRIORITIES.has(raw.priority) ? raw.priority : "normal",
    dueAt: raw.dueAt ? String(raw.dueAt).slice(0, 40) : null,
    scope,
    groupId: scope === "group" ? String(raw.groupId || "") : "",
    memberId: scope === "member" ? String(raw.memberId || "") : "",
    done: !!raw.done,
    doneAt: raw.doneAt ? String(raw.doneAt) : null,
    doneBy: raw.doneBy ? String(raw.doneBy) : null,
    allowAssigneeEdit: !!raw.allowAssigneeEdit,
    createdBy: String(raw.createdBy || ""),
    createdById: raw.createdById ? String(raw.createdById) : null,
    createdByRole: String(raw.createdByRole || "member"),
    createdAt: raw.createdAt || new Date().toISOString(),
    updatedAt: raw.updatedAt || new Date().toISOString(),
  }
}

export function reloadTodos() {
  todos = readJsonTyped(TODOS_FILE, [], "array")
    .filter((t) => t && typeof t === "object" && t.id)
    .map(sanitizeTodo)
  return todos
}

export function listTodos() {
  return todos
}

export function getTodo(id) {
  return todos.find((t) => t.id === id) || null
}

function persist() {
  return writeJsonAtomic(TODOS_FILE, todos)
}

export async function createTodo(data) {
  return withLock("todos", async () => {
    if (todos.length >= MAX_TODOS) {
      const err = new Error(`Todo 数量已达上限 ${MAX_TODOS}`)
      err.status = 400
      throw err
    }
    const todo = sanitizeTodo({
      id: crypto.randomUUID(),
      ...data,
      done: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    todos.push(todo)
    await persist()
    return todo
  })
}

export async function updateTodo(id, patch) {
  return withLock("todos", async () => {
    const todo = getTodo(id)
    if (!todo) {
      const err = new Error("Todo 不存在")
      err.status = 404
      throw err
    }
    const allowed = ["title", "note", "priority", "dueAt", "allowAssigneeEdit", "scope", "groupId", "memberId"]
    const merged = { ...todo }
    for (const key of allowed) {
      if (patch[key] !== undefined) merged[key] = patch[key]
    }
    Object.assign(todo, sanitizeTodo(merged))
    todo.updatedAt = new Date().toISOString()
    await persist()
    return todo
  })
}

export async function setTodoDone(id, done, actorName) {
  return withLock("todos", async () => {
    const todo = getTodo(id)
    if (!todo) {
      const err = new Error("Todo 不存在")
      err.status = 404
      throw err
    }
    todo.done = !!done
    todo.doneAt = done ? new Date().toISOString() : null
    todo.doneBy = done ? actorName : null
    todo.updatedAt = new Date().toISOString()
    await persist()
    return todo
  })
}

export async function deleteTodo(id) {
  return withLock("todos", async () => {
    const before = todos.length
    todos = todos.filter((t) => t.id !== id)
    await persist()
    return before - todos.length
  })
}

/** 删除成员时，清理其创建/指派的 Todo 关联 */
export async function removeUserFromTodos(userId) {
  return withLock("todos", async () => {
    let changed = false
    for (const todo of todos) {
      if (todo.scope === "member" && todo.memberId === userId) {
        todo.scope = "all"
        todo.memberId = ""
        changed = true
      }
      if (todo.createdById === userId) {
        todo.createdById = null
        changed = true
      }
    }
    if (changed) await persist()
    return changed
  })
}

/** 删除小组时，把该小组的 Todo 转为全体 */
export async function removeGroupFromTodos(groupId) {
  return withLock("todos", async () => {
    let changed = false
    for (const todo of todos) {
      if (todo.scope === "group" && todo.groupId === groupId) {
        todo.scope = "all"
        todo.groupId = ""
        changed = true
      }
    }
    if (changed) await persist()
    return changed
  })
}
