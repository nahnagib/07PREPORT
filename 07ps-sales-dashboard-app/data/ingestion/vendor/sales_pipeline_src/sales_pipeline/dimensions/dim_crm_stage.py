from __future__ import annotations

import pandas as pd


class CrmStageDimensionBuilder:
    def build(self, stages: pd.DataFrame) -> pd.DataFrame:
        out = pd.DataFrame()
        out["StageID"] = pd.to_numeric(stages["id"], errors="coerce").astype("Int64") if "id" in stages.columns else pd.Series(dtype="Int64")
        out["Stage"] = stages["name"] if "name" in stages.columns else pd.NA
        out["Sequence"] = pd.to_numeric(stages["sequence"], errors="coerce").astype("Int64") if "sequence" in stages.columns else pd.NA
        out["IsWonStage"] = stages["is_won"].fillna(False).astype(bool) if "is_won" in stages.columns else False
        out["Fold"] = stages["fold"].fillna(False).astype(bool) if "fold" in stages.columns else False
        out["TeamID"] = pd.to_numeric(stages["team_id_id"], errors="coerce").astype("Int64") if "team_id_id" in stages.columns else pd.NA
        return out.drop_duplicates().sort_values(["Sequence", "Stage"], na_position="last").reset_index(drop=True)
