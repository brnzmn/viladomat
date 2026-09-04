import type { Route } from 'next';

export type NavItem = {
  href: Route;
  label: string;
  /** Milestone in which the screen is delivered; screens beyond the current one show a placeholder. */
  milestone: string;
  available: boolean;
};

/** Screens in build order (plan, "UI screens"). */
export const NAV_ITEMS: readonly NavItem[] = [
  { href: '/', label: 'Overview', milestone: 'M0', available: true },
  { href: '/seed', label: 'Seed & governance', milestone: 'M0', available: true },
  { href: '/upload', label: 'Upload', milestone: 'M1', available: true },
  { href: '/grouping', label: 'Grouping', milestone: 'M2', available: false },
  { href: '/documents', label: 'Documents', milestone: 'M2', available: true },
  { href: '/bank', label: 'Bank', milestone: 'M3', available: false },
  { href: '/works', label: 'Works', milestone: 'M4', available: false },
  { href: '/vendors', label: 'Vendors', milestone: 'M5', available: false },
  { href: '/findings', label: 'Findings', milestone: 'M3', available: true },
  { href: '/requests', label: 'Requests & reports', milestone: 'M6', available: false },
];
