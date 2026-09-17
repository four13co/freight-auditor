import { useState } from 'react';
import { Check, ChevronsUpDown } from 'lucide-react';
import { cn } from 'cn';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import { useTenant } from '@/providers/TenantProvider';
import { useAuth } from '@/providers/auth-provider';

/**
 * 86e3a6rak. Only the Employee role has more than one tenant to switch
 * between today (see TenantProvider's Uncertainties note on the missing
 * Grand Client backend model) -- everyone else renders nothing, which also
 * covers the "0 tenants" case by construction.
 */
export function TenantPicker() {
  const { role } = useAuth();
  const { options, activeClient, setActiveClient, isLoading } = useTenant();
  const [open, setOpen] = useState(false);

  if (role !== 'employee' || (!isLoading && options.length === 0)) {
    return null;
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button variant="outline" role="combobox" aria-expanded={open} className="w-56 justify-between">
            <span className="truncate">{activeClient ? activeClient.name : 'Select client…'}</span>
            <ChevronsUpDown className="ml-2 size-4 shrink-0 opacity-50" />
          </Button>
        }
      />
      <PopoverContent className="w-56 p-0">
        <Command>
          <CommandInput placeholder="Search clients…" />
          <CommandList>
            <CommandEmpty>No client found.</CommandEmpty>
            <CommandGroup>
              {options.map((tenant) => (
                <CommandItem
                  key={tenant.id}
                  value={tenant.name}
                  onSelect={() => {
                    setActiveClient(tenant);
                    setOpen(false);
                  }}
                >
                  <Check className={cn('size-4', activeClient?.id === tenant.id ? 'opacity-100' : 'opacity-0')} />
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
