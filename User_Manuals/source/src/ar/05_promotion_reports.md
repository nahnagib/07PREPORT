<!-- only:full -->
# الترويج: Critical Number (الرقم الحرج)

## الغرض

يحوِّل تقرير **Critical Number** هدف المبيعات السنوي إلى **قيمة مبيعات يومية مطلوبة** تُسمّى "الرقم الحرج"، ثم يتابع هل تواكب المبيعات هذه الوتيرة اليوم وخلال الشهر وخلال السنة. كما يحصي أيام العمل والعطلات الرسمية وأيام الإغلاق الاضطراري للفروع.

**لفتح التقرير:** **Promotion** › بطاقة **Critical Number**، أو تبويب **Critical Number**.

![Critical Number: العدادات](shots/critical_top.png){annot="1:140,103;2:300,230;3:720,230;4:1230,230;5:395,261"}

1. عامل التصفية **Date** (التاريخ): تُحسب العدادات حتى هذا اليوم، وقيمته الافتراضية اليوم.
2. **Daily Counter** (العدّاد اليومي): مبيعات اليوم (**Achieved** أي المُحقَّق) وما تبقّى (**Remaining**) لبلوغ **Target** اليومي، وهو الرقم الحرج اليومي. وتمثّل **Variance** الفجوة بالنسبة المئوية.
3. **Monthly Counter** (العدّاد الشهري): أيام العمل المنقضية هذا الشهر (مثل **22 / 26 Working Days**)، والقيمة **Achieved** و**Remaining** للشهر، وسطر الوتيرة مثل <span class="ltr">"114% of pace achieved"</span> (تحقق 114% من الوتيرة) و<span class="ltr">"+LYD 2.3M vs pace"</span> (زيادة 2.3 مليون دينار عن الوتيرة).
4. **Yearly Counter** (العدّاد السنوي): المعلومات نفسها للسنة حتى تاريخه.
5. **Export image**: لحفظ العدّاد كصورة PNG.

تظهر على كل عدّاد شارة **On Pace** (أخضر، على الوتيرة) أو **Behind Pace** (كهرماني، متأخر عن الوتيرة) أو **Underperforming** (أحمر، أداء ضعيف).

## بطاقات الرقم الحرج

![Critical Number: الهدف اليومي والتقويم](shots/critical_mid.png)

| البطاقة | المعنى |
|---|---|
| **Daily Critical Number** | هدف المبيعات اليومي الأساسي الذي تُقاس به جميع العدادات، ويتغيّر بحسب عاملَي التصفية **Company** و**Customer Group**. |
| **Working Days YTD** | أيام العمل منذ بداية السنة، مع الفترة نفسها من السنة الماضية للمقارنة. تُستبعد منها أيام الراحة الأسبوعية (الجمعة) والعطلات الرسمية. |
| **Weekly Rest Days YTD** | أيام الراحة الأسبوعية المعتادة حتى الآن. |
| **Official Holidays YTD** | العطلات الرسمية حتى الآن. انقر **HOLIDAY LIST** لعرض كل عطلة وتاريخها. |
| **Forced Closures YTD** | الأيام التي اضطر فيها فرع إلى الإغلاق (محسوبة بعدد أيام الفروع). انقر **BRANCH BREAKDOWN** لمعرفة الفروع. |
| **Missing Value YTD** | صافي الفجوة عن الوتيرة: (أيام العمل منذ بداية السنة × الرقم الحرج اليومي) ناقص القيمة الفعلية منذ بداية السنة. القيمة الموجبة تعني التقدّم على الوتيرة، والسالبة تعني التأخر عنها. |
| **Missing Days YTD** | القيمة الناقصة معبَّرًا عنها بأيام مبيعات (القيمة الناقصة ÷ الرقم الحرج اليومي). |

يلخّص جدول **Performance Details** في أسفل الصفحة كل مؤشر مع **Actual** و**Target** و**Variance to Target** و**Status** وعبارة توضيحية مبسّطة **Takeaway** (الخلاصة). انقر **Export PDF** لتنزيله.

> [!NOTE]
> الإغلاق الاضطراري لفرع واحد لا يُنقص **Working Days YTD** على مستوى الشركة، بل يظهر في بطاقته الخاصة. يتولى المسؤول إدارة العطلات وأيام الإغلاق.

