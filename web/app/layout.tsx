import type { Metadata } from "next";
import { Nunito } from "next/font/google";
import { QueryProvider } from "@/lib/query/provider";
import { AppToaster } from "./components/AppToaster";
import "./globals.css";

const nunito = Nunito({
  variable: "--font-nunito",
  subsets: ["latin"],
  weight: ["300", "400", "500", "600", "700", "800", "900"],
});

export const metadata: Metadata = {
  title: "sonica - song embedding visualizer",
  description: "Music Visualizer with Embeddings Spotify player",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${nunito.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col">
        <QueryProvider>{children}</QueryProvider>
        <AppToaster />
      </body>
    </html>
  );
}
