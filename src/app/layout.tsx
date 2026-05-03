import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Senfoni Chat — Secure Terminal Messenger',
  description: 'End-to-end encrypted terminal-style chat platform. API key authenticated, moderator controlled.',
  robots: 'noindex, nofollow',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="tr">
      <body>{children}</body>
    </html>
  );
}
