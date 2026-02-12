import { NavLink } from 'react-router-dom';

const TABS = [
  { path: '/new', label: 'New Project' },
  { path: '/projects', label: 'Projects' },
  { path: '/templates', label: 'Templates' },
];

export function AppHeader() {
  return (
    <header className="bg-white border-b border-gray-200">
      {/* Top bar */}
      <div className="flex items-center justify-between px-6 py-3">
        {/* Logo */}
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-semibold text-gray-900">
            OnlyiGaming Content Tool
          </h1>
        </div>
      </div>

      {/* Tab navigation */}
      <nav className="flex px-6 border-t border-gray-100">
        {TABS.map((tab) => (
          <NavLink
            key={tab.path}
            to={tab.path}
            className={({ isActive }) => `
              px-4 py-3 text-sm font-medium border-b-2 transition-colors
              ${isActive
                ? 'border-brand-600 text-brand-600'
                : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
              }
            `}
          >
            {tab.label}
          </NavLink>
        ))}
      </nav>
    </header>
  );
}
