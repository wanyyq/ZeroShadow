import { useEffect } from "react"
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom"
import { ThemeProvider } from "@/components/theme-provider"
import { ErrorBoundary } from "@/components/error-boundary"
import { TooltipProvider } from "@/components/ui/tooltip"
import { Toaster } from "@/components/ui/sonner"
import { AuthProvider, useAuth } from "@/state/auth"
import { GroupsProvider } from "@/state/groups"
import { ClientSettingsProvider } from "@/state/client-settings"
import { ClipboardProvider } from "@/state/clipboard"
import { UploadsProvider } from "@/state/uploads"
import { OperationsProvider } from "@/state/operations"
import { syncAvatars } from "@/lib/avatar-cache"
import { BrowserPage } from "@/pages/browser-page"
import { LoginPage } from "@/pages/login-page"
import { SettingsPage } from "@/pages/settings"
import { TeamPage } from "@/pages/team-page"
import PreviewPage from "@/pages/preview-page"
import EditorPage from "@/pages/editor-page"
import HtmlPage from "@/pages/html-page"
import { ToolsPage } from "@/pages/tools-page"
import { AboutPage } from "@/pages/about-page"

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
        <AuthProvider>
          <GroupsProvider>
            <AvatarSync />
            <ClientSettingsProvider>
              <ClipboardProvider>
                <UploadsProvider>
                  <OperationsProvider>
                    <TooltipProvider delay={300}>
                      <BrowserRouter>
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
                          <Route path="*" element={<Navigate to="/" replace />} />
                        </Routes>
                      </BrowserRouter>
                      <Toaster position="bottom-center" />
                    </TooltipProvider>
                  </OperationsProvider>
                </UploadsProvider>
              </ClipboardProvider>
            </ClientSettingsProvider>
          </GroupsProvider>
        </AuthProvider>
      </ErrorBoundary>
    </ThemeProvider>
  )
}