> [!TIP]
> من الطبيعي ألا يعرض العدّاد اليومي شيئًا تقريبًا في بداية اليوم؛ فمبيعات اليوم تُضاف مع كل تحديث (08:50 و11:50 و14:50 و17:50 و20:50).

# الترويج: Revenue Trend (اتجاه الإيرادات)

## الغرض

يعرض تقرير **Revenue Trend** المبيعات **شهرًا بشهر** للسنة الحالية، مقارنةً **بالشهر نفسه من السنة الماضية** و**بالهدف**، للقيمة والكمية ومتوسط سعر البيع.

**لفتح التقرير:** **Promotion** › **Revenue Trend**.

![Revenue Trend](shots/revenue_top.png){annot="1:150,144;2:180,468;3:330,144;4:486,112;5:385,176;6:60,431;7:160,600"}

1. **اسم الرسم البياني** مع أيقونة **(i)**: مرِّر المؤشر فوقها لقراءة ما يعرضه الرسم.
2. الرسوم **MoM Value** و**MoM Volume** و**MoM ASP**: نقطة لكل شهر. يبيّن المفتاح **Actual** (خط أسود متصل) و**Y-1** (السنة الماضية، خط برتقالي منقّط) و**Target** (خط بنفسجي متقطّع).
3. **Export as PDF**: لتنزيل أرقام الرسم كملف PDF.
4. **التوسيع** (أيقونة الأسهم): لفتح الرسم بحجم أكبر مع أرقامه في جدول (**Month** و**Actual** و**Y-1** و**Target**).
5. **Export image**: لحفظ الرسم كصورة PNG.
6. **شريط النطاق**: اسحب المقبضين عند طرفي الشريط الرمادي لتكبير نطاق محدد من الأشهر.
7. **بطاقات الفروقات**: **Value** و**Volume** و**ASP Variance to YTD Target**، ومثلها **to MTD Target**. البطاقة الوردية تعني عدم تحقيق الهدف، والبيضاء تعني تحقيقه.

وفي أسفل الصفحة يسرد جدول **Performance Details** كل مؤشر مع **Actual** و**Last** (السنة الماضية) و**Target** و**Variance to Last** و**Variance to Target** و**Status** و**Takeaway**، مع زر **Export PDF**.

# الترويج: Invoices Engine (محرّك الفواتير)

## الغرض

يحلّل تقرير **Invoices Engine** **الفواتير**: عددها، وكفاءتها (عدد الأسطر والقيمة والكمية لكل فاتورة)، وتوزيعها على فئات القيمة.

**لفتح التقرير:** **Promotion** › **Invoices Engine**.

![Invoices Engine](shots/invoices_top.png){annot="1:190,144;2:675,144;3:1195,144;4:150,366;5:745,366;6:1150,350"}

1. **# of Lines per Invoice**: متوسط عدد أسطر المنتجات في الفاتورة، لكل من **LYTD** و**YTD** و**LMTD** و**MTD**.
2. **Sales per Invoice**: متوسط قيمة الفاتورة.
3. **Volume per Invoice**: متوسط الكمية في الفاتورة.
4. **Sales Trend**: قيمة مبيعات الفواتير **Invoice Sales Value** (أعمدة) وعدد الفواتير **# of Invoices** (خط) حسب السنة. **انقر سنةً** لتصفية الصفحة كلها على تلك السنة، وانقر **Back to all years** لإلغاء ذلك.
5. **Drill-down**: لعرض الأرقام التي يقوم عليها الرسم.
6. مربعات **Total # of Invoices**: عدد الفواتير لـ **YTD** و**LYTD** و**MTD** و**LMTD**.

وفي الأسفل يعرض رسم **Invoices Trend** كلًّا من **Avg Sales per Invoice** و**Avg Lines per Invoice** و**Avg Volume per Invoice** حسب السنة.

![Invoices Classification](shots/invoices_class.png)

يصنّف رسم **Invoices Classification** الفواتير حسب قيمتها:

| الفئة | النطاق |
|---|---|
| **High Value** (A) | أكثر من 50 ألف دينار |
| **Upper-Mid Value** (B) | من 25 إلى 50 ألف دينار |
| **Medium Value** (C) | من 5 إلى 25 ألف دينار |
| **Low Value** (D) | أقل من 5 آلاف دينار |

