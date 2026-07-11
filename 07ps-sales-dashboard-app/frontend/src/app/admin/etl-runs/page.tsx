'use client';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Superseded by the ETL Control Center (/admin/etl-control), which subsumes this page's
 * read-only history plus live status, manual execution, and cancellation. Kept as a redirect
 * rather than deleted so old bookmarks/links still land somewhere useful. The backend
 * `/admin/etl-runs/log|audit` endpoints this page used are left in place, unused but harmless.
 */
export default function AdminEtlRunsRedirectPage() {
  const router = useRouter();
  useEffect(() => {
    router.replace('/admin/etl-control');
  }, [router]);
  return null;
}
