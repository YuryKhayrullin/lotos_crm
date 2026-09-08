"use client"

export function LoaderFullScreen() {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-white">
      <div className="flex flex-col items-center gap-4">
        <div className="relative">
          <svg className="h-12 w-12 text-pink-500 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor">
            <circle className="opacity-25" cx="12" cy="12" r="10" strokeWidth="4" />
            <path className="opacity-75" d="M12 2a10 10 0 0 1 10 10" strokeWidth="4" strokeLinecap="round" />
          </svg>
        </div>
        <p className="text-slate-500 font-medium">Загрузка Лотос CRM...</p>
      </div>
    </div>
  )
}