import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Research2Report",
  description: "Evidence-grounded AI research report drafting MVP",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
