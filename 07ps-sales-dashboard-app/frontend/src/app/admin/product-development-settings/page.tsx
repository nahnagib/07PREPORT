'use client';
import React from 'react';
import { AdminLayout } from '../../../components/AdminLayout';
import { AdminOnlyGuard } from '../../../components/AuthGuard';
import { TrackerSettings } from '../../../components/pdt/Settings';

/** Admin › Product Development Settings: the Product Development Plan lists and follow-up settings (Admin role only). */
export default function ProductDevelopmentSettingsPage() {
  return (
    <AdminOnlyGuard>
      <AdminLayout>
        <TrackerSettings />
      </AdminLayout>
    </AdminOnlyGuard>
  );
}
