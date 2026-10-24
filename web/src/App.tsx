import { lazy, Suspense, useEffect } from "react"
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom"
import { ThemeProvider } from "@/components/theme-provider"
import { ErrorBoundary } from "@/components/error-boundary"
import { TooltipProvider } from "@/components/ui/tooltip"
import { Toaster } from "@/components/ui/sonner"
import { ConfirmProvider } from "@/components/confirm-dialog"
import { Spinner } from "@/components/ui/spinner"
import { AuthProvider, useAuth } from "@/state/auth"
import { I18nProvider } from "@/lib/i18n"
import { GroupsProvider } from "@/state/groups"
import { ClientSettingsProvider } from "@/state/client-settings"
import { ClipboardProvider } from "@/state/clipboard"
import { UploadsProvider } from "@/state/uploads"
import { OperationsProvider } from "@/state/operations"
import { syncAvatars } from "@/lib/avatar-cache"
import { BrowserPage } from "@/pages/browser-page"
import { LoginPage } from "@/pages/login-page"

/**
 * 路由级懒加载（v1.2.1「首屏瘦身」）。
 *
 * 背景：主包原先 900KB 左右，弱网下首屏要等好几秒 —— 而设置页、编辑器、预览页、
 * 分享页这些东西，绝大多数访问者在首屏根本用不到。
 *
 * 取舍：
 *   - **文件浏览页与登录页保持同步导入**（它们是首屏/last-mile 的主路径，
 *     懒加载只会多一次往返）；
 *   - 其余页面全部 `import()`，由 Vite 自动拆成独立 chunk，进入该路由时才下载；
 *   - 切语言、切主题等 Provider 仍在最外层，页面 chunk 只负责页面本身。
 */
const SettingsPage = lazy(() => import("@/pages/settings").then((m) => ({ default: m.SettingsPage })))
const TeamPage = lazy(() => import("@/pages/team-page").then((m) => ({ default: m.TeamPage })))
const PreviewPage = lazy(() => import("@/pages/preview-page"))
const EditorPage = lazy(() => import("@/pages/editor-page"))
const HtmlPage = lazy(() => import("@/pages/html-page"))
const ToolsPage = lazy(() => import("@/pages/tools-page").then((m) => ({ default: m.ToolsPage })))
const AboutPage = lazy(() => import("@/pages/about-page").then((m) => ({ default: m.AboutPage })))
const SharePage = lazy(() => import("@/pages/share-page"))
/**
 * WebMCP 也走懒加载：它的工具定义（十来个 JSON Schema + 描述）有 ~9KB，
 * 而对 99% 的访客来说浏览器根本没有 `navigator.modelContext`（Chrome 实验特性），
 * 把它打进主包等于为了一个用不上的功能让所有人多下一段代码。
 * 这里只做一次特性检测，支持时才去下载那个 chunk。
 */
const WebMcpBridge = lazy(() => import("@/state/webmcp").then((m) => ({ default: m.WebMcpBridge })))
const hasWebMcp = typeof navigator !== "undefined" && "modelContext" in navigator

function PageFallback() {
  return (
    <div className="flex min-h-dvh flex-1 items-center justify-center">
      <Spinner />
    </div>
  )
}

// 登录后同步头像列表（仅下载 md5 变动的头像）
function AvatarSync() {
  const { me, ready } = useAuth()
  useEffect(() => {
    if (ready && me.role !== "guest") void syncAvatars()
  }, [ready, me.role, me.userId])
  return null
}

export default function App() {
  return (
    <ThemeProvider defaultTheme="system" storageKey="zs-theme">
      <ErrorBoundary>
        {/* 语言放在最外层：登录页、错误边界里的提示，以及下面所有 Provider 都可能用到它 */}
        <I18nProvider>
          <AuthProvider>
            <GroupsProvider>
              <AvatarSync />
              {/* WebMCP：把当前账号的能力注册成浏览器 AI 代理可调用的工具。
                  只有支持 navigator.modelContext 的浏览器才会下载并执行这段代码，
                  其余浏览器既不多请求、也不多解析。
                  它挂在 ClientSettingsProvider **内部**（见下），因为注册前必须先看
                  用户的显式授权（「设置 → 外观 → 允许浏览器 AI 调用网盘」，默认关）。 */}
              <ClientSettingsProvider>
                {hasWebMcp && (
                  <Suspense fallback={null}>
                    <WebMcpBridge />
                  </Suspense>
                )}
                <ClipboardProvider>
                  <UploadsProvider>
                    <OperationsProvider>
                      <TooltipProvider delay={300}>
                        <ConfirmProvider>
                          <BrowserRouter>
                            <Suspense fallback={<PageFallback />}>
                              <Routes>
                                <Route path="/" element={<BrowserPage />} />
                                <Route path="/login" element={<LoginPage />} />
                                <Route path="/settings" element={<SettingsPage />} />
                                <Route path="/team" element={<TeamPage />} />
                                <Route path="/preview" element={<PreviewPage />} />
                                <Route path="/editor" element={<EditorPage />} />
                                <Route path="/html-preview" element={<HtmlPage />} />
                                <Route path="/tools" element={<ToolsPage />} />
                                <Route path="/about" element={<AboutPage />} />
                                {/* 公开分享页：不需要登录，也不套 AppShell */}
                                <Route path="/s/:token" element={<SharePage />} />
                                <Route path="*" element={<Navigate to="/" replace />} />
                              </Routes>
                            </Suspense>
                          </BrowserRouter>
                          <Toaster position="bottom-center" />
                        </ConfirmProvider>
                      </TooltipProvider>
                    </OperationsProvider>
                  </UploadsProvider>
                </ClipboardProvider>
              </ClientSettingsProvider>
            </GroupsProvider>
          </AuthProvider>
        </I18nProvider>
      </ErrorBoundary>
    </ThemeProvider>
  )
}
