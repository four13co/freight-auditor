import { Link } from 'react-router-dom';
import { Building2, ClipboardList, FileSliders, FileWarning, ShieldAlert, type LucideIcon } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { buttonVariants } from '@/components/ui/button';
import { cn } from 'cn';
import { useAuth } from '@/providers/auth-provider';
import { getOwnClientId } from '@/lib/api';
import { useScopedEntities } from '@/lib/in-memory-hierarchy-store';
import { ActivityFeed, SummaryCard } from '@/pages/employee/HomePage';

type ActivityStatus = 'submitted' | 'processed' | 'approved' | 'rejected' | 'on hold';

interface ActivityItem {
  id: string;
  description: string;
  status: ActivityStatus;
  relativeTime: string;
}

/** Placeholder feed, same as Employee's HomePage -- real activity source (transaction lifecycle events) is a future item, not yet built for either role. */
const RECENT_ACTIVITY: ActivityItem[] = [
  { id: 'a1', description: 'Invoice #48213 approved for Northwind Region', status: 'approved', relativeTime: '2 minutes ago' },
  { id: 'a2', description: 'Invoice #48211 submitted for review', status: 'submitted', relativeTime: '18 minutes ago' },
  { id: 'a3', description: 'Invoice #48198 rejected — rate mismatch', status: 'rejected', relativeTime: '1 hour ago' },
  { id: 'a4', description: 'Invoice #48190 processed', status: 'processed', relativeTime: '3 hours ago' },
];

interface QuickAction {
  label: string;
  to: string;
  icon: LucideIcon;
}

/**
 * 86e3a6rgc's suggested actions ("view grand clients, check findings") name
 * a Findings destination that doesn't exist anywhere in the Account role's
 * NAV_CONFIG -- same gap Employee's HomePage (86e3a6rbe) already disclosed
 * for its own suggested actions. Substituted with this epic's three real
 * Account destinations instead (all shipped in PRs #408/#409); see this
 * PR's Uncertainties.
 */
const QUICK_ACTIONS: QuickAction[] = [
  { label: 'View Clients', to: '/account/clients', icon: Building2 },
  { label: 'Manage users', to: '/account/users', icon: ClipboardList },
  { label: 'Rules & rates', to: '/account/clients/rules-rates', icon: FileSliders },
];

function greeting(date: Date): string {
  const hour = date.getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

/**
 * 86e3a6rgc: mirrors Employee's HomePage (86e3a6rbe) -- reuses its
 * `SummaryCard`/`ActivityFeed` components directly, per this task's own AC
 * ("Reuses shared components from Employee home screen where possible") --
 * scoped to the signed-in tenant's own data. "Active Clients count" is the
 * one metric this page can source for real (the shared in-memory-
 * hierarchy-store's `client:<ownClientId>` scope, same data 86e3a6rhv's page
 * manages); the other three metrics have no backend for either role yet,
 * so they stay placeholder, same as Employee's page.
 */
export default function AccountHomePage() {
  const { user } = useAuth();
  const ownClientId = getOwnClientId();
  const { entities: grandClients } = useScopedEntities(ownClientId ? `client:${ownClientId}` : null);
  const activeGrandClientCount = grandClients.filter((e) => e.status === 'active').length;

  const now = new Date();
  const dateLabel = now.toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  const firstName = user?.name?.split(' ')[0] ?? user?.email ?? 'there';

  const summaryMetrics = [
    { label: 'Active Clients', value: String(activeGrandClientCount), icon: Building2 },
    { label: 'Transactions pending review', value: '8', icon: ClipboardList },
    { label: 'Recent findings/variances', value: '3', icon: FileWarning },
    { label: 'Open disputes', value: '1', icon: ShieldAlert },
  ];

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          {greeting(now)}, {firstName}
        </h1>
        <p className="text-sm text-muted-foreground">{dateLabel}</p>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {summaryMetrics.map((metric) => (
          <SummaryCard key={metric.label} metric={metric} />
        ))}
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Recent activity</CardTitle>
          </CardHeader>
          <CardContent>
            <ActivityFeed items={RECENT_ACTIVITY} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Quick actions</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            {QUICK_ACTIONS.map((action) => (
              <Link
                key={action.to}
                to={action.to}
                className={cn(buttonVariants({ variant: 'outline' }), 'justify-start')}
              >
                <action.icon className="size-4" aria-hidden="true" />
                {action.label}
              </Link>
            ))}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
