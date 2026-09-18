import { useState } from 'react';
import { Check, ChevronsUpDown } from 'lucide-react';
import { cn } from 'cn';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import { useTenant } from '@/providers/TenantProvider';
import { useAuth } from '@/providers/auth-provider';

/**
 * 86e3a6rak. Employee picks any Client; the Account role picks their own
 * Grand Client (see TenantProvider's doc comment on the
 * in-memory-hierarchy-store.ts stand-in). Grand Client/Vendor render
 * nothing, which also covers the "0 tenants" case by construction.
 */
export function TenantPicker() {
  const { role } = useAuth();
  const { options, activeClient, activeGrandClient, setActiveClient, setActiveGrandClient, isLoading } = useTenant();
  const [open, setOpen] = useState(false);

  const isEmployee = role === 'employee';
  const isAccount = role === 'account';

  if ((!isEmployee && !isAccount) || (!isLoading && options.length === 0)) {
    return null;
  }

  const active = isEmployee ? activeClient : activeGrandClient;
  const setActive = isEmployee ? setActiveClient : setActiveGrandClient;
  const label = isEmployee ? 'client' : 'grand client';

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button variant="outline" role="combobox" aria-expanded={open} className="w-56 justify-between">
            <span className="truncate">{active ? active.name : `Select ${label}…`}</span>
            <ChevronsUpDown className="ml-2 size-4 shrink-0 opacity-50" />
          </Button>
        }
      />
      <PopoverContent className="w-56 p-0">
        <Command>
          <CommandInput placeholder={`Search ${label}s…`} />
          <CommandList>
            <CommandEmpty>No {label} found.</CommandEmpty>
            <CommandGroup>
              {options.map((tenant) => (
                <CommandItem
                  key={tenant.id}
                  value={tenant.name}
                  onSelect={() => {
                    setActive(tenant);
                    setOpen(false);
                  }}
                >
                  <Check className={cn('size-4', active?.id === tenant.id ? 'opacity-100' : 'opacity-0')} />
                  {tenant.name}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
