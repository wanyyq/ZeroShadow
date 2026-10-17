/**
 * 极小的 XML 解析器（浏览器与 Node 共用）
 *
 * 为什么不直接用 `DOMParser`：解析逻辑要能在 `node scripts/office-preview-test.mjs`
 * 里跑（Node 没有 DOMParser），而且 `DOMParser` 会把整份 XML 变成一堆 DOM 对象，
 * 对 60KB 的 chunk 预算来说也偏重。这里只做 OOXML 需要的事：
 *   - 元素 / 属性 / 文本 / 注释 / CDATA / 处理指令 / DOCTYPE
 *   - 实体解码（`&amp;` `&lt;` `&#x4E2D;` 等）
 *   - 命名空间前缀原样保留（`w:p` / `a:t`），查询时按「本地名」匹配
 *
 * 不校验良构性：遇到截断的标签就停下，返回已经解析到的部分 —— 预览的目标是
 * 「尽量显示出来」，而不是给用户报 XML 语法错误。
 */

export interface XmlNode {
  /** 限定名，例如 `w:p`（没有前缀时就是本地名） */
  name: string
  /** 属性表；键保留前缀，例如 `r:embed`。重复属性后者覆盖前者 */
  attrs: Record<string, string>
  children: XmlNode[]
  /** 本元素直属的文本（已解码、已拼接），不含子元素里的文本 */
  text: string
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: "\u00a0",
}

export function decodeEntities(src: string): string {
  if (src.indexOf("&") < 0) return src
  return src.replace(/&(#[xX]?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, body: string) => {
    if (body.charAt(0) === "#") {
      const hex = body.charAt(1) === "x" || body.charAt(1) === "X"
      const code = Number.parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10)
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return whole
      try {
        return String.fromCodePoint(code)
      } catch {
        return whole
      }
    }
    return ENTITIES[body] ?? whole
  })
}

/** 元素/属性的本地名（去掉 `w:` 这类前缀） */
export function localName(name: string): string {
  const i = name.indexOf(":")
  return i < 0 ? name : name.slice(i + 1)
}

const ATTR_RE = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g

function parseAttrs(source: string, out: Record<string, string>) {
  ATTR_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = ATTR_RE.exec(source))) {
    out[m[1]] = decodeEntities(m[2] ?? m[3] ?? "")
  }
}

/**
 * 解析整份 XML。
 *
 * 返回值是**文档元素**（`<w:document>` / `<worksheet>` 这类根元素），
 * 而不是一个伪包装节点 —— OOXML 部件永远只有一个根元素，
 * 这样调用方的 `child(root, "body")` 之类才符合直觉。
 * 空文档则退化成 `#root` 包装节点。
 */
