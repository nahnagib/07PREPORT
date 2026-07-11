import React from 'react';

export interface LoadingSkeletonProps {
  /** Matches the final card/chart shape - Section 3.21: "never a blank white card or a generic spinner alone." */
  variant?: 'kpi' | 'chart' | 'table';
}

export function LoadingSkeleton({ variant = 'kpi' }: LoadingSkeletonProps) {
  const height = variant === 'chart' ? 240 : variant === 'table' ? 320 : 88;
  return (
    <div
      className="ps-skeleton"
      role="status"
      aria-label="Loading"
      style={{ width: '100%', height, borderRadius: 8 }}
    />
  );
}
