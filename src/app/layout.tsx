import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Koya Content Agent",
  description:
    "Research, draft, evaluate and publish channel-ready content, grounded in sources you can check.",
};

/**
 * The document, and nothing else.
 *
 * The app's nav, the signed-in identity and the demo-mode badge used to live
 * here, so a PUBLIC article at /a/[slug] rendered with the whole workspace
 * around it: a stranger following a shared link saw the dashboard nav and the
 * name of the person who approved the piece.
 *
 * The chrome now lives in `(app)/layout.tsx`, which only wraps the signed-in
 * routes. `/a`, `/confirm` and `/unsubscribe` are public and get the bare
 * document.
 */
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
