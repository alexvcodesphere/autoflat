/**
 * Die Schriften liegen unter app/fonts/ und werden lokal geladen, nicht von
 * fonts.googleapis.com. Grund: ein Build soll kein Netz brauchen. Bei einem
 * Werkzeug, das lokal läuft, ist eine Build-Zeit-Abhängigkeit von einem
 * fremden CDN ein Fehler, der zur ungünstigsten Zeit auffällt.
 */
import localFont from "next/font/local"
import Link from "next/link"

import "./globals.css"
import { ThemeProvider } from "@/components/theme-provider"
import { ThemeToggle } from "@/components/theme-toggle"
import { Toaster } from "@/components/ui/sonner"
import { LiveRefresh } from "@/components/live-refresh"
import { CostFooter } from "@/components/cost-footer"
import { cn } from "@/lib/utils"

const notoSerifHeading = localFont({
  src: "./fonts/NotoSerif-Variable.woff2",
  weight: "100 900", display: "swap", variable: "--font-heading",
})
const geist = localFont({
  src: "./fonts/Geist-Variable.woff2",
  weight: "100 900", display: "swap", variable: "--font-sans",
})
const fontMono = localFont({
  src: "./fonts/GeistMono-Variable.woff2",
  weight: "100 900", display: "swap", variable: "--font-mono",
})

export const metadata = {
  title: "autoflat",
  description: "Aus einer Wohnungsanzeige wird eine sendefertige Bewerbungsmail",
}

/**
 * "Einfügen" steht bewusst nicht hier. Bei leerer Queue ist das Feld die
 * Seite, bei gefüllter führt "Weiteres einfügen" hin — die Aktion gehört in
 * den Zusammenhang, nicht in eine Dauer-Navigation.
 */
const NAV = [
  { href: "/", label: "Queue" },
  { href: "/firmen", label: "Firmen" },
]

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="de"
      suppressHydrationWarning
      className={cn("antialiased", fontMono.variable, "font-sans", geist.variable, notoSerifHeading.variable)}
    >
      <body className="text-sm">
        <ThemeProvider>
          <div className="mx-auto flex min-h-screen max-w-3xl flex-col px-6 py-8">
            <header className="mb-10 flex items-center justify-between gap-4">
              <nav className="flex items-baseline gap-5">
                <Link href="/" className="font-heading text-base font-semibold">autoflat</Link>
                {NAV.map((item) => (
                  <Link key={item.href} href={item.href}
                    className="text-muted-foreground hover:text-foreground text-sm transition-colors">
                    {item.label}
                  </Link>
                ))}
              </nav>
              <div className="flex items-center gap-3">
                <LiveRefresh />
                <ThemeToggle />
              </div>
            </header>

            <div className="flex-1">{children}</div>

            <CostFooter />
          </div>
          <Toaster />
        </ThemeProvider>
      </body>
    </html>
  )
}
