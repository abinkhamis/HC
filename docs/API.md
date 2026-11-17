# HC Operations Hub — واجهة برمجة أداة العقود الاستشارية

هذه الواجهة هي نفسها التي تستخدمها صفحات المنصة، وهي معدّة ليُربط بها أي نظام آخر لاحقًا (مثل «مها») دون إعادة بناء الوظائف. منطق العمل كله في [src/consulting.js](../src/consulting.js) ولا يعتمد على الواجهة.

## قواعد عامة
- **الشركة:** كل طلب يعمل على الشركة المختارة في الجلسة فقط. يُرسل العميل `X-Company-Id` بالشركة التي يعمل عليها، وإن اختلفت عن الجلسة يُرفض الطلب برمز `409` و`code: company_changed`. أي `company_id` داخل البيانات يُتجاهل.
- **الطلبات المعدِّلة** (POST/PATCH/DELETE) تتطلب الترويسة `X-Requested-With: hub`.
- **التواريخ** بصيغة `YYYY-MM-DD`، و**المبالغ** أرقام بالريال.
- **الأخطاء:** `{ "error": "<رسالة عربية>", "code": "<رمز اختياري>" }`. من الرموز: `no_template`، `missing_fields`، `finance_confirmation_required`، `cross_company_reference`، `duplicate`.
- **لا شيء تلقائي:** لا تتغير حالة عقد أو إنجاز مخرج أو دفعه إلا بطلب صريح من الطرق أدناه.

## الاستشاريون
| الطريقة | المسار | الوصف |
|---|---|---|
| GET | `/api/records/consultants?q=` | قائمة الاستشاريين |
| POST | `/api/records/consultants` | إضافة استشاري (`full_name_ar` مطلوب) |
| PATCH | `/api/records/consultants/:id` | تعديل |

## العقود
| الطريقة | المسار | الوصف |
|---|---|---|
| GET | `/api/consulting/contracts?status=&q=` | قائمة العقود مع القيمة والمدفوع والمتبقي وأقرب استحقاق |
| POST | `/api/consulting/contracts` | إنشاء عقد ومخرجاته (مخرج واحد على الأقل) |
| GET | `/api/consulting/contracts/:id` | العقد كاملًا: الاستشاري، المخرجات وحالاتها، الدفعات، سجل النشاط |
| PATCH | `/api/consulting/contracts/:id` | تعديل العقد، و`deliverables` (إن أُرسلت) تحل محل القائمة |
| POST | `/api/consulting/contracts/:id/status` | `{action, date, reason?, file?}`، والإجراءات: `mark_sent` · `mark_signed` · `terminate` · `close` · `reopen` |
| POST/GET | `/api/consulting/contracts/:id/signed-copy` | رفع النسخة الموقعة أو تنزيلها |

مثال إنشاء:
```json
{
  "consultant_id": 12, "project_name": "…", "supervisor_name": "…",
  "contract_date": "2026-10-01", "start_date": "2026-10-01", "end_date": "2026-12-31",
  "deliverables": [
    { "title": "…", "amount": 10000, "due_date": "2026-10-31", "period_from": "2026-10-01", "period_to": "2026-10-31" }
  ]
}
```
- لا يُحذف مخرج صدرت له شهادة أو سُجّلت له دفعة.
- لا تُخفض قيمة مخرج إلى أقل من المدفوع له.

## المستندات الرسمية
تُرفض كل طرق الإصدار برمز `422 no_template` إذا لم يرفع الـ Admin النموذج الرسمي لنفس الشركة.

| الطريقة | المسار | الوصف |
|---|---|---|
| GET | `/api/consulting/templates` | هل نموذجا العقد والشهادة متوفران؟ والتواقيع والأختام المتاحة |
| POST | `/api/consulting/contracts/:id/document/preview` | القيم التي ستُكتب في العقد والبيانات الناقصة |
| POST | `/api/consulting/contracts/:id/document` | إصدار ملف العقد (Word) |
| GET | `/api/consulting/contracts/:id/document` | تنزيل آخر إصدار |
| POST | `/api/consulting/deliverables/:id/certificate/preview` | معاينة شهادة الإنجاز |
| POST | `/api/consulting/deliverables/:id/certificate` | إصدار الشهادة، و`completion_date` إلزامي (وهو ما يسجّل الإنجاز) |
| GET | `/api/consulting/deliverables/:id/certificate` | تنزيل الشهادة |

