export function Placeholder({ title, milestone, scope }: { title: string; milestone: string; scope: string }) {
  return (
    <div className="space-y-3">
      <h1 className="text-xl font-semibold">{title}</h1>
      <div className="card space-y-2">
        <p className="text-sm">
          This screen is not yet available in this milestone. It is scheduled for <strong>{milestone}</strong>.
        </p>
        <p className="text-sm text-neutral-600">Planned scope: {scope}</p>
      </div>
    </div>
  );
}