تعرض كل فئة قيمتها الإجمالية ونسبتها من المجموع وعدد فواتيرها. **انقر فئةً** لتصفية الصفحة عليها، واستخدم **Drill-down** لعرض الأرقام التي تقوم عليها.

تحتوي هذه الصفحة أيضًا على عامل التصفية **Customer**، ويُطبَّق عليها وحدها.

# الترويج: Customer Growth (نمو العملاء)

## الغرض

يتابع تقرير **Customer Growth** **قاعدة العملاء**: العملاء الجدد وإجمالي العملاء، ومن احتفظنا بهم ومن فقدناهم، وأكثر العملاء مساهمة، وأداء فئات العملاء.

**لفتح التقرير:** **Promotion** › **Customer Growth**.

![Customer Growth](shots/customer_top.png){annot="1:170,176;2:1190,176;3:190,397;4:1240,440"}

1. **New Customers** (العملاء الجدد) و**Total Customers** (إجمالي العملاء): أعداد العملاء لـ **LYTD** و**YTD** و**LMTD** و**MTD**.
2. **Customer Status** (حالة العملاء): عدد العملاء **Active Retained** و**Inactive / Non-Active** و**Blocked** و**Reactivated** (راجع الجدول أدناه). انقر **View Customer Status details** لفتح قائمة العملاء.
3. **Customers Trend**: **Total Sales Value** (أعمدة) و**Customer Count** (خط) حسب السنة. انقر سنةً لتصفية الصفحة عليها.
4. **بطاقات المعدلات**: **Customer Acquisition** و**Customer Growth** و**Retention Rate** و**Churn Rate** (راجع *المعدلات* أدناه). البطاقة الوردية تعني أن المعدل غير مُرضٍ.

وفي الأسفل يقارن رسم **Customers Contribution** بين **Top 10 Customers** (أكبر 10 عملاء) و**Other Customers** (بقية العملاء) — انقر أيًّا من المجموعتين لعرض عملائها — ويعرض رسم **Customers Category Share** المبيعات حسب فئة العملاء (انقر فئةً لعرض عملائها، واستخدم **Back to categories** للعودة). قد يستغرق تحميل هذه الصفحة بضع دقائق.

### حالات العملاء

| الحالة | المعنى |
|---|---|
| **Active Retained** | اشترى هذه السنة (YTD) **وأيضًا** في الفترة نفسها من السنة الماضية (LYTD). |
| **New** | اشترى هذه السنة ولم يسبق له الشراء قط. |
| **Reactivated** | اشترى هذه السنة، ولم يشترِ في LYTD، لكنه اشترى قبل ذلك. |
| **Non Active** | اشترى في LYTD لكنه **لم** يشترِ هذه السنة. |
| **Blocked** | محظور في نظام الشركة، بصرف النظر عن مشترياته. |
| **Other** | لا ينطبق عليه أي مما سبق. |

### المعدلات

| المعدل | طريقة الحساب |
|---|---|
| **Customer Acquisition** (اكتساب العملاء) | التغيّر في العملاء الجدد مقارنةً بالسنة الماضية: (الجدد YTD − الجدد LYTD) ÷ الجدد LYTD |
| **Customer Growth** (نمو العملاء) | التغيّر في إجمالي العملاء: (الإجمالي YTD − الإجمالي LYTD) ÷ الإجمالي LYTD |
| **Retention Rate** (معدل الاحتفاظ) | (Active Retained + Reactivated) ÷ إجمالي العملاء LYTD |
| **Churn Rate** (معدل الفقدان) | Non Active ÷ إجمالي العملاء LYTD |

> [!NOTE]
> لا يساوي مجموع معدلَي الاحتفاظ والفقدان 100% دائمًا؛ لأن العملاء المُعاد تنشيطهم يُحسبون ضمن الاحتفاظ مع أنهم لم يكونوا جزءًا من قاعدة السنة الماضية.

> [!TIP]
> استخدم عامل التصفية **Customer** للاطلاع على عميل واحد عبر الصفحة كلها.

# الترويج: Pipeline Health (سلامة فرص البيع)

## الغرض

