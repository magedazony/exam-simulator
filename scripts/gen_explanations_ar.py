#!/usr/bin/env python3
"""Generate Arabic whyCorrect explanations for PMP exam questions.

This script builds rule-based Arabic explanations from the stem + options + taskCode.
Because the Arabic xlsx has no 'correct' answers yet, the explanation format is:
  "الإجابة الصحيحة هي: <correct> — <مبدأ PMP للمجال> — المشتتات: ..."

NOTE: correct answers are MISSING in this file. Run with --no-correct to generate
      explanations using placeholder correct answer (A) for structure only, then
      fill in correct answers via human review before publishing.

Run:
    python3 scripts/gen_explanations_ar.py content/pdf-arabic-agile.xlsx [--dry-run] [--no-correct]
"""

import sys
import re
import openpyxl

# ------------------------------------------------------------------
# Arabic PMP domain knowledge lookup by task code
# ------------------------------------------------------------------
TASK_PRINCIPLES_AR = {
    "PEOPLE-1": "بناء فريق عالي الأداء يتطلب وضع أهداف مشتركة وأدوار واضحة وبيئة عمل آمنة نفسياً.",
    "PEOPLE-2": "دعم تطور أعضاء الفريق من خلال التدريب والتوجيه وتوفير فرص النمو المهني.",
    "PEOPLE-3": "تمكين أعضاء الفريق يعني تفويض القرارات لأقرب الناس للعمل وإزالة العوائق التي لا يمكنهم حلها بأنفسهم.",
    "PEOPLE-4": "توفير الموارد الكافية (أشخاص وأدوات وميزانية) مسؤولية مدير المشروع؛ يجب التصعيد عند وجود فجوات.",
    "PEOPLE-5": "تدريب أعضاء الفريق وإرشادهم لسد الفجوات المهارية، مع تكييف الأسلوب حسب كل شخص.",
    "PEOPLE-6": "بناء ثقافة فريق منتجة قائمة على الثقة والشفافية والمساءلة المتبادلة.",
    "PEOPLE-7": "معالجة النزاعات مبكراً وبشكل مباشر وبعقلية حل المشكلات؛ تجنب النزاع يزيده سوءاً.",
    "PEOPLE-8": "إشراك أصحاب المصلحة باستمرار: تحديدهم وتحليل تأثيرهم واهتمامهم ثم التواصل والتكيف معهم.",
    "PROCESS-1": "بدء المشاريع بشكل صحيح: ميثاق المشروع يُخوّل المشروع رسمياً ويحدد مدير المشروع.",
    "PROCESS-2": "النطاق هو ما تم الاتفاق عليه كتابياً. النطاق غير الواضح يجب توضيحه قبل البدء وليس افتراضه.",
    "PROCESS-3": "إدارة قائمة الأعمال المتراكمة والتسليم التكراري: الأولوية حسب القيمة، والتحسين المستمر مع مالك المنتج.",
    "PROCESS-4": "المشتريات: تحديد المتطلبات قبل اختيار المورد؛ مراقبة أداء المورد وفق شروط العقد.",
    "PROCESS-5": "إغلاق المشروع: الحصول على القبول الرسمي وتحرير الموارد وتوثيق الدروس المستفادة وأرشفة السجلات.",
    "PROCESS-6": "الجدول الزمني وإدارة القيمة المكتسبة: استخدام EVM لتقييم الأداء؛ التنبؤ يستخدم CPI وEAC = BAC / CPI.",
    "PROCESS-7": "الجودة: التخطيط للجودة مسبقاً والتحقق من استيفاء المتطلبات بالاختبار والاستفادة من الدروس المستفادة.",
    "PROCESS-8": "التواصل: مطابقة الوسيلة والتكرار لاحتياجات أصحاب المصلحة؛ التواصل المفرط أو القاصر كلاهما يسبب مشاكل.",
    "PROCESS-9": "التكامل: التغييرات يجب أن تمر عبر عملية التحكم المتكاملة في التغييرات — لا موافقات غير رسمية أو شفهية.",
    "PROCESS-10": "إدارة المعرفة: التقاط الدروس المستفادة ومشاركتها طوال المشروع وليس فقط عند الإغلاق.",
    "BUSINESS-1": "تحقيق الفوائد: ربط مخرجات المشروع بنتائج أعمال قابلة للقياس وتتبع تحقق تلك الفوائد.",
    "BUSINESS-2": "التوافق الاستراتيجي: ضمان بقاء أهداف المشروع متوافقة مع استراتيجية المنظمة طوال التنفيذ.",
    "BUSINESS-3": "إدارة التغيير: تقييم التأثير وإشراك أصحاب المصلحة المتأثرين واستخدام عملية تغيير منظمة.",
    "BUSINESS-4": "الحوكمة والامتثال: اتباع سياسات المنظمة والمتطلبات التنظيمية وإرشادات مكتب إدارة المشاريع.",
    "BUSINESS-5": "إدارة المخاطر: التحديد والتحليل والتخطيط للاستجابات والمراقبة المستمرة. توثيق جميع المخاطر.",
    "BUSINESS-6": "تقديم القيمة: قياس وإثبات القيمة المقدمة للعميل والمنظمة.",
    "BUSINESS-7": "ثقافة المنظمة وهيكلها: فهم البيئة (وظيفية، مصفوفية، مشروعية) والعمل ضمنها.",
    "BUSINESS-8": "التحسين المستمر: تطبيق جلسات الاستعراض وتحليل السبب الجذري والتعلم التكراري لرفع الأداء.",
}

