import { SectionHeader } from "./ConsolePrimitives";

export function LoadingSkeleton() {
  return (
    <section className="surface skeleton-panel">
      <SectionHeader title="Preparing console" detail="Hydrating the latest snapshot and live transport state." />
      <div className="skeleton-grid">
        {Array.from({ length: 4 }).map((_, index) => (
          <div key={index} className="skeleton-block" />
        ))}
      </div>
    </section>
  );
}
