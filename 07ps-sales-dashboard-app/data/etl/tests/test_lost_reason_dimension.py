from __future__ import annotations

import sys
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from sales_pipeline.dimensions.dim_lost_reason import LostReasonDimensionBuilder  # noqa: E402


def test_lost_reason_dimension_adds_standardized_english_labels() -> None:
    expected = {
        " Not enough stock ": "Not Enough Stock",
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
        "سبب عربي غير معروف": "Other / Unmapped",
        "Custom English Reason": "Custom English Reason",
    }
    source = pd.DataFrame(
        [{"id": index, "name": reason} for index, reason in enumerate(expected, start=1)]
    )

    dim = LostReasonDimensionBuilder().build(source).set_index("LostReasonID")

    for index, (reason, english) in enumerate(expected.items(), start=1):
        assert dim.loc[index, "LostReason"] == reason
        assert dim.loc[index, "LostReasonEnglish"] == english

    assert dim.loc[5, "LostReasonEnglish"] == dim.loc[8, "LostReasonEnglish"]
