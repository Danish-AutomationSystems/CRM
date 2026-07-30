import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'AS CRM',
  description: 'Automation Systems CRM — Sales pipeline and customer management'
};

export default function RootLayout({
  children
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
      </head>
      <body>{children}</body>
    </html>
  );
}
