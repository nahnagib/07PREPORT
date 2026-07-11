from __future__ import annotations

import pandas as pd


LOST_REASON_ENGLISH_MAP = {
    "Not enough stock": "Not Enough Stock",
    "Too expensive": "Price Too High",
    "We don't have people/skills": "Insufficient Resources / Skills",
    "تم اداخالها عن طريق الخطا": "Entered by Mistake",
    "تم ادخال الزبون مسبقآ": "Customer Already Registered",
    "تم انتهاء المشروع": "Project Completed",
    "تم ايقاف التنفيذ": "Project Execution Stopped",
    "تم تسجيل الزبون مسبقا": "Customer Already Registered",
    "ضعف عملية التسويق مع العميل": "Weak Customer Engagement",
    "لا يوجد تحديث للحالة": "No Status Update",
    "لا يوجد رد": "No Response from Customer",
    "لعدم جدية الزبون في الشراء": "Customer Not Serious About Purchasing",
    "لعدم متابعة الزبون بطريقة الصحيحة من الموظف المسجل": "Inadequate Follow-up by Assigned Employee",
    "لعدم متابعة الزبون بطريقة الصحيحة من الموظف المسجل وعدم كتابة تفاصيل": "Inadequate Follow-up and Missing Notes",
}


class LostReasonDimensionBuilder:
    def build(self, lost_reasons: pd.DataFrame) -> pd.DataFrame:
        out = pd.DataFrame()
        out["LostReasonID"] = pd.to_numeric(lost_reasons["id"], errors="coerce").astype("Int64") if "id" in lost_reasons.columns else pd.Series(dtype="Int64")
        out["LostReason"] = lost_reasons["name"] if "name" in lost_reasons.columns else pd.NA
        out["LostReasonEnglish"] = self._english_label(out["LostReason"])
        return out.drop_duplicates().sort_values("LostReason", na_position="last").reset_index(drop=True)

    @staticmethod
    def _english_label(reason: pd.Series) -> pd.Series:
        trimmed = reason.astype("string").str.strip()
        mapped = trimmed.map(LOST_REASON_ENGLISH_MAP)
        has_arabic = trimmed.str.contains(r"[\u0600-\u06FF]", regex=True, na=False)
        english_label = trimmed.where(~has_arabic, "Other / Unmapped")
        return mapped.combine_first(english_label).where(trimmed.notna(), pd.NA)
