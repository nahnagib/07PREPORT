import type { Metadata } from 'next';
import '../styles/globals.css';
import { ThemeProvider } from '../components/ThemeProvider';
import { BusinessUnitProvider } from '../components/BusinessUnitProvider';
import { AuthProvider } from '../lib/AuthProvider';
import { AuthGuard } from '../components/AuthGuard';

export const metadata: Metadata = {
  title: 'BMH – Sales Dashboard', // Section 3.26 naming convention: [Group] – [Department] Dashboard
  description: '07 Ps Project - Sales/Promotion dashboard (Tachometer page, validation data)',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <ThemeProvider>
          <BusinessUnitProvider>
            <AuthProvider>
              <AuthGuard>{children}</AuthGuard>
            </AuthProvider>
          </BusinessUnitProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
