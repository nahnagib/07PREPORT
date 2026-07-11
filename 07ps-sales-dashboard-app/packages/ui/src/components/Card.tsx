import React from 'react';

// Design-quality pass: widened to extend React.HTMLAttributes<HTMLDivElement> (was just
// children/className/aria-label) so a caller can pass onClick/onKeyDown/tabIndex/role/style --
// needed to make GaugeCard's whole card clickable for the drill-down feature without forking Card
// into a second component. Purely additive: every existing Card usage that doesn't pass these
// extra props behaves exactly as before.
export interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  children: React.ReactNode;
  className?: string;
  /** Section 3.5: every card carries exactly one primary metric or visual. */
  'aria-label'?: string;
}

/** Standards Section 3.5 - Card Design: 8px radius, soft shadow, neutral light background, 16px padding.
 *
 * Design-system-enforcement pass, dark-mode depth fix: `--ps-card-shadow` in dark mode is a black
 * shadow (`rgba(0,0,0,0.45)`) sitting on a near-black page canvas (`--ps-color-page-bg: #0b111e`) --
 * it renders correctly but is essentially invisible, which is why cards were reading as "flat"/
 * inconsistent in dark mode even after AspMiniCard picked up the same shadow token. A neutral 1px
 * border (`--ps-color-border`) is the depth cue that actually reads on a dark surface, and it's the
 * same border AspMiniCard already uses (as a status-colored variant) -- adding it here means every
 * card built on this shared shell now has a visible, consistent "this is a distinct card" edge,
 * independent of whether the box-shadow is perceptible. The shadow itself is left in place (still
 * correct, still helps in light mode / on lighter surfaces), just no longer the only depth signal. */
export function Card({ children, className = '', style, ...rest }: CardProps) {
  return (
    <div
      className={`ps-card ${className}`}
      style={{
        borderRadius: 'var(--ps-card-radius, 8px)',
        padding: 'var(--ps-card-padding, 16px)',
        background: 'var(--ps-card-bg)',
        border: '1px solid var(--ps-color-border)',
        boxShadow: 'var(--ps-card-shadow)',
        ...style,
      }}
      {...rest}
    >
      {children}
    </div>
  );
}
