// Development only (#preview): the note band of every page and the inks,
// drawn without a server, to check the print at a glance.

import { NoteBand } from "./print";
import { PalettePicker, UvSwitch } from "./inks";
import { Button, Status } from "./ui";

const titles = ["Overview", "Sales register", "Samples", "Findings", "Graph", "Audit trail", "Export", "Upload", "Requests", "Records"];

export default function Preview() {
  return (
    <div className="min-h-full bg-canvas p-8">
      <div className="mb-6 flex items-center gap-4">
        <PalettePicker />
        <UvSwitch />
      </div>
      {titles.map((t, i) => (
        <NoteBand key={t} title={t} eyebrow={i === 0 ? "Revenue audit, 1 Apr 2025 to 31 Mar 2026" : undefined} summary={i % 3 === 1 ? "A line of summary under the title, as a page gives it." : undefined} action={i === 2 ? <Button>Test the evidence</Button> : i === 6 ? <Status tone="good">Engagement signed off</Status> : undefined} />
      ))}
    </div>
  );
}
