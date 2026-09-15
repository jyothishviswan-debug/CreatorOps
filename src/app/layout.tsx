import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import "@/ui/foundation.css";

const inter = Inter({
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "CreatorOps",
  description: "CreatorOps partnership workspace",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={inter.className}>
      <body>{children}</body>
    </html>
  );
}