خيارات الإصدار: `include_logo`، `include_signature`، `include_stamp`، `signature_id`، `stamp_id`.

## الإرسال والدفع
| الطريقة | المسار | الوصف |
|---|---|---|
| POST | `/api/consulting/deliverables/:id/certificate-sent` | `{sent_at, sent_to?}` |
| POST | `/api/consulting/deliverables/:id/payments` | `{amount, paid_at, transfer_reference?, note?, finance_confirmed: true}` |
| DELETE | `/api/consulting/payments/:id` | `{reason}` إلزامي، ويُسجَّل في سجل النشاط |

- لا تُقبل دفعة دون `finance_confirmed: true`.
- لا تُقبل دفعة تتجاوز المتبقي أو بتاريخ مستقبلي.

## لوحة المتابعة
`GET /api/consulting/summary?days=30` يعيد:
- `counts` و`money` (الإجمالي، المدفوع، غير المدفوع).
- `overdue` و`upcoming`: مخرجات غير مدفوعة.
- `certificates_to_send` و`awaiting_payment`.
- `contracts_ending` و`contracts_expired`.

العقود بحالة «مسودة» لا تدخل في المتابعة المالية.

## الحالات المحسوبة لكل مخرج
- `stage`: `in_progress` · `completed` · `certificate_issued` · `certificate_sent`
- `payment_status`: `unpaid` · `partial` · `paid`
- `due_state`: `overdue` · `upcoming` · `null`
- `paid_total` و`remaining`

## قبل ربط «مها»
تعمل الواجهة حاليًا بجلسة المستخدم (كوكي). يحتاج الربط مع نظام آخر حساب خدمة أو مفتاح API بصلاحيات محددة، ويُضاف ذلك عند الربط دون تغيير الوظائف أعلاه.

---

# أداة تذاكر الطيران

منطق العمل كله في [src/airtickets.js](../src/airtickets.js)، والدالة `computeEntitlements` مستقلة (بلا قاعدة بيانات) ويمكن استدعاؤها مباشرة. القواعد العامة أعلاه (الشركة، الترويسات، الأخطاء) تنطبق.

| الطريقة | المسار | الوصف |
|---|---|---|
| GET | `/api/air-tickets/meta` | التسميات: أنواع السجلات، حالات الرصيد، الشمول |
| GET | `/api/air-tickets/policy` | السياسة الحالية وسجل الإصدارات |
| POST | `/api/admin/air-tickets/policy` | (مسؤول) إصدار جديد: `cycle_months`، `due_soon_days`، `tracking_start`، `effective_from` (اليوم أو بعده)، `note` |
| GET | `/api/air-tickets/summary?from&to` | لوحة المتابعة: الإجماليات، `due_soon`، `accumulated`، `disbursed`، `alerts` |
| GET | `/api/air-tickets/balances?eligibility&balance_status&employee_status&q` | رصيد كل موظف. `eligibility`: `eligible` (افتراضي) · `excluded` · `all` |
| GET | `/api/air-tickets/employees/:id` | رصيد موظف كامل: الفترات، الأسرة، سجل الصرف، الاعتمادات، السجل |
| PATCH | `/api/air-tickets/employees/:id/profile` | `destination`، `travel_class`، `notes` |
| POST | `/api/air-tickets/employees/:id/family` | `family_count`، `effective_from`، `note` |
| DELETE | `/api/air-tickets/family/:id` | `reason` مطلوب |
| GET | `/api/air-tickets/disbursements?employee_id&source&from&to&q` | سجل الصرف |
| POST | `/api/air-tickets/disbursements` | `employee_id`، `source` (`historical`/`current`)، `disbursed_on`، `entitlements_used`، `employee_included`، `family_count`، `ticket_amount`، `exit_reentry_fee`، `reference`، `notes`، `confirm_exceed` |
| PATCH | `/api/air-tickets/disbursements/:id` | نفس الحقول (عدا الموظف والنوع) |
| DELETE | `/api/air-tickets/disbursements/:id` | (مسؤول) `reason` مطلوب |
| POST | `/api/air-tickets/employees/:id/opening-balance/approve` | (مسؤول) `reviewed: true` مطلوب، `as_of`، `note` |
| POST | `/api/air-tickets/employees/:id/opening-balance/revoke` | (مسؤول) `reason` مطلوب |
| GET | `/api/air-tickets/events?employee_id` | سجل التعديلات |
| GET | `/api/air-tickets/export.xlsx?from&to` | تقرير Excel |

