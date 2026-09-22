// Step 14B.1 onboarding: a tiny hand-off between the record step's `Check for existing ...` button and the duplicate-result region. The check is
// started in one block and its result is rendered in another; whoever starts it asks for focus to move to the result once it arrives (so a keyboard /
// screen-reader user lands on it, like after `Extract from Agreement`). A module-level flag is enough: it is set right before a user-started check
// and consumed by the next result (or cleared by a failed check).
const request = { pending: false };

export const requestDuplicatesResultFocus = (): void => {
  request.pending = true;
};
export const clearDuplicatesResultFocusRequest = (): void => {
  request.pending = false;
};
export const consumeDuplicatesResultFocusRequest = (): boolean => {
  const was = request.pending;
  request.pending = false;
  return was;
};
