#!/usr/bin/env python3 -I
"""
Extract PMP questions from two uploaded PDFs and write them to xlsx files.

PDF 1: 3b43b526-agile_exam_arabic_-1.pdf  → content/pdf-arabic-agile.xlsx
  - Scanned Arabic pages → OCR with Tesseract (ara lang)
  - Each page appears to be one question

PDF 2: f3aa620e-EXAM_no_.1-1.pdf           → content/pdf-english-exam1.xlsx
  - Text-based English PDF
  - Alternating pages: Q-only page, then Q+ANS page
  - Parse the ANS pages (even-numbered from page 2 onward)

Output columns (same schema as starter-drafts-docx2.xlsx):
  id | stem | optionA | optionB | optionC | optionD | correct | whyCorrect |
  difficulty | taskCode | mindset | keyConcept | learningObjective | lang | source
"""

import sys, re, io, os
import pdfplumber
import pytesseract
from PIL import Image
import openpyxl
from openpyxl.styles import Font, PatternFill, Alignment

UPLOADS = '/mnt/user-data/uploads'
OUTPUT_DIR = '/home/claude/exam-simulator/content'

HEADERS = [
    'id', 'stem', 'optionA', 'optionB', 'optionC', 'optionD',
    'correct', 'whyCorrect', 'difficulty', 'taskCode', 'mindset',
    'keyConcept', 'learningObjective', 'lang', 'source'
]

HEADER_FILL = PatternFill(start_color='1b4a78', end_color='1b4a78', fill_type='solid')
HEADER_FONT = Font(color='FFFFFF', bold=True)


def make_workbook(rows: list[dict], filename: str) -> None:
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = 'Questions'

    # Header row
    for col, h in enumerate(HEADERS, 1):
        cell = ws.cell(row=1, column=col, value=h)
        cell.fill = HEADER_FILL
        cell.font = HEADER_FONT
        cell.alignment = Alignment(horizontal='center')

    # Freeze header
    ws.freeze_panes = 'A2'

    # Set column widths
    widths = {
        'id': 8, 'stem': 60, 'optionA': 40, 'optionB': 40,
        'optionC': 40, 'optionD': 40, 'correct': 10,
        'whyCorrect': 60, 'difficulty': 12, 'taskCode': 10,
        'mindset': 12, 'keyConcept': 30, 'learningObjective': 40,
        'lang': 6, 'source': 20,
    }
    for col, h in enumerate(HEADERS, 1):
        ws.column_dimensions[ws.cell(row=1, column=col).column_letter].width = widths.get(h, 20)

    for r_idx, row in enumerate(rows, 2):
        for col, h in enumerate(HEADERS, 1):
            val = row.get(h, '')
            cell = ws.cell(row=r_idx, column=col, value=val)
            cell.alignment = Alignment(wrap_text=True, vertical='top')

    path = os.path.join(OUTPUT_DIR, filename)
    wb.save(path)
    print(f"  Saved {len(rows)} questions → {path}")


# ─── PDF 2: English text-based ────────────────────────────────────────────────

def parse_english_pdf() -> list[dict]:
    path = os.path.join(UPLOADS, 'f3aa620e-EXAM_no_.1-1.pdf')
    questions = []

    def clean(s: str) -> str:
        return re.sub(r'\s+', ' ', s.strip())

    with pdfplumber.open(path) as pdf:
        total = len(pdf.pages)
        print(f"  English PDF: {total} pages")

        # ANS pages are every other page starting from page index 2 (page 3 shown above)
        # Pattern: page idx 2 = Q1+ANS, 4 = Q2+ANS, 6 = Q3+ANS ... (0-indexed)
        # Actually: idx 1=Q1, idx 2=Q1+ANS, idx 3=Q2, idx 4=Q2+ANS ...
        # So ANS pages = even indices starting from 2: 2, 4, 6 ...
        q_count = 0
        for idx in range(2, total, 2):  # ANS pages
            text = pdf.pages[idx].extract_text() or ''
            if not text.strip():
                continue

            # Parse question number
            q_match = re.match(r'^(\d+)\s*\.?\s*', text)
            if not q_match:
                continue
            q_num = int(q_match.group(1))

            # Split on option markers "o\n" or leading "o "
            # Options follow the stem and are preceded/followed by "o"
            # Format: stem\nOptionA\no\nOptionB\no\nOptionC\no\nOptionD\no\nANS. correct

            # Remove question number prefix
            body = text[q_match.end():].strip()

            # Split at ANS line
            ans_match = re.search(r'\nANS\.\s*(.+?)$', body, re.IGNORECASE | re.MULTILINE)
            correct_text = ''
            if ans_match:
                correct_text = clean(ans_match.group(1))
                body = body[:ans_match.start()].strip()

            # Options are lines not starting with "o" interspersed with "o" markers
            # Pattern: text line, then "o", text line, then "o", ...
            # Split on "\no\n" or "\no "
            lines = [l.strip() for l in body.split('\n') if l.strip()]

            # Reconstruct: "o" on its own line is an option bullet
            # Lines before "o" are question text; lines between "o"s are options
            option_lines = []
            stem_lines = []
            in_options = False
            pending = []

            for line in lines:
                if line == 'o':
                    if pending:
                        if not in_options:
                            # First "o" – everything before is stem
                            stem_lines = pending
                            in_options = True
                        else:
                            option_lines.append(' '.join(pending))
                        pending = []
                else:
                    pending.append(line)
            # last pending = last option
            if pending and in_options:
                option_lines.append(' '.join(pending))
            elif pending:
                stem_lines.extend(pending)

            stem = clean(' '.join(stem_lines))
            opts = [clean(o) for o in option_lines]

            # Pad/trim to 4 options
            while len(opts) < 4:
                opts.append('')
            opts = opts[:4]

            # Determine correct letter
            correct_letter = ''
            if correct_text:
                for letter, opt in zip('ABCD', opts):
                    if opt and (opt.lower() in correct_text.lower() or correct_text.lower() in opt.lower()):
                        correct_letter = letter
                        break
                if not correct_letter:
                    correct_letter = 'A'  # fallback

            if not stem:
                continue

            q_count += 1
            questions.append({
                'id': f'EN1-{q_num:03d}',
                'stem': stem,
                'optionA': opts[0],
                'optionB': opts[1],
                'optionC': opts[2],
                'optionD': opts[3],
                'correct': correct_letter,
                'whyCorrect': f'[Explanation needed] Correct answer: {correct_text}',
                'difficulty': 'medium',
                'taskCode': '',
                'mindset': 'hybrid',
                'keyConcept': '',
                'learningObjective': '',
                'lang': 'en',
                'source': 'EXAM_no1_PDF',
            })

    print(f"  Extracted {q_count} English questions")
    return questions


