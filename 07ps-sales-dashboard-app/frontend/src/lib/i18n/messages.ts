/**
 * App-shell strings in English and Arabic, grouped by area: `shell.*` (header, sidebar, bottom
 * nav, hubs) and `dept.*` (the seven departments). The Kaizen module is English-only and keeps its
 * own text in lib/kaizen/text.ts.
 * Adding a string = one line in `en` (the type) plus its `ar` twin (checked by the compiler).
 */
const en = {
  // Shell
  'shell.home': 'Home',
  'shell.admin': 'Admin',
  'shell.back': 'Back',
  'shell.logout': 'Log out',
  'shell.darkMode': 'Switch to dark mode',
  'shell.lightMode': 'Switch to light mode',
  'shell.language': 'العربية',
  'shell.languageAria': 'Switch language to Arabic',
  'shell.notifications': 'Notifications',
  'shell.signedIn': 'Signed in',
  'shell.collapse': 'Collapse sidebar',
  'shell.expand': 'Expand sidebar',
  'shell.hubTitle': '7Ps Dashboard Hub',
  'shell.hubSubtitle': 'Select a department to view its performance dashboard.',
  'shell.viewKpis': 'View KPIs',
  'shell.comingSoon': 'Coming Soon',
  'shell.openReport': 'Open report',
  'shell.liveReport': 'Live report.',
  'shell.notBuilt': 'Not built yet.',
  'shell.deptReports': 'Reports available in the {pTerm} ({name}) department.',
  'shell.loading': 'Loading...',
  'shell.noAccess': "You don't have access to this page.",

  // Departments
  'dept.promotion.pTerm': 'Promotion',
  'dept.promotion.name': 'Commercial Department',
  'dept.promotion.tagline': 'Sales performance dashboard',
  'dept.product.pTerm': 'Product',
  'dept.product.name': 'Production Department',
  'dept.product.tagline': 'Production performance dashboard',
  'dept.price.pTerm': 'Price',
  'dept.price.name': 'Finance Department',
  'dept.price.tagline': 'Financial performance dashboard',
  'dept.place.pTerm': 'Place',
  'dept.place.name': 'Supply Chain Department',
  'dept.place.tagline': 'Supply chain performance dashboard',
  'dept.people.pTerm': 'People',
  'dept.people.name': 'Human Resource Department',
  'dept.people.tagline': 'Workforce performance dashboard',
  'dept.process.pTerm': 'Process',
  'dept.process.name': 'Excellence Department',
  'dept.process.tagline': 'Process excellence dashboard',
  'dept.physical-evidence.pTerm': 'Physical Evidence',
  'dept.physical-evidence.name': 'HSE Department',
  'dept.physical-evidence.tagline': 'Safety & environment dashboard',

};

export type MessageKey = keyof typeof en;

const ar: Record<MessageKey, string> = {
  'shell.home': 'الرئيسية',
  'shell.admin': 'الإدارة',
  'shell.back': 'رجوع',
  'shell.logout': 'تسجيل الخروج',
  'shell.darkMode': 'الوضع الداكن',
  'shell.lightMode': 'الوضع الفاتح',
  'shell.language': 'English',
  'shell.languageAria': 'تغيير اللغة إلى الإنجليزية',
  'shell.notifications': 'الإشعارات',
  'shell.signedIn': 'تم تسجيل الدخول',
  'shell.collapse': 'طي القائمة',
  'shell.expand': 'توسيع القائمة',
  'shell.hubTitle': 'لوحة 7Ps الرئيسية',
  'shell.hubSubtitle': 'اختر إدارة لعرض لوحة أدائها.',
  'shell.viewKpis': 'عرض المؤشرات',
  'shell.comingSoon': 'قريباً',
  'shell.openReport': 'فتح التقرير',
  'shell.liveReport': 'تقرير مباشر.',
  'shell.notBuilt': 'لم يُبنَ بعد.',
  'shell.deptReports': 'التقارير المتاحة في {pTerm} ({name}).',
  'shell.loading': 'جارٍ التحميل...',
  'shell.noAccess': 'لا تملك صلاحية الوصول إلى هذه الصفحة.',

  'dept.promotion.pTerm': 'الترويج',
  'dept.promotion.name': 'الإدارة التجارية',
  'dept.promotion.tagline': 'لوحة أداء المبيعات',
  'dept.product.pTerm': 'المنتج',
  'dept.product.name': 'إدارة الإنتاج',
  'dept.product.tagline': 'لوحة أداء الإنتاج',
  'dept.price.pTerm': 'السعر',
  'dept.price.name': 'الإدارة المالية',
  'dept.price.tagline': 'لوحة الأداء المالي',
  'dept.place.pTerm': 'المكان',
  'dept.place.name': 'إدارة سلسلة الإمداد',
  'dept.place.tagline': 'لوحة أداء سلسلة الإمداد',
  'dept.people.pTerm': 'الأفراد',
  'dept.people.name': 'إدارة الموارد البشرية',
  'dept.people.tagline': 'لوحة أداء القوى العاملة',
  'dept.process.pTerm': 'العمليات',
  'dept.process.name': 'إدارة التميز',
  'dept.process.tagline': 'لوحة التميز في العمليات',
  'dept.physical-evidence.pTerm': 'الدليل المادي',
  'dept.physical-evidence.name': 'إدارة الصحة والسلامة والبيئة',
  'dept.physical-evidence.tagline': 'لوحة السلامة والبيئة',

};

export const MESSAGES: Record<'en' | 'ar', Record<MessageKey, string>> = { en, ar };
