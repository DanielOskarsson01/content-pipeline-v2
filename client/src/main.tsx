import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { RouterProvider } from 'react-router-dom'
import { ErrorBoundary, type FallbackProps } from 'react-error-boundary'
import './index.css'
import { router } from './router'

function ErrorFallback({ error, resetErrorBoundary }: FallbackProps) {
  const message = error instanceof Error ? error.message : String(error);
  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <div className="bg-white rounded-lg shadow-lg p-8 max-w-lg w-full">
        <h1 className="text-xl font-bold text-red-600 mb-2">Something went wrong</h1>
        <pre className="text-sm text-gray-700 bg-gray-100 rounded p-3 mb-4 overflow-auto max-h-48 whitespace-pre-wrap">
          {message}
        </pre>
        <button
          onClick={resetErrorBoundary}
          className="px-4 py-2 bg-[#E11D73] text-white rounded hover:bg-[#E11D73]/90 text-sm font-medium"
        >
          Reload
        </button>
      </div>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary FallbackComponent={ErrorFallback} onReset={() => window.location.reload()}>
      <RouterProvider router={router} />
    </ErrorBoundary>
  </StrictMode>,
)
