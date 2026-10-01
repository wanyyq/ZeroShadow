declare global {
  interface Window {
    lucide?: {
      createIcons: (options?: unknown) => void
    }
    gsap?: {
      from: (targets: unknown, vars: Record<string, unknown>) => GsapTween
      to: (targets: unknown, vars: Record<string, unknown>) => GsapTween
      fromTo: (targets: unknown, fromVars: Record<string, unknown>, toVars: Record<string, unknown>) => GsapTween
      set: (targets: unknown, vars: Record<string, unknown>) => GsapTween
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

/* ============================================================================
   动画
   规则来自 gsap-core / gsap-performance 两条 skill，以及上一版踩过的坑：

   1. **只动 transform 与 opacity**（`x`/`y`/`scale`/`opacity`），
      不碰 width/height/top/left —— 那些会逐帧触发布局。
   2. **绝不给 `<html>` 或整页容器做动画**。上一版对 documentElement 淡入、
      又给整页容器做 y 位移，等于每帧重绘/合成整屏，好机器都掉帧，
      学校机房那种机器更不用说。整页级别的动画一律不做。
   3. **同一批元素只保留一个 tween**：列表刷新很频繁，不 kill 旧 tween 就会
      叠成好几个同时跑，既闪又费。
   4. **限制数量**：只对前 N 个可见项做错落，长列表直接放弃动画。
   5. 尊重「减少动画」设置，**也尊重系统的 prefers-reduced-motion**。
   ========================================================================== */

/** 参与错落入场的最大元素数，超出就不做动画（长列表动画只会拖慢首屏） */
const MAX_STAGGER_ITEMS = 36

interface GsapTween {
  kill: () => void
}

function motionDisabled() {
  if (typeof document === "undefined") return true
  if (document.documentElement.dataset.reduceMotion === "1") return true
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true
}

// 记住上一次的列表动画，新的开始前先杀掉，避免叠加
let listTween: GsapTween | null = null

/**
 * 列表错落入场：仅 opacity + 4px 上移，0.18s。
 * 幅度刻意做小——列表是高频刷新的区域，动作越大越像「闪一下」。
 */
export function animateListIn(container: HTMLElement | null) {
  if (!container) return
  listTween?.kill()
  listTween = null
  if (!window.gsap || motionDisabled()) return
  const items = Array.from(container.querySelectorAll("[data-animate-item]")).slice(0, MAX_STAGGER_ITEMS)
  if (!items.length) return
  try {
    listTween = window.gsap.from(items, {
      opacity: 0,
      y: 4,
      duration: 0.18,
      ease: "power1.out",
      stagger: 0.012,
      overwrite: true,
      clearProps: "opacity,transform",
    })
  } catch {
    /* 动画失败不影响功能 */
  }
}

/**
 * 单个小元素的入场（登录卡片这类）。
 * 只给**小元素**用：传整页容器进来就会变成整屏重绘。
 */
export function animatePageIn(el: HTMLElement | null) {
  if (!el || !window.gsap || motionDisabled()) return
  try {
    window.gsap.from(el, {
      opacity: 0,
      y: 8,
      duration: 0.28,
      ease: "power2.out",
      clearProps: "opacity,transform",
    })
  } catch {
    /* ignore */
  }
}
