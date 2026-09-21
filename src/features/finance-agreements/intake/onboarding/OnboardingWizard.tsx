"use client";

// Step 14B.1 onboarding: the NEW-COUNTERPARTY WIZARD. Shown in place of Contract source / Existing details / Extracted / Cross-verification while a
// new Partner or Vendor is being set up from a signed Agreement (`Create new Partner from Agreement`). It reads as one flow:
//
//   1 Signed Agreement -> extracted Agreement values      2 Proposed new record (editable)
//   3 Duplicate check                                     4 Confirmed onboarding values + create
//
// It is NOT the Cross-verification table: there is no CreatorOps record yet, so nothing is "Missing in CreatorOps". When the record is created the
// form continues in the normal intake on the new draft, and the same File is sent through the ordinary upload / extract / attach flow.
import { createRight } from "./onboarding-mode";
import { useIntake } from "../intake-context";
import { SectionCard } from "../SectionCard";
import { WizardCreateBlock } from "./WizardCreateBlock";
import { WizardDuplicatesBlock } from "./WizardDuplicatesBlock";
import { WizardRecordBlock } from "./WizardRecordBlock";
import { WizardUploadBlock } from "./WizardUploadBlock";

export function OnboardingWizard() {
  const { onboarding, permissions } = useIntake();
  const noun = onboarding.type === "PARTNER" ? "Partner" : "Vendor";
  // Decided on the server before render: a person who can review but not create is told up front (and the last step is disabled with the reason).
  const right = createRight(permissions, onboarding.type, onboarding.state.form.accounts.length > 0);

  return (
    <SectionCard sectionKey="onboarding" title={`New ${noun} from Agreement`} description={`Read the signed Agreement, check whether the ${noun} already exists, then create it. Nothing is created until the last step.`}>
      {!right.canCreate && (
        <div className="banner" role="status" style={{ margin: "0 0 4px" }} data-testid="onboarding-permission-note">
          <span>
            <b>You can review, but not create.</b> {right.reason} You can still read the Agreement and use an existing {noun} if one is found.
          </span>
        </div>
      )}
      <WizardUploadBlock />
      <WizardRecordBlock />
      <WizardDuplicatesBlock />
      <WizardCreateBlock />
    </SectionCard>
  );
}
