import type { ReactNode } from 'react';
import './globals.css';

export const metadata = {
  title: 'Pairspace — пространство для двоих',
  description: 'Письма, встречи и ваша общая история.',
  robots: { index: false, follow: false },
};

export default function Layout({ children }: { children: ReactNode }) {
  return <html lang="ru"><body>{children}</body></html>;
}
