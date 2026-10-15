import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Data Wallet — Own your personal data" },
      { name: "description", content: "A personal data wallet to store, control and share your data on your terms." },
      { property: "og:title", content: "Data Wallet — Own your personal data" },
      { property: "og:description", content: "Store, control and share your personal data on your terms." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Index,
});

const items = [
  { label: "Identity", count: 3 },
  { label: "Health", count: 0 },
  { label: "Finance", count: 2 },
  { label: "Devices", count: 5 },
];

function Index() {
  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="mx-auto max-w-3xl px-6 py-20">
        <p className="font-mono text-xs uppercase tracking-[0.3em] text-primary">Coming soon</p>
        <h1 className="mt-4 text-5xl font-semibold tracking-tight">Data Wallet</h1>
        <p className="mt-4 max-w-xl text-lg text-muted-foreground">
          One place to hold your personal data — and decide who gets to see it.
        </p>

        <div className="mt-12 rounded-2xl border bg-card p-6 shadow-wallet">
          <div className="flex items-center justify-between">
            <span className="font-mono text-sm text-muted-foreground">wallet://you</span>
            <span className="rounded-full bg-primary/15 px-3 py-1 text-xs font-medium text-primary">Placeholder</span>
          </div>
          <div className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-4">
            {items.map((i) => (
              <div key={i.label} className="rounded-xl bg-muted p-4">
                <div className="text-3xl font-semibold">{i.count}</div>
                <div className="mt-1 text-sm text-muted-foreground">{i.label}</div>
              </div>
            ))}
          </div>
          <button disabled className="mt-6 w-full rounded-xl bg-primary py-3 font-medium text-primary-foreground opacity-60">
            Connect a data source
          </button>
        </div>
      </div>
    </main>
  );
}
