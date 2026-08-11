#!/usr/bin/env /usr/bin/python3
"""Generate the public, synthetic G/H QA PDFs.

The PDFs use explicit text lines because the production anydoc converter and
our deterministic extractors intentionally consume the printed layout. All
personal and financial identifiers are synthetic.
"""
from pathlib import Path

from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas

ROOT = Path(__file__).resolve().parents[1]
PDF_DIR = ROOT / "fixtures" / "pdfs"


def write_pdf(name: str, pages: list[str]) -> None:
    path = PDF_DIR / name
    pdf = canvas.Canvas(str(path), pagesize=A4, pageCompression=0)
    pdf.setTitle("Quick2AVault synthetic QA fixture")
    pdf.setAuthor("Quick2AVault")
    _, height = A4
    for page in pages:
        text = pdf.beginText(42, height - 42)
        text.setFont("Helvetica", 9)
        text.setLeading(12)
        for line in page.strip().splitlines():
            text.textLine(line)
        pdf.drawText(text)
        pdf.showPage()
    pdf.save()


def main() -> None:
    write_pdf(
        "fixture-G-pet_asight-tax-invoice.pdf",
        ["""
PRIYA NAIR
TAX INVOICE
12 Test Garden, 5th Main
Indiranagar, Bengaluru - 560 038
Karnataka, INDIA
Invoice Number: INV/2026-27/01
Invoice Date: April 1, 2026
Due Date: April 15, 2026
Contact: Priya Nair
Currency: USD
Email: priya.nair@example.test
Place of Supply: Export of Service
GSTIN: 29ABCDE1234F1Z5

BILL TO: PetaSight Inc.
8 The Green, Suite R, Dover, DE 19901, USA
Contact Person: Alex Morgan
Email: alex.morgan@petasight.example

Data Science consulting services (March 4 - 31) | 998393 | 0.3043 | 5,397 | 1,642.31
Kilo Pass subscription (Reimbursement) | 998393 | 1 | 49 | 49
Subtotal: $1,691.31
Tax: $0.00
Total: $1,691.31

Bank Details:
Name: PRIYA NAIR
Bank: Example Bank
Branch: Indiranagar, Bengaluru - 560 038, INDIA
Current Account No.: 12345678901234
IFS Code: EXAMP0001234
SWIFT: EXAMPINBB
Notes: Thank you for your business.
SUPPLY MEANT FOR EXPORT UNDER BOND OR LETTER OF UNDERTAKING WITHOUT PAYMENT OF INTEGRATED TAX
GSTIN: 29ABCDE1234F1Z5
ORIGINAL
"""],
    )

    write_pdf(
        "fixture-H-paytm-contract-note.pdf",
        [
            """
PAYTM MONEY LIMITED
CONTRACT NOTE CUM TAX INVOICE
PAN of Trading Member | AAJCP4398N
GSTIN of Trading Member | 29AAJCP4398N1ZE
Name of the Client: PRIYA NAIR Branch: Bengaluru
Address: 45 Sample Road
UCC & Client Code: TEST1234
PAN of Client: AB******1C
Mobile No.: ******1234
Contract Note No: 2216643
Trade Date: 01/07/2026
Settlement Number | 2026662
Settlement Date 02/07/2026

REC LIMITED/532955 INE020B01018 Qty 7 Price 370.2000 Net 2591.40 DR
KALPATARU PROJECTS INTERNATION/527 INE220B01022 Qty 7 Price 1356.2000 Net 9493.40 DR
Net amount receivable/payable by client: 12,121.96 DR
Pay In/Pay Out Obligation: 12,084.80
Ledger Balance: 281.66 CR
Total Amount in Words | TWELVE THOUSAND ONE HUNDRED TWENTY ONE RUPEES AND NINETY SIX PAISE ONLY
""",
            """
PAYTM MONEY LIMITED
CHARGES
Taxable Value of Supply (Brokerage): 20.00
CGST: 1.84
SGST: 1.84
Stamp Duty: 1.00
Securities Transaction Tax: 12.08
""",
            """
PAYTM MONEY LIMITED
TRADE DETAILS
This synthetic page intentionally contains no additional trade rows.
""",
        ],
    )


if __name__ == "__main__":
    main()
