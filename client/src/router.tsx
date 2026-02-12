import { createBrowserRouter, Link, Navigate, Outlet } from 'react-router-dom';
import { QueryClientProvider } from '@tanstack/react-query';
import { queryClient } from './api/client';
import { AppHeader } from './components/layout/AppHeader';
import { Toast } from './components/layout/Toast';
import { NewProject } from './components/pages/NewProject';
import { ProjectsList } from './components/pages/ProjectsList';

function RootLayout() {
  return (
    <QueryClientProvider client={queryClient}>
      <div className="min-h-screen bg-gray-50">
        <AppHeader />
        <main className="max-w-5xl mx-auto p-6">
          <Outlet />
        </main>
        <Toast />
      </div>
    </QueryClientProvider>
  );
}

function TemplatesPage() {
  return (
    <div className="rounded-lg border border-dashed border-gray-300 p-12 text-center">
      <p className="text-gray-400 text-sm">No templates yet</p>
    </div>
  );
}

function RunViewPage() {
  return (
    <div className="text-center py-12 text-gray-500">
      Run View — Phase 3
    </div>
  );
}

function NotFoundPage() {
  return (
    <div className="text-center py-12">
      <p className="text-gray-500">Page not found</p>
      <Link to="/projects" className="text-brand-600 hover:underline text-sm mt-2 inline-block">
        Back to Projects
      </Link>
    </div>
  );
}

export const router = createBrowserRouter([
  {
    path: '/',
    element: <RootLayout />,
    children: [
      { index: true, element: <Navigate to="/projects" replace /> },
      { path: 'new', element: <NewProject /> },
      { path: 'projects', element: <ProjectsList /> },
      { path: 'templates', element: <TemplatesPage /> },
      { path: 'projects/:projectId/runs/:runId', element: <RunViewPage /> },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
]);
