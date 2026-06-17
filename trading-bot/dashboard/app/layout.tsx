import type { Metadata } from 'next';
import './globals.css';
import CryptoPolyfill from '@/components/CryptoPolyfill';

export const metadata: Metadata = {
  title: 'TradeBot — AI Trading Dashboard',
  description: 'Real-time AI crypto trading monitor',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="h-full">
      <body className="h-full overflow-hidden">
        <CryptoPolyfill />
        {children}
      </body>
    </html>
  );
}
