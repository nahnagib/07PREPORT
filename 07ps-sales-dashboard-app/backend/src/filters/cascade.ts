/**
 * Cross-filtering ("cascading") logic for the Filter Bar, kept free of I/O so it is unit-testable.
 *
 * Input is the set of DISTINCT dimension combinations that really occur together in the sales
 * data (one Combo per distinct (company, customer group, channel, branch, salesperson, customer)
 * tuple -- see optionsService.ts for how they're loaded). An option is "valid" for a dimension when
 * at least one combo that satisfies EVERY OTHER dimension's current selection contains it -- i.e.
 * standard cross-filter semantics: a dimension's own selection never narrows its own list (so a
 * multi-select can be widened), while every other dimension's selection does.
 *
 *   - Multi-select: a dimension's selection is a set; a combo passes it when its value is in the
 *     set, so the resulting options are the union of what each selected value allows.
 *   - Empty selection = "All" = no restriction from that dimension.
 *   - Selected values that are no longer valid are dropped, one dimension per pass and the most
 *     specific dimension first (customer, then salesperson, branch, channel, group, company), then
 *     the options are recomputed -- dropping a value can make others valid again, so pruning
 *     everything at once would wipe a parent selection (e.g. Company) whose only "conflict" was
 *     with a child that is itself about to be dropped.
 *   - `scope` is the caller's role/salesperson data scope. It is a hard restriction on every
 *     dimension (never dropped, never widened by selections).
 */

export const DIMENSIONS = ['companyKeys', 'segmentKeys', 'channelKeys', 'salesTeamKeys', 'salespersonKeys', 'customerKeys'] as const;
export type Dimension = (typeof DIMENSIONS)[number];

/** One distinct co-occurrence, values stringified so number/string keys compare uniformly. A null
 * (e.g. a sale with no branch) never becomes an option but still constrains its own combo. */
export type Combo = Record<Dimension, string | null>;

export type Selection = Record<Dimension, string[]>;

export const emptySelection = (): Selection => ({
  companyKeys: [],
  segmentKeys: [],
  channelKeys: [],
  salesTeamKeys: [],
  salespersonKeys: [],
  customerKeys: [],
});

/** Pruning priority: earlier = dropped first. */
const PRUNE_ORDER: readonly Dimension[] = ['customerKeys', 'salespersonKeys', 'salesTeamKeys', 'channelKeys', 'segmentKeys', 'companyKeys'];

const MAX_PASSES = DIMENSIONS.length + 2;

export interface CascadeResult {
  /** Valid option values per dimension, given every other dimension's selection. */
  options: Record<Dimension, Set<string>>;
  /** The selection after dropping values that are no longer valid. */
  selection: Selection;
  /** Number of combos consistent with the full (pruned) selection -- 0 means the filters together
   * match no data at all. */
  matchingCombos: number;
}

export function computeCascade(combos: readonly Combo[], selection: Selection, scope: Partial<Selection> = {}): CascadeResult {
  let current: Selection = { ...emptySelection(), ...selection };
  let options = emptyOptions();
  let matching = 0;

  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const selSets = DIMENSIONS.map((d) => (current[d].length > 0 ? new Set(current[d]) : null));
    const scopeSets = DIMENSIONS.map((d) => ((scope[d]?.length ?? 0) > 0 ? new Set(scope[d]) : null));

    options = emptyOptions();
    matching = 0;

    for (const combo of combos) {
      // Which dimensions does this combo fail (against selection AND scope)?
      let failedIndex = -1;
      let failures = 0;
      for (let i = 0; i < DIMENSIONS.length; i++) {
        const v = combo[DIMENSIONS[i]];
        const scopeOk = !scopeSets[i] || (v !== null && scopeSets[i]!.has(v));
        const selOk = !selSets[i] || (v !== null && selSets[i]!.has(v));
        if (!scopeOk) {
          // Scope is a hard wall: a combo outside it contributes nothing to any dimension.
          failures = 2;
          break;
        }
        if (!selOk) {
          failures++;
          failedIndex = i;
          if (failures > 1) break;
        }
      }
      if (failures === 0) {
        matching++;
        for (const d of DIMENSIONS) {
          const v = combo[d];
          if (v !== null) options[d].add(v);
        }
      } else if (failures === 1) {
        // Fails only its own dimension's selection -> still valid for THAT dimension's list.
        const d = DIMENSIONS[failedIndex];
        const v = combo[d];
        if (v !== null) options[d].add(v);
      }
    }

    const dropDim = PRUNE_ORDER.find((d) => current[d].some((v) => !options[d].has(v)));
    if (!dropDim) break;
    current = { ...current, [dropDim]: current[dropDim].filter((v) => options[dropDim].has(v)) };
  }

  return { options, selection: current, matchingCombos: matching };
}

function emptyOptions(): Record<Dimension, Set<string>> {
  return {
    companyKeys: new Set(),
    segmentKeys: new Set(),
    channelKeys: new Set(),
    salesTeamKeys: new Set(),
    salespersonKeys: new Set(),
    customerKeys: new Set(),
  };
}
