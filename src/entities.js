// Declarative definition of the company-scoped records. The generic tenant
// repository builds every query from this whitelist; nothing here mentions a
// specific company.

// Stored statuses ("قيد إنهاء الخدمة" is shown, not stored — see src/employees.js).
const STATUS_EMPLOYEE = [['onboarding', 'قيد الانضمام'], ['active', 'نشط'], ['inactive', 'منتهي الخدمة']];

export const ENTITIES = {
  employees: {
    table: 'employees',
    label: 'سجلات الموظفين',
    singular: 'موظف',
    labelField: 'full_name_ar',
    fields: [
      { name: 'employee_no', label: 'الرقم الوظيفي', type: 'empno' },
      { name: 'full_name_ar', label: 'الاسم بالعربية', type: 'text', required: true },
      { name: 'full_name_en', label: 'الاسم بالإنجليزية', type: 'text' },
      { name: 'gender', label: 'الجنس', type: 'select', options: [['male', 'ذكر'], ['female', 'أنثى']] },
      { name: 'national_id', label: 'رقم الهوية / الإقامة', type: 'text' },
      { name: 'nationality_ar', label: 'الجنسية (عربي)', type: 'text' },
      { name: 'nationality_en', label: 'الجنسية (إنجليزي)', type: 'text' },
      { name: 'job_title', label: 'المسمى الوظيفي (عربي)', type: 'text' },
      { name: 'job_title_en', label: 'المسمى الوظيفي (إنجليزي)', type: 'text' },
      { name: 'department', label: 'الإدارة', type: 'text' },
      { name: 'hire_date', label: 'تاريخ المباشرة', type: 'date' },
      { name: 'end_date', label: 'تاريخ انتهاء الخدمة', type: 'date' },
      { name: 'status', label: 'الحالة', type: 'select', options: STATUS_EMPLOYEE, default: 'active' },
      { name: 'basic_salary', label: 'الراتب الأساسي', type: 'number' },
      { name: 'housing_allowance', label: 'بدل السكن', type: 'number' },
      { name: 'transport_allowance', label: 'بدل النقل', type: 'number' },
      { name: 'other_allowance', label: 'بدلات أخرى', type: 'number' },
    ],
    list: ['employee_no', 'full_name_ar', 'job_title', 'department', 'status'],
    search: ['employee_no', 'full_name_ar', 'full_name_en', 'national_id'],
  },

  consultants: {
    table: 'consultants',
    label: 'الاستشاريون',
    singular: 'استشاري',
    labelField: 'full_name_ar',
    fields: [
      { name: 'full_name_ar', label: 'الاسم بالعربية', type: 'text', required: true },
      { name: 'full_name_en', label: 'الاسم بالإنجليزية', type: 'text' },
      { name: 'gender', label: 'الجنس', type: 'select', options: [['male', 'ذكر'], ['female', 'أنثى']] },
      { name: 'nationality_ar', label: 'الجنسية (عربي)', type: 'text' },
      { name: 'nationality_en', label: 'الجنسية (إنجليزي)', type: 'text' },
      { name: 'id_number', label: 'رقم الهوية / الإقامة', type: 'text' },
      { name: 'mobile', label: 'رقم الجوال', type: 'text' },
      { name: 'email', label: 'البريد الإلكتروني', type: 'text' },
      { name: 'bank_beneficiary', label: 'اسم المستفيد في الحساب', type: 'text' },
      { name: 'bank_name', label: 'البنك', type: 'text' },
      { name: 'iban', label: 'رقم الآيبان (IBAN)', type: 'iban' },
      { name: 'swift_code', label: 'رمز السويفت', type: 'text' },
      { name: 'notes', label: 'ملاحظات', type: 'textarea' },
    ],
    list: ['full_name_ar', 'nationality_ar', 'id_number', 'mobile', 'bank_name', 'iban'],
    search: ['full_name_ar', 'full_name_en', 'id_number', 'mobile', 'email'],
  },

  tickets: {
    table: 'tickets',
    label: 'التذاكر',
    singular: 'تذكرة',
    labelField: 'subject',
    fields: [
      { name: 'ticket_no', label: 'رقم التذكرة', type: 'text' },
      { name: 'subject', label: 'الموضوع', type: 'text', required: true },
      { name: 'employee_id', label: 'الموظف', type: 'ref', ref: 'employees' },
      {
        name: 'category', label: 'التصنيف', type: 'select',
        options: [['travel', 'تذاكر سفر'], ['request', 'طلب خدمة'], ['other', 'أخرى']],
      },
      {
        name: 'priority', label: 'الأولوية', type: 'select', default: 'normal',
        options: [['low', 'منخفضة'], ['normal', 'عادية'], ['high', 'عالية']],
      },
      {
        name: 'status', label: 'الحالة', type: 'select', default: 'open',
        options: [['open', 'مفتوحة'], ['in_progress', 'قيد المعالجة'], ['closed', 'مغلقة']],
      },
      { name: 'details', label: 'التفاصيل', type: 'textarea' },
    ],
    list: ['ticket_no', 'subject', 'employee_id', 'priority', 'status'],
    search: ['ticket_no', 'subject'],
  },

  bank_accounts: {
    table: 'bank_accounts',
    label: 'الحسابات البنكية',
    singular: 'حساب بنكي',
    labelField: 'account_holder',
    fields: [
      { name: 'employee_id', label: 'الموظف (اتركه فارغًا لحساب الشركة)', type: 'ref', ref: 'employees' },
      { name: 'account_holder', label: 'اسم صاحب الحساب', type: 'text', required: true },
      { name: 'bank_name', label: 'البنك', type: 'text', required: true },
      { name: 'iban', label: 'رقم الآيبان (IBAN)', type: 'iban', required: true },
      { name: 'is_primary', label: 'الحساب الأساسي', type: 'checkbox' },
    ],
    list: ['account_holder', 'employee_id', 'bank_name', 'iban', 'is_primary'],
    search: ['account_holder', 'bank_name', 'iban'],
  },
};

// Public description sent to the browser (no table names).
export function entityMeta() {
  return Object.fromEntries(
    Object.entries(ENTITIES).map(([key, d]) => [
      key,
      { label: d.label, singular: d.singular, fields: d.fields, list: d.list },
    ]),
  );
}
