'use client';
import React, { Suspense, useCallback, useState } from 'react';
import { LoadingSkeleton } from '@07ps/ui';
import { AppHeader } from '../AppHeader';
import { BottomNavBar } from '../BottomNavBar';
import { NoAccess } from '../NoAccess';
import { RefreshFooter } from '../RefreshFooter';
import { TopTabBar, type TopTab } from '../TopTabBar';
import { ValidationStatusBar } from '../ValidationStatusBar';
import { useAuth } from '../../lib/AuthProvider';
import { formatTimestamp } from '../../lib/format';
import { useRefreshStatus } from '../../lib/hooks';
import { BASE, ENTRY, PLAN, type Row } from '../../lib/pdp/api';
import { usePdp } from '../../lib/pdp/hooks';
import { copy as t } from '../../lib/pdp/text';
import { Loaded } from './ui';
import { Overview } from './Overview';
import { Tree } from './Tree';
import { Roadmap } from './Roadmap';
import { NewProject, Projects } from './Projects';
import { ProjectDetail } from './ProjectDetail';
import { Launches } from './Launches';
import { Feedback } from './Feedback';
import { Policy } from './Policy';
import { Admin } from './Admin';
import { TrackerDashboard } from '../pdt/Dashboard';
import { TrackerEntry } from '../pdt/Entry';
import { TRACKER, type Options as TrackerOptions } from '../../lib/pdt/api';

export type PdpSection = 'dashboard' | 'entry' | 'overview' | 'tree' | 'roadmap' | 'projects' | 'new-project' | 'project' | 'launches' | 'feedback' | 'policy' | 'admin';

/** The dashboard and its data entry (components/pdt) read the tracker API, not the gate module's /options. */
const TRACKER_SECTIONS: readonly PdpSection[] = ['dashboard', 'entry'];

/** What every section receives: the module's /options payload (drop-downs, tree pickers, governance, the viewer's own
 * governance roles) and a refresh() that re-reads it and the section after a save. */
export interface SectionProps {
  options: Row;
  revision: number;
  refresh: () => void;
}

const TAB_OF: Record<PdpSection, keyof typeof t.tabs> = {
  dashboard: 'dashboard',
  entry: 'entry',
  overview: 'overview',
  tree: 'tree',
  roadmap: 'roadmap',
  projects: 'projects',
  'new-project': 'projects',
  project: 'projects',
  launches: 'launches',
  feedback: 'feedback',
  policy: 'policy',
  admin: 'admin',
};
const HREF: Record<keyof typeof t.tabs, string> = {
  dashboard: BASE,
  entry: `${BASE}/entry`,
  overview: `${BASE}/gates`,
  tree: `${BASE}/tree`,
  roadmap: `${BASE}/roadmap`,
  projects: `${BASE}/projects`,
  launches: `${BASE}/launches`,
  feedback: `${BASE}/feedback`,
  policy: `${BASE}/policy`,
  admin: `${BASE}/admin`,
};

function renderSection(section: PdpSection, props: SectionProps, code?: string) {
  switch (section) {
    case 'tree':
      return <Tree {...props} />;
    case 'roadmap':
      return <Roadmap {...props} />;
    case 'projects':
      return <Projects {...props} />;
    case 'new-project':
      return <NewProject {...props} />;
    case 'project':
      return <ProjectDetail {...props} code={code ?? ''} />;
    case 'launches':
      return <Launches {...props} />;
    case 'feedback':
      return <Feedback {...props} />;
    case 'policy':
      return <Policy {...props} />;
    case 'admin':
      return <Admin {...props} />;
    default:
      return <Overview {...props} />;
  }
}

/** The TIKA gate module's screens: Admin only since the 2026-11-18 redesign (reached from Admin › Product Development Settings). */
const GATE_TABS: readonly (keyof typeof t.tabs)[] = ['overview', 'tree', 'roadmap', 'projects', 'launches', 'feedback', 'policy', 'admin'];

