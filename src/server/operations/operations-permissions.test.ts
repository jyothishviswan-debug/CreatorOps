import { describe, expect, it } from "vitest";

import { deriveOperationsPermissions, NO_OPERATIONS_PERMISSIONS } from "./operations-permissions";

describe("deriveOperationsPermissions", () => {
  it("every permission is false when the actor cannot even view Operations, regardless of individual action grants", () => {
    const result = deriveOperationsPermissions({ operationsView: false, manageTasks: true, assignTasks: true, completeTasks: true, viewApprovalQueue: true, manageReminders: true });
    expect(result).toEqual(NO_OPERATIONS_PERMISSIONS);
  });

  it("each action permission requires BOTH view AND its own exact action grant - never derived from another action", () => {
    const onlyManageTasks = deriveOperationsPermissions({ operationsView: true, manageTasks: true, assignTasks: false, completeTasks: false, viewApprovalQueue: false, manageReminders: false });
    expect(onlyManageTasks).toEqual({ canView: true, canManageTasks: true, canAssignTasks: false, canCompleteTasks: false, canViewApprovalQueue: false, canManageReminders: false });
  });

  it("full grants yield every permission true", () => {
    const full = deriveOperationsPermissions({ operationsView: true, manageTasks: true, assignTasks: true, completeTasks: true, viewApprovalQueue: true, manageReminders: true });
    expect(full).toEqual({ canView: true, canManageTasks: true, canAssignTasks: true, canCompleteTasks: true, canViewApprovalQueue: true, canManageReminders: true });
  });
});
