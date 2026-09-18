import { Link } from 'react-router-dom';
import { Building2, ClipboardList, FileSliders, FileWarning, ShieldAlert, Users, type LucideIcon } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { buttonVariants } from '@/components/ui/button';
import { cn } from 'cn';
import { useAuth } from '@/providers/auth-provider';

interface SummaryMetric {
  label: string;
  value: string;
  icon: typeof Building2;
}

/** Placeholder counts -- 86e3a6rbe AC says "placeholder data is fine for now, but wire the card structure". */
const SUMMARY_METRICS: SummaryMetric[] = [
  { label: 'Active clients', value: '24', icon: Building2 },
  { label: 'Transactions pending review', value: '132', icon: ClipboardList },
  { label: 'Recent findings/variances', value: '17', icon: FileWarning },
  { label: 'Open disputes', value: '5', icon: ShieldAlert },
];

type ActivityStatus = 'submitted' | 'processed' | 'approved' | 'rejected' | 'on hold';

const STATUS_BADGE_VARIANT: Record<ActivityStatus, 'secondary' | 'default' | 'destructive' | 'outline'> = {
  submitted: 'secondary',
  processed: 'outline',
  approved: 'default',
  rejected: 'destructive',
  'on hold': 'secondary',
};

interface ActivityItem {
  id: string;
  description: string;
  status: ActivityStatus;
  relativeTime: string;
}

/** Placeholder feed -- real activity source (transaction lifecycle events) is a future item. */
const RECENT_ACTIVITY: ActivityItem[] = [
  { id: 'a1', description: 'Invoice #48213 approved for Acme Freight', status: 'approved', relativeTime: '2 minutes ago' },
  { id: 'a2', description: 'Invoice #48211 submitted by Beacon Logistics', status: 'submitted', relativeTime: '18 minutes ago' },
  { id: 'a3', description: 'Invoice #48198 rejected — rate mismatch', status: 'rejected', relativeTime: '1 hour ago' },
  { id: 'a4', description: 'Invoice #48190 processed for Meridian Carriers', status: 'processed', relativeTime: '3 hours ago' },
  { id: 'a5', description: 'Invoice #48176 placed on hold pending documentation', status: 'on hold', relativeTime: 'Yesterday' },
];

interface QuickAction {
  label: string;
  to: string;
  icon: LucideIcon;
}

/**
 * 86e3a6rbe's suggested actions (upload invoice, view findings, manage
 * clients) name two destinations that don't exist as routes anywhere in
 * NAV_CONFIG yet (findings/upload aren't part of the Employee nav tree
 * built by 86e3a6r30's other subtasks) -- routing a button at a path with
 * no matching <Route> would 404. Substituted with this epic's three real
 * Employee destinations instead; see this PR's Uncertainties.
 */
const QUICK_ACTIONS: QuickAction[] = [
  { label: 'Manage accounts', to: '/employee/accounts', icon: Building2 },
  { label: 'Manage users', to: '/employee/users', icon: Users },
  { label: 'Rules & rates', to: '/employee/rules-rates', icon: FileSliders },
];

function greeting(date: Date): string {
  const hour = date.getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

export function SummaryCard({ metric }: { metric: SummaryMetric }) {
  const Icon = metric.icon;
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">{metric.label}</CardTitle>
        <Icon className="size-4 text-muted-foreground" aria-hidden="true" />
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-semibold tracking-tight">{metric.value}</div>
      </CardContent>
    </Card>
  );
}

export function ActivityFeed({ items }: { items: ActivityItem[] }) {
  return (
    <ul className="flex flex-col gap-3">
      {items.map((item) => (
        <li key={item.id} className="flex items-center justify-between gap-4 text-sm">
          <div className="flex flex-col">
            <span>{item.description}</span>
            <span className="text-xs text-muted-foreground">{item.relativeTime}</span>
          </div>
          <Badge variant={STATUS_BADGE_VARIANT[item.status]} className="shrink-0 capitalize">
            {item.status}
          </Badge>
        </li>
      ))}
    </ul>
  );
}

export default function EmployeeHomePage() {
  const { user } = useAuth();
  const now = new Date();
  const dateLabel = now.toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  const firstName = user?.name?.split(' ')[0] ?? user?.email ?? 'there';

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          {greeting(now)}, {firstName}
        </h1>
        <p className="text-sm text-muted-foreground">{dateLabel}</p>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {SUMMARY_METRICS.map((metric) => (
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