**حقول الرصيد المحسوبة:** `accrued`، `used`، `remaining`، `family_accrued`، `family_used`، `family_remaining`، `next_due`، `balance_status` (`provisional` · `approved` · `not_required` · `needs_review`)، `final` (صحيح فقط إذا كان معتمدًا أو لا يحتاج اعتمادًا)، `warnings`.

**رموز الأخطاء:** `not_eligible`، `nationality_missing`، `hire_date_missing`، `exceeds_balance` (أعد الإرسال مع `confirm_exceed: true` بعد التأكد)، `opening_locked`، `review_required`.

**لـ«مها» لاحقًا:** تنبيهات الاستحقاقات القادمة من `summary.due_soon`، والرصيد من `employees/:id`. تسجيل الصرف يبقى بطلب صريح من المستخدم؛ لا شيء يُصرف أو يُعتمد تلقائيًا.

---

# أداة متابعة إجراءات الموظفين

منطق العمل في [src/procedures.js](../src/procedures.js). القواعد العامة أعلاه تنطبق.

| الطريقة | المسار | الوصف |
|---|---|---|
| GET | `/api/procedures/meta` | التسميات |
| GET | `/api/procedures/summary` | لوحة المتابعة |
| GET | `/api/procedures/outstanding?owner_member_id&party_id&case_type&case_id&overdue=1` | النواقص: كل إجراء معلّق في الحالات المفتوحة |
| GET | `/api/procedures/employee-match?full_name_ar&employee_no&national_id` | موظفو الشركة المطابقون (للتحقق من التكرار) مع حالة المباشرة المفتوحة إن وُجدت |
| POST | `/api/procedures/onboarding` | موظف جديد + حالة مباشرة في عملية واحدة: `employee` (حقول الدليل + `hire_date`)، `case` (`project_id`، `owner_name`، `notes`)، `confirm_new_employee` |
| GET | `/api/procedures/cases?case_type&status&q&project_id&overdue=1` | الحالات مع نسبة الإنجاز |
| POST | `/api/procedures/cases` | `case_type`، `employee_id`، `key_date`، `project_id`، `offboarding_reason_id`، `notice_date`، `owner_name`، `notes`، `confirm_duplicate` |
| GET / PATCH | `/api/procedures/cases/:id` | حالة كاملة بإجراءاتها وسجلها / تعديل بياناتها |
| GET | `/api/procedures/cases/:id/documents-ready` | المستندات القابلة للتجهيز (إجراءات مرتبطة بخطاب ولم تُربط بعد) |
| POST | `/api/procedures/cases/:id/steps` | إجراء إضافي لهذه الحالة |
| POST | `/api/procedures/cases/:id/close` | `confirmed: true`، `closed_on`، `note` |
| POST | `/api/procedures/cases/:id/cancel` | `reason` |
| POST | `/api/procedures/cases/:id/reopen` | (مسؤول) `reason` |
| DELETE | `/api/procedures/cases/:id` | (مسؤول) `reason` |
| PATCH | `/api/procedures/steps/:id` | `status`، `owner_member_id`، `party_id`، `assignee_name`، `due_date`، `completed_on`، `reference`، `notes`، `na_reason` / `na_reason_id`، `reason` (عند التغيير من «لا ينطبق») |
| DELETE | `/api/procedures/steps/:id` | حذف إجراء إضافي فقط، `reason` |
| POST | `/api/procedures/steps/:id/letter` | ربط خطاب صادر من مركز الخطابات: `issued_letter_id` (أو `null` مع `reason`) |
| GET | `/api/procedures/lists` · `/api/procedures/checklists?case_type` | القوائم وقوائم الإجراءات |
| POST / PATCH | `/api/admin/procedures/lists[/:id]` · `/api/admin/procedures/members[/:id]` · POST `/api/admin/procedures/checklists` | (مسؤول) تعديل القوائم وأعضاء الفريق |
| GET | `/api/procedures/events` · `/api/procedures/export.xlsx` | السجل والتصدير |

**رموز الأخطاء:** `employee_exists`، `possible_duplicate`، `duplicate_case`، `reason_required`، `steps_pending`، `confirmation_required`، `case_not_open`.

