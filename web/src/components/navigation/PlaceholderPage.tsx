/**
 * Stub for a nav destination whose real screen is a separate, not-yet-built
 * epic (86e3a6r30 Employee UI / 86e3a6r3b Client UI). Exists so every nav
 * item routes to *something* now (86e3a6r9c AC: "route correctly even if
 * pages are placeholder/empty for now") instead of a router 404.
 */
export function PlaceholderPage({ title }: { title: string }) {
  return (
    <div className="flex flex-col gap-2">
      <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      <p className="text-sm text-muted-foreground">This screen hasn&apos;t been built yet.</p>
    </div>
  );
}
