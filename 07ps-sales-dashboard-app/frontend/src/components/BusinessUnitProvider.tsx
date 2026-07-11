'use client';
import React, { createContext, useContext, useEffect, useState } from 'react';

export type BusinessUnit = 'all' | 'majaal' | 'tika';

interface BusinessUnitContextValue {
  businessUnit: BusinessUnit;
  setBusinessUnit: (bu: BusinessUnit) => void;
}

const BusinessUnitContext = createContext<BusinessUnitContextValue | null>(null);

/**
 * Standards Section 4.5 - Company/Business Unit Filter: "Selecting a single company automatically
 * swaps the business-unit logo in the header (Section 3.12) and scopes every KPI, chart, and table
 * on the page." This provider is the single source of truth for that selection; Header reads it to
 * swap logos, and (in later phases) the API layer reads the equivalent server-side claim for RLS.
 */
export function BusinessUnitProvider({ children }: { children: React.ReactNode }) {
  const [businessUnit, setBusinessUnit] = useState<BusinessUnit>('all');

  useEffect(() => {
    document.documentElement.setAttribute('data-business-unit', businessUnit);
  }, [businessUnit]);

  return (
    <BusinessUnitContext.Provider value={{ businessUnit, setBusinessUnit }}>
      {children}
    </BusinessUnitContext.Provider>
  );
}

export function useBusinessUnit() {
  const ctx = useContext(BusinessUnitContext);
  if (!ctx) throw new Error('useBusinessUnit must be used within BusinessUnitProvider');
  return ctx;
}
