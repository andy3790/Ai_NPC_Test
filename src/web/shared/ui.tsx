import type React from 'react';
import { states } from './formatters.js';

export function Icon({ name, size = 20 }: { name: string; size?: number }) {
  const paths: Record<string, React.ReactNode> = {
    lab: <><path d="M9 3h6M10 3v6L4 19q-1 2 2 2h12q3 0 2-2L14 9V3"/><path d="M7 15h10"/></>,
    grid: <><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></>,
    compare: <><path d="M4 20V10m6 10V4m6 16v-7m5 7V7"/></>,
    book: <><path d="M12 5c-3-2-6-2-9-1v15c3-1 6-1 9 1 3-2 6-2 9-1V4c-3-1-6-1-9 1v15"/></>,
    download: <><path d="M12 3v12m-5-5 5 5 5-5M4 15v6h16v-6"/></>,
    plus: <path d="M12 5v14M5 12h14"/>, play: <path d="m8 4 13 8-13 8Z"/>,
    arrow: <path d="M4 12h16m-6-6 6 6-6 6"/>, close: <path d="m6 6 12 12M6 18 18 6"/>,
    clock: <><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name] ?? paths.grid}</svg>;
}
export function Badge({ status }: { status: string }) { return <span className={`badge ${status}`}><i/>{states[status] ?? status}</span>; }
export function Stat({ label, value, note, accent }: { label: string; value: string; note: React.ReactNode; accent?: boolean }) { return <div className={`stat ${accent ? 'accent' : ''}`}><span>{label}</span><strong>{value}</strong><small>{note}</small></div>; }
