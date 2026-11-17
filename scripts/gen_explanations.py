#!/usr/bin/env python3
"""Generate whyCorrect explanations for PMP exam questions.

This script builds rule-based explanations from the stem + options + correct answer.
Every explanation follows the pattern:
  1. Why the CORRECT answer is right (PMP principle)
  2. Why each WRONG answer is incorrect (brief)

Run:
    python3 scripts/gen_explanations.py content/pdf-english-exam1.xlsx [--dry-run]
"""

import sys
import re
import openpyxl

# ------------------------------------------------------------------
# PMP domain knowledge lookup by task code
# ------------------------------------------------------------------
TASK_PRINCIPLES = {
    "PEOPLE-1": "Build a high-performing team by establishing shared goals, clear roles, and an environment of psychological safety.",
    "PEOPLE-2": "Support team member development through coaching, mentoring, and growth opportunities.",
    "PEOPLE-3": "Empower team members: delegate decisions to those closest to the work and remove impediments they cannot resolve themselves.",
    "PEOPLE-4": "Adequate resources (people, tools, budget) are a PM responsibility; escalate when gaps are identified.",
    "PEOPLE-5": "Train and mentor team members to close skill gaps; tailor coaching to individual learning styles.",
    "PEOPLE-6": "Build a productive team culture based on trust, transparency, and mutual accountability.",
    "PEOPLE-7": "Address and resolve conflict early, directly, and in a problem-solving mindset. Avoidance makes it worse.",
    "PEOPLE-8": "Engage stakeholders continuously: identify, analyse influence/interest, plan engagement, then communicate and adapt.",
    "PROCESS-1": "Start projects correctly: a project charter formally authorises the project and names the PM.",
    "PROCESS-2": "Scope is what has been agreed in writing. Unclear scope must be clarified before work begins, not assumed.",
    "PROCESS-3": "Backlog management and iterative delivery: prioritise by value, refine continuously, and involve the Product Owner.",
    "PROCESS-4": "Procurement: define requirements before selecting a vendor; monitor vendor performance against contract terms.",
    "PROCESS-5": "Project closure: obtain formal acceptance, release resources, capture lessons learned, and archive records.",
    "PROCESS-6": "Schedule and EVM: use earned value to assess performance; forecasting uses CPI and EAC = BAC / CPI.",
    "PROCESS-7": "Quality: plan quality in, verify requirements are met through testing, and use lessons learned to improve.",
    "PROCESS-8": "Communication: match the medium and frequency to stakeholder needs; excessive or insufficient communication both cause problems.",
    "PROCESS-9": "Integration: changes must go through the integrated change control process — no informal or verbal approvals.",
    "PROCESS-10": "Knowledge management: capture and share lessons learned throughout the project, not only at closure.",
    "BUSINESS-1": "Benefits realisation: link project outputs to measurable business outcomes and track realisation.",
    "BUSINESS-2": "Strategic alignment: ensure project objectives remain aligned to organisational strategy throughout delivery.",
    "BUSINESS-3": "Change management: assess impact, engage affected stakeholders, and use a structured change process.",
    "BUSINESS-4": "Governance and compliance: follow organisational policies, regulatory requirements, and PMO guidelines.",
    "BUSINESS-5": "Risk management: identify, analyse, plan responses, and monitor continuously. Document all risks.",
    "BUSINESS-6": "Value delivery: measure and demonstrate value delivered to the customer and organisation.",
    "BUSINESS-7": "Organisational culture and structure: understand the environment (functional, matrix, projectised) and work within it.",
    "BUSINESS-8": "Continuous improvement: apply retrospectives, root-cause analysis, and iterative learning to raise performance.",
}

OPTION_LETTERS = ["A", "B", "C", "D"]


def get_option_text(row, letter):
    mapping = {"A": row.get("optionA"), "B": row.get("optionB"), "C": row.get("optionC"), "D": row.get("optionD")}
    return (mapping.get(letter) or "").strip()


