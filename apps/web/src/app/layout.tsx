import type { Metadata } from "next";
import { Toaster } from "sonner";
import { SentryProvider } from "@/components/sentry-provider";
import "./globals.css";

export const metadata: Metadata = {
  title: "AgentHiFive",
  description: "Authority delegation platform for AI agents",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-background font-sans text-foreground antialiased">
        <SentryProvider>
          {children}
        </SentryProvider>
        <Toaster richColors position="top-center" />
      </body>
    </html>
  );
}