/**
 * Product → Product Development Plan. Same chrome as the other Product pages (AppHeader, the app's top tab strip,
 * RefreshFooter, BottomNavBar).
 *   dashboard / entry   the pipeline dashboard and its data entry (components/pdt): tabs Dashboard · Data entry & follow-up.
 *   every other section the TIKA gate module (/gates, /tree, /projects, ...): Admin role only, with its own tab strip.
 */
export default function PdpPage({ section = 'dashboard', code }: { section?: PdpSection; code?: string }) {
  const { user, token, logout, canView, isAdmin, error: authError, retryAuth } = useAuth();
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision((n) => n + 1), []);
  const tracker = TRACKER_SECTIONS.includes(section);
  // The tracker reads with plan View (dashboard) or entry View; the entry screens need entry View; the gate module is Admin only.
  const allowed = tracker ? (section === 'entry' ? canView(ENTRY) : canView(PLAN) || canView(ENTRY)) : isAdmin;
  const options = usePdp<Row>(allowed && !tracker ? '/options' : null, revision);
  const trackerOptions = usePdp<TrackerOptions>(allowed && tracker ? `${TRACKER}/options` : null, revision);
  const refreshStatus = useRefreshStatus(token, authError, retryAuth);
  if (!allowed) return <NoAccess message={tracker ? t.noAccess : 'The R&D gate screens are reserved for the Admin role.'} />;

  const tabKeys: (keyof typeof t.tabs)[] = tracker
    ? (['dashboard', 'entry'] as const).filter((k) => (k === 'entry' ? canView(ENTRY) : canView(PLAN) || canView(ENTRY)))
    : [...GATE_TABS];
  const tabs: TopTab[] = tabKeys.map((k) => ({ label: t.tabs[k], href: HREF[k] }));
  const active = t.tabs[TAB_OF[section]];
  const withWarehouse = section === 'launches';

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', paddingBottom: 64 }}>
      <AppHeader
        subTitle={section === 'project' && code ? code : section === 'new-project' ? 'New project' : undefined}
        anchorDate=""
        onAnchorDateChange={() => undefined}
        roleLabel={user?.role.label ?? user?.fullName}
        onLogout={logout}
        showDateInput={false}
      />
      <TopTabBar active={active} tabs={tabs} />
      {withWarehouse && (
        <ValidationStatusBar
          isStale={refreshStatus.data?.isStale}
          isInverted={refreshStatus.data?.isInverted}
          refreshCheck={refreshStatus.data?.refreshCheck}
          lastRefreshTime={refreshStatus.data ? formatTimestamp(refreshStatus.data.lastRefreshTime) : undefined}
        />
      )}
      <main data-testid="pdp-main" style={{ flex: 1, padding: 'var(--ps-space-4, 24px)', display: 'flex', flexDirection: 'column', gap: 'var(--ps-space-4, 24px)', minWidth: 0 }}>
        {tracker ? (
          <Loaded state={trackerOptions} skeleton="kpi">
            {(o) =>
              section === 'entry' ? <TrackerEntry options={o} revision={revision} refresh={refresh} /> : <TrackerDashboard options={o} revision={revision} refresh={refresh} />
            }
          </Loaded>
        ) : (
          <Loaded state={options} skeleton="kpi">
            {(o) => <Suspense fallback={<LoadingSkeleton variant="table" />}>{renderSection(section, { options: o, revision, refresh }, code)}</Suspense>}
          </Loaded>
        )}
      </main>
      {withWarehouse && (
        <RefreshFooter
          lastUpdate={formatTimestamp(refreshStatus.data?.lastUpdate ?? null)}
          lastOrderCreated={formatTimestamp(refreshStatus.data?.lastOrderCreated ?? null)}
          lastRefreshTime={formatTimestamp(refreshStatus.data?.lastRefreshTime ?? null)}
        />
      )}
      <BottomNavBar active="Product Development Plan" />
    </div>
  );
}
