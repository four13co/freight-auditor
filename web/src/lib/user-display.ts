/**
 * 86e38pz8e: shared between Sidebar.tsx's and PortalApp.tsx's new user
 * menus (and ProfileView.tsx) so "how do we label a signed-in user" is
 * computed once, not hand-duplicated per chrome.
 */
export function getDisplayName(name: string | null | undefined, email: string | null | undefined): string {
  const trimmedName = name?.trim();
  if (trimmedName) return trimmedName;
  return email ?? 'Account';
}

/** Initials for an avatar badge: first letters of up to two name words, else the email's first letter. */
export function getInitials(name: string | null | undefined, email: string | null | undefined): string {
  const trimmedName = name?.trim();
  if (trimmedName) {
    const parts = trimmedName.split(/\s+/).filter(Boolean);
    const initials = parts.slice(0, 2).map((part) => part[0]!.toUpperCase()).join('');
    if (initials) return initials;
  }
  const trimmedEmail = email?.trim();
  if (trimmedEmail) return trimmedEmail[0]!.toUpperCase();
  return '?';
}
