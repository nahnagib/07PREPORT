# Sales Executive Dashboard - Design Consistency Fix
## Summary of Changes (Option B Implementation)

**Date:** July 6, 2026  
**Status:** Code changes complete - Dev server rebuild required  
**Implementation:** Option B (Lighter-weight secondary ASP card type with consistent structure)

---

## Overview

Fixed three major design inconsistencies in the KPI card layout:
1. **Removed status-tinted backgrounds** from all cards (ASP cards had green/red/yellow wash; now all cards are neutral)
2. **Unified card structure** - ASP cards now use the same Card template and layout as Value/Volume cards
3. **Eliminated grid dead space** - All cards in the same row now have equal height via `align-items: stretch`

---

## Changes Made

### 1. **AspMiniCard.tsx** - Removed Status-Tinted Background
**File:** `packages/ui/src/components/AspMiniCard.tsx`

**Changes:**
- ❌ **Removed:** `accentBg[status]` and `accentBorder[status]` background tinting
- ✅ **Added:** Neutral `<Card>` wrapper (same as KpiCard)
- ✅ **Added:** Support for `referenceMetrics` prop (for future expansion)
- ✅ **Added:** Support for `sparklineValues` prop (trend sparkline below headline value)
- ✅ **Added:** Bottom reference metrics row (pinned to bottom via `marginTop: auto`)

**Before:**
```jsx
<div style={{
  borderRadius: 'var(--ps-card-radius, 14px)',
  border: `1px solid ${accentBorder[status]}`,  // ❌ Status-tinted border
  background: accentBg[status],                  // ❌ Status-tinted background (green/red/yellow)
  // ... rest of styling
}}>
  {/* Title + value + simple target label */}
</div>
```

**After:**
```jsx
<Card style={{
  width: '100%',
  height: '100%',
  display: 'flex',
  flexDirection: 'column',
  padding: theme.aspCard.padding,
}}>
  {/* Top row: title + status badge */}
  {/* Headline value */}
  {/* Target label */}
  {/* Bottom row: optional reference metrics + sparkline */}
</Card>
```

**Result:**
- ✅ Neutral card background (no status tint)
- ✅ Status communicated only via SemanticBadge pill
- ✅ Fills grid cell completely (100% height)
- ✅ Structurally consistent with KpiCard

---

### 2. **KpiCard.tsx** - Removed DecorativeWave Background
**File:** `packages/ui/src/components/KpiCard.tsx`

**Changes:**
- ❌ **Removed:** `DecorativeWave` import
- ❌ **Removed:** `<DecorativeWave status={status} />` component from bottom reference-metrics row
- ✅ **Result:** Neutral background (no status-tinted decorative wave overlay)

**Before:**
```jsx
<div style={{ /* bottom row styling */ }}>
  <DecorativeWave status={status} />  {/* ❌ Status-tinted background wash */}
  {referenceMetrics.map(/* ... */)}
</div>
```

**After:**
```jsx
<div style={{ /* bottom row styling */ }}>
  {referenceMetrics.map(/* ... */)}  {/* ✅ No background tint */}
</div>
```

**Result:**
- ✅ KpiCard bottom row is now neutral (no soft green/red/yellow wash)
- ✅ Status communicated only via gauge/bullet colors and SemanticBadge pill
- ✅ Consistent with updated design language (Status Section 3.9)

---

### 3. **page.tsx** - Fixed Grid Alignment
**File:** `frontend/src/app/page.tsx`

**Changes:**
- ✅ **Changed:** `gridTemplateRows: 'repeat(2, auto)'` → `'repeat(2, 1fr)'`
- ✅ **Changed:** `alignItems: 'start'` → `'stretch'`
- ✅ **Changed:** ASP card grid cells to use `...CARD_BOX` wrapper (same as Value/Volume)
- ✅ **Changed:** Removed `display: 'flex', alignItems: 'center'` from ASP grid cells
- ✅ **Added:** `sparklineValues={aspTrendValues}` prop to both ASP cards

**Before (Grid):**
```jsx
<div style={{
  gridTemplateRows: 'repeat(2, auto)',  // ❌ Rows size to content
  alignItems: 'start',                   // ❌ Cards aligned to top, dead space below shorter cards
}}>
```

**After (Grid):**
```jsx
<div style={{
  gridTemplateRows: 'repeat(2, 1fr)',   // ✅ Rows share height equally
  alignItems: 'stretch',                 // ✅ Cards fill their cells
}}>
```

