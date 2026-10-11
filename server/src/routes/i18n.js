import { Router } from "express"
import { availableLangs, getLang } from "../i18n.js"
import { getConfig } from "../config.js"

// ============================================================================
//  routes/i18n.js —— 界面语言清单与语言文件
//
//  这两个接口必须**无需登录**就能访问：登录页本身也要显示语言选择器。
//  它们只暴露"有哪些语言"和"某个语言的译文"，不涉及任何用户数据。
//  走 GET，因此不经过 csrfGuard（它只校验写请求），兼容模式页也能用最朴素的
//  XHR 直接取（不需要自定义头，也就不触发任何预检）。
// ============================================================================

const router = Router()

router.get("/", (_req, res) => {
  const langs = availableLangs()
  const configured = getConfig().defaultLang
  // 站点默认语言可能指向一个已经被删掉的语言文件：此时回落到内置中文，
  // 否则前端会拿着一个不存在的默认值反复请求
  const fallback = langs.some((l) => l.code === configured) ? configured : "zh"
  // 目录内容随时可能变（用户丢文件进来），别让浏览器缓存住清单
  res.setHeader("Cache-Control", "no-cache")
  res.json({ langs, default: fallback })
})

router.get("/:code", (req, res) => {
  const lang = getLang(req.params.code)
  if (!lang) {
    return res.status(404).json({
      error: "没有这个语言文件",
      errorKey: "api.i18n.unknown_lang",
    })
  }
  res.setHeader("Cache-Control", "no-cache")
  res.json(lang)
})

export default router
