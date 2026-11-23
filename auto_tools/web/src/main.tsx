import React from 'react';
import ReactDOM from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import './styles.css';
import { App } from './App';
import { ProductList } from './pages/ProductList';
import { ProductEditor } from './pages/ProductEditor';
import { SettingsPage } from './pages/SettingsPage';
import { DashboardPage } from './pages/DashboardPage';
import { MercadoLibreWorkspacePage } from './pages/MercadoLibreWorkspacePage';
import { MercadoLibreProductEditor } from './pages/MercadoLibreProductEditor';
import { MercadoLibreSettingsPage } from './pages/MercadoLibreSettingsPage';
import { SourceProductLibrary } from './pages/SourceProductLibrary';
import { NativePromptProvider } from './components/NativePromptProvider';
import { PlannerPage } from './pages/planner/PlannerPage';
import { AliExpressAutoFillPage } from './pages/AliExpressAutoFillPage';
import { OrdersPage } from './pages/orders/OrdersPage';
const MiaoshouSorterPage = React.lazy(() => import('./pages/miaoshou/MiaoshouSorterPage').then(m => ({ default: m.MiaoshouSorterPage })));
const MiaoshouQueuePage = React.lazy(() => import('./pages/miaoshou/MiaoshouQueuePage').then(m => ({ default: m.MiaoshouQueuePage })));
const MiaoshouSettingsPage = React.lazy(() => import('./pages/miaoshou/MiaoshouSettingsPage').then(m => ({ default: m.MiaoshouSettingsPage })));
const MiaoshouDraftPage = React.lazy(() => import('./pages/miaoshou/MiaoshouDraftPage').then(m => ({ default: m.MiaoshouDraftPage })));
const miaoshouPage = (element: React.ReactNode) => <React.Suspense fallback={<div className="empty-state">正在加载美客多工作区…</div>}>{element}</React.Suspense>;

const router = createBrowserRouter([
  {
    path: '/',
    element: <App />,
    children: [
      { index: true, element: <DashboardPage /> },
      { path: 'projects', element: <PlannerPage mode="projects" /> },
      { path: 'projects/:projectId', element: <PlannerPage mode="projects" /> },
      { path: 'tasks', element: <PlannerPage mode="tasks" /> },
      { path: 'sources', element: <SourceProductLibrary /> },
      { path: 'aliexpress/auto-fill', element: <AliExpressAutoFillPage /> },
      { path: 'joom', element: <ProductList mode="browse" /> },
      { path: 'joom/publish-list', element: <ProductList mode="publish" /> },
      { path: 'joom/delete-list', element: <ProductList mode="remove" /> },
      { path: 'dashboard', element: <DashboardPage /> },
      { path: 'products/:id', element: <ProductEditor /> },
      { path: 'settings', element: <SettingsPage /> },
      { path: 'orders', element: <OrdersPage /> },
      { path: 'miaoshou/sort', element: miaoshouPage(<MiaoshouSorterPage />) },
      { path: 'miaoshou/queue', element: miaoshouPage(<MiaoshouQueuePage />) },
      { path: 'miaoshou/settings', element: miaoshouPage(<MiaoshouSettingsPage />) },
      { path: 'miaoshou/drafts/:id', element: miaoshouPage(<MiaoshouDraftPage />) },
      { path: 'mercadolibre', element: <MercadoLibreWorkspacePage /> },
      { path: 'mercadolibre/settings', element: <MercadoLibreSettingsPage /> },
      { path: 'mercadolibre/products/:productId', element: <MercadoLibreProductEditor /> },
    ],
  },
]);

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <NativePromptProvider><RouterProvider router={router} /></NativePromptProvider>
  </React.StrictMode>,
);