MINDSET_AR = {
    "predictive": "في المشاريع التنبؤية، الخطة المفصلة والتغييرات المنضبطة هي الأساس.",
    "agile":      "في المشاريع الرشيقة، المرونة وتلبية التغيير والتسليم التدريجي هي المحرك.",
    "hybrid":     "في المناهج الهجينة، اختر المقاربة بناءً على احتياجات كل جانب من المشروع.",
}

OPTION_LETTERS = ["A", "B", "C", "D"]


def get_option_text(row, letter):
    mapping = {
        "A": row.get("optionA"),
        "B": row.get("optionB"),
        "C": row.get("optionC"),
        "D": row.get("optionD"),
    }
    return (mapping.get(letter) or "").strip()


def build_explanation_ar(row, no_correct=False):
    correct = (row.get("correct") or "").strip().upper()
    if not correct:
        if no_correct:
            correct = "A"  # placeholder — human must fill
        else:
            return None  # skip

    task = (row.get("taskCode") or "").strip()
    mindset = (row.get("mindset") or "").strip().lower()
    stem = (row.get("stem") or "").strip()

    principle = TASK_PRINCIPLES_AR.get(task, "أفضل ممارسات PMP تتطلب التواصل الفعّال والتخطيط الدقيق وإدارة أصحاب المصلحة.")
    mindset_note = MINDSET_AR.get(mindset, "")

    correct_text = get_option_text(row, correct)

    # Simple stem-based tailoring
    stem_lower = stem.lower() if stem else ""
    if "خطر" in stem or "مخاطر" in stem or "risk" in stem_lower:
        tailoring = "معالجة المخاطر تعني تحديدها وتحليلها والتخطيط للاستجابة لها."
    elif "عميل" in stem or "stakeholder" in stem_lower or "صاحب مصلحة" in stem:
        tailoring = "التفاعل مع أصحاب المصلحة باستمرار هو أساس إدارة التوقعات."
    elif "جدول" in stem or "schedule" in stem_lower or "تأخر" in stem:
        tailoring = "انحرافات الجدول الزمني تتطلب تحليل السبب الجذري ثم التصحيح."
    elif "ميزاني" in stem or "budget" in stem_lower or "تكلف" in stem:
        tailoring = "التحكم في التكاليف يتطلب مراقبة مستمرة ومقارنة الأداء بالخط الأساسي."
    elif "فريق" in stem or "team" in stem_lower:
        tailoring = "إدارة الفريق تعني تطوير الكفاءات وحل النزاعات وبناء الثقة."
    elif "تغيير" in stem or "change" in stem_lower:
        tailoring = "كل تغيير يجب أن يمر بعملية التحكم في التغييرات."
    else:
        tailoring = ""

    # Build explanation
    explanation = f"{correct}) صحيحة. {principle}"
    if tailoring:
        explanation += f" {tailoring}"
    if mindset_note:
        explanation += f" {mindset_note}"

    # Distractors
    distractors = []
    for letter in OPTION_LETTERS:
        if letter == correct:
            continue
        txt = get_option_text(row, letter)
        if not txt:
            continue
        distractor_note = _distractor_ar(letter, txt)
        distractors.append(f"{letter}) {distractor_note}")

    if distractors:
        explanation += " — المشتتات: " + " | ".join(distractors)

    if no_correct and not (row.get("correct") or "").strip():
        explanation += " ⚠️ [يرجى مراجعة الإجابة الصحيحة وتحديثها]"

    return explanation