يعرض تقرير **Pipeline Health** وضع **خط فرص البيع** (فرص نظام إدارة علاقات العملاء CRM) خلال هذه السنة: كيف تنتقل الفرص من فرصة إلى عرض سعر إلى أمر بيع إلى تسليم، وما المتوقع إغلاقه ومتى، ومدى احتمال إغلاق كل صفقة.

**لفتح التقرير:** **Promotion** › **Pipeline Health**. تستخدم هذه الصفحة **بيانات منذ بداية السنة فقط**.

![Pipeline Health](shots/pipeline_health.png){annot="1:80,380;2:250,144;3:775,230;4:1020,169"}

1. **Full Pipeline** (خط الفرص الكامل): قمع يمثّل **Opportunities → Quotations → Sales Orders → Deliveries** (الفرص ← عروض الأسعار ← أوامر البيع ← التسليمات)، مع عدد كل مرحلة ونسبتها وقيمتها أسفله. انقر مرحلةً (أو **Drill-down**) لعرض سجلاتها.
2. **Opportunity chain** (سلسلة الفرصة): لتتبّع كل فرصة حتى التسليم.
3. **Stage Benchmark** (مقارنة المراحل): نسبة التحويل الفعلية في كل خطوة (مثل **Opportunity → Quotation**) مقارنةً بالنسبة المستهدفة، مع شارة الحالة.
4. **Expected Closure Opportunity**: **Expected Opportunity Count** (أعمدة) و**Expected Opportunity Value** (خط) حسب الشهر المتوقع لإغلاق الصفقات. انقر شهرًا لعرض فرصه.

وفي الأسفل يعرض رسم **Opportunity by Stage** الفرص المفتوحة حسب مرحلتها في CRM، ويجمّعها رسم **Probabilities Distribution** حسب احتمال الفوز. انقر جزءًا أو عمودًا لعرض الفرص. قد يستغرق تحميل هذه الصفحة بضع دقائق.

تعرض قائمة الفرص (**Opportunity Details**) الأعمدة **Opportunity Name** و**Stage** و**Probability %** و**Expected Close Date** و**Value** و**Customer** و**Company** و**Salesperson** و**Created Date**، مع زر **Download as PDF**. انقر **Back** للعودة إلى الرسوم.

> [!NOTE]
> تُستبعد الفرص المكسوبة والخاسرة من عروض خط الفرص لأنها لم تعد "ضمن الخط".

# الترويج: Pipeline Trend (اتجاه فرص البيع)

## الغرض

يعرض تقرير **Pipeline Trend** تطوّر الفرص وعروض الأسعار وأوامر البيع **شهرًا بشهر**، وسرعة الفوز بعروض الأسعار، وعمر البنود المفتوحة.

**لفتح التقرير:** **Promotion** › **Pipeline Trend** (بيانات منذ بداية السنة فقط).

![Pipeline Trend](shots/pipeline_trend.png){annot="1:180,176;2:345,381;3:910,176"}

