import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import './globals.css';

export const metadata: Metadata = {
  title: 'LeadRadar',
  description:
    'Find local businesses that need website, SEO, social, and automation work — with the evidence for why.',
};

/**
 * `children` is typed explicitly rather than with Next 16's generated
 * `LayoutProps` global, because that type only exists after a build has written
 * `.next/types`. Depending on it would make `npm run typecheck` fail on a clean
 * checkout, which is exactly when it needs to work.
 */
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="flex min-h-full flex-col">{children}</body>
    </html>
  );
}