def build_explanation(row):
    correct = (row.get("correct") or "").strip().upper()
    stem = (row.get("stem") or "").strip()
    task = (row.get("taskCode") or "PROCESS-6").strip()
    mindset = (row.get("mindset") or "hybrid").strip()

    correct_text = get_option_text(row, correct)
    principle = TASK_PRINCIPLES.get(task, "Apply PMI best practice for this task area.")

    # --- build "why correct" ---
    why_correct = f"{correct}) is correct. {principle}"

    # Tailor based on common PMP answer patterns
    stem_lower = stem.lower()

    if any(w in stem_lower for w in ["risk", "identified risk", "risk register"]):
        why_correct += " Identified risks belong in the risk register and must have a planned response."
    elif any(w in stem_lower for w in ["change", "scope change", "change request"]):
        why_correct += " All changes must go through the integrated change control process before implementation."
    elif any(w in stem_lower for w in ["conflict", "disagree", "dispute"]):
        why_correct += " Conflict is best resolved by directly confronting it in a collaborative, problem-solving manner."
    elif any(w in stem_lower for w in ["stakeholder", "sponsor", "customer"]):
        why_correct += " Stakeholders must be engaged proactively and their concerns addressed through structured communication."
    elif any(w in stem_lower for w in ["schedule", "behind", "delay", "critical path"]):
        why_correct += " Schedule issues require a corrective action plan based on data, not assumptions."
    elif any(w in stem_lower for w in ["quality", "defect", "testing", "audit"]):
        why_correct += " Quality is built in by planning and verification, not inspected in at the end."
    elif any(w in stem_lower for w in ["team", "member", "developer", "morale"]):
        why_correct += " Team empowerment and psychological safety are key to high performance."
    elif any(w in stem_lower for w in ["vendor", "contract", "procurement", "supplier"]):
        why_correct += " Contract terms govern the relationship; monitor vendor performance and enforce requirements formally."
    elif any(w in stem_lower for w in ["lessons", "retrospective", "review"]):
        why_correct += " Lessons learned are captured throughout the project and shared to improve future performance."
    elif any(w in stem_lower for w in ["earned value", "cpi", "spi", "eac", "bac", "ev ", "pv ", "ac "]):
        why_correct += " Earned Value metrics: SV = EV − PV, CV = EV − AC, SPI = EV ÷ PV, CPI = EV ÷ AC, EAC = BAC ÷ CPI."

    # --- build "why wrong" for each incorrect option ---
    wrong_parts = []
    for letter in OPTION_LETTERS:
        if letter == correct:
            continue
        opt_text = get_option_text(row, letter)
        if not opt_text:
            continue

        opt_lower = opt_text.lower()
        reason = ""

        # Pattern matching for common wrong-answer types
        if any(w in opt_lower for w in ["escalate", "inform sponsor", "call sponsor", "notify sponsor"]):
            reason = "Escalating to the sponsor before exhausting direct resolution is premature."
        elif any(w in opt_lower for w in ["ignore", "do nothing", "not address", "overlook"]):
            reason = "Ignoring an issue violates the PM's responsibility to manage the project proactively."
        elif any(w in opt_lower for w in ["cancel", "terminate", "stop the project"]):
            reason = "Cancellation is a last resort; it requires sponsor approval and formal closure."
        elif any(w in opt_lower for w in ["update the plan", "revise the plan", "change the plan"]) and "change control" not in opt_lower:
            reason = "Plan changes without going through change control bypass governance and invalidate the baseline."
        elif any(w in opt_lower for w in ["meet with", "schedule a meeting", "call a meeting"]) and "resolve" not in opt_lower:
            reason = "Calling a general meeting does not by itself resolve the issue; a structured action is needed."
        elif any(w in opt_lower for w in ["fast track", "fast-track"]):
            reason = "Fast-tracking compresses the schedule by overlapping phases but adds risk of rework."
        elif any(w in opt_lower for w in ["crash", "add resource", "add staff"]) and correct != letter:
            reason = "Crashing adds cost; it should only be used when the schedule impact justifies the expense."
        elif any(w in opt_lower for w in ["accept", "proceed", "continue without"]):
            reason = "Proceeding without addressing the identified issue creates unmanaged risk."
        elif any(w in opt_lower for w in ["make-or-buy", "reanalyse", "re-analyse"]):
            reason = "Re-opening a completed make-or-buy analysis after contract sign-off is not efficient; manage the existing contract."
        else:
            # Generic fallback
            reason = f"This option does not align with PMI best practice for {task.lower().replace('-', ' ')} in a {mindset} environment."

        wrong_parts.append(f"{letter}) {reason}")

    explanation = why_correct
    if wrong_parts:
        explanation += " — Distractors: " + " | ".join(wrong_parts)

    # Trim to a reasonable length
    if len(explanation) > 800:
        explanation = explanation[:797] + "..."

    return explanation


def main():
    if len(sys.argv) < 2:
        print("Usage: python3 gen_explanations.py <file.xlsx> [--dry-run]")
        sys.exit(1)

    path = sys.argv[1]
    dry_run = "--dry-run" in sys.argv

    wb = openpyxl.load_workbook(path)
    ws = wb.active
    headers = [ws.cell(1, c).value for c in range(1, 25)]

    try:
        why_col = headers.index("whyCorrect") + 1  # 1-based
    except ValueError:
        print("ERROR: 'whyCorrect' column not found.")
        sys.exit(1)

    updated = 0
    skipped = 0

    for i, row_cells in enumerate(ws.iter_rows(min_row=2), start=2):
        row_data = {headers[j]: row_cells[j].value for j in range(len(headers)) if headers[j]}

        current_why = str(row_data.get("whyCorrect") or "").strip()
        if current_why and "[Explanation needed]" not in current_why and current_why != "":
            skipped += 1
            continue

        explanation = build_explanation(row_data)

        if dry_run:
            print(f"Row {i}: {explanation[:100]}...")
        else:
            ws.cell(i, why_col).value = explanation
        updated += 1

    if not dry_run:
        wb.save(path)
        print(f"Saved. Updated: {updated}, Skipped (already had text): {skipped}")
    else:
        print(f"Dry run. Would update: {updated}, Would skip: {skipped}")


if __name__ == "__main__":
    main()
