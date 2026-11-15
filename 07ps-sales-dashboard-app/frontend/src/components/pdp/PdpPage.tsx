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
import { APPROVAL, BASE, ENTRY, PLAN, type Row } from '../../lib/pdp/api';
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

export type PdpSection = 'overview' | 'tree' | 'roadmap' | 'projects' | 'new-project' | 'project' | 'launches' | 'feedback' | 'policy' | 'admin';

/** What every section receives: the module's /options payload (drop-downs, tree pickers, governance, the viewer's own
 * governance roles) and a refresh() that re-reads it and the section after a save. */
export interface SectionProps {
  options: Row;
  revision: number;
  refresh: () => void;
}

const TAB_OF: Record<PdpSection, keyof typeof t.tabs> = {
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
  overview: BASE,
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

/**
 * Product → Product Development Plan (TIKA only). Same chrome as the other Product pages (AppHeader, the app's top tab
 * strip, RefreshFooter, BottomNavBar); every section is one route (/tree, /roadmap, /projects, ...). Readable with the
 * plan page, the data-entry page or the approval page; the forms inside check their own actions.
 */
export default function PdpPage({ section = 'overview', code }: { section?: PdpSection; code?: string }) {
  const { user, token, logout, canView, canEdit, isAdmin, error: authError, retryAuth } = useAuth();
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision((n) => n + 1), []);
  const allowed = [PLAN, ENTRY, APPROVAL].some(canView);
  const options = usePdp<Row>(allowed ? '/options' : null, revision);
  const refreshStatus = useRefreshStatus(token, authError, retryAuth);
  if (!allowed) return <NoAccess message={t.noAccess} />;

  const tabKeys = (Object.keys(t.tabs) as (keyof typeof t.tabs)[]).filter((k) => k !== 'admin' || canEdit(ENTRY) || isAdmin);
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
        <Loaded state={options} skeleton="kpi">
          {(o) => <Suspense fallback={<LoadingSkeleton variant="table" />}>{renderSection(section, { options: o, revision, refresh }, code)}</Suspense>}
        </Loaded>
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
