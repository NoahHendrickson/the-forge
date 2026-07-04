export default function App() {
  return (
    <main className="min-h-screen bg-neutral-100 p-8 font-sans">
      <div className="mx-auto max-w-sm rounded-xl bg-white p-6 shadow-sm">
        <h1 className="text-lg font-medium text-neutral-900">Vitality</h1>
        <p className="mt-1 text-sm text-neutral-500">Tier 7 · 173 total</p>
        <button
          className="mt-4 rounded-lg bg-blue-600 px-4 py-2.5 text-sm text-white"
          onClick={() => alert('app click handler fired')}
        >
          Add mod
        </button>
      </div>
    </main>
  )
}
