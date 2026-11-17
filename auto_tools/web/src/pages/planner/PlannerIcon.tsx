export type IconName = 'folder' | 'tasks' | 'plus' | 'search' | 'grid' | 'list' | 'board' | 'arrow' | 'star' | 'calendar' | 'repeat' | 'check' | 'close' | 'archive' | 'piano' | 'shop' | 'sun' | 'leaf' | 'edit' | 'collection' | 'package' | 'upload' | 'download' | 'trash' | 'settings' | 'globe' | 'filter' | 'more' | 'expand' | 'collapse';
const paths: Record<IconName, React.ReactNode> = {
  download: <><path d="M12 3v13m-5-5 5 5 5-5M4 15v5h16v-5"/></>,
  expand: <><path d="M14 3h7v7M21 3l-8 8M10 21H3v-7m0 7 8-8"/></>,
  collapse: <><path d="M21 3 14 10m0-7v7h7M3 21l7-7m0 7v-7H3"/></>,
  filter: <path d="M3 4h18l-7 8v7l-4 2v-9L3 4Z"/>,
  more: <><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></>,
  collection: <><path d="m12 3 9 5-9 5-9-5 9-5Zm-9 9 9 5 9-5M3 16l9 5 9-5"/></>,
  package: <><path d="m12 3 9 5v9l-9 5-9-5V8l9-5ZM3 8l9 5 9-5M12 13v9M7.5 5.5l9 5V15"/></>,
  upload: <><path d="M12 16V3m-5 5 5-5 5 5M4 15v5h16v-5"/></>,
  trash: <><path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7"/></>,
  settings: <><path d="m10 3-.7 2.2-2.2 1.3-2.3-.5-2 3.4 1.6 1.7v2.6l-1.6 1.7 2 3.4 2.3-.5 2.2 1.3L10 22h4l.7-2.4 2.2-1.3 2.3.5 2-3.4-1.6-1.7v-2.6l1.6-1.7-2-3.4-2.3.5-2.2-1.3L14 3h-4Z"/><circle cx="12" cy="12.5" r="3"/></>,
  globe: <><circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="4" ry="9"/><path d="M3 12h18"/></>,
  folder: <><path d="M3 7V5a2 2 0 0 1 2-2h5l3 3h6a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"/><path d="M8 11v5m4-7v7m4-4v4"/></>,
  tasks: <><path d="m3 5 1.5 1.5L7 3.5M11 5h10M3 12l1.5 1.5L7 10.5M11 12h10M3 19l1.5 1.5L7 17.5M11 19h10"/></>,
  plus: <path d="M12 5v14M5 12h14"/>, search: <><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/></>,
  grid: <><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></>,
  list: <path d="M8 5h13M8 12h13M8 19h13M3 5h.01M3 12h.01M3 19h.01"/>,
  board: <><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16M15 4v16M5.5 8h1M11.5 8h1M17.5 8h1"/></>,
  arrow: <path d="M5 12h14m-5-5 5 5-5 5"/>, star: <path d="m12 3 2.8 5.7 6.3.9-4.6 4.4 1.1 6.3-5.6-3-5.6 3 1.1-6.3L2.9 9.6l6.3-.9Z"/>,
  calendar: <><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M7 3v4M17 3v4M3 11h18M8 15h2M14 15h2"/></>,
  repeat: <><path d="m17 2 4 4-4 4M3 11V8a2 2 0 0 1 2-2h16M7 22l-4-4 4-4m14-1v3a2 2 0 0 1-2 2H3"/></>,
  check: <path d="m5 12 4 4L19 6"/>, close: <path d="m6 6 12 12M6 18 18 6"/>,
  archive: <><rect x="3" y="3" width="18" height="5" rx="1"/><path d="M5 8v12h14V8M10 12h4"/></>,
  piano: <><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 13v7m6-7v7M7 4v8h3V4m4 0v8h3V4"/></>,
  shop: <><path d="M3 9 5 3h14l2 6v3a3 3 0 0 1-6 0 3 3 0 0 1-6 0 3 3 0 0 1-6 0V9ZM5 15v6h14v-6M10 21v-5h4v5"/><path d="M3 9h18"/></>,
  sun: <><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/></>,
  leaf: <><path d="M20 3C10 2 3 7 5 15c2 6 14 6 15-12Z"/><path d="M3 22 15 10"/></>,
  edit: <><path d="m15 4 5 5M4 20l5-1L21 7a2 2 0 0 0-5-5L4 14v6Z"/></>,
};
export function PlannerIcon({ name, size = 18 }: { name: string; size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name as IconName] ?? paths.folder}</svg>;
}