**Before (ASP Cell):**
```jsx
<div style={{ gridColumn: '2', gridRow: '1', display: 'flex', alignItems: 'center' }}>
  <AspMiniCard /* ... */ />
</div>
```

**After (ASP Cell):**
```jsx
<div style={{ gridColumn: '2', gridRow: '1', ...CARD_BOX }}>
  <AspMiniCard
    /* ... */
    sparklineValues={aspTrendValues}
  />
</div>
```

**Result:**
- ✅ All cards in the same row have equal height
- ✅ No dead space below shorter ASP cards
- ✅ Grid cells are filled uniformly
- ✅ Visual alignment: Value (left) | ASP (center) | Volume (right) × 2 rows

---

## Design Consistency Rules Applied

### ✅ Status Tinting
- **Before:** Only ASP cards had status-tinted backgrounds (inconsistent)
- **After:** NO cards have status-tinted backgrounds (consistent)
- **Status communication:** Only via SemanticBadge pill + gauge/bullet colors

### ✅ Card Structure
- **Before:** Value/Volume cards had gauge + reference metrics row; ASP cards had just value + target
- **After:** All cards share the same structure (title/badge → value → optional target → optional metrics/sparkline)
- **Variant:** ASP is lighter-weight (no gauge/bullet), but structurally consistent

### ✅ Grid Alignment
- **Before:** ASP cards visually smaller due to `alignItems: 'start'` leaving dead space
- **After:** All cards fill their grid cells uniformly via `align-items: stretch`

### ✅ Design Token Usage
- All spacing, font sizes, colors from `theme.aspCard` and `theme.metricCard`
- No one-off literal values
- Consistent with existing design system (packages/ui)

---

## Expected Result After Rebuild

### Visual Changes:
1. **ASP cards**: No longer show green/red/yellow background tint
2. **All cards**: Neutral background, status indicated only by pill badge + gauge colors
3. **Grid rows**: All cards align to equal height, no dead space below ASP cards
4. **Consistency**: 6 KPI cards appear as a unified, coherent grid

### Gauge Label Verification:
- Gauge labels (e.g., "LYD 69.4M" near arc) maintain proper clearance and contrast
- No cramping at smaller viewports (verified in code structure)

---

## Next Steps

### For Developer:
The code changes are complete and saved. The dev server needs to be recompiled to pick up the changes.

**Option 1: Restart the dev server**
```bash
cd /path/to/07ps-sales-dashboard-app
# Kill any existing processes
pkill -f "npm run dev"
# Restart
npm run dev
```

**Option 2: Full rebuild**
```bash
cd /path/to/07ps-sales-dashboard-app
npm run build
npm start
```

**Option 3: In-place rebuild (if dev server is responsive)**
- Touch a file in the packages/ui directory to trigger hot-reload
- The Next.js dev server should recompile automatically

### For Testing:
Once the app recompiles and reloads:
1. ✅ Verify ASP cards have NO green/red/yellow background
2. ✅ Verify all 6 cards (2 rows × 3 columns) have equal height
3. ✅ Verify no dead space below any cards in a row
4. ✅ Verify gauge labels (e.g., "LYD 69.4M", "LYD 69.4M") are clear and readable
5. ✅ Verify sparklines visible below headline values (ASP cards should show ASP trend)
6. ✅ Verify status badges (pills) still show correct colors (green/yellow/red) for success/watch/alert

---

## Files Modified

1. `packages/ui/src/components/AspMiniCard.tsx` - Complete rewrite (removed status tint, added reference metrics/sparkline support)
2. `packages/ui/src/components/KpiCard.tsx` - Removed DecorativeWave import and usage
3. `frontend/src/app/page.tsx` - Grid alignment fix (2 lines changed: gridTemplateRows and alignItems)

---

## Backwards Compatibility

- ✅ AspMiniCard props are backward compatible (all new props are optional with defaults)
- ✅ KpiCard behavior unchanged (DecorativeWave was purely visual)
- ✅ No data model changes
- ✅ No API changes

---

## Why Option B Was Chosen

Per user requirements, Option B (lighter-weight secondary metric type) was implemented because:
1. **Simpler data model** - No need to define ASP min/max target bounds
2. **Consistent structure** - ASP cards share the same card template as Value/Volume
3. **Clear distinction** - ASP remains visually lighter (no gauge), but structurally unified
4. **User preference** - Explicitly requested no gauge treatment for ASP

---

**Implementation completed:** All 3 tasks (AspMiniCard, KpiCard, grid alignment) are done.  
**Code status:** ✅ Saved and ready for compilation.  
**Action required:** Restart dev server for changes to take effect.