export function parseXml(source: string): XmlNode {
  const root: XmlNode = { name: "#root", attrs: {}, children: [], text: "" }
  const stack: XmlNode[] = [root]
  const len = source.length
  let i = 0

  const addText = (raw: string) => {
    if (!raw) return
    stack[stack.length - 1].text += decodeEntities(raw)
  }

  while (i < len) {
    const lt = source.indexOf("<", i)
    if (lt < 0) {
      addText(source.slice(i))
      break
    }
    if (lt > i) addText(source.slice(i, lt))

    if (source.startsWith("<!--", lt)) {
      const end = source.indexOf("-->", lt + 4)
      i = end < 0 ? len : end + 3
      continue
    }
    if (source.startsWith("<![CDATA[", lt)) {
      const end = source.indexOf("]]>", lt + 9)
      addText(source.slice(lt + 9, end < 0 ? len : end))
      i = end < 0 ? len : end + 3
      continue
    }
    if (source.startsWith("<?", lt)) {
      const end = source.indexOf("?>", lt + 2)
      i = end < 0 ? len : end + 2
      continue
    }
    if (source.startsWith("<!", lt)) {
      // DOCTYPE 之类：跳到下一个 '>'（内含 [ ] 的写法在 OOXML 里不会出现）
      const end = source.indexOf(">", lt + 2)
      i = end < 0 ? len : end + 1
      continue
    }
    if (source.charAt(lt + 1) === "/") {
      const end = source.indexOf(">", lt + 2)
      i = end < 0 ? len : end + 1
      if (stack.length > 1) stack.pop()
      continue
    }

    // 开始标签：引号内的 '>' 不算结束
    let j = lt + 1
    let quote = ""
    while (j < len) {
      const c = source.charAt(j)
      if (quote) {
        if (c === quote) quote = ""
      } else if (c === '"' || c === "'") {
        quote = c
      } else if (c === ">") {
        break
      }
      j++
    }
    const raw = source.slice(lt + 1, j)
    i = j + 1
    const selfClose = raw.charAt(raw.length - 1) === "/"
    const body = selfClose ? raw.slice(0, -1) : raw
    const spaceAt = body.search(/\s/)
    const name = (spaceAt < 0 ? body : body.slice(0, spaceAt)).trim()
    if (!name) continue
    const node: XmlNode = { name, attrs: {}, children: [], text: "" }
    if (spaceAt >= 0) parseAttrs(body.slice(spaceAt), node.attrs)
    stack[stack.length - 1].children.push(node)
    if (!selfClose) stack.push(node)
  }
  return root.children.find((node) => node.name !== "#root") ?? root
}

/** 直接子元素里本地名匹配的第一个 */
export function child(node: XmlNode | null | undefined, name: string): XmlNode | undefined {
  if (!node) return undefined
  for (const c of node.children) if (localName(c.name) === name) return c
  return undefined
}

/** 直接子元素里本地名匹配的全部 */
export function kids(node: XmlNode | null | undefined, name: string): XmlNode[] {
  if (!node) return []
  const out: XmlNode[] = []
  for (const c of node.children) if (localName(c.name) === name) out.push(c)
  return out
}

/** 深度优先、按文档顺序收集后代的指定元素 */
export function descendants(node: XmlNode | null | undefined, name: string, out: XmlNode[] = []): XmlNode[] {
  if (!node) return out
  for (const c of node.children) {
    if (localName(c.name) === name) out.push(c)
    descendants(c, name, out)
  }
  return out
}

/** 深度优先找到第一个指定元素 */
export function find(node: XmlNode | null | undefined, name: string): XmlNode | undefined {
  if (!node) return undefined
  for (const c of node.children) {
    if (localName(c.name) === name) return c
    const hit = find(c, name)
    if (hit) return hit
  }
  return undefined
}

/** 取属性：先精确匹配，再按本地名匹配（`r:embed` 与 `embed` 等价） */
export function attr(node: XmlNode | null | undefined, name: string): string | undefined {
  if (!node) return undefined
  const exact = node.attrs[name]
  if (exact !== undefined) return exact
  for (const key of Object.keys(node.attrs)) {
    if (localName(key) === name) return node.attrs[key]
  }
  return undefined
}

/** 数字属性（EMU、字号、列宽…），解析失败返回 undefined */
export function numAttr(node: XmlNode | null | undefined, name: string): number | undefined {
  const raw = attr(node, name)
  if (raw === undefined) return undefined
  const n = Number.parseFloat(raw)
  return Number.isFinite(n) ? n : undefined
}

/**
 * OOXML 的布尔属性：`<w:b/>` 与 `<w:b w:val="true"/>` 都是真，
 * `<w:b w:val="0"/>` / `"false"` / `"off"` 是假。
 */
export function boolProp(node: XmlNode | null | undefined): boolean {
  if (!node) return false
  const val = attr(node, "val")
  if (val === undefined || val === "") return true
  const v = val.toLowerCase()
  return v !== "0" && v !== "false" && v !== "off"
}

/** 元素全部文本（含后代），用于 `<w:t>` 之外的简易取文本 */
export function textOf(node: XmlNode | null | undefined): string {
  if (!node) return ""
  let out = node.text
  for (const c of node.children) out += textOf(c)
  return out
}
