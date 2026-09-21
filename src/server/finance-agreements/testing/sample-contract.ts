// Step 14A: a fully SYNTHETIC collaboration agreement (all names, numbers and
// identifiers are invented; the PAN/GSTIN/IFSC/account values are shaped like
// real ones but belong to nobody). Shared by the extractor tests and the
// follow-up extraction-service tests via makeTextPdf(SAMPLE_CONTRACT_PAGES).

// Valid-Verhoeff synthetic Aadhaar-shaped number (invented).
export const SAMPLE_AADHAAR = "234123412346";

export const SAMPLE_CONTRACT_PAGES: string[][] = [
  [
    "COLLABORATION AGREEMENT",
    "Agreement No: CO/2025/0042",
    "This Agreement is made on the 5th day of March, 2025 between CreatorOps Media Pvt Ltd and the Collaborator.",
    "Collaborator Name: Sample Creator Studio",
    "Mobile: +91 98765 43210",
    "Email: hello@samplecreator.example",
    "Address: 12, Test Street, Sample Nagar,",
    "Bengaluru - 560001",
    "State: Karnataka",
    "PAN: ABCPE1234F",
    "Name as per PAN: Sample Creator",
    "GSTIN: 29ABCPE1234F1Z5",
    `Aadhaar No: 2341 2341 2346`,
    "Account Number: 123456789012",
    "IFSC: HDFC0001234",
    "Instagram Page Link: https://www.instagram.com/sample.creator/?igsh=abc",
    "Page Name: Sample Creator Official",
  ],
  [
    "Effective Date: 01/04/2025",
    "Termination Date: 31 March 2026",
    "Currency: INR",
    "Payment Cycle: Monthly",
    "Fixed Fee: Rs. 25,000/-",
    "Fixed deliverable units: 12 reels",
    "Account Transfer Fee: Rs. 10,000",
    "Advance Payment: Nil",
    "Invoice Required: Yes",
    "Payment Terms: Net 30",
    "3. Renewal",
    "This Agreement may be renewed for a further term by mutual written consent.",
    "4. Termination",
    "Either party may terminate this Agreement by giving 30 days written notice.",
    "5. Scope of Services",
    "The Collaborator shall publish reels and stories on the page as briefed.",
  ],
  [
    "Incentive:",
    "10,000 to 50,000 views: Rs. 2,000",
    "Above 50,000 views: Rs. 5,000",
    "Performance target: 5% follower growth per month.",
    "LFC: YouTube Video, Podcast",
    "SFC: Reels, Shorts",
  ],
];

export const SAMPLE_CONTRACT_TEXT_PAGES: string[] = SAMPLE_CONTRACT_PAGES.map((lines) => lines.join("\n"));