# ─── PDF 1: Arabic OCR ────────────────────────────────────────────────────────

def ocr_page(page, resolution: int = 200) -> str:
    img = page.to_image(resolution=resolution)
    pil_img = img.original
    text = pytesseract.image_to_string(pil_img, lang='ara', config='--psm 6')
    return text.strip()


def parse_arabic_pdf() -> list[dict]:
    path = os.path.join(UPLOADS, '3b43b526-agile_exam_arabic_-1.pdf')
    questions = []

    def clean(s: str) -> str:
        return re.sub(r'\s+', ' ', s.strip())

    with pdfplumber.open(path) as pdf:
        total = len(pdf.pages)
        print(f"  Arabic PDF: {total} pages — running OCR (this takes a few minutes)...")

        q_count = 0
        # Skip page 1 (cover), process remaining
        # Each page seems to be one question
        for idx in range(1, total):
            if idx % 20 == 0:
                print(f"    OCR progress: {idx}/{total} pages...")

            text = ocr_page(pdf.pages[idx])
            if not text or len(text) < 20:
                continue

            lines = [l.strip() for l in text.split('\n') if l.strip()]
            if not lines:
                continue

            # Arabic question structure: stem on top, then options (usually 4)
            # Options often start with letters like أ, ب, ج, د or numbers or bullets
            # Try to identify option patterns

            # Heuristic: last 4 non-empty lines are options if page has enough lines
            # OR look for lines starting with Arabic letters/numbers

            option_patterns = [
                r'^[أابتثجحخدذرزسشصضطظعغفقكلمنهويىة][.)\-\s]',  # Arabic letter options
                r'^[١٢٣٤][.)\-\s]',  # Arabic numerals
                r'^[1234][.)\-\s]',   # Western numerals
                r'^●|•|\-\s',  # bullets
            ]

            option_indices = []
            for i, line in enumerate(lines):
                for pat in option_patterns:
                    if re.match(pat, line):
                        option_indices.append(i)
                        break

            if len(option_indices) >= 3:
                # Stem = everything before first option
                stem_text = clean(' '.join(lines[:option_indices[0]]))
                opt_texts = [clean(lines[i]) for i in option_indices]
            else:
                # Fallback: assume last 4 lines are options
                if len(lines) > 5:
                    stem_text = clean(' '.join(lines[:-4]))
                    opt_texts = [clean(l) for l in lines[-4:]]
                else:
                    stem_text = clean(' '.join(lines))
                    opt_texts = []

            # Pad/trim to 4 options
            while len(opt_texts) < 4:
                opt_texts.append('')
            opt_texts = opt_texts[:4]

            if not stem_text or len(stem_text) < 10:
                continue

            q_count += 1
            questions.append({
                'id': f'AR-AGL-{q_count:03d}',
                'stem': stem_text,
                'optionA': opt_texts[0],
                'optionB': opt_texts[1],
                'optionC': opt_texts[2],
                'optionD': opt_texts[3],
                'correct': '',  # answer key not in this PDF
                'whyCorrect': '[Explanation needed]',
                'difficulty': 'medium',
                'taskCode': '',
                'mindset': 'agile',
                'keyConcept': '',
                'learningObjective': '',
                'lang': 'ar',
                'source': 'agile_exam_arabic_PDF',
            })

    print(f"  Extracted {q_count} Arabic questions via OCR")
    return questions


# ─── Main ─────────────────────────────────────────────────────────────────────

if __name__ == '__main__':
    os.makedirs(OUTPUT_DIR, exist_ok=True)

    print("\n=== Parsing English PDF (EXAM No.1) ===")
    en_questions = parse_english_pdf()
    make_workbook(en_questions, 'pdf-english-exam1.xlsx')

    print("\n=== Parsing Arabic PDF (Agile Exam) ===")
    ar_questions = parse_arabic_pdf()
    make_workbook(ar_questions, 'pdf-arabic-agile.xlsx')

    print(f"\nDone. Total: {len(en_questions)} EN + {len(ar_questions)} AR questions.")