1. **Quotation Rates** (معدلات عروض الأسعار): **Total Quotations YTD** و**Won Quotations YTD** و**Lost Quotations YTD** و**Open Quotations YTD** و**Win Rate YTD** (نسبة الفوز) و**Won/Lost Ratio YTD** (نسبة المكسوب إلى الخاسر).
2. **Open Opportunities & Quotations by Aging**: البنود المفتوحة مجمّعة حسب عمرها: **0-30 days** و**30-60 days** و**60-90 days** و**90+ days**.
3. **Opportunities** و**Quotations** و**Sales Orders**: الأعداد والقيم الشهرية (**#YTD** و**Value YTD**).

ويسرد جدول **Performance Details** في الأسفل كل مؤشر مع **Actual** و**Target** و**Variance%** و**Variance LY** و**Trend** و**Status** و**Takeaway**.

> [!TIP]
> العمود الكبير في فئة **90+ days** يعني أن عروض الأسعار تتقادم دون قرار؛ تابعها مع المندوبين المعنيين.

# الترويج: Activity Momentum (زخم النشاط)

## الغرض

يبيّن تقرير **Activity Momentum** ما إذا كانت الفرص **يُعمل عليها بنشاط**: كم منها نشط أو مكسوب أو خاسر أو متوقف، ولماذا تُفقد الصفقات.

**لفتح التقرير:** **Promotion** › **Activity Momentum** (بيانات منذ بداية السنة فقط).

![Activity Momentum](shots/activity.png){annot="1:205,176;2:270,389;3:1190,389;4:1500,180"}

1. **Opportunity Activities** (أنشطة الفرص): **#YTD** (الفرص المُنشأة هذه السنة) و**#Won** و**#W/O Activity** و**#Active** و**#Lost** و**#W/O Next Step**.
2. **Total Lost Opportunity by Reason**: أسباب خسارة الفرص كنسبة من جميع الفرص الخاسرة.
3. **New Opportunities**: الفرص المُنشأة كل شهر (**YTD**) مقارنةً بـ **Target**.
4. **Inactive Deals Ratio** و**Lost Deals Ratio** (راجع الجدول أدناه). البطاقة الوردية تعني أن النسبة غير مُرضية.

| المصطلح | المعنى |
|---|---|
| **#W/O Activity** (دون نشاط) | فرص B2B مفتوحة لم يصدر لها أي عرض سعر، ومضى على إنشائها 30 يومًا أو أكثر. |
| **#W/O Next Step** (دون خطوة تالية) | فرص B2B مفتوحة صدر لها عرض سعر، لكن لم يحدث شيء منذ 30 يومًا أو أكثر من آخر عرض. |
| **Inactive Deals Ratio** | الفرص التي بلا نشاط **أو** بلا خطوة تالية (تُحسب كل فرصة مرة واحدة) كنسبة من فرص B2B المفتوحة. |
| **Lost Deals Ratio** | الفرص الخاسرة كنسبة من جميع فرص هذه السنة. |

انقر **View Opportunity Activities details** لفتح **Opportunity Table** (الأعمدة: **Created Date** و**Opportunity Name** و**Customer** و**Company** و**Expected Revenue** و**Salesperson** و**Stage**). استخدم **Activity Filter** لعرض الفرص **Active** أو **Lost** أو **Won** أو **Inactive** أو **Without Next Step** فقط. ويشرح **Opportunity Activities definitions** كل مصطلح على الشاشة.

# الترويج: تقارير MARCOM

تعرض تقارير **MARCOM** (الاتصالات التسويقية) الأربعة مساهمة إدارة التسويق. تأتي بياناتها من **ملف شهري** تحمّله إدارة التسويق، وليس من نظام المبيعات.

## العناصر المشتركة في صفحات MARCOM

![رأس صفحات MARCOM وعوامل التصفية](shots/marcom_filters.png){annot="1:380,118;2:95,160;3:195,160;4:415,160;5:525,188;6:1395,254"}

1. **Data as of … — uploaded by … on …**: الشهر الذي تمتد إليه البيانات، ومن حمّلها ومتى.
2. **Year** (السنة): السنة المعروضة، وتُستخدم السنة السابقة للمقارنة.
3. **From** و**To**: أول شهر وآخر شهر في الفترة.
4. **Brand** (العلامة التجارية)، وفي بعض الصفحات **Platform** (المنصة) أو **Campaign status** (حالة الحملة): لتضييق نطاق الصفحة.
5. **Reset**: لإعادة عوامل تصفية MARCOM إلى قيمها الافتراضية.
6. تعرض كل بطاقة مؤشر حالةً (**On target** أو **Watch** أو **Off target** أو **No target**)، والتغيّر **vs previous** (مقارنةً بالسابق: **improving** تحسّن، **worsening** تراجع، **unchanged** دون تغيير)، وزر **View as table**.

> [!NOTE]
> عوامل تصفية MARCOM منفصلة عن شريط تصفية المبيعات، فلا تنطبق **Company** و**Branch** وأمثالهما على هذه الصفحات. وإذا ظهرت الرسالة **No MARCOM data uploaded yet**، فهذا يعني أن ملف تلك الفترة لم يُحمَّل بعد.

## MARCOM Spending (الإنفاق التسويقي)

يبيّن كيف تُنفق ميزانية التسويق وما عائدها.

![MARCOM Spending (معروضة لسنة 2025)](shots/marcom_spending.png)

- **Total Spend vs Total Revenue**: الإنفاق التسويقي مقارنةً بـ **Revenue Attributed to Marketing** (الإيرادات المنسوبة إلى التسويق). فعِّل **Overlay company revenue** لإضافة **Total Company Revenue** (إجمالي إيرادات الشركة).
- **ROI trend — YTD vs LYTD**: العائد على الاستثمار هذه السنة مقارنةً بالسنة الماضية؛ الأخضر فوق النسبة المستهدفة والأحمر دونها.
- **Budget utilization by brand**: الإنفاق كنسبة من الميزانية لكل علامة، ويمثّل الخط **100% of budget**، والعلامات التي تتجاوزه تظهر **Over budget** (تجاوز الميزانية).
- **Brand growth**: رقم كل علامة الحالي مقارنةً بالسنة الماضية.
- **CAC — Customer Acquisition Cost** (تكلفة اكتساب العميل) و**CPC — Cost per Click** (تكلفة النقرة)، بما في ذلك CAC كنسبة من متوسط الفاتورة، وCPC لكل علامة.

## Media Campaign Performance (أداء الحملات الإعلامية)

يعرض أداء الحملات الإعلانية والإعلانات الخارجية.

![Media Campaign Performance](shots/marcom_campaigns.png)

- **Spend vs Revenue by Campaign**: إنفاق كل حملة وإيراداتها، ومرِّر الرسم أفقيًا لرؤية جميع الحملات.
- **Total Spend vs Revenue Rate**: الإيرادات ÷ الإنفاق لجميع الحملات مجتمعة.
- **ROI by Campaign**: العائد لكل حملة، باللون الأخضر (فوق الهدف) أو الكهرماني أو الأحمر.
- **Campaign timeline**: توقيت كل حملة؛ مرِّر المؤشر فوق أي شريط لمعرفة تواريخه وعلامته وإنفاقه وإيراداته وعائده.
- **Geographic coverage by type** و**Cost by type**: وسائل الإعلان الخارجي مثل **Billboards** و**Mega Billboards** و**Bridge Banners** و**Street Lights** و**Light Screen**، مع **Units** (الوحدات) و**Cost per unit** (تكلفة الوحدة). ويمكن عرض **Cost by type** بشكل **Bars** (أعمدة) أو **Bubbles** (فقاعات).

## Digital Performance (الأداء الرقمي)

يعرض أداء وسائل التواصل الاجتماعي والموقع الإلكتروني.

![Digital Performance](shots/marcom_digital.png)

- **Followers / Likes by platform**: المتابعون والإعجابات على Facebook وInstagram وLinkedIn وTikTok وGoogle، مع إجمالي Meta (Facebook + Instagram).
- **CTR — Click-through rate** (نسبة النقر) و**Engagement Rate** (معدل التفاعل)، إجماليًا ولكل منصة.
- **Organic vs Paid engagement per month**: التفاعل العضوي مقابل المدفوع شهريًا، بعرض **Stacked** (مكدّس) أو **Grouped** (مجمّع)، مع حصة التفاعل العضوي.
- **Bounce Rate** (معدل الارتداد، والأقل أفضل) و**Average Session Duration** (متوسط مدة الجلسة) للموقع الإلكتروني.

## Trade Marketing & Retail (التسويق التجاري والتجزئة)

يعرض التسويق داخل نقاط البيع والفعاليات.

![Trade Marketing & Retail](shots/marcom_trade.png)

- **Compliance Rate** (نسبة الالتزام): مدى التزام نقاط البيع بمعايير العرض، وتبيّن البطاقة آخر شهر ومتوسط الفترة.
- **Giveaways Stock** و**Printed Materials Stock**: مستويات مخزون الهدايا الترويجية والمطبوعات.
- **Events by type — per month**: الفعاليات حسب الفئة (Professionals وArchitects/Designers وCorporate وCSR وEntertainment وLaunch & Opening وInternal/Trainings وExhibitions). اختر **Include planned** (تضمين المخطط) أو **Completed only** (المكتمل فقط)، وتُستبعد الفعاليات الملغاة.
- **Events timeline — plan vs completion**: الفعاليات المخططة مقابل المنجزة، بعرض **Timeline** (خط زمني) أو **Table** (جدول: **Event** و**Type** و**Brand** و**Planned** و**Completion**).
- **Attendance Rate** (نسبة الحضور): الحضور الفعلي مقارنةً بالمتوقع.
<!-- /only -->
