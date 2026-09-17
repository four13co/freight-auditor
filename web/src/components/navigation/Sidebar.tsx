import { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { ChevronDown } from 'lucide-react';
import { cn } from 'cn';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Separator } from '@/components/ui/separator';
import { useAuth } from '@/providers/auth-provider';
import { NAV_CONFIG, type NavItem } from '@/components/navigation/nav-config';

function isActivePath(itemPath: string, pathname: string): boolean {
  return pathname === itemPath || pathname.startsWith(`${itemPath}/`);
}

function containsActiveDescendant(item: NavItem, pathname: string): boolean {
  if (isActivePath(item.path, pathname)) return true;
  return (item.children ?? []).some((child) => containsActiveDescendant(child, pathname));
}

function NavLinkRow({
  item,
  active,
  collapsed,
  depth,
  onNavigate,
}: {
  item: NavItem;
  active: boolean;
  collapsed: boolean;
  depth: number;
  onNavigate?: () => void;
}) {
  const Icon = item.icon;
  const link = (
    <Link
      to={item.path}
      onClick={onNavigate}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm font-medium transition-colors',
        collapsed ? 'justify-center' : '',
        active ? 'bg-sidebar-accent text-sidebar-accent-foreground' : 'text-sidebar-foreground/80 hover:bg-sidebar-accent/50 hover:text-sidebar-accent-foreground',
      )}
      style={collapsed ? undefined : { paddingInlineStart: `${10 + depth * 16}px` }}
    >
      <Icon className="size-4 shrink-0" />
      {!collapsed && <span className="truncate">{item.label}</span>}
    </Link>
  );

  if (!collapsed) return link;

  return (
    <Tooltip>
      <TooltipTrigger render={link} />
      <TooltipContent side="right">{item.label}</TooltipContent>
    </Tooltip>
  );
}

function NavTree({
  items,
  collapsed,
  depth = 0,
  onNavigate,
}: {
  items: NavItem[];
  collapsed: boolean;
  depth?: number;
  onNavigate?: () => void;
}) {
  const { pathname } = useLocation();

  return (
    <ul className="flex flex-col gap-0.5">
      {items.map((item) => {
        const active = isActivePath(item.path, pathname);
        const hasChildren = Boolean(item.children?.length);

        if (!hasChildren || collapsed) {
          return (
            <li key={item.path}>
              <NavLinkRow item={item} active={active} collapsed={collapsed} depth={depth} onNavigate={onNavigate} />
            </li>
          );
        }

        return (
          <li key={item.path}>
            <NavGroup item={item} depth={depth} onNavigate={onNavigate} />
          </li>
        );
      })}
    </ul>
  );
}

function NavGroup({ item, depth, onNavigate }: { item: NavItem; depth: number; onNavigate?: () => void }) {
  const { pathname } = useLocation();
  const [open, setOpen] = useState(() => containsActiveDescendant(item, pathname));
  const Icon = item.icon;
  const active = isActivePath(item.path, pathname);

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div
        className={cn(
          'flex items-center rounded-md text-sm font-medium',
          active ? 'bg-sidebar-accent text-sidebar-accent-foreground' : 'text-sidebar-foreground/80',
        )}
      >
        <Link
          to={item.path}
          onClick={onNavigate}
          aria-current={active ? 'page' : undefined}
          className="flex flex-1 items-center gap-2.5 px-2.5 py-2 hover:text-sidebar-accent-foreground"
          style={{ paddingInlineStart: `${10 + depth * 16}px` }}
        >
          <Icon className="size-4 shrink-0" />
          <span className="truncate">{item.label}</span>
        </Link>
        <CollapsibleTrigger
          aria-label={open ? `Collapse ${item.label}` : `Expand ${item.label}`}
          className="px-2 py-2 hover:text-sidebar-accent-foreground"
        >
          <ChevronDown className={cn('size-3.5 transition-transform', open ? 'rotate-180' : '')} />
        </CollapsibleTrigger>
      </div>
      <CollapsibleContent>
        <NavTree items={item.children ?? []} collapsed={false} depth={depth + 1} onNavigate={onNavigate} />
      </CollapsibleContent>
    </Collapsible>
  );
}

export function Sidebar({ collapsed, onNavigate }: { collapsed: boolean; onNavigate?: () => void }) {
  const { role } = useAuth();
  if (!role) return null;

  return (
    <nav aria-label="Main navigation" className="flex h-full flex-col gap-1 p-2">
      <NavTree items={NAV_CONFIG[role]} collapsed={collapsed} onNavigate={onNavigate} />
      {!collapsed && <Separator className="my-2" />}
    </nav>
  );
}
