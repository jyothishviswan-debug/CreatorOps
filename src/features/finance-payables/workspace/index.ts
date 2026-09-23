// Step 15B: the Payables workspace (/finance/payables). The server page (src/app/finance/payables/page.tsx)
// resolves the actor, parses the URL with parseWorkspaceUrlState and reads the first page through the
// service; these are the pure modules and the client components it renders.
export { PayablesWorkspace } from "./PayablesWorkspace";
export { WorkspaceDenied, WorkspaceLoadError } from "./WorkspaceStates";
export { WORKSPACE_SUBTITLE, WORKSPACE_TITLE } from "./workspace-copy";
export { parseWorkspaceUrlState, toWorkspaceRequest, workspaceHref, WORKSPACE_PAGE_LIMIT, type WorkspaceUrlState } from "./workspace-query";
export { NEW_PAYABLE_HREF } from "./workspace-view-model";
