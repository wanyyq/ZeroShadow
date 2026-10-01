declare global {
  interface Window {
    lucide?: {
      createIcons: (options?: unknown) => void
    }
    gsap?: {
      from: (targets: unknown, vars: Record<string, unknown>) => unknown
      to: (targets: unknown, vars: Record<string, unknown>) => unknown
      fromTo: (targets: unknown, fromVars: Record<string, unknown>, toVars: Record<string, unknown>) => unknown
      set: (targets: unknown, vars: Record<string, unknown>) => unknown
    }
  }
}

let scheduled = false

export function renderIcons() {
  if (scheduled) return
  scheduled = true
  requestAnimationFrame(() => {
    scheduled = false
    try {
      window.lucide?.createIcons()
    } catch {
      /* lucide 尚未加载完成 */
    }
  })
}

function hasIconPlaceholder(node: Node): boolean {
  if (!(node instanceof Element)) return false
  if (node.tagName === "I" && node.hasAttribute("data-lucide")) return true
  return node.querySelector?.("i[data-lucide]") !== null
}

/** 监听动态插入的 DOM，自动初始化 data-lucide 图标（AIGC.md 规范） */
export function initLucide() {
  const boot = () => renderIcons()
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true })
  } else {
    boot()
  }
  window.addEventListener("load", boot, { once: true })

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (hasIconPlaceholder(node)) {
          renderIcons()
          return
        }
      }
    }
  })
  observer.observe(document.body, { childList: true, subtree: true })
}

export function animateListIn(container: HTMLElement | null) {
  if (!container || !window.gsap) return
  // 「减少动画」由 client-settings 写在 <html data-reduce-motion> 上：
  // CSS 压不掉 GSAP 设的 inline 样式，必须在这里主动跳过
  if (document.documentElement.dataset.reduceMotion === "1") return
  const items = container.querySelectorAll("[data-animate-item]")
  if (!items.length || items.length > 80) return
  try {
    window.gsap.from(items, {
      opacity: 0,
      y: 6,
      duration: 0.28,
      ease: "power2.out",
      stagger: 0.015,
      clearProps: "all",
    })
  } catch {
    /* 动画失败不影响功能 */
  }
}

export function animatePageIn(el: HTMLElement | null) {
  if (!el || !window.gsap) return
  if (document.documentElement.dataset.reduceMotion === "1") return
  try {
    window.gsap.from(el, {
      opacity: 0,
      y: 10,
      duration: 0.35,
      ease: "power2.out",
      clearProps: "all",
    })
  } catch {
    /* ignore */
  }
}

/**
 * 切换明暗主题时给整页一个很轻的淡入。
 * 只淡 opacity，不动布局，所以不会引起重排；「减少动画」开启时直接跳过。
 */
export function animateThemeSwap(el: HTMLElement | null) {
  if (!el || !window.gsap) return
  if (document.documentElement.dataset.reduceMotion === "1") return
  try {
    window.gsap.fromTo(
      el,
      { opacity: 0.55 },
      { opacity: 1, duration: 0.24, ease: "power1.out", clearProps: "opacity" }
    )
  } catch {
    /* ignore */
  }
}

/** 侧边栏导航首次渲染时的轻微错落入场（只跑一次，之后交给 CSS hover） */
export function animateSidebarIn(container: HTMLElement | null) {
  if (!container || !window.gsap) return
  if (document.documentElement.dataset.reduceMotion === "1") return
  const rows = container.querySelectorAll("button")
  if (!rows.length || rows.length > 20) return
  try {
    window.gsap.from(rows, {
      opacity: 0,
      x: -8,
      duration: 0.3,
      ease: "power2.out",
      stagger: 0.03,
      clearProps: "all",
    })
  } catch {
    /* ignore */
  }
}
