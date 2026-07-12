import { Megaphone, Package, Truck, Users, HardHat, Workflow, Wallet, type LucideIcon } from 'lucide-react';

/** Single source of truth for the 7Ps Framework's seven departments, mirroring the existing
 * `navItems.ts` "single source of truth" pattern. Reused by the Dashboard Hub (cards), the
 * DepartmentSidebar (nav items), and the placeholder pages (name/description). Only Promotion has
 * a real backend today (`status: 'live'`) -- the rest are frontend-only placeholders. */
export interface Department {
  /** URL slug, also the route segment under `/`. */
  key: string;
  /** The 7Ps term, e.g. "Promotion". */
  pTerm: string;
  /** The real-world department it represents, e.g. "Sales Department". */
  name: string;
  /** Short one-line description shown on the Hub card. */
  tagline: string;
  icon: LucideIcon;
  /** Accent hex used for the card's icon chip / top accent / hover glow and the sidebar's active
   * highlight while inside this department -- kept as plain hex here rather than new CSS tokens,
   * since these are department-identity colors, not part of the semantic/business-unit token set. */
  accent: string;
  href: string;
  status: 'live' | 'placeholder';
}

export const DEPARTMENTS: Department[] = [
  {
    key: 'promotion',
    pTerm: 'Promotion',
    name: 'Sales Department',
    tagline: 'Sales performance dashboard',
    icon: Megaphone,
    accent: '#4d88c4',
    href: '/promotion',
    status: 'live',
  },
  {
    key: 'product',
    pTerm: 'Product',
    name: 'Production Department',
    tagline: 'Production performance dashboard',
    icon: Package,
    accent: '#5a9e6f',
    href: '/product',
    status: 'placeholder',
  },
  {
    key: 'place',
    pTerm: 'Place',
    name: 'Supply Chain Department',
    tagline: 'Supply chain performance dashboard',
    icon: Truck,
    accent: '#c48a3f',
    href: '/place',
    status: 'placeholder',
  },
  {
    key: 'people',
    pTerm: 'People',
    name: 'Human Resources',
    tagline: 'Workforce performance dashboard',
    icon: Users,
    accent: '#a06fc4',
    href: '/people',
    status: 'placeholder',
  },
  {
    key: 'physical-evidence',
    pTerm: 'Physical Evidence',
    name: 'HSE (Health, Safety & Environment)',
    tagline: 'Safety & environment dashboard',
    icon: HardHat,
    accent: '#cc7a3f',
    href: '/physical-evidence',
    status: 'placeholder',
  },
  {
    key: 'process',
    pTerm: 'Process',
    name: 'Business Excellence',
    tagline: 'Process excellence dashboard',
    icon: Workflow,
    accent: '#3f9bc4',
    href: '/process',
    status: 'placeholder',
  },
  {
    key: 'price',
    pTerm: 'Price',
    name: 'Finance Department',
    tagline: 'Financial performance dashboard',
    icon: Wallet,
    accent: '#6f9ceb',
    href: '/price',
    status: 'placeholder',
  },
];

export function getDepartment(key: string): Department | undefined {
  return DEPARTMENTS.find((d) => d.key === key);
}
