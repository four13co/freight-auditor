/**
 * 86e3ankd7: the DB-layer rename turned membership_role's portal-facing
 * enum labels from client_viewer/client_admin into account_viewer/
 * account_admin. AC5 (and the No-go on touching web/) froze the HTTP wire
 * format as-is, so every route that reads or writes a portal role must
 * translate at the boundary: internal code and the DB speak account_*,
 * the wire still speaks client_* (analyst/lead pass through unchanged,
 * both directions -- they were never renamed).
 */

const DB_TO_WIRE: Record<string, string> = {
  account_viewer: 'client_viewer',
  account_admin: 'client_admin',
};

const WIRE_TO_DB: Record<string, string> = {
  client_viewer: 'account_viewer',
  client_admin: 'account_admin',
};

/** Translate a role read from the DB (membership.role) into the frozen wire value. */
export function roleDbToWire(role: string): string {
  return DB_TO_WIRE[role] ?? role;
}

/** Translate a role received over the wire into the DB's current enum label. */
export function roleWireToDb(role: string): string {
  return WIRE_TO_DB[role] ?? role;
}
