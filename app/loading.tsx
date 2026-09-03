export default function Loading() {
  return (
    <div className="min-h-screen bg-[#f4f7fa] text-[#17212b]" aria-busy="true" aria-live="polite">
      <div className="max-w-7xl mx-auto px-6 py-8">
        <div className="mb-8">
          <div className="skeleton h-4 w-48 rounded-md mb-3" />
          <div className="skeleton h-8 w-2/3 rounded-lg mb-2" />
          <div className="skeleton h-4 w-1/2 rounded-md" />
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5 mb-8">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="p-5 rounded-2xl bg-white border border-[#dfe6ee] shadow-sm">
              <div className="skeleton h-3 w-24 rounded mb-3" />
              <div className="skeleton h-8 w-28 rounded-lg mb-2" />
              <div className="skeleton h-3 w-32 rounded" />
            </div>
          ))}
        </div>
        <div className="bg-white rounded-2xl border border-[#dfe6ee] shadow-sm overflow-hidden">
          <div className="p-5 border-b border-[#dfe6ee]">
            <div className="skeleton h-5 w-56 rounded-md mb-2" />
            <div className="skeleton h-3 w-96 max-w-full rounded" />
          </div>
          <div className="p-6 space-y-3">
            {[0, 1, 2, 3, 4].map((i) => (
              <div key={i} className="skeleton h-10 w-full rounded-xl" />
            ))}
          </div>
        </div>
        <p className="sr-only">Loading PayRescue control room…</p>
      </div>
    </div>
  );
}
