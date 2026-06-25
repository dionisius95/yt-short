import type { Metadata } from 'next';
import '../styles/globals.css';
import { ElectronBanner } from '../components/ui/ElectronBanner';

export const metadata: Metadata = {
  title: 'AI Shorts Generator',
  description: 'Transform long-form YouTube videos into viral short-form clips',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <head />
      <body className="min-h-screen bg-background text-text-primary antialiased font-sans">
        {children}
        <ElectronBanner />
      </body>
    </html>
  );
}