def _distractor_ar(letter, text):
    text_lower = text.lower() if text else ""
    if "تجاهل" in text or "ignore" in text_lower:
        return f"تجاهل المشكلة ليس تصرف مدير مشروع محترف."
    if "يُبلّغ" in text or "report" in text_lower or "escalate" in text_lower:
        return f"التصعيد ليس دائماً الخيار الأول — حاول الحل محلياً أولاً."
    if "وحد" in text or "alone" in text_lower or "unilateral" in text_lower:
        return f"القرارات الأحادية بدون إشراك الفريق وأصحاب المصلحة تُضعف نتائج المشروع."
    if "تأخير" in text or "defer" in text_lower or "wait" in text_lower:
        return f"تأجيل المعالجة يفاقم المشكلات في المشاريع."
    return f"هذا الخيار لا يتوافق مع أفضل ممارسات PMP لهذا السياق."


def process_file(path, dry_run=False, no_correct=False):
    wb = openpyxl.load_workbook(path)
    ws = wb.active
    headers = [cell.value for cell in ws[1]]

    if "whyCorrect" not in headers:
        print(f"ERROR: 'whyCorrect' column not found in {path}", file=sys.stderr)
        sys.exit(1)

    why_idx = headers.index("whyCorrect") + 1  # 1-based for openpyxl

    updated = 0
    skipped = 0

    for row_num, row in enumerate(ws.iter_rows(min_row=2), start=2):
        row_dict = {headers[i]: (row[i].value or "") for i in range(len(headers))}

        existing = str(row_dict.get("whyCorrect") or "").strip()
        # Skip rows that already have a real explanation
        if existing and not existing.startswith("[Explanation needed") and "⚠️" not in existing:
            skipped += 1
            continue

        expl = build_explanation_ar(row_dict, no_correct=no_correct)
        if expl is None:
            skipped += 1
            continue

        if dry_run:
            print(f"Row {row_num}: {expl[:120]}...")
        else:
            ws.cell(row=row_num, column=why_idx).value = expl
        updated += 1

    print(f"{'[DRY RUN] ' if dry_run else ''}Updated: {updated}, Skipped: {skipped}")

    if not dry_run:
        wb.save(path)
        print(f"Saved: {path}")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(f"Usage: python3 {sys.argv[0]} <file.xlsx> [--dry-run] [--no-correct]", file=sys.stderr)
        sys.exit(1)
    path = sys.argv[1]
    dry = "--dry-run" in sys.argv
    no_correct = "--no-correct" in sys.argv
    process_file(path, dry_run=dry, no_correct=no_correct)