**لـ«مها» لاحقًا:** تقرأ النواقص من `outstanding` والمستندات من `documents-ready`، وتجهّز المسودات عبر معاينة مركز الخطابات للمراجعة. سجل التعديلات فيه الحقل `actor` (`user` حاليًا، و`assistant` محجوز لمها مع المستخدم الذي أكّد). لا تُكمل إجراءً ولا تغلق حالة ولا تُصدر مستندًا دون تأكيد المستخدم، ويبقى التنفيذ اليدوي متاحًا.

---

# إدارة الاستشاريين والعقود الاستشارية — الإضافات

| الطريقة | المسار | الوصف |
|---|---|---|
| GET | `/api/consulting/consultants?q` · `/api/consulting/consultants/:id` | الاستشاريون مع إجمالي العقود والمصروف · ملف الاستشاري بعقوده وطلباته |
| GET | `/api/consulting/consultant-match?full_name_ar&id_number&mobile&iban` | المطابقات داخل الشركة (لمنع التكرار) |
| POST | `/api/consulting/contracts-with-consultant` | `consultant` + `contract` (مع `deliverables`) في عملية واحدة، `confirm_new_consultant` |
| GET | `/api/consulting/deliverables?state&q&contract_id` | المخرجات عبر العقود. `state`: `overdue` · `upcoming` · `no_certificate` · `not_sent` · `to_request` · `awaiting_payment` · `paid` |
| POST | `/api/consulting/deliverables/:id/certificate` | يتطلب الآن `approvers`: ثلاثة `{ name, title? }` |
| GET | `/api/consulting/deliverables/:id/certificates` · `/api/consulting/approver-suggestions` | سجل إصدارات الشهادة · أسماء المعتمدين السابقة |
| GET | `/api/consulting/contracts/:id/requestable` | المتبقي غير المصروف والمطلوب سابقًا والمتاح للطلب لكل مخرج |
| GET / POST | `/api/consulting/payment-requests` | القائمة / إنشاء: `contract_id`، `items: [{ deliverable_id, amount }]`، `request_date`، `notes`، `confirm_duplicate` |
| GET / PATCH | `/api/consulting/payment-requests/:id` | التفاصيل (المطلوب، المصروف، المتبقي) / تعديل المسودة |
| POST | `/api/consulting/payment-requests/:id/document/preview` · `/document` | معاينة / إصدار ملف Excel: `approvers` حسب النموذج |
| POST | `/api/consulting/payment-requests/:id/sent` · `/cancel` · `/payments` | الإرسال للمالية · الإلغاء (`reason`) · الصرف الفعلي (`amount`، `paid_at`، `transfer_reference`، `finance_confirmed: true`) |
| POST | `/api/consulting/payments/:id/void` · `/correct` | (مسؤول) إلغاء أو تصحيح صرف مع `reason`؛ لا حذف |
| GET | `/api/consulting/ready` | ما يمكن تجهيزه الآن (لمها لاحقًا) |

**رموز الأخطاء الجديدة:** `consultant_exists`، `possible_duplicate`، `approvers_required`، `already_requested`، `exceeds_remaining`، `request_locked`.

**تغيير:** `DELETE /api/consulting/payments/:id` أصبح للمسؤول فقط ويُلغي الدفعة (يحتفظ بها في السجل) بدل حذفها.

---

# نماذج شهادات الإنجاز — الإعداد (مسؤول فقط)

| الطريقة | المسار | الوصف |
|---|---|---|
| GET | `/api/admin/templates/:id/analysis` | خانات المستند واقتراحات الربط ودرجة الثقة والحقول المتاحة والمطلوبة |
| POST | `/api/admin/templates/:id/mapping` | `mapping: { slotId: { mode: 'field' \| 'fixed' \| 'blank', pattern } }` → إصدار جديد (مسودة) مع نتائج فحص التنسيق والحقول |
| POST | `/api/admin/templates/:id/trial` | شهادة تجريبية ببيانات وهمية (`pdf: true` لمعاينة PDF) |
| GET | `/api/admin/templates/:id/trial/docx` · `/trial/pdf` | ملفات التجربة |
| POST | `/api/admin/templates/:id/approve` | الاعتماد والتفعيل؛ يُرفض بـ `not_ready` مع ما ينقص |

**تغيير:** رفع نموذج شهادة إنجاز يُنشئ مسودة (`draft: true`) بدل تفعيله، و`/activate` لنموذج شهادة غير معتمد يُرفض بـ `not_approved`.
