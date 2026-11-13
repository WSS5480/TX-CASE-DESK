# David's case management notes (Nov 6, 2026, updated Nov 12, 2026)

Source: `2026-11-12-case-management-development-notes.pdf` in this folder (from attorney David Solis, sent in by Steve on Nov 13, 2026).
This file is a plain-text copy so a session can read it without opening the PDF. If the two ever differ, the PDF wins.

Where the Nov 12 notes overlap the Nov 6 log, **Nov 12 replaces Nov 6**: running notes now fall under the Synopsis, and the Nov 12 contact types replace the Nov 6 list.

## Nov 12 requirements (current)

| # | Area | What David wants |
|---|------|------------------|
| 1 | Case list | Opening the case module shows only a list of cases. Clicking a case opens the full case matter. |
| 2 | Order | Most recently opened case at the top, down to the least recently opened. |
| 3 | Client and style | Each row shows the client's name and the case style. The list is searchable by both. |
| 4 | File number | The file number shows on every row without opening the case. |
| 5 | Appeals | The Appeals tab can go if there isn't room. It rarely matters when working a case in litigation. |
| 6 | Synopsis | The Notes section is renamed Synopsis: a quick snapshot of the case. |
| 7 | Synopsis contents | Date of loss, statute of limitations date, a brief summary of the case (like today's notes), total medicals or amount of damages, insurance company information, the client's date of birth and social security number. |
| 8 | Summary field | The brief summary stays multi-line: Enter starts a new line. |
| 9 | Contacts | Contacts get a date of birth and a social security number (for conflict checks and for giving information to medical providers). |
| 10 | Contact types | Client, Opposing Party / Defendant, Attorney, Witness, Medical Provider, Litigation Support (e.g. a process service or records retrieval company), Other. |

## Nov 6 log (still stands unless replaced above)

| Area | Note |
|------|------|
| Case record | Add the client's name as its own field. The case style does not include it. |
| Case record | Keep the cause number, and add a separate internal file number. |
| Case record | Add an SOL deadline field. |
| Status | Status is a dropdown: Intake, Property Damage, Treating, Demand Sent, Negotiating, Review for Suit, Suit Filed, Discovery, Mediation, Trial. |
| Notes | Enter starts a new line instead of one long string of text. |
| Ticklers | Under Notes, show 2 or 3 ticklers for upcoming deadlines or upcoming internal tasks. |
| Dictation | Every line where you can type also supports dictation. |
| Contacts | New contact gets a date of birth field and a social security number field. |
| Notes | Notes need to be more than free text. |
| Contacts | Contact types (replaced by the Nov 12 list above). |

## David's open questions (none answered yet)

1. Does "separate case number client" mean a client name field plus an internal file number, kept apart from the case style and the cause number?
2. Does the status list need a closing status after Trial, such as Closed or Settled?
3. How do existing cases with an older status map to the new list?
4. Where will the software run (web, desktop, phone)? That decides how dictation is built.
5. What does "more than free text" mean for Notes: a note type, a date and author stamp, a link to a case, contact or tickler?
6. How is the social security number protected: masked on screen, limited to certain users, encrypted in storage?
7. Does "Attorney" cover both co-counsel and opposing counsel, or does opposing counsel need its own type?
8. Can one contact have more than one type (a client who is also a witness)?
9. Does the case list order mean most recently opened at the top, as the notes assume?
10. Where do running, dated notes go now that Notes is Synopsis, and do the ticklers sit under the Synopsis?
11. Does the Synopsis show total medicals and total damages as two figures or one?
12. Which insurance details does the Synopsis show (company, claim number, adjuster, policy limits)?
13. Does the Synopsis show the social security number in full or masked, and who can see it?
