# Automation Documentation Rubric

8 sections · 40 points total · **Pass threshold: 28/40**

---

## Scoring Key

| Label | Meaning |
|---|---|
| ✅ Full credit | Meets all criteria for the section |
| 🟡 Partial credit | Covers the section but has notable gaps |
| ❌ No credit | Missing, too vague, or not useful without reading the code |

---

## Section Scores

### 1. Overview — 5 pts

| Score | Criteria |
|---|---|
| ✅ 5 pts | 3–6 sentence plain-English summary. Clearly answers what it does, why it exists, and what problem it solves. No jargon or code references. |
| 🟡 3 pts | Covers what it does but omits the "why" or problem context. Mild jargon present. |
| ❌ 0 pts | Missing, too vague to be useful, or requires reading the code to understand. |

---

### 2. Data Inputs — 6 pts

| Score | Criteria |
|---|---|
| ✅ 6 pts | Every input documented with name/label, source, type/format, required status, and any gotchas. Table used for 3+ inputs. |
| 🟡 3 pts | Most inputs present but one or more is missing source, type, or required status. Minor gaps. |
| ❌ 0 pts | Section missing or describes inputs only vaguely (e.g., "the data"). |

---

### 3. Outputs — 5 pts

| Score | Criteria |
|---|---|
| ✅ 5 pts | All outputs documented: what it is, destination, format, trigger/frequency, and side effects. |
| 🟡 3 pts | Primary output described but frequency, format, or side effects are missing. |
| ❌ 0 pts | Section absent or only says something like "writes results to sheet." |

---

### 4. Assumptions — 6 pts

| Score | Criteria |
|---|---|
| ✅ 6 pts | All four categories addressed (hardcoded values, data shape, environmental, behavioral). Hardcoded values flagged with ⚠️. |
| 🟡 3 pts | 2–3 categories covered but one is thin or missing. Hardcoded values listed but not flagged. |
| ❌ 0 pts | Section absent, or only 1 category present, or no hardcoded values flagged despite clearly existing. |

---

### 5. Limitations — 5 pts

| Score | Criteria |
|---|---|
| ✅ 5 pts | Scale ceilings, unhandled edge cases, brittleness (silent vs loud failures), and out-of-scope items all addressed. |
| 🟡 3 pts | Some limitations listed but scale ceiling or silent failure modes omitted. |
| ❌ 0 pts | Section missing or just says "may not work in all cases." |

---

### 6. Design Decisions & Constraints — 5 pts

| Score | Criteria |
|---|---|
| ✅ 5 pts | Explains *why* the automation was built this way — constraints, tradeoffs, rejected alternatives, and known tech debt. Unknown rationale flagged for author confirmation. |
| 🟡 3 pts | Some explanation of choices but reads more like "what" than "why." Tech debt or alternatives not addressed. |
| ❌ 0 pts | Section absent or just restates what the code does. |

---

### 7. How to Run / Trigger — 4 pts

| Score | Criteria |
|---|---|
| ✅ 4 pts | Step-by-step instructions a non-builder can follow. Covers where to go, what to do, how to verify it worked, and required permissions. |
| 🟡 2 pts | Steps present but verification or permissions omitted. Assumes familiarity with the tool. |
| ❌ 0 pts | Section missing or says "run the script." |

---

### 8. Maintenance Notes — 4 pts

| Score | Criteria |
|---|---|
| ✅ 4 pts | What to update when upstream things change, how to extend it, known fragile spots, and optional future improvements. |
| 🟡 2 pts | Covers one or two areas but doesn't give specific file/line references for what to change. |
| ❌ 0 pts | Absent or just says "contact the original author." |

---

## Score Thresholds

| Score | Rating | Meaning |
|---|---|---|
| 36–40 | Excellent | Handoff-ready |
| 28–35 | Adequate | Needs minor gaps filled |
| < 28 | Insufficient | Revise before sharing |

---

## Weighting Rationale

**Assumptions and Data Inputs are weighted highest (6 pts each)** because they are the most commonly skimped sections and the primary source of silent failures — a missing input source or unflagged hardcoded value causes the most downstream pain.

**The ⚠️ flag requirement is load-bearing.** The skill requires hardcoded values to be visually scannable. A doc that lists them in prose without flagging loses points even if the content is present.

**Design Decisions is intentionally hard to max out.** It requires explaining *why*, not *what*. Docs that restate the code logic without addressing constraints, tradeoffs, or rejected alternatives receive no credit.
