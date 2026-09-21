import type { Metadata } from 'next';
import '../styles/globals.css';
import { BASE_PATH } from '../lib/basePath';
import { ThemeProvider } from '../components/ThemeProvider';
import { BusinessUnitProvider } from '../components/BusinessUnitProvider';
import { AuthProvider } from '../lib/AuthProvider';
import { AuthGuard } from '../components/AuthGuard';
import { FilterProvider } from '../components/FilterProvider';
import { PdfExportContextBridge } from '../components/PdfExportContextBridge';

export const metadata: Metadata = {
  title: 'BMH - 7Ps Dashboard',
  description: '07 Ps Project - Sales/Promotion dashboard (Tachometer page, validation data)',
  // White logo for dark browser themes, black for light ones.
  icons: {
    icon: [
      { url: `${BASE_PATH}/bmh-logo-white.png`, type: 'image/png', media: '(prefers-color-scheme: dark)' },
      { url: `${BASE_PATH}/bmh-logo-black.png`, type: 'image/png', media: '(prefers-color-scheme: light)' },
    ],
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <ThemeProvider>
          <BusinessUnitProvider>
            <AuthProvider>
              <FilterProvider>
                <PdfExportContextBridge />
                <AuthGuard>{children}</AuthGuard>
              </FilterProvider>
            </AuthProvider>
          </BusinessUnitProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
