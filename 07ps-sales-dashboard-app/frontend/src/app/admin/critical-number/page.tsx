'use client';
import React, { useEffect, useState } from 'react';
import { Card, VisualInfoIcons } from '@07ps/ui';
import { AdminLayout } from '../../../components/AdminLayout';
import { useAuth } from '../../../lib/AuthProvider';
import { adminApi } from '../../../lib/api';
import { vh } from '../../../lib/visualHelp';
export default function CriticalNumberSettings() {
  const { token, isAdmin } = useAuth();
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  useEffect(() => { if (isAdmin && token) adminApi.getCriticalNumber(token).then(r => setValue(String(r.value))).catch(e => setMessage(e.message)); }, [token, isAdmin]);
  if (!isAdmin) return <AdminLayout>Administrator access required.</AdminLayout>;
  return <AdminLayout><Card><h2>Daily Critical Number <VisualInfoIcons title="Daily Critical Number" {...vh('admin.criticalNumber.setting')} /></h2>
    <p>Base daily sales pace in LYD. Company and customer-group percentages apply to this amount. Changes take effect on the next dashboard load.</p>
    <form onSubmit={async e => { e.preventDefault(); setBusy(true); setMessage(''); try { const r = await adminApi.setCriticalNumber(token, Number(value)); setValue(String(r.value)); setMessage('Saved'); } catch (err) { setMessage((err as Error).message); } finally { setBusy(false); } }}>
      <label>Daily Critical Number (LYD) <input type="number" min="0.01" step="0.01" required value={value} onChange={e => setValue(e.target.value)} /></label>
      <button disabled={busy || !value} type="submit">{busy ? 'Saving…' : 'Save'}</button><p role="status">{message}</p>
    </form></Card></AdminLayout>;
}
