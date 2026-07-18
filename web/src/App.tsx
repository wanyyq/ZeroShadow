import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom"
import { ThemeProvider } from "@/components/theme-provider"
import { TooltipProvider } from "@/components/ui/tooltip"
import { Toaster } from "@/components/ui/sonner"
import { AuthProvider } from "@/state/auth"
import { ClientSettingsProvider } from "@/state/client-settings"
import { ClipboardProvider } from "@/state/clipboard"
import { UploadsProvider } from "@/state/uploads"
import { BrowserPage } from "@/pages/browser-page"
import { LoginPage } from "@/pages/login-page"
import { SettingsPage } from "@/pages/settings"

export default function App() {
  return (
    <ThemeProvider defaultTheme="system" storageKey="zs-theme">
      <AuthProvider>
        <ClientSettingsProvider>
          <ClipboardProvider>
            <UploadsProvider>
              <TooltipProvider delay={300}>
                <BrowserRouter>
                  <Routes>
                    <Route path="/" element={<BrowserPage />} />
                    <Route path="/login" element={<LoginPage />} />
                    <Route path="/settings" element={<SettingsPage />} />
                    <Route path="*" element={<Navigate to="/" replace />} />
                  </Routes>
                </BrowserRouter>
                <Toaster position="bottom-center" />
              </TooltipProvider>
            </UploadsProvider>
          </ClipboardProvider>
        </ClientSettingsProvider>
      </AuthProvider>
    </ThemeProvider>
  )
}
